import { AttentionClient, FlyxClient, HostRuntimeRegistry, ClientError, DraftStore, revalidateAttentionRoute } from "@flyx/client-core";
import type { AttentionRouteResolution } from "@flyx/client-core";
import { InteractionSchema } from "@flyx/mvp-protocol";
import { z } from "zod";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { expoFetchImplementation, expoPlatformSignals, nativeFetch, nativeSocketFactory, openExpoStore } from "../platform/expo";
import { pairNativeDirect } from "../platform/transport";
import { parseNativePairing } from "../platform/pairing";
import { readSessionSnapshot } from "./session";
import type { NativeClientStore } from "../platform/store";

export class MobileEnvironment {
  readonly registry: HostRuntimeRegistry;
  readonly drafts: DraftStore;
  current: FlyxClient | undefined;
  private observers = new Set<(client: FlyxClient | undefined) => void>();
  private selection = 0;
  private pairingWork: { input: string; promise: Promise<void> } | undefined;
  private seenLinks = new Set<string>();
  private routesInstalled = false;
  onError: (error: unknown) => void = () => {};
  onAttention: (result: AttentionRouteResolution) => void = () => {};
  constructor(readonly store: NativeClientStore) {
    this.drafts = new DraftStore(store);
    this.registry = new HostRuntimeRegistry((hostId) => new FlyxClient({ hostId, store, platformSignals: expoPlatformSignals, clock: expoPlatformSignals.clock, fetch: nativeFetch, socketFactory: nativeSocketFactory, appOrigin: "flyx://app" }));
  }
  observe(handler: (client: FlyxClient | undefined) => void): () => void { this.observers.add(handler); handler(this.current); return () => { this.observers.delete(handler); }; }
  private emit(): void { for (const handler of this.observers) handler(this.current); }
  async selectHost(hostId: string): Promise<void> {
    const selection = ++this.selection;
    if (!await this.store.getProfile(hostId)) throw new ClientError("HOST_NOT_FOUND", "Saved Host does not exist");
    if (selection !== this.selection) return;
    await this.store.setSelectedHost(hostId);
    if (selection !== this.selection) return;
    this.current = this.registry.get(hostId); this.emit();
    await this.registry.setDesiredHost(hostId);
  }
  pair(input: string): Promise<void> {
    if (this.pairingWork) {
      if (this.pairingWork.input === input) return this.pairingWork.promise;
      return Promise.reject(new ClientError("PAIRING_BUSY", "Wait for the current pairing attempt"));
    }
    const selection = ++this.selection;
    const assertCurrent = () => { if (selection !== this.selection) throw new ClientError("CONNECTION_REPLACED", "Pairing was cancelled by a newer selection"); };
    const promise = this.pairOnce(input, assertCurrent).finally(() => { if (this.pairingWork?.promise === promise) this.pairingWork = undefined; });
    this.pairingWork = { input, promise }; return promise;
  }
  private async pairOnce(input: string, assertCurrent: () => void): Promise<void> {
    const { decoded, profile, fragment } = await parseNativePairing(input, this.store);
    assertCurrent(); this.registry.closeHost(profile.hostId);
    if (decoded.kind === "direct") await pairNativeDirect(profile, decoded.offer.endpoint, decoded.offer.grant, this.store, expoFetchImplementation, nativeSocketFactory, assertCurrent);
    else await this.registry.get(profile.hostId).pair(fragment, "Flyx native device");
    assertCurrent(); await this.selectHost(profile.hostId);
  }
  async forget(hostId: string): Promise<void> {
    this.selection++;
    if (this.current && this.registry.peek(hostId) === this.current) { this.current = undefined; this.emit(); }
    await this.registry.forgetLocalHost(hostId);
  }
  async openAttention(value: unknown): Promise<AttentionRouteResolution> {
    const result = await revalidateAttentionRoute(value, {
      getSession: async (hostId, sessionId) => {
        await this.selectHost(hostId); const client = this.registry.get(hostId);
        await client.selectSession(sessionId);
        const snapshot = await client.request<unknown>("session.getSnapshot", { sessionId });
        const parsed = readSessionSnapshot(snapshot, sessionId);
        return { id: parsed.sessionId, ...(parsed.activeTurnId ? { activeTurnId: parsed.activeTurnId } : {}) };
      },
      getInteraction: async (hostId, sessionId, interactionId) => InteractionSchema.parse(await this.registry.get(hostId).request("interaction.get", { sessionId, interactionId })),
    });
    this.onAttention(result); return result;
  }
  attentionClient(client = this.current): AttentionClient {
    const hostId = client?.getState().profile?.hostId;
    if (!client || !hostId) throw new ClientError("NOT_CONNECTED", "Connect a Host first");
    return new AttentionClient({ hostId, request: (method, payload, commandId) => commandId ? client.command(method, payload, commandId) : client.request(method, payload) });
  }
  async registerPush(projectId: string): Promise<void> {
    z.uuid().parse(projectId);
    if (!this.current) throw new ClientError("NOT_CONNECTED", "Connect a Host before enabling notifications");
    const client = this.current, selection = this.selection;
    if (Platform.OS === "android") await Notifications.setNotificationChannelAsync("flyx-attention", { name: "Flyx Host attention", importance: Notifications.AndroidImportance.DEFAULT });
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) throw new ClientError("NOTIFICATION_PERMISSION_REQUIRED", "Notification permission was not granted");
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    if (selection !== this.selection || client !== this.current) throw new ClientError("CONNECTION_REPLACED", "Host selection changed before notification registration");
    await this.attentionClient(client).registerPush({ platform: "expo", tokenType: "expo", token: token.data, projectId }, crypto.randomUUID());
  }
  installPlatformRoutes(): void {
    if (this.routesInstalled) return; this.routesInstalled = true;
    const process = (url: string) => {
      if (this.seenLinks.has(url)) return; this.seenLinks.add(url);
      if (this.seenLinks.size > 8) this.seenLinks.delete(this.seenLinks.values().next().value!);
      void this.pair(url).catch((error: unknown) => this.onError(error));
    };
    Linking.addEventListener("url", (event) => process(event.url));
    void Linking.getInitialURL().then((url) => { if (url) process(url); }).catch((error: unknown) => this.onError(error));
    const handled = new Set<string>();
    const respond = (response: Notifications.NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (handled.has(id)) return; handled.add(id);
      if (handled.size > 128) handled.delete(handled.values().next().value!);
      void this.openAttention(response.notification.request.content.data).catch((error: unknown) => this.onError(error));
      void Notifications.clearLastNotificationResponseAsync().catch((error: unknown) => this.onError(error));
    };
    Notifications.addNotificationResponseReceivedListener(respond);
    void Notifications.getLastNotificationResponseAsync().then((response) => { if (response) respond(response); }).catch((error: unknown) => this.onError(error));
  }
}
let environment: Promise<MobileEnvironment> | undefined;
/** App entry owns the desired runtime. React mounts only attach observers. */
export function getMobileEnvironment(): Promise<MobileEnvironment> {
  return environment ??= openExpoStore().then(async (store) => {
    const app = new MobileEnvironment(store);
    const selected = await store.getSelectedHost();
    if (selected) void app.selectHost(selected).catch((error: unknown) => app.onError(error));
    app.installPlatformRoutes(); return app;
  });
}
