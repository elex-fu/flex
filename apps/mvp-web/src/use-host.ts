import { useCallback, useEffect, useRef, useState } from "react";
import {
  createFlyxClient,
  type ClientState,
  type HostProfile,
  type PendingCommand,
} from "@flyx/client-core";
import type { Bootstrap, SessionEvent, TimelineItem } from "@flyx/mvp-protocol";
import { hasTerminalItem, isRecord, projectSnapshot, timelineItemFromEvent, type Snapshot } from "./timeline.js";

export type HostStatus = {
  provider: {
    provider: Bootstrap["provider"];
    transport: string;
    adapterVersion: string;
    executable: string;
    runtimeVersion: string;
    workspace: string;
    sandboxRequired: boolean;
  };
  git: { branch?: string; dirty: boolean; files: Array<{ path: string }> };
};

export type Device = {
  id: string;
  hostId: string;
  displayName?: string;
  platform: string;
  credentialKind: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
};

export type DeviceList = { devices: Device[]; currentDeviceId: string };

export type WorkspaceDiff = {
  branch?: string;
  head?: string;
  dirty: boolean;
  files: Array<{ path: string }>;
  diff: string;
  truncated: boolean;
  baselineWarning?: string;
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "操作失败，请检查连接后重试";
}

export function connectionLabel(state: ClientState): string {
  if (state.pairingRequired) return "未配对";
  if (state.error?.code === "DEVICE_REVOKED" || state.error?.code === "REVOKED") return "设备已撤销";
  if (state.error?.code === "IDENTITY_MISMATCH" || state.error?.code === "HOST_KEY_MISMATCH") return "Host 身份不匹配";
  if (state.connection === "online") return state.sync === "synced" ? "已同步" : "补同步中";
  if (state.connection === "authenticating") return "验证设备中";
  if (state.connection === "reconnecting" || state.connection === "degraded") return "已断开，自动恢复中";
  if (state.connection === "failed") return "连接失败";
  if (state.connection === "closed") return "连接已关闭";
  return "连接中";
}

/** React projection only. Connection, auth, synchronization and write receipts live in client-core. */
export function useHost(initialPairing?: string) {
  const [client] = useState(() => createFlyxClient({
    directBaseUrl: window.location.origin,
    // An explicit local page is the development HTTP boundary. Imported
    // endpoints still undergo the core's HTTPS/WSS and identity validation.
    allowInsecureLoopback: window.location.protocol === "http:"
      && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname),
  }));
  const [connection, setConnection] = useState<ClientState>(() => client.getState());
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [pendingCommands, setPendingCommands] = useState<PendingCommand[]>([]);
  const [error, setError] = useState("");
  const itemsRef = useRef<TimelineItem[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const metadataGenerationRef = useRef<number | null>(null);

  const resetProjection = useCallback(() => {
    sessionIdRef.current = null;
    itemsRef.current = [];
    setItems([]);
    setSnapshot(null);
    setBootstrap(null);
    setHostStatus(null);
  }, []);

  const applyEvent = useCallback((event: SessionEvent) => {
    if (sessionIdRef.current && event.sessionId !== sessionIdRef.current) return;
    const explicitId = isRecord(event.payload) && typeof event.payload.itemId === "string" ? event.payload.itemId : `event-${event.id}`;
    const existing = itemsRef.current.find((item) => item.itemId === explicitId);
    const projected = timelineItemFromEvent(event, existing);
    if (projected) {
      const nextItems = existing
        ? itemsRef.current.map((item) => item.itemId === projected.itemId ? projected : item)
        : [...itemsRef.current, projected];
      itemsRef.current = nextItems;
      setItems(nextItems);
    }
    setSnapshot((current) => projectSnapshot(current, event, itemsRef.current));
  }, []);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    const active = () => lifecycleRef.current === lifecycle;
    const offState = client.onState((state) => {
      setConnection(state);
      if (state.pairingRequired) resetProjection();
      if (state.error) setError(state.error.message);
      if (state.connection !== "online" || state.sync !== "synced") return;
      setError("");
      if (metadataGenerationRef.current === state.transportGeneration) return;
      metadataGenerationRef.current = state.transportGeneration;
      const generation = state.transportGeneration;
      // These requests use the current authenticated transport, including
      // Relay. No Host HTTP endpoints are required by the hosted app.
      void Promise.allSettled([
        client.request<Bootstrap>("host.bootstrap", {}),
        client.request<HostStatus>("host.getStatus", {}),
        client.listProfiles(),
      ]).then(([boot, status, saved]) => {
        if (!active() || client.getState().transportGeneration !== generation) return;
        if (boot.status === "fulfilled") setBootstrap(boot.value);
        if (status.status === "fulfilled") setHostStatus(status.value);
        if (saved.status === "fulfilled") setProfiles(saved.value);
      });
    });
    const offSnapshot = client.onSnapshot((value) => {
      const next = value as Snapshot;
      if (sessionIdRef.current && sessionIdRef.current !== next.session.id) resetProjection();
      sessionIdRef.current = next.session.id;
      setSnapshot(next);
    });
    const offEvent = client.onEvent(applyEvent);
    const offReset = client.onReset(resetProjection);
    const offOutbox = client.onOutbox(setPendingCommands);
    if (!initializedRef.current) {
      initializedRef.current = true;
      void (initialPairing ? client.pair(initialPairing) : client.start()).catch((cause) => setError(errorMessage(cause)));
    }
    return () => {
      offState(); offSnapshot(); offEvent(); offReset(); offOutbox();
      // StrictMode's synthetic cleanup must not cancel a pairing exchange.
      window.setTimeout(() => { if (active()) client.stop(); }, 0);
    };
  }, [applyEvent, client, initialPairing, resetProjection]);

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    setError("");
    try { return await operation(); }
    catch (cause) { setError(errorMessage(cause)); return undefined; }
  }, []);

  const pair = useCallback(async (input: string, deviceName: string) => {
    await run(async () => {
      metadataGenerationRef.current = null;
      await client.pair(input.trim(), deviceName.trim() || "Flyx 浏览器");
    });
  }, [client, run]);

  const sendPrompt = useCallback(async (prompt: string) => {
    return run(async () => {
      const response = await client.command<{ turnId?: string }>("session.startTurn", { prompt });
      if (response.turnId && !hasTerminalItem(itemsRef.current, response.turnId)) {
        setSnapshot((current) => current ? {
          ...current,
          session: { ...current.session, activityState: "running" },
          activeTurn: { id: response.turnId!, status: "queued", prompt },
        } : current);
      }
      return response;
    });
  }, [client, run]);

  const logout = useCallback(async () => {
    await run(async () => {
      await client.logout();
      resetProjection();
      metadataGenerationRef.current = null;
      setPendingCommands([]);
      setError("");
    });
  }, [client, resetProjection, run]);

  const selectHost = useCallback(async (hostId: string) => {
    await run(async () => {
      resetProjection();
      metadataGenerationRef.current = null;
      await client.selectHost(hostId);
    });
  }, [client, resetProjection, run]);

  const retryCommand = useCallback(async (commandId: string) => {
    await run(() => client.retryCommand(commandId));
  }, [client, run]);

  return {
    client, connection, bootstrap, snapshot, items, hostStatus, profiles, pendingCommands, error,
    status: connectionLabel(connection),
    ready: connection.connection === "online" && connection.sync === "synced",
    pair, sendPrompt, logout, selectHost, retryCommand, run, setError,
  };
}
