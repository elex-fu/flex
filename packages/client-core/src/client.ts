import { decodeConnectionFragment, verifyHostDescriptor } from "@flyx/mvp-protocol";
import type { HostDescriptorV1, SessionEvent } from "@flyx/mvp-protocol";
import { generateNoiseKeyPair } from "@flyx/secure-channel";
import { abortError, assertNotAborted, ClientError, errorInfo, isRecord, payloadHash, Signal, toBase64Url, validateDirectUrl } from "./common.js";
import { CommandOutbox } from "./command-outbox.js";
import { ConnectionSupervisor } from "./connection-supervisor.js";
import { IndexedDbClientStore } from "./host-profile-store.js";
import { RpcClient } from "./rpc-client.js";
import { systemMonotonicClock } from "./platform.js";
import type { MonotonicClock, PlatformSignals } from "./platform.js";
import { SyncEngine } from "./sync-engine.js";
import { connectDirectWeb, directJson, fetchDirectDescriptor, pairDirectWeb } from "./transports/direct-web.js";
import type { DirectWebOptions } from "./transports/direct-web.js";
import { connectRelayE2ee } from "./transports/relay-e2ee.js";
import type { SocketFactory } from "./transports/websocket.js";
import type { ClientState, ClientStore, ClientTransport, ConnectionEndpoint, DeviceCredential, DraftKey, HostProfile, PendingCommand, Unsubscribe } from "./types.js";

export interface FlyxClientOptions extends DirectWebOptions {
  profile?: HostProfile;
  /** Fixed owner for a registry runtime, independent of the selected UI Host. */
  hostId?: string;
  store?: ClientStore;
  directBaseUrl?: string;
  onlineTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  platformSignals?: PlatformSignals;
  clock?: MonotonicClock;
  random?: () => number;
  stableWindowMs?: number;
  suspensionThresholdMs?: number;
  probeDeadlineMs?: number;
  /** Dependency injection for native shells and deterministic contract tests. */
  connectTransport?: (endpoint: ConnectionEndpoint, profile: HostProfile, generation: number, signal: AbortSignal) => Promise<ClientTransport>;
  socketFactory?: SocketFactory;
  /** Origin serving the web app. Defaults to globalThis.location.origin in a
   * browser and makes exact same-origin Direct connections prefer cookies. */
  appOrigin?: string;
}

export interface DraftCommandOptions {
  commandId?: string;
  draftUpdatedAt?: number;
  /** The composer may clear its input only after this callback runs. */
  onPersisted?: (command: PendingCommand) => void;
}

interface MemoryDeviceKey { publicKey: Uint8Array; secretKey: Uint8Array; deviceId?: string }
interface CredentialResponse { deviceId: string; refreshCredential: string; expiresAt: string; scopes: string[] }

/** Remove secrets synchronously, before decoding, network access, or React rendering. */
export function consumePairingFragment(location: Pick<Location, "href">, history: Pick<History, "replaceState">): string | undefined {
  const url = new URL(location.href);
  const legacy = url.searchParams.get("pair") ?? url.searchParams.get("pairing");
  const pairingHash = /(?:^#|&)(?:pair|offer)=/.test(url.hash) ? url.hash : undefined;
  const rawLegacyHash = /^#[A-Za-z0-9_-]{43,128}$/.test(url.hash) ? url.hash.slice(1) : undefined;
  if (!pairingHash && !rawLegacyHash && legacy === null) return undefined;
  url.searchParams.delete("pair");
  url.searchParams.delete("pairing");
  if (pairingHash || rawLegacyHash) url.hash = "";
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return pairingHash ?? rawLegacyHash ?? legacy ?? undefined;
}

function sameIdentity(a: HostProfile, b: Pick<HostProfile, "hostId" | "hostPublicKey" | "signingPublicKey" | "fingerprint">): boolean {
  return a.hostId === b.hostId && a.hostPublicKey === b.hostPublicKey && a.signingPublicKey === b.signingPublicKey && a.fingerprint === b.fingerprint;
}
function endpointAddress(endpoint: ConnectionEndpoint): string { return endpoint.kind === "direct-https" ? endpoint.baseUrl : `${endpoint.relayUrl}/${endpoint.routeId}`; }

export class FlyxClient {
  readonly store: ClientStore;
  private state: ClientState = { connection: "idle", sync: "unknown", transportGeneration: 0, pairingRequired: false };
  private states = new Signal<ClientState>();
  private outboxChanges = new Signal<PendingCommand[]>();
  private rpc = new RpcClient();
  private sync: SyncEngine;
  private supervisor: ConnectionSupervisor | undefined;
  private profile: HostProfile | undefined;
  private outbox: CommandOutbox | undefined;
  private memoryKeys = new Map<string, MemoryDeviceKey>();
  private pendingPair: { grant: string; deviceName: string } | undefined;
  private unresolvedWrites = false;
  private lifecycle = 0;
  private started = false;
  private locallyRevoked = false;
  private credentialTransition: { generation: number; accepted: boolean; deferred?: ClientError } | undefined;
  private initializing: Promise<void> | undefined;
  constructor(private options: FlyxClientOptions = {}) {
    this.store = options.store ?? new IndexedDbClientStore();
    this.profile = options.profile;
    if (options.hostId && options.profile && options.hostId !== options.profile.hostId) throw new ClientError("HOST_RUNTIME_BOUND", "Runtime profile belongs to a different Host");
    this.sync = new SyncEngine({ request: (method, payload) => this.rpc.request(method, payload), isCurrent: (generation) => this.supervisor?.generation === generation, recover: () => this.reconnect() });
    this.sync.onState((sync) => this.update({ sync }));
    this.rpc.onEvent((event) => this.sync.receive(event, this.rpc.generation));
    this.rpc.onPong((nonce) => this.supervisor?.receivedPong(nonce));
    this.rpc.onError((error) => {
      if (!["DEVICE_REVOKED", "AUTHENTICATION_REQUIRED", "PAIRING_REQUIRED", "CREDENTIAL_EXPIRED"].includes(error.code)) return;
      const transition = this.credentialTransition;
      if (transition?.generation === this.rpc.generation) { transition.deferred = error; return; }
      void this.failAuthorization(error);
    });
  }
  /** A registry binds an adopted bootstrap client once its identity is known. */
  bindHostOwner(hostId: string): void {
    if (this.options.hostId && this.options.hostId !== hostId || this.profile && this.profile.hostId !== hostId) throw new ClientError("HOST_RUNTIME_BOUND", "Runtime already belongs to a different Host");
    this.options = { ...this.options, hostId };
  }
  private assertHostOwner(hostId: string): void {
    if (this.options.hostId && this.options.hostId !== hostId) throw new ClientError("HOST_RUNTIME_BOUND", "Select the other Host's registry runtime");
  }
  getState(): ClientState { return structuredClone(this.state); }
  onState(handler: (state: ClientState) => void): Unsubscribe { handler(this.getState()); return this.states.subscribe(handler); }
  onEvent(handler: (event: SessionEvent) => void): Unsubscribe { return this.sync.onEvent(handler); }
  onSnapshot(handler: (snapshot: unknown) => void): Unsubscribe { return this.sync.onSnapshot(handler); }
  onReset(handler: () => void): Unsubscribe { return this.sync.onReset(handler); }
  onOutbox(handler: (commands: PendingCommand[]) => void): Unsubscribe { return this.outboxChanges.subscribe(handler); }
  private update(patch: Partial<ClientState>): void { this.state = { ...this.state, ...patch }; this.states.emit(this.getState()); }
  listProfiles(): Promise<HostProfile[]> { return this.store.listProfiles(); }
  async listPendingCommands(): Promise<PendingCommand[]> { return this.outbox?.list() ?? []; }
  request<T = unknown>(method: string, payload: unknown = {}): Promise<T> { return this.rpc.request<T>(method, payload); }
  command<T = unknown>(method: string, payload: unknown = {}, commandId?: string): Promise<T> {
    if (!this.outbox || this.state.connection !== "online" || this.state.sync !== "synced") return Promise.reject(new ClientError("NOT_CONNECTED", "Wait until the Host is connected and synchronized"));
    return this.outbox.execute<T>(method, payload, commandId).then(async (result) => {
      if (["access.revokeAll", "access.revokeAllDevices", "access.revokeSelf"].includes(method)) { this.locallyRevoked = true; await this.clearCurrentCredential(); }
      return result;
    });
  }
  async commandFromDraft<T = unknown>(method: string, payload: unknown, key: DraftKey, options: DraftCommandOptions = {}): Promise<T> {
    if (!this.outbox || this.state.connection !== "online" || this.state.sync !== "synced") throw new ClientError("NOT_CONNECTED", "Wait until the Host is connected and synchronized");
    if (key.hostId !== this.requireProfile().hostId) throw new ClientError("DRAFT_HOST_MISMATCH", "Draft belongs to a different Host");
    if (isRecord(payload) && typeof payload.sessionId === "string" && payload.sessionId !== key.sessionId) throw new ClientError("DRAFT_SESSION_MISMATCH", "Command targets a different draft Session");
    const lifecycle = this.lifecycle;
    const commandId = options.commandId ?? crypto.randomUUID();
    const hash = await payloadHash(method, payload);
    if (lifecycle !== this.lifecycle) throw abortError();
    const command: PendingCommand = { commandId, hostId: key.hostId, method, payloadHash: hash, payload: structuredClone(payload), createdAt: new Date().toISOString(), state: "queued", dispatchState: "not_dispatched" };
    await this.store.putCommandAndClearDraft(command, key, options.draftUpdatedAt);
    if (lifecycle !== this.lifecycle) throw abortError();
    options.onPersisted?.(structuredClone(command));
    return this.command<T>(method, payload, commandId);
  }
  retryCommand<T = unknown>(commandId: string): Promise<T> {
    if (!this.outbox || this.state.connection !== "online" || this.state.sync !== "synced") return Promise.reject(new ClientError("NOT_CONNECTED", "Wait until the Host is connected and synchronized"));
    return this.outbox.retry<T>(commandId);
  }
  async start(): Promise<void> {
    if (this.initializing) return this.initializing;
    if (this.started) return;
    this.started = true;
    const lifecycle = ++this.lifecycle;
    this.initializing = this.initialize(lifecycle).catch((error: unknown) => {
      if (lifecycle !== this.lifecycle) return;
      this.update({ connection: "failed", error: errorInfo(error), pairingRequired: error instanceof ClientError && error.code === "PAIRING_REQUIRED" });
    }).finally(() => { if (lifecycle === this.lifecycle) this.initializing = undefined; });
    return this.initializing;
  }
  private async initialize(lifecycle: number): Promise<void> {
    this.update({ connection: "connecting" });
    if (!this.profile) {
      const selected = this.options.hostId ?? await this.store.getSelectedHost();
      const profile = selected ? await this.store.getProfile(selected) : undefined;
      if (lifecycle !== this.lifecycle) return;
      this.profile = profile;
    }
    if (!this.profile) {
      const baseUrl = this.options.directBaseUrl;
      if (!baseUrl) throw new ClientError("PAIRING_REQUIRED", "Scan a Host pairing offer to connect");
      const descriptor = await fetchDirectDescriptor(baseUrl, undefined, this.options);
      if (lifecycle !== this.lifecycle) return;
      if (this.options.hostId && descriptor.hostId !== this.options.hostId) throw new ClientError("IDENTITY_MISMATCH", "Endpoint belongs to a different registry Host");
      this.profile = this.profileFromDescriptor(descriptor);
      this.addEndpoint({ id: "direct-current-origin", kind: "direct-https", source: "manual", baseUrl: validateDirectUrl(baseUrl, this.options.allowInsecureLoopback).origin, availability: "unknown" });
    }
    if (lifecycle !== this.lifecycle) return;
    this.configure();
    await this.supervisor!.start();
  }
  private profileFromDescriptor(descriptor: HostDescriptorV1): HostProfile {
    return { hostId: descriptor.hostId, label: "Flyx Host", hostPublicKey: descriptor.hostPublicKey, signingPublicKey: descriptor.signingPublicKey, fingerprint: descriptor.fingerprint, endpoints: descriptor.endpoints.map((endpoint) => ({ ...endpoint, availability: "unknown" })) };
  }
  private addEndpoint(endpoint: ConnectionEndpoint): void {
    const profile = this.requireProfile();
    const matching = profile.endpoints.findIndex((value) => value.id === endpoint.id || endpointAddress(value) === endpointAddress(endpoint));
    if (matching >= 0) profile.endpoints[matching] = { ...endpoint, id: profile.endpoints[matching]!.id };
    else profile.endpoints.push(endpoint);
  }
  private requireProfile(): HostProfile { if (!this.profile) throw new ClientError("PAIRING_REQUIRED", "Select a Host first"); return this.profile; }
  private async persistProfile(): Promise<void> {
    const profile = this.requireProfile();
    const lifecycle = this.lifecycle;
    await this.store.putProfile(profile);
    if (lifecycle !== this.lifecycle || this.profile !== profile) throw abortError();
    await this.store.setSelectedHost(profile.hostId);
    if (lifecycle !== this.lifecycle || this.profile !== profile) throw abortError();
    this.update({ profile });
  }
  private isSameOrigin(baseUrl: string): boolean {
    const appOrigin = this.options.appOrigin ?? (typeof location !== "undefined" ? location.origin : undefined);
    if (!appOrigin) return false;
    try { return new URL(appOrigin).origin === validateDirectUrl(baseUrl, this.options.allowInsecureLoopback).origin; }
    catch { return false; }
  }
  private configure(): void {
    const profile = this.requireProfile();
    const lifecycle = this.lifecycle;
    // A late outbox result after stop/forget must not recreate deleted Host data.
    const commandStore = new Proxy(this.store, {
      get: (target, property) => {
        if (property === "putCommand") return (command: PendingCommand) => {
          if (lifecycle !== this.lifecycle || this.profile !== profile) return Promise.reject(abortError());
          return target.putCommand(command);
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.outbox = new CommandOutbox(commandStore, profile.hostId, (method, payload, commandId) => {
      if (lifecycle !== this.lifecycle || this.profile !== profile) return Promise.reject(abortError());
      return this.rpc.request(method, payload, commandId);
    });
    this.outbox.onChange((commands) => { this.unresolvedWrites = commands.some((command) => ["sent", "receipt_unknown"].includes(command.state)); this.outboxChanges.emit(commands); });
    this.supervisor = new ConnectionSupervisor({
      endpoints: () => profile.endpoints,
      preferredEndpointId: () => profile.preferredEndpointId,
      allowLoopback: this.options.allowInsecureLoopback ?? false,
      connect: async (endpoint, generation, signal) => {
        if (this.options.connectTransport) return this.options.connectTransport(endpoint, profile, generation, signal);
        if (endpoint.kind === "direct-https") {
          const credential = await this.store.getCredential(profile.hostId);
          return connectDirectWeb(endpoint.baseUrl, profile, generation, {
            ...this.options,
            preferCookie: this.isSameOrigin(endpoint.baseUrl),
            ...(credential ? { deviceRefreshCredential: credential.refreshCredential } : {}),
          }, signal);
        }
        const key = this.memoryKeys.get(profile.hostId);
        return connectRelayE2ee({ profile, relayUrl: endpoint.relayUrl, routeId: endpoint.routeId, generation, signal, ...(key?.deviceId && !this.pendingPair ? { staticKey: key.secretKey, deviceId: key.deviceId } : {}), ...(this.options.socketFactory ? { socketFactory: this.options.socketFactory } : {}) });
      },
      activate: (transport, endpoint, signal) => this.activate(transport, endpoint, signal),
      ping: (nonce) => this.rpc.ping(nonce),
      probe: async (endpoint, signal) => {
        if (endpoint.kind !== "direct-https") throw new ClientError("INVALID_ENDPOINT", "Only Direct endpoints can be probed");
        const clock = this.options.clock ?? this.options.platformSignals?.clock ?? systemMonotonicClock;
        const before = clock.now();
        await fetchDirectDescriptor(endpoint.baseUrl, profile, this.options, signal);
        return Math.max(0, clock.now() - before);
      },
      canUpgrade: () => !this.unresolvedWrites && !(this.outbox?.hasUnresolvedWrites ?? false),
      endpointChanged: (endpoint) => {
        const index = profile.endpoints.findIndex((value) => value.id === endpoint.id);
        if (index >= 0) profile.endpoints[index] = endpoint;
        if (lifecycle !== this.lifecycle) return;
        void this.store.putProfile(profile).catch(() => { if (lifecycle === this.lifecycle) this.update({ error: { code: "STORAGE_WRITE_FAILED", message: "Unable to save connection profile" } }); });
      },
      ...(this.options.onlineTarget ? { onlineTarget: this.options.onlineTarget } : typeof window !== "undefined" ? { onlineTarget: window } : {}),
      ...(this.options.platformSignals ? { platformSignals: this.options.platformSignals } : {}),
      ...(this.options.clock ? { clock: this.options.clock } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      ...(this.options.stableWindowMs !== undefined ? { stableWindowMs: this.options.stableWindowMs } : {}),
      ...(this.options.suspensionThresholdMs !== undefined ? { suspensionThresholdMs: this.options.suspensionThresholdMs } : {}),
      ...(this.options.probeDeadlineMs !== undefined ? { probeDeadlineMs: this.options.probeDeadlineMs } : {}),
    });
    this.supervisor.onState((state) => {
      if (state.transportGeneration !== this.state.transportGeneration) { this.rpc.unbind(); this.sync.invalidate(); }
      if (!state.error) delete this.state.error;
      this.update({ ...state, profile, pairingRequired: state.error !== undefined && ["PAIRING_REQUIRED", "AUTHENTICATION_REQUIRED", "DEVICE_REVOKED", "CREDENTIAL_EXPIRED"].includes(state.error.code) });
    });
  }
  private async activate(transport: ClientTransport, endpoint: ConnectionEndpoint, signal: AbortSignal): Promise<void> {
    const profile = this.requireProfile();
    if (this.credentialTransition && this.credentialTransition.generation !== transport.generation) this.credentialTransition = undefined;
    this.rpc.bind(transport);
    await this.rpc.hello(profile, transport.deviceId);
    assertNotAborted(signal);
    const stored = await this.store.getCredential(profile.hostId);
    assertNotAborted(signal);
    // A Direct same-origin ticket is already backed by the HttpOnly cookie.
    // Do not rotate that browser session into script-readable device auth on
    // every reload merely because the ephemeral Relay key was lost.
    if (transport.authentication === "direct-cookie") {
      if (!transport.deviceId) throw new ClientError("AUTHENTICATION_REQUIRED", "Host did not identify the browser session");
      await this.finishActivation(transport, signal, "http-only-cookie");
      return;
    }
    let key = this.memoryKeys.get(profile.hostId);
    if (!key) { key = await generateNoiseKeyPair(); this.memoryKeys.set(profile.hostId, key); }
    if (this.pendingPair && endpoint.kind === "relay-wss") {
      const paired = await this.rotateCredential(transport.generation, "access.pair", { grant: this.pendingPair.grant, proposedDevicePublicKey: toBase64Url(key.publicKey), deviceInfo: { displayName: this.pendingPair.deviceName, platform: "web" } }, key);
      this.pendingPair = undefined;
      throw new ClientError("AUTH_REFRESHED", "Device paired; establishing its authenticated connection");
    }
    if (!key.deviceId || transport.kind === "relay" && !transport.deviceId) {
      if (transport.kind === "relay" && !stored) throw new ClientError("PAIRING_REQUIRED", "Pairing expired; scan a new Host offer");
      await this.rotateCredential(transport.generation, "access.refresh", { proposedDevicePublicKey: toBase64Url(key.publicKey), ...(transport.kind === "relay" && stored ? { refreshCredential: stored.refreshCredential } : {}) }, key);
      throw new ClientError("AUTH_REFRESHED", "Device authenticated; renewing the connection lease");
    }
    if (transport.deviceId && transport.deviceId !== key.deviceId) throw new ClientError("DEVICE_MISMATCH", "Connection belongs to a different device");
    await this.finishActivation(transport, signal, "short-lived-refresh");
  }
  private async finishActivation(transport: ClientTransport, signal: AbortSignal, securityLevel: "http-only-cookie" | "short-lived-refresh"): Promise<void> {
    const profile = this.requireProfile();
    const descriptor = await this.rpc.request<unknown>("host.getDescriptor");
    let verified: HostDescriptorV1;
    try { verified = await verifyHostDescriptor(descriptor, profile, this.options.allowInsecureLoopback ? { allowLoopbackHttp: true } : {}); }
    catch { throw new ClientError("IDENTITY_MISMATCH", "Host descriptor does not match its pinned identity"); }
    assertNotAborted(signal);
    for (const advertised of verified.endpoints) {
      const known = profile.endpoints.find((candidate) => candidate.id === advertised.id);
      this.addEndpoint({ ...advertised, availability: known?.availability ?? "unknown", ...(known?.lastRttMs !== undefined ? { lastRttMs: known.lastRttMs } : {}) });
    }
    await this.persistProfile();
    this.locallyRevoked = false;
    assertNotAborted(signal);
    await this.sync.synchronize(transport.generation);
    assertNotAborted(signal);
    await this.outbox!.reconcile();
    this.outboxChanges.emit(await this.outbox!.list());
    this.update({ securityLevel });
  }
  private async rotateCredential(generation: number, method: "access.pair" | "access.refresh", payload: unknown, key: MemoryDeviceKey): Promise<CredentialResponse> {
    const transition = { generation, accepted: false } as { generation: number; accepted: boolean; deferred?: ClientError };
    this.credentialTransition = transition;
    try {
      const response = await this.rpc.request<CredentialResponse>(method, payload, crypto.randomUUID());
      if (this.supervisor?.generation !== generation) throw abortError();
      await this.saveCredential(response, key, generation);
      transition.accepted = true;
      return response;
    } catch (error) {
      if (this.credentialTransition === transition) this.credentialTransition = undefined;
      const code = error instanceof ClientError ? error.code : undefined;
      if (method === "access.refresh" && ["REFRESH_INVALID", "UNAUTHENTICATED", "AUTHENTICATION_REQUIRED", "DEVICE_UNAUTHORIZED", "DEVICE_EXPIRED", "CREDENTIAL_EXPIRED"].includes(code ?? "")) {
        await this.clearCurrentCredential();
        throw new ClientError("AUTHENTICATION_REQUIRED", "The saved device credential expired or was revoked");
      }
      throw transition.deferred ?? error;
    }
  }
  private async saveCredential(response: CredentialResponse, key: MemoryDeviceKey, generation: number): Promise<void> {
    if (!isRecord(response) || typeof response.deviceId !== "string" || typeof response.refreshCredential !== "string" || typeof response.expiresAt !== "string" || !Array.isArray(response.scopes)) throw new ClientError("INVALID_CREDENTIAL", "Host returned an invalid device credential");
    const credential: DeviceCredential = { hostId: this.requireProfile().hostId, deviceId: response.deviceId, refreshCredential: response.refreshCredential, expiresAt: response.expiresAt, scopes: response.scopes, storage: "short-lived-refresh" };
    if (this.supervisor?.generation !== generation) throw abortError();
    await this.store.putCredential(credential);
    if (this.supervisor?.generation !== generation) throw abortError();
    key.deviceId = response.deviceId;
    await this.persistProfile();
    this.update({ securityLevel: "short-lived-refresh" });
  }
  stop(): void {
    this.started = false;
    this.lifecycle++;
    this.initializing = undefined;
    this.supervisor?.stop();
    this.supervisor = undefined;
    this.outbox = undefined;
    this.credentialTransition = undefined;
    this.unresolvedWrites = false;
    this.rpc.unbind();
    this.sync.invalidate();
    this.update({ connection: "closed" });
  }
  reconnect(): void { if (this.supervisor) void this.supervisor.reconnect(); else { this.started = false; void this.start(); } }
  async selectHost(hostId: string): Promise<void> {
    this.assertHostOwner(hostId);
    const previousLifecycle = this.lifecycle;
    const profile = await this.store.getProfile(hostId);
    if (previousLifecycle !== this.lifecycle) throw abortError();
    if (!profile) throw new ClientError("HOST_NOT_FOUND", "Saved Host does not exist");
    this.stop();
    this.sync.reset();
    this.profile = profile;
    const lifecycle = this.lifecycle;
    await this.store.setSelectedHost(hostId);
    if (lifecycle !== this.lifecycle) throw abortError();
    await this.start();
  }
  async preferEndpoint(endpointId: string): Promise<void> {
    const profile = this.requireProfile();
    if (!profile.endpoints.some((endpoint) => endpoint.id === endpointId)) throw new ClientError("ENDPOINT_NOT_FOUND", "Host endpoint does not exist");
    profile.preferredEndpointId = endpointId;
    await this.persistProfile();
    await this.supervisor?.reconnect(endpointId);
  }
  async pair(input: string, deviceName = "Flyx browser"): Promise<void> {
    this.stop();
    const lifecycle = this.lifecycle;
    this.sync.reset();
    this.update({ connection: "authenticating", pairingRequired: true });
    try {
      let value = input.trim();
      if (/^https?:\/\//.test(value)) {
        const url = new URL(value);
        value = url.hash || url.searchParams.get("pair") || url.searchParams.get("pairing") || "";
      }
      const decoded = await decodeConnectionFragment(value, this.options.allowInsecureLoopback ? { allowLoopbackHttp: true } : {});
      if (lifecycle !== this.lifecycle) throw abortError();
      let directGrant: string | undefined;
      let directUrl: string | undefined;
      if (decoded) {
        const offer = decoded.offer;
        this.assertHostOwner(offer.hostId);
        const stored = await this.store.getProfile(offer.hostId);
        if (lifecycle !== this.lifecycle) throw abortError();
        if (stored && !sameIdentity(stored, offer)) throw new ClientError("IDENTITY_MISMATCH", "Pairing offer changes a saved Host identity; verify the replacement on the Host first");
        this.profile = stored ?? { hostId: offer.hostId, label: "Flyx Host", hostPublicKey: offer.hostPublicKey, signingPublicKey: offer.signingPublicKey, fingerprint: offer.fingerprint, endpoints: [] };
        if (decoded.kind === "relay") {
          this.addEndpoint({ id: "relay-offer", kind: "relay-wss", relayUrl: decoded.offer.relay.url, routeId: decoded.offer.relay.routeId, availability: "unknown" });
          this.pendingPair = { grant: decoded.offer.pairing.grant, deviceName };
          this.profile.preferredEndpointId = this.profile.endpoints.find((endpoint) => endpoint.kind === "relay-wss" && endpoint.routeId === decoded.offer.relay.routeId)!.id;
        } else {
          directGrant = decoded.offer.grant;
          directUrl = decoded.offer.endpoint;
          this.addEndpoint({ id: "direct-offer", kind: "direct-https", source: "manual", baseUrl: directUrl, availability: "unknown" });
        }
      } else {
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new ClientError("INVALID_PAIRING_OFFER", "Paste a complete pairing link or one-time grant");
        directUrl = this.options.directBaseUrl;
        if (!directUrl) throw new ClientError("PAIRING_REQUIRED", "A plain grant requires opening this Host's HTTPS app");
        const descriptor = await fetchDirectDescriptor(directUrl, this.profile, this.options);
        if (lifecycle !== this.lifecycle) throw abortError();
        this.assertHostOwner(descriptor.hostId);
        const stored = await this.store.getProfile(descriptor.hostId);
        if (lifecycle !== this.lifecycle) throw abortError();
        if (stored && !sameIdentity(stored, descriptor)) throw new ClientError("IDENTITY_MISMATCH", "Host identity differs from its saved pin");
        this.profile = stored ?? this.profileFromDescriptor(descriptor);
        this.addEndpoint({ id: "direct-current-origin", kind: "direct-https", source: "manual", baseUrl: validateDirectUrl(directUrl, this.options.allowInsecureLoopback).origin, availability: "unknown" });
        directGrant = value;
      }
      if (directGrant && directUrl) {
        await fetchDirectDescriptor(directUrl, this.requireProfile(), this.options);
        if (lifecycle !== this.lifecycle) throw abortError();
        await pairDirectWeb(directUrl, directGrant, this.options, deviceName);
        if (lifecycle !== this.lifecycle) throw abortError();
        this.pendingPair = undefined;
      }
      if (lifecycle !== this.lifecycle) throw abortError();
      await this.persistProfile();
      if (lifecycle !== this.lifecycle) throw abortError();
      await this.start();
    } catch (error) { if (lifecycle === this.lifecycle) this.update({ connection: "failed", pairingRequired: true, error: errorInfo(error) }); throw error; }
  }
  /** Local deletion is available offline and does not claim remote revocation. */
  async forgetLocalHost(hostId: string = this.requireProfile().hostId): Promise<void> {
    const current = this.profile?.hostId === hostId || this.options.hostId === hostId;
    if (current) { this.stop(); this.sync.reset(); this.pendingPair = undefined; }
    const lifecycle = this.lifecycle;
    const key = this.memoryKeys.get(hostId);
    key?.secretKey.fill(0);
    this.memoryKeys.delete(hostId);
    await this.store.forgetLocalHost(hostId);
    if (current && lifecycle === this.lifecycle && (!this.profile || this.profile.hostId === hostId)) {
      this.profile = undefined;
      delete this.state.profile;
      delete this.state.securityLevel;
      delete this.state.endpointId;
      delete this.state.transportKind;
      delete this.state.error;
      this.outboxChanges.emit([]);
      this.update({ connection: "closed", sync: "unknown", pairingRequired: true });
    }
  }
  /** A separate, authenticated server mutation; never implied by local forget. */
  revokeRemoteDevice<T = unknown>(deviceId?: string): Promise<T> {
    return deviceId ? this.command<T>("access.revokeDevice", { deviceId }) : this.command<T>("access.revokeSelf", {});
  }
  async logout(): Promise<void> {
    const profile = this.requireProfile();
    if (!this.locallyRevoked) await this.rpc.request("access.revokeSelf", {}, crypto.randomUUID());
    // Revoke succeeded before clearing the local credential; offline logout
    // cannot be presented as a successful remote revocation.
    await this.clearCurrentCredential();
    const endpoint = profile.endpoints.find((value) => value.id === this.state.endpointId);
    if (endpoint?.kind === "direct-https") await directJson(endpoint.baseUrl, "/api/auth/logout", this.options, { method: "POST" }).catch(() => undefined);
    this.stop();
    this.sync.reset();
    this.update({ pairingRequired: true, connection: "closed" });
  }
  private async clearCurrentCredential(): Promise<void> {
    const hostId = this.profile?.hostId;
    if (!hostId) return;
    await this.store.deleteCredential(hostId);
    const key = this.memoryKeys.get(hostId);
    key?.secretKey.fill(0);
    this.memoryKeys.delete(hostId);
  }
  private async failAuthorization(error: ClientError): Promise<void> {
    const lifecycle = this.lifecycle;
    this.locallyRevoked = true;
    await this.clearCurrentCredential();
    if (lifecycle !== this.lifecycle) return;
    this.stop();
    this.update({ connection: "failed", pairingRequired: true, error: errorInfo(error) });
  }
}

export function createFlyxClient(options: FlyxClientOptions = {}): FlyxClient { return new FlyxClient(options); }
