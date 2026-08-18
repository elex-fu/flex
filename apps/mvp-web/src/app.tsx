import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Bootstrap, SessionEvent, TimelineItem } from "@flyx/mvp-protocol";

type Snapshot = {
  session: {
    id: string;
    activityState: string;
    headSequence: number;
    providerSessionId?: string;
  };
  // Keep the optional field explicitly undefined-able because the live
  // projection removes an active turn as soon as a terminal event arrives.
  activeTurn?: { id: string; status: string; prompt: string } | undefined;
  pendingApprovals: Array<{
    approvalId: string;
    toolUseId: string;
    request: Record<string, unknown>;
    version: number;
  }>;
};

type HostStatus = {
  provider: {
    sdkVersion: string;
    claudeExecutable: string;
    claudeVersion: string;
    workspace: string;
    sandboxRequired: boolean;
  };
  git: { branch?: string; dirty: boolean; files: Array<{ path: string }> };
};

type TimelinePage = {
  events: SessionEvent[];
  upTo: number;
  nextAfter?: number;
  hasMore: boolean;
};

type Frame =
  | { type: "response"; id: string; ok: true; payload: unknown }
  | { type: "response"; id: string; ok: false; error: { code: string; message: string } }
  | { type: "event"; sessionId: string; event: SessionEvent };

type JsonRecord = Record<string, unknown>;

const commandId = () => crypto.randomUUID();

/**
 * The server sends a canonical event payload, not a TimelineItem snapshot.
 * Keep this projection deliberately small and deterministic: replaying the
 * same event range after a refresh must produce exactly the same item IDs and
 * content as the live stream.
 */
function eventPayload(event: SessionEvent): JsonRecord {
  return isRecord(event.payload) ? event.payload : { value: event.payload };
}

function eventItemKind(event: SessionEvent): TimelineItem["kind"] {
  if (event.type.startsWith("user.")) return "user_message";
  if (event.type.startsWith("assistant.")) return "assistant_message";
  if (event.type.startsWith("tool.")) return "tool_call";
  if (event.type === "turn.failed" || event.type === "session.recovery.required" || event.type.endsWith(".failed") || event.type.endsWith(".unavailable") || event.type.includes("persist_failed")) return "error";
  if (event.type === "turn.reconciled" && isRecord(eventPayload(event).outcome)) {
    const outcome = eventPayload(event).outcome;
    const status = isRecord(outcome) && typeof outcome.status === "string" ? outcome.status : undefined;
    if (status === "failed" || status === "outcome_unknown") return "error";
  }
  if (event.type.startsWith("approval.")) return "approval";
  return "system";
}

function eventStatus(event: SessionEvent, payload: JsonRecord): string {
  if (typeof payload.status === "string") return payload.status;
  if (event.type === "provider.session.init") return "info";
  if (event.type === "assistant.message.completed" && payload.aborted === true) return "aborted";
  if (event.type === "turn.interrupt.requested") return "requested";
  if (event.type === "turn.interrupt.unavailable" || event.type.endsWith(".unavailable")) return "error";
  if (event.type === "turn.completed") return "completed";
  if (event.type === "turn.cancelled") return "cancelled";
  if (event.type === "turn.failed") return "failed";
  if (event.type === "turn.reconciled" && isRecord(payload.outcome) && typeof payload.outcome.status === "string") return payload.outcome.status;
  return event.type.split(".").at(-1) ?? event.type;
}

function shouldRenderEventWithoutItem(event: SessionEvent): boolean {
  return event.type === "provider.session.init"
    || event.type === "turn.interrupt.requested"
    || event.type === "turn.interrupt.unavailable"
    || event.type === "approval.resolve.unavailable"
    || event.type === "turn.reconciled"
    || event.type === "host.event_persist_failed"
    || event.type === "diagnostic";
}

function timelineItemFromEvent(event: SessionEvent, existing?: TimelineItem): TimelineItem | undefined {
  const payload = eventPayload(event);
  const explicitItemId = typeof payload.itemId === "string" ? payload.itemId : undefined;
  if (!explicitItemId && !shouldRenderEventWithoutItem(event)) return undefined;
  const itemId = explicitItemId ?? `event-${event.id}`;
  const kind = eventItemKind(event);
  const previousContent = isRecord(existing?.content) ? existing.content : {};
  // Host assistant deltas are already normalized to the accumulated text.
  // Replacing only `text` avoids doubling content while still preserving any
  // metadata already attached to the item. Tool progress/completion payloads,
  // by contrast, are partial and must be merged with the started item.
  const content: JsonRecord = {
    ...previousContent,
    ...payload,
    ...(explicitItemId ? {} : { message: payload.message ?? event.type }),
  };
  if (typeof payload.result === "string" && typeof payload.message !== "string") content.message = payload.result;
  if (event.type === "turn.cancelled" && typeof payload.reason === "string") content.message = `Turn cancelled: ${payload.reason}`;
  if (kind === "assistant_message" && typeof payload.text === "string") content.text = payload.text;
  return {
    sessionId: event.sessionId,
    itemId,
    kind,
    status: eventStatus(event, payload),
    revision: existing ? existing.revision + 1 : 0,
    content,
    updatedAt: event.occurredAt,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTerminalItem(items: TimelineItem[], turnId: string): boolean {
  return items.some((item) => {
    
    const content = isRecord(item.content) ? item.content : undefined;
    if (content?.turnId !== turnId) return false;
    if (["completed", "failed", "cancelled", "outcome_unknown"].includes(item.status)) return true;
    const outcome = isRecord(content.outcome) ? content.outcome : undefined;
    return Boolean(outcome && typeof outcome.status === "string" && ["completed", "failed", "cancelled", "outcome_unknown"].includes(outcome.status));
  });
}

function approvalFromEvent(event: SessionEvent): Snapshot["pendingApprovals"][number] | undefined {
  const payload = eventPayload(event);
  if (typeof payload.approvalId !== "string" || typeof payload.toolUseId !== "string") return undefined;
  return {
    approvalId: payload.approvalId,
    toolUseId: payload.toolUseId,
    request: payload,
    version: typeof payload.version === "number" ? payload.version : 0,
  };
}

function projectSnapshot(snapshot: Snapshot | null, event: SessionEvent, items: TimelineItem[]): Snapshot | null {
  if (!snapshot) return snapshot;
  const payload = eventPayload(event);
  const turnId = typeof payload.turnId === "string" ? payload.turnId : snapshot.activeTurn?.id;
  const next: Snapshot = {
    ...snapshot,
    // `/api/snapshot` may already report a newer head than the historical
    // page currently being replayed. Never make the UI cursor move backwards
    // while catch-up is applying that page.
    session: { ...snapshot.session, headSequence: Math.max(snapshot.session.headSequence, event.sequence) },
    pendingApprovals: snapshot.pendingApprovals.slice(),
  };
  const ensureTurn = (status: string, prompt?: string) => {
    if (!turnId) return;
    next.activeTurn = {
      id: turnId,
      status,
      prompt: prompt ?? (next.activeTurn?.id === turnId ? next.activeTurn.prompt : ""),
    };
  };

  if (event.type === "provider.session.init" && typeof payload.providerSessionId === "string") {
    next.session.providerSessionId = payload.providerSessionId;
  }
  switch (event.type) {
    case "user.message.created":
      ensureTurn("queued", typeof payload.text === "string" ? payload.text : undefined);
      next.session.activityState = "running";
      break;
    case "turn.requested":
      ensureTurn("queued");
      next.session.activityState = "running";
      break;
    case "turn.started":
      ensureTurn("running");
      next.session.activityState = "running";
      break;
    case "approval.requested": {
      ensureTurn("waiting_approval");
      next.session.activityState = "waiting_approval";
      const approval = approvalFromEvent(event);
      if (approval && !next.pendingApprovals.some((item) => item.approvalId === approval.approvalId)) {
        next.pendingApprovals.push(approval);
      }
      break;
    }
    case "approval.resolved": {
      const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : undefined;
      if (approvalId) next.pendingApprovals = next.pendingApprovals.filter((item) => item.approvalId !== approvalId);
      const pendingForTurn = items.some((item) => item.kind === "approval" && item.status === "pending" && (!turnId || item.content && isRecord(item.content) && item.content.turnId === turnId));
      ensureTurn(pendingForTurn ? "waiting_approval" : "running");
      next.session.activityState = pendingForTurn ? "waiting_approval" : "running";
      break;
    }
    case "approval.resolve.unavailable":
      ensureTurn("outcome_unknown");
      next.session.activityState = "outcome_unknown";
      break;
    case "session.recovery.required":
      ensureTurn("outcome_unknown");
      next.session.activityState = "outcome_unknown";
      break;
    case "turn.interrupt.requested":
      ensureTurn("interrupting");
      next.session.activityState = "interrupting";
      break;
    case "turn.interrupt.unavailable":
    case "host.event_persist_failed":
      ensureTurn("outcome_unknown");
      next.session.activityState = "outcome_unknown";
      break;
    case "turn.reconciled": {
      const outcome = isRecord(payload.outcome) ? payload.outcome : undefined;
      const outcomeStatus = outcome && typeof outcome.status === "string" ? outcome.status : undefined;
      if (outcomeStatus === "outcome_unknown") {
        ensureTurn("outcome_unknown");
        next.session.activityState = "outcome_unknown";
      } else if (outcomeStatus === "completed" || outcomeStatus === "failed" || outcomeStatus === "cancelled") {
        next.activeTurn = undefined;
        next.session.activityState = "idle";
        next.pendingApprovals = next.pendingApprovals.filter((item) => item.request.turnId !== turnId);
      }
      break;
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled":
      next.activeTurn = undefined;
      next.session.activityState = "idle";
      next.pendingApprovals = next.pendingApprovals.filter((item) => item.request.turnId !== turnId);
      break;
    default:
      break;
  }
  return next;
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => undefined) as JsonRecord | undefined;
  if (!response.ok) {
    const message = body && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [status, setStatus] = useState("连接中");
  const [prompt, setPrompt] = useState("");
  const [pairingToken, setPairingToken] = useState("");
  const [error, setError] = useState("");
  const [diff, setDiff] = useState<{ branch?: string; head?: string; dirty: boolean; files: Array<{ path: string }>; diff: string; truncated: boolean; baselineWarning?: string } | null>(null);
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>());
  const lastSequenceRef = useRef(0);
  const itemsRef = useRef<TimelineItem[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const authenticatedRef = useRef(false);
  const connectingRef = useRef(false);
  const recoveringRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectRef = useRef<((reset: boolean) => Promise<void>) | null>(null);
  const lifecycleRef = useRef(0);

  const rejectPending = useCallback((cause: Error) => {
    for (const pending of pendingRef.current.values()) pending.reject(cause);
    pendingRef.current.clear();
  }, []);

  const applyEvent = useCallback((event: SessionEvent): boolean => {
    if (sessionIdRef.current && event.sessionId !== sessionIdRef.current) return false;
    const expected = lastSequenceRef.current + 1;
    if (event.sequence <= lastSequenceRef.current) return true;
    if (event.sequence !== expected) {
      setStatus("需要重新同步");
      setError(`Timeline sequence gap: expected ${expected}, got ${event.sequence}`);
      return false;
    }
    lastSequenceRef.current = event.sequence;
    const existing = itemsRef.current.find((item) => item.itemId === (isRecord(event.payload) && typeof event.payload.itemId === "string" ? event.payload.itemId : ""));
    const projected = timelineItemFromEvent(event, existing);
    if (projected) {
      const index = itemsRef.current.findIndex((item) => item.itemId === projected.itemId);
      const nextItems = index < 0
        ? [...itemsRef.current, projected]
        : itemsRef.current.map((item, itemIndex) => itemIndex === index ? projected : item);
      itemsRef.current = nextItems;
      setItems(nextItems);
    }
    setSnapshot((current) => projectSnapshot(current, event, itemsRef.current));
    return true;
  }, []);

  const request = useCallback((method: string, payload: unknown, write = false): Promise<any> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("WebSocket 未连接"));
    const id = crypto.randomUUID();
    const frame = { type: "request", id, method, payload, ...(write ? { commandId: commandId() } : {}) };
    return new Promise((resolve, reject) => {
      pendingRef.current.set(id, { resolve, reject });
      try { socket.send(JSON.stringify(frame)); }
      catch (cause) {
        pendingRef.current.delete(id);
        reject(cause);
        return;
      }
      window.setTimeout(() => {
        if (pendingRef.current.delete(id)) reject(new Error("请求超时"));
      }, 30_000);
    });
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback((immediate = false) => {
    if (!authenticatedRef.current || reconnectTimerRef.current !== null || connectingRef.current) return;
    const delay = immediate ? 0 : Math.min(5_000, 250 * (2 ** reconnectAttemptRef.current));
    reconnectAttemptRef.current = Math.min(reconnectAttemptRef.current + 1, 5);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void connectRef.current?.(false);
    }, delay);
  }, []);

  const catchUp = useCallback(async (sessionId: string, reset: boolean): Promise<number> => {
    if (reset) {
      lastSequenceRef.current = 0;
      itemsRef.current = [];
      setItems([]);
    }
    let cursor = lastSequenceRef.current;
    const snapshotResponse = await fetchJson<Snapshot>("/api/snapshot", { cache: "no-store" });
    if (snapshotResponse.session.id !== sessionId) throw new Error("Session changed while reconnecting");
    const upper = snapshotResponse.session.headSequence;
    if (cursor > upper) {
      // A host/database replacement can only be reconciled by a complete
      // replay. Never silently move the cursor backwards with old items.
      lastSequenceRef.current = 0;
      itemsRef.current = [];
      setItems([]);
      cursor = 0;
    }
    let pageCursor = cursor;
    while (true) {
      const query = new URLSearchParams({ after: String(pageCursor), limit: "200", upTo: String(upper) });
      const page = await fetchJson<TimelinePage>(`/api/session/${encodeURIComponent(sessionId)}/timeline?${query.toString()}`, { cache: "no-store" });
      if (page.upTo !== upper) throw new Error("Timeline upper bound changed during catch-up");
      for (const event of page.events) {
        if (!applyEvent(event)) throw new Error("Timeline sequence gap during catch-up");
      }
      if (!page.hasMore) break;
      // `lastSequenceRef` is also advanced by the live socket.  During a
      // reconnect, a queued event may therefore move it beyond this HTTP
      // page while the page itself is still valid. Paginate by the server's
      // authoritative cursor, not by that shared live cursor, and let
      // applyEvent deduplicate any overlap.
      if (page.nextAfter === undefined || page.nextAfter <= pageCursor) throw new Error("Timeline pagination did not advance");
      pageCursor = page.nextAfter;
    }
    return pageCursor;
  }, [applyEvent]);

  const connect = useCallback(async (reset: boolean) => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    clearReconnectTimer();
    const oldSocket = socketRef.current;
    socketRef.current = null;
    if (oldSocket) {
      try { oldSocket.close(1000, "reconnect"); } catch { /* already closed */ }
      rejectPending(new Error("WebSocket reconnecting"));
    }
    setStatus("同步中");
    try {
      const boot = await fetchJson<Bootstrap & { pairingRequired?: boolean }>("/api/bootstrap", { cache: "no-store" });
      setBootstrap(boot);
      if (boot.pairingRequired) {
        // A lost/expired browser cookie is an authentication boundary, not a
        // transient WebSocket failure. Stop the reconnect loop and let the
        // pairing screen ask for a fresh one-time grant.
        authenticatedRef.current = false;
        const token = pairingToken || new URLSearchParams(window.location.search).get("pairing") || window.location.hash.slice(1);
        if (!token) throw new Error("请输入电脑终端显示的一次性配对 Token");
        const credential = await fetchJson<{ credential: string }>("/api/pairing/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        await fetchJson<{ ok: true }>("/api/auth/browser-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential: credential.credential }),
        });
        window.history.replaceState({}, "", window.location.pathname);
      }
      const snap = await fetchJson<Snapshot>("/api/snapshot", { cache: "no-store" });
      authenticatedRef.current = true;
      sessionIdRef.current = snap.session.id;
      setSnapshot(snap);
      const cursor = await catchUp(snap.session.id, reset);
      try {
        const hostStatusResponse = await fetch("/api/status", { cache: "no-store" });
        if (hostStatusResponse.ok) setHostStatus(await hostStatusResponse.json() as HostStatus);
      } catch { /* diagnostics are optional; the session stream remains usable */ }
      const ticketResponse = await fetchJson<{ ticket: string }>("/api/auth/websocket-ticket", { method: "POST" });
      const url = new URL("/api/ws", window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      url.search = new URLSearchParams({ ticket: ticketResponse.ticket }).toString();
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        if (socket !== socketRef.current) return;
        reconnectAttemptRef.current = 0;
        setStatus("实时连接，补同步中");
        void request("session.subscribe", { sessionId: snap.session.id, afterSequence: cursor })
          .then(() => {
            if (socket === socketRef.current) {
              recoveringRef.current = false;
              setError("");
              setStatus("已同步");
            }
          })
          .catch((cause) => {
            if (socket === socketRef.current) {
              setError(cause instanceof Error ? cause.message : String(cause));
              try { socket.close(); } catch { /* no-op */ }
            }
          });
      };
      socket.onmessage = (message) => {
        if (socket !== socketRef.current) return;
        let frame: Frame;
        try { frame = JSON.parse(message.data as string) as Frame; }
        catch (cause) {
          setError(`无效的 Host 消息：${cause instanceof Error ? cause.message : String(cause)}`);
          return;
        }
        if (frame.type === "response") {
          const pending = pendingRef.current.get(frame.id);
          if (!pending) return;
          pendingRef.current.delete(frame.id);
          if (frame.ok) pending.resolve(frame.payload);
          else {
            setError(frame.error.message);
            pending.reject(new Error(frame.error.message));
          }
          return;
        }
        if (frame.type === "event") {
          if (sessionIdRef.current && frame.event.sessionId !== sessionIdRef.current) {
            setError("Host returned an event for an unexpected Session");
            return;
          }
          if (!applyEvent(frame.event)) {
            recoveringRef.current = true;
            try { socket.close(1013, "RESYNC_REQUIRED"); } catch { /* no-op */ }
            scheduleReconnect(true);
            return;
          }
          setSnapshot((current) => current ? { ...current, session: { ...current.session, headSequence: Math.max(current.session.headSequence, frame.event.sequence) } } : current);
        }
      };
      socket.onerror = () => {
        if (socket === socketRef.current) setStatus("连接异常，准备重连");
      };
      socket.onclose = () => {
        if (socket !== socketRef.current) return;
        socketRef.current = null;
        rejectPending(new Error("WebSocket 已断开"));
        setStatus("已断开，自动恢复中");
        scheduleReconnect();
      };
    } catch (cause) {
      setStatus(authenticatedRef.current ? "恢复失败，自动重试" : "未配对");
      setError(cause instanceof Error ? cause.message : String(cause));
      if (authenticatedRef.current) scheduleReconnect();
      else {
        sessionIdRef.current = null;
        lastSequenceRef.current = 0;
        itemsRef.current = [];
        setItems([]);
        setSnapshot(null);
      }
    } finally {
      connectingRef.current = false;
    }
  }, [catchUp, clearReconnectTimer, pairingToken, rejectPending, request, scheduleReconnect]);

  connectRef.current = connect;

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    void connect(true);
    const handleOnline = () => void connectRef.current?.(false);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("online", handleOnline);
      // React StrictMode mounts, cleans up, and mounts once more in
      // development. Defer teardown one macrotask so that the synthetic
      // cleanup cannot kill the second mount's connection.
      window.setTimeout(() => {
        if (lifecycleRef.current !== lifecycle) return;
        clearReconnectTimer();
        const socket = socketRef.current;
        socketRef.current = null;
        if (socket) {
          try { socket.close(1000, "page closing"); } catch { /* no-op */ }
        }
        rejectPending(new Error("页面已关闭"));
      }, 0);
    };
  // Deliberately mount once. `connect` closes over the pairing input, so using
  // it as an effect dependency would tear down the live socket on every token
  // keystroke. Pairing/reconnect buttons use the current callback directly.
  }, []);

  const sendPrompt = async () => {
    const value = prompt.trim();
    if (!value) return;
    setPrompt("");
    try {
      const response = await request("session.startTurn", { prompt: value }, true) as { turnId?: string };
      if (response.turnId) {
        setSnapshot((current) => current ? {
          ...current,
          session: { ...current.session, activityState: "running" },
          activeTurn: { id: response.turnId!, status: "queued", prompt: value },
        } : current);
        // A very fast no-tool Turn can reach terminal state before the RPC
        // response is delivered. Do not let that late accepted response
        // resurrect an already-closed activeTurn in the UI.
        if (hasTerminalItem(itemsRef.current, response.turnId)) {
          setSnapshot((current) => current && current.activeTurn?.id === response.turnId
            ? { ...current, activeTurn: undefined, session: { ...current.session, activityState: "idle" } }
            : current);
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const interrupt = async () => {
    try { await request("session.interrupt", {}, true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const logout = async () => {
    try {
      await fetchJson<{ ok: true }>("/api/auth/logout", { method: "POST" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      try { socket.close(1000, "logout"); } catch { /* no-op */ }
    }
    authenticatedRef.current = false;
    sessionIdRef.current = null;
    lastSequenceRef.current = 0;
    itemsRef.current = [];
    setItems([]);
    setSnapshot(null);
    setHostStatus(null);
    setDiff(null);
    setError("");
    setStatus("未配对");
  };

  const approval = async (approvalId: string, action: "allow_once" | "deny") => {
    if (status !== "已同步") return;
    try { await request("approval.respond", { approvalId, action }, true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const loadDiff = async () => {
    if (!snapshot) return;
    try {
      setDiff(await fetchJson(`/api/session/${encodeURIComponent(snapshot.session.id)}/diff`, { cache: "no-store" }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const approvalItems = useMemo(() => items.filter((item) => item.kind === "approval" && item.status === "pending"), [items]);
  const interactionReady = status === "已同步";
  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow">FLYX / CLAUDE MVP</span><h1>远程执行台</h1></div><div className="topbar-actions"><span className={`connection ${status.includes("断") || status.includes("失败") ? "offline" : ""}`}>{status}</span>{snapshot && <button className="ghost" onClick={() => void logout()}>退出配对</button>}</div></header>
    {!snapshot && <section className="card pairing"><h2>连接电脑 Host</h2><p>把 Host 终端显示的一次性 Token 粘贴到这里。Token 只使用一次，浏览器会保存 HttpOnly 会话。</p><input value={pairingToken} onChange={(event) => setPairingToken(event.target.value)} placeholder="配对 Token" /><button onClick={() => void connect(true)}>配对并连接</button>{error && <p className="error">{error}</p>}</section>}
    {snapshot && <>
      <section className="status-grid"><div className="card"><span className="label">工作区</span><strong>{bootstrap ? "Claude / default" : "加载中"}</strong><small>{hostStatus?.git.branch ?? snapshot.session.activityState}{hostStatus?.git.dirty ? " · dirty" : ""}</small></div><div className="card"><span className="label">Claude</span><strong>{hostStatus?.provider.claudeVersion ?? "检查中"}</strong><small>{hostStatus?.provider.sdkVersion ?? "SDK"}</small></div><div className="card"><span className="label">待审批</span><strong>{approvalItems.length}</strong><small>{snapshot.session.headSequence > 0 ? "可继续对话" : "新会话"}</small></div></section>
      <section className="timeline card"><div className="section-head"><h2>执行 Timeline</h2><div className="section-actions"><button className="ghost" onClick={() => void loadDiff()}>查看 Diff</button><button className="ghost" onClick={() => window.location.reload()}>刷新恢复</button></div></div>{items.length === 0 && <p className="muted">等待 Claude 事件…</p>}{items.map((item) => <TimelineCard key={item.itemId} item={item} onApproval={approval} disabled={!interactionReady} />)}</section>
      {diff && <section className="diff card"><div className="section-head"><h2>Workspace Diff</h2><span className="item-status">{diff.dirty ? "有变更" : "clean"}</span></div><p className="muted">{diff.branch ?? "unknown"}{diff.head ? ` · ${diff.head.slice(0, 8)}` : ""} · {diff.files.length} files</p>{diff.baselineWarning && <p className="error">{diff.baselineWarning}</p>}{diff.files.length > 0 && <ul className="file-list">{diff.files.map((file) => <li key={file.path}>{file.path}</li>)}</ul>}<pre>{diff.diff || "没有未提交变更"}{diff.truncated ? "\n\n[已截断]" : ""}</pre></section>}
      <section className="composer card"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="让 Claude 修改 fixture、运行测试，或继续上一个任务…" disabled={!interactionReady || snapshot.session.activityState !== "idle"} /><div className="composer-actions"><button className="primary" onClick={() => void sendPrompt()} disabled={!interactionReady || !prompt.trim() || snapshot.session.activityState !== "idle"}>发送任务</button><button className="danger" onClick={() => void interrupt()} disabled={!interactionReady || !snapshot.activeTurn || snapshot.session.activityState === "outcome_unknown"}>中止当前 Turn</button></div></section>
      {error && <p className="error">{error}</p>}
    </>}
  </main>;
}

function TimelineCard({ item, onApproval, disabled = false }: { item: TimelineItem; onApproval: (id: string, action: "allow_once" | "deny") => void; disabled?: boolean }) {
  const content = isRecord(item.content) ? item.content : { value: item.content };
  const title = item.kind === "assistant_message" ? "Claude" : item.kind === "tool_call" ? String(content.toolName ?? "Tool") : item.kind === "approval" ? `需要批准：${String(content.toolName ?? "Tool")}` : item.kind === "user_message" ? "你" : item.kind === "error" ? "错误" : "系统";
  const body = content.text ?? content.message ?? content.output ?? content.error ?? content.value ?? JSON.stringify(content, null, 2);
  return <article className={`timeline-item ${item.kind} ${item.status}`}><div className="item-title"><span>{title}</span><span className="item-status">{item.status}</span></div><pre>{typeof body === "string" ? body : JSON.stringify(body, null, 2)}</pre>{item.kind === "approval" && item.status === "pending" && typeof content.approvalId === "string" && <div className="approval-actions"><button className="primary" onClick={() => onApproval(content.approvalId as string, "allow_once")}>允许一次</button><button className="danger" onClick={() => onApproval(content.approvalId as string, "deny")}>拒绝</button></div>}</article>;
}
