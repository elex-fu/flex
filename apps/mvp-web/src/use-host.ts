import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ClientState,
  type HostProfile,
  type PendingCommand,
  type SessionReplicaState,
} from "@flyx/client-core";
import type { Bootstrap, SessionEvent, TimelineContentReference, TimelineItem } from "@flyx/mvp-protocol";
import { canonicalTimelineItem } from "./canonical-timeline.js";
import { getWebHostRuntimes, setDesiredWebHost } from "./host-runtimes.js";
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
  const [client, setClient] = useState(() => getWebHostRuntimes().getCurrent());
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
  const [cacheError, setCacheError] = useState<string>("");
  const replicaGenerationRef = useRef<number | null>(null);
  const [replicaState, setReplicaState] = useState<SessionReplicaState | null>(null);
  const resolvedContentRef = useRef(new Map<string, unknown>());
  const lifecycleRef = useRef(0);
  const metadataGenerationRef = useRef<number | null>(null);

  const resetProjection = useCallback(() => {
    sessionIdRef.current = null;
    itemsRef.current = [];
    setItems([]);
    setSnapshot(null);
    setBootstrap(null);
    setHostStatus(null);
    resolvedContentRef.current.clear();
  }, []);

  const applyEvent = useCallback((event: SessionEvent) => {
    if (client.getProjectionMode() !== "legacy") return;
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
  }, [client]);

  useEffect(() => getWebHostRuntimes().observe((runtime) => {
    setClient(runtime); setConnection(runtime.getState()); setReplicaState(null);
    metadataGenerationRef.current = null; resetProjection();
  }), [resetProjection]);

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
      if (!active() || client.getProjectionMode() !== "legacy") return;
      const next = value as Snapshot;
      if (sessionIdRef.current && sessionIdRef.current !== next.session.id) resetProjection();
      sessionIdRef.current = next.session.id;
      setSnapshot(next);
    });
    const offReplica = client.onReplica((state) => {
      if (!active()) return;
      if (state.mode === "legacy") { if (replicaGenerationRef.current !== null) { resetProjection(); replicaGenerationRef.current = null; } return; }
      if (client.getProjectionMode() !== "canonical" && !(state.stale && state.epoch)) return;
      if (replicaGenerationRef.current !== state.replicaGeneration) { resolvedContentRef.current.clear(); replicaGenerationRef.current = state.replicaGeneration; }
      setReplicaState(state);
      if (sessionIdRef.current && sessionIdRef.current !== state.sessionId) resetProjection();
      sessionIdRef.current = state.sessionId ?? null;
      const nextItems = state.items.map((item) => canonicalTimelineItem(item, resolvedContentRef.current.get(`${state.replicaGeneration}:${item.itemId}:${item.revision}`)));
      itemsRef.current = nextItems; setItems(nextItems);
      if (isRecord(state.snapshot) && isRecord(state.snapshot.session)) {
        const next = state.snapshot as unknown as Snapshot;
        setSnapshot({ ...next, pendingApprovals: state.interactionsAuthoritative ? (state.interactions?.items ?? []) as Snapshot["pendingApprovals"] : [] });
      }
    });
    const offEvent = client.onEvent(applyEvent);
    const offReset = client.onReset(resetProjection);
    const offOutbox = client.onOutbox(setPendingCommands);
    const offCache = client.onCacheError((cause) => setCacheError(cause?.message ?? ""));
    void getWebHostRuntimes().initialize(initialPairing).catch((cause) => { if (active()) setError(errorMessage(cause)); });
    return () => {
      lifecycleRef.current++;
      offState(); offSnapshot(); offReplica(); offEvent(); offReset(); offOutbox(); offCache();
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
      await getWebHostRuntimes().pair(input.trim(), deviceName.trim() || "Flyx 浏览器");
    });
  }, [client, run]);

  const sendPrompt = useCallback(async (prompt: string) => {
    return run(async () => {
      const response = await client.command<{ turnId?: string }>("session.startTurn", { prompt });
      if (client.getProjectionMode() === "legacy" && response.turnId && !hasTerminalItem(itemsRef.current, response.turnId)) {
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
      await setDesiredWebHost(hostId);
    });
  }, [client, resetProjection, run]);

  const retryCommand = useCallback(async (commandId: string) => {
    await run(() => client.retryCommand(commandId));
  }, [client, run]);

  const queryCommandReceipt = useCallback(async (commandId: string) => run(() => client.queryCommandReceipt(commandId)), [client, run]);

  const loadContent = useCallback(async (reference: TimelineContentReference, sessionId?: string) => run(async () => new TextDecoder("utf-8", { fatal: true }).decode(await client.readContent(reference, sessionId ?? sessionIdRef.current ?? undefined))), [client, run]);
  const loadItemContent = useCallback(async (itemId: string) => run(async () => {
    const state = client.replica.getState();
    const item = state.items.find((entry) => entry.itemId === itemId);
    if (!item) throw new Error("Timeline item is outside the loaded window");
    const content = await client.resolveItemContent(itemId);
    if (client.replica.getState().replicaGeneration !== state.replicaGeneration) return;
    resolvedContentRef.current.set(`${state.replicaGeneration}:${itemId}:${item.revision}`, content);
    const nextItems = itemsRef.current.map((entry) => entry.itemId === itemId && entry.revision === item.revision ? canonicalTimelineItem(item, content) : entry);
    itemsRef.current = nextItems; setItems(nextItems); return content;
  }), [client, run]);

  return {
    client, connection, bootstrap, snapshot, items, hostStatus, profiles, pendingCommands, error,
    status: connectionLabel(connection),
    ready: connection.connection === "online" && connection.sync === "synced" && (client.getProjectionMode() === "legacy" || replicaState?.interactionsAuthoritative === true && !replicaState.stale),
    pair, sendPrompt, logout, selectHost, retryCommand, queryCommandReceipt, loadContent, loadItemContent, replicaState, cacheError, run, setError,
  };
}
