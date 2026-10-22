import { useCallback, useEffect, useRef, useState } from "react";
import { type ClientState, type HostProfile, type PendingCommand, type SessionReplicaState } from "@flyx/client-core";
import { INTERACTION_CAPABILITY, InteractionListResponseSchema, InteractionResponseSchema, InteractionSchema, type Bootstrap, type Interaction, type InteractionRespondApprovalRequest, type InteractionResponse, type QuestionRespondRequest, type SessionEvent, type TimelineItem } from "@flyx/mvp-protocol";
import { canonicalTimelineItem } from "./canonical-timeline.js";
import { WebDraftController } from "./draft-controller.js";
import { getWebHostRuntimes, type WebHostRuntimes } from "./host-runtimes.js";
import { WebSelectionFence, SelectedWebLoader, type WebLoadState } from "./selection-loader.js";
import { loadWebSessionPage, normalizeWebSnapshot, WEB_SESSION_CATALOG_CAPABILITY, type WebSessionChoice } from "./session-catalog.js";
import { expandWorkspaceDiff, parseWorkspaceDiff, type WebWorkspaceDiff } from "./workspace-diff.js";
import { currentApprovalWrite } from "./device-rights.js";
import { canSendSavedCommand } from "./command-review.js";
import { isRecord, projectSnapshot, timelineItemFromEvent, type Snapshot } from "./timeline.js";

export type HostStatus = { provider: { provider: Bootstrap["provider"]; transport: string; adapterVersion: string; executable: string; runtimeVersion: string; workspace: string; sandboxRequired: boolean }; git: { branch?: string; dirty: boolean; files: Array<{path:string}> } };
export type Device = { id: string; hostId: string; displayName?: string; platform: string; credentialKind: string; scopes: string[]; createdAt: string; lastSeenAt?: string; revokedAt?: string };
export type DeviceList = { devices: Device[]; currentDeviceId: string };
export type WorkspaceDiff = WebWorkspaceDiff;
type InteractionView = { interactions: Interaction[]; hasMore: boolean; sourceRevision: number; approvalWrite: boolean };
type LocalForgetState = { status: "idle" | "removing" | "removed" | "failed"; label?: string; error?: string };
type RemoteRevokeState = { status: "idle" | "sending" | "acknowledged" | "unknown"; error?: string };
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : "操作失败，请检查连接后重试"; }
export function connectionLabel(state: ClientState): string {
  if (state.error?.code === "DEVICE_REVOKED" || state.error?.code === "REVOKED") return "设备已撤销";
  if (state.pairingRequired) return "未配对";
  if (state.error?.code === "IDENTITY_MISMATCH" || state.error?.code === "HOST_KEY_MISMATCH") return "Host 身份不匹配";
  if (state.connection === "online") return state.sync === "synced" ? "已同步" : "补同步中";
  if (state.connection === "authenticating") return "验证设备中";
  if (state.connection === "reconnecting" || state.connection === "degraded") return "已断开，自动恢复中";
  if (state.connection === "failed") return "连接失败";
  if (state.connection === "closed") return "连接已关闭";
  return "连接中";
}

/** Observer only. The application entry owns bootstrap and the desired Host. */
export function useHost(runtimes: WebHostRuntimes = getWebHostRuntimes()) {
  const [client, setClient] = useState(() => runtimes.getCurrent());
  const [connection, setConnection] = useState<ClientState>(() => client.getState());
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [pendingCommands, setPendingCommands] = useState<PendingCommand[]>([]);
  const [error, setError] = useState("");
  const [cacheError, setCacheError] = useState("");
  const [replicaState, setReplicaState] = useState<SessionReplicaState | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(() => client.replica.getState().sessionId);
  const [sessions, setSessions] = useState<WebSessionChoice[]>([]);
  const [nextSessionId,setNextSessionId] = useState<string | undefined>(undefined);
  const [deviceScopes, setDeviceScopes] = useState<string[]>([]);
  const [forgetState, setForgetState] = useState<LocalForgetState>({ status: "idle" });
  const [remoteRevokeState, setRemoteRevokeState] = useState<RemoteRevokeState>({ status: "idle" });
  const itemsRef = useRef<TimelineItem[]>([]), sessionIdRef = useRef<string | undefined>(selectedSessionId);
  const lifecycleRef = useRef(0), metadataGenerationRef = useRef<number | undefined>(undefined), replicaGenerationRef = useRef<number | undefined>(undefined);
  const resolvedContentRef = useRef(new Map<string, unknown>());
  const [fence] = useState(() => new WebSelectionFence());
  const [drafts] = useState(() => new WebDraftController());
  const [draft, setDraft] = useState(() => drafts.getState());
  const [diffLoader] = useState(() => new SelectedWebLoader<WebWorkspaceDiff>(fence));
  const [diffState, setDiffState] = useState<WebLoadState<WebWorkspaceDiff>>({ status: "idle" });
  const [interactionLoader] = useState(() => new SelectedWebLoader<InteractionView>(fence));
  const [interactionState, setInteractionState] = useState<WebLoadState<InteractionView>>({ status: "idle" });
  const itemLoadersRef = useRef(new Map<string, SelectedWebLoader<unknown>>());
  const [itemLoads, setItemLoads] = useState<Record<string, WebLoadState<unknown>>>({});
  const interactionSignatureRef = useRef(""), interactionRevisionRef = useRef(0);

  const resetProjection = useCallback(() => {
    fence.invalidate(); itemsRef.current = []; setItems([]); setSnapshot(null); setBootstrap(null); setHostStatus(null);
    resolvedContentRef.current.clear(); itemLoadersRef.current.clear(); setItemLoads({}); diffLoader.reset(); interactionLoader.reset(); interactionSignatureRef.current = "";
  }, [fence, diffLoader, interactionLoader]);
  const rememberSession = useCallback((sessionId: string) => {
    sessionIdRef.current = sessionId; setSelectedSessionId(sessionId);
    const profile = client.getState().profile;
    if (profile) { runtimes.rememberSession(profile.hostId, sessionId); fence.select({hostId:profile.hostId,sessionId,transportGeneration:client.getState().transportGeneration}); }
  }, [client, runtimes, fence]);
  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | undefined> => {
    const runtime = client; setError("");
    try { const result = await operation(); return runtimes.getCurrent() === runtime ? result : undefined; }
    catch (cause) { if (runtimes.getCurrent() === runtime) setError(errorMessage(cause)); return undefined; }
  }, [client, runtimes]);
  const refreshInteractions = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || client.getState().connection !== "online" || client.getProjectionMode() !== "canonical" || !client.getNegotiatedHello()?.capabilities.includes(INTERACTION_CAPABILITY)) return;
    return interactionLoader.load(async () => {
      const page = InteractionListResponseSchema.parse(await client.request("interaction.list", {sessionId}));
      // Each card receives a current authenticated DTO; summaries alone cannot enable responses.
      const [values,rights] = await Promise.all([
        Promise.all(page.interactions.map(async (item) => InteractionSchema.parse(await client.request("interaction.get", {sessionId,interactionId:item.interactionId})))),
        client.request("access.listDevices",{}).catch(() => undefined),
      ]);
      if (values.some((item) => item.sessionId !== sessionId)) throw new Error("INTERACTION_SESSION_MISMATCH");
      return {interactions:values,hasMore:page.hasMore,sourceRevision:++interactionRevisionRef.current,approvalWrite:currentApprovalWrite(rights,client.getState().profile?.hostId ?? "")};
    });
  }, [client, interactionLoader]);

  useEffect(() => drafts.observe(setDraft), [drafts]);
  useEffect(() => diffLoader.observe(setDiffState), [diffLoader]);
  useEffect(() => interactionLoader.observe(setInteractionState), [interactionLoader]);
  useEffect(() => runtimes.observeError(setError), [runtimes]);
  useEffect(() => runtimes.observe((runtime) => {
    setClient(runtime); setConnection(runtime.getState()); setReplicaState(null); setDeviceScopes([]); setSessions([]); setNextSessionId(undefined); setPendingCommands([]); setCacheError(""); setRemoteRevokeState({status:"idle"});
    metadataGenerationRef.current = undefined; replicaGenerationRef.current = undefined; resetProjection();
    const hostId = runtime.getState().profile?.hostId;
    const sessionId = runtime.replica.getState().sessionId ?? (hostId ? runtimes.sessionFor(hostId) : undefined);
    sessionIdRef.current = sessionId; setSelectedSessionId(sessionId);
  }), [runtimes, resetProjection]);
  useEffect(() => {
    const profile = connection.profile;
    if (!profile || !selectedSessionId) { fence.select(undefined); void drafts.select(undefined); return; }
    fence.select({hostId:profile.hostId,sessionId:selectedSessionId,transportGeneration:connection.transportGeneration});
    void drafts.select({hostId:profile.hostId,sessionId:selectedSessionId},client);
  }, [drafts, fence, client, connection.profile?.hostId, selectedSessionId]);

  useEffect(() => {
    const lifecycle = ++lifecycleRef.current;
    const active = () => lifecycleRef.current === lifecycle && runtimes.getCurrent() === client;
    const offState = client.onState((state) => {
      if (!active()) return;
      setConnection(state);
      if (state.profile && sessionIdRef.current) fence.select({hostId:state.profile.hostId,sessionId:sessionIdRef.current,transportGeneration:state.transportGeneration});
      if (state.pairingRequired) resetProjection();
      if (state.error) setError(state.error.message);
      if (state.connection !== "online" || state.sync !== "synced") return;
      setError("");
      if (metadataGenerationRef.current === state.transportGeneration) return;
      metadataGenerationRef.current = state.transportGeneration;
      const generation = state.transportGeneration;
      void Promise.allSettled([client.request<Bootstrap>("host.bootstrap", {}),client.request<HostStatus>("host.getStatus", {}),client.listProfiles(),client.request<DeviceList>("access.listDevices", {})]).then(([boot,status,saved,devices]) => {
        if (!active() || client.getState().transportGeneration !== generation) return;
        if (boot.status === "fulfilled") setBootstrap(boot.value);
        if (status.status === "fulfilled") setHostStatus(status.value);
        if (saved.status === "fulfilled") setProfiles(saved.value);
        if (devices.status === "fulfilled" && Array.isArray(devices.value.devices)) {
          const self = devices.value.devices.find((item) => item.id === devices.value.currentDeviceId && item.hostId === state.profile?.hostId && !item.revokedAt);
          setDeviceScopes(self?.scopes ?? []);
        }
        if (client.getNegotiatedHello()?.capabilities.includes(WEB_SESSION_CATALOG_CAPABILITY)) {
          void loadWebSessionPage((method,payload) => client.request(method,payload)).then((page) => { if (active() && client.getState().transportGeneration === generation) {setSessions(page.sessions);setNextSessionId(page.nextSessionId);} }).catch((cause:unknown) => { if (active()) setError(errorMessage(cause)); });
        }
      });
    });
    const offSnapshot = client.onSnapshot((value) => {
      if (!active() || client.getProjectionMode() !== "legacy") return;
      let next:Snapshot; try {next=normalizeWebSnapshot(value);} catch (cause) {setError(errorMessage(cause));return;}
      if (sessionIdRef.current && sessionIdRef.current !== next.session.id) resetProjection();
      rememberSession(next.session.id); setSnapshot(next);
    });
    const offReplica = client.onReplica((state) => {
      if (!active()) return;
      if (state.mode === "legacy") { if (replicaGenerationRef.current !== undefined) { resetProjection(); replicaGenerationRef.current = undefined; } return; }
      if (client.getProjectionMode() !== "canonical" && !(state.stale && state.epoch)) return;
      if (replicaGenerationRef.current !== state.replicaGeneration) { fence.invalidate(); resolvedContentRef.current.clear(); itemLoadersRef.current.clear(); setItemLoads({}); replicaGenerationRef.current = state.replicaGeneration; interactionSignatureRef.current = ""; }
      setReplicaState(state);
      if (state.sessionId) { if (sessionIdRef.current && sessionIdRef.current !== state.sessionId) resetProjection(); rememberSession(state.sessionId); }
      const nextItems = state.items.map((item) => canonicalTimelineItem(item,resolvedContentRef.current.get(`${state.replicaGeneration}:${item.itemId}:${item.revision}`)));
      itemsRef.current = nextItems; setItems(nextItems);
      if (isRecord(state.snapshot) && isRecord(state.snapshot.session)) {
        try { const normalized = normalizeWebSnapshot(state.snapshot); setSnapshot({...normalized,pendingApprovals:state.interactionsAuthoritative ? (state.interactions?.items ?? []) as Snapshot["pendingApprovals"] : []}); } catch (cause) { setSnapshot(null);setError(errorMessage(cause)); }
      }
      if (!state.stale && state.interactionsAuthoritative) {
        const entries = (state.interactions?.items ?? []).filter(isRecord).map((item) => [item.interactionId ?? item.approvalId,item.version,item.status,item.deliveryState,item.responseAvailable]);
        const facts = isRecord(state.snapshot) ? state.snapshot : {};
        const turn = isRecord(facts.activeTurn) ? facts.activeTurn : {};
        const interactionItems = state.items.filter((item) => item.kind === "question" || item.kind === "approval" || typeof item.metadata?.interactionId === "string").map((item) => [item.itemId,item.revision,item.status]);
        const signature = JSON.stringify([state.sessionId,state.transportGeneration,state.replicaGeneration,entries,interactionItems,turn.id,turn.status,turn.generation]);
        if (signature !== interactionSignatureRef.current) { interactionSignatureRef.current = signature; void refreshInteractions(); }
      }
    });
    const offEvent = client.onEvent((event: SessionEvent) => {
      if (!active() || client.getProjectionMode() !== "legacy" || sessionIdRef.current && event.sessionId !== sessionIdRef.current) return;
      const explicitId = isRecord(event.payload) && typeof event.payload.itemId === "string" ? event.payload.itemId : `event-${event.id}`;
      const existing = itemsRef.current.find((item) => item.itemId === explicitId), projected = timelineItemFromEvent(event,existing);
      if (projected) { const next = existing ? itemsRef.current.map((item) => item.itemId === projected.itemId ? projected : item) : [...itemsRef.current,projected]; itemsRef.current = next; setItems(next); }
      setSnapshot((current) => projectSnapshot(current,event,itemsRef.current));
    });
    const offReset = client.onReset(() => { if (active()) resetProjection(); });
    const offOutbox = client.onOutbox((commands) => { if (active()) setPendingCommands(commands); });
    const offCache = client.onCacheError((cause) => { if (active()) setCacheError(cause?.message ?? ""); });
    void client.listProfiles().then((saved) => { if (active()) setProfiles(saved); }).catch((cause:unknown) => { if (active()) setCacheError(errorMessage(cause)); });
    void client.listPendingCommands().then((commands) => { if (active()) setPendingCommands(commands); }).catch((cause:unknown) => { if (active()) setCacheError(errorMessage(cause)); });
    return () => { lifecycleRef.current++; offState(); offSnapshot(); offReplica(); offEvent(); offReset(); offOutbox(); offCache(); };
  }, [client,runtimes,fence,resetProjection,rememberSession,refreshInteractions]);

  const pair = useCallback(async (input:string,deviceName:string) => { try { await runtimes.pair(input.trim(),deviceName.trim() || "Flyx 浏览器"); return true; } catch { return false; } }, [runtimes]);
  const selectHost = useCallback(async (hostId:string) => { resetProjection(); try { await runtimes.setDesired(hostId); } catch (cause) { setError(errorMessage(cause)); } }, [resetProjection,runtimes]);
  const selectSession = useCallback((sessionId:string) => run(async () => {
    if (!client.getNegotiatedHello()?.capabilities.includes(WEB_SESSION_CATALOG_CAPABILITY)) throw new Error("SESSION_CATALOG_UNAVAILABLE");
    resetProjection(); rememberSession(sessionId); await client.selectSession(sessionId);
  }), [run,client,resetProjection,rememberSession]);
  const loadMoreSessions = useCallback(() => run(async () => {
    if (!nextSessionId || !client.getNegotiatedHello()?.capabilities.includes(WEB_SESSION_CATALOG_CAPABILITY)) return;
    const generation = client.getState().transportGeneration;
    const page = await loadWebSessionPage((method,payload) => client.request(method,payload),nextSessionId);
    if (runtimes.getCurrent() !== client || client.getState().transportGeneration !== generation) return;
    setSessions((current) => [...new Map([...current,...page.sessions].map((session) => [session.id,session])).values()]); setNextSessionId(page.nextSessionId);
  }), [run,client,runtimes,nextSessionId]);
  const sendPrompt = useCallback(() => run(() => drafts.submit(client.getNegotiatedHello()?.capabilities.includes(WEB_SESSION_CATALOG_CAPABILITY) ?? false)), [run,drafts,client]);
  const queryCommandReceipt = useCallback((commandId:string) => run(async () => {
    const sessionId = sessionIdRef.current, generation = client.getState().transportGeneration;
    const command = await client.queryCommandReceipt(commandId);
    if (runtimes.getCurrent() === client && sessionIdRef.current === sessionId && client.getState().transportGeneration === generation && /^(?:session\.(?:recovery\.|createNew|rename|archive|unarchive|closeRuntime)|checkpoint\.|worktree\.)/.test(command.method)) await client.retrySynchronization();
    return command;
  }), [client,run,runtimes]);
  const sendSavedCommand = useCallback((commandId:string) => run(async () => {
    const command = await client.store.getCommand(commandId);
    if (!command || command.hostId !== client.getState().profile?.hostId || !canSendSavedCommand(command)) throw new Error("SAVED_COMMAND_NOT_DISPATCHABLE");
    return client.retryCommand(commandId);
  }), [client,run]);
  const forgetLocalHost = useCallback(async () => {
    const profile = client.getState().profile;
    if (!profile) return;
    setForgetState({status:"removing",label:profile.label});
    try {
      await drafts.forgetHost(profile.hostId,() => runtimes.forgetLocalHost(profile.hostId));
      setForgetState({status:"removed",label:profile.label});
      const current = runtimes.getCurrent();
      void current.listProfiles().then((saved) => { if (runtimes.getCurrent() === current) setProfiles(saved); }).catch((cause:unknown) => { if (runtimes.getCurrent() === current) setCacheError(errorMessage(cause)); });
    }
    catch (cause) { setForgetState({status:"failed",label:profile.label,error:errorMessage(cause)}); }
  }, [client,runtimes,drafts]);
  const revokeRemoteSelf = useCallback(async () => {
    const runtime = client; setRemoteRevokeState({status:"sending"});
    try { const response = await client.revokeRemoteDevice(); if (!isRecord(response) || response.ok !== true) throw new Error("REVOKE_ACK_UNCONFIRMED"); if (runtimes.getCurrent() === runtime) setRemoteRevokeState({status:"acknowledged"}); }
    catch (cause) { if (runtimes.getCurrent() === runtime) setRemoteRevokeState({status:"unknown",error:errorMessage(cause)}); }
  }, [client,runtimes]);
  const loadItemContent = useCallback(async (itemId:string) => {
    const state = client.replica.getState(), item = state.items.find((entry) => entry.itemId === itemId);
    if (!item) return;
    const key = `${state.replicaGeneration}:${itemId}:${item.revision}`;
    let loader = itemLoadersRef.current.get(key);
    if (!loader) { loader = new SelectedWebLoader(fence); itemLoadersRef.current.set(key,loader); loader.observe((value) => setItemLoads((current) => ({...current,[key]:value}))); }
    const content = await loader.load(() => client.resolveItemContent(itemId));
    if (content === undefined || client.replica.getState().replicaGeneration !== state.replicaGeneration || client.replica.getState().items.find((entry) => entry.itemId === itemId)?.revision !== item.revision) return;
    resolvedContentRef.current.set(key,content);
    const next = itemsRef.current.map((entry) => entry.itemId === itemId && entry.revision === item.revision ? canonicalTimelineItem(item,content) : entry);
    itemsRef.current = next; setItems(next);
  }, [client,fence]);
  const loadDiff = useCallback(() => diffLoader.load(async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) throw new Error("SESSION_SELECTION_REQUIRED");
    return parseWorkspaceDiff(await client.request("session.getDiff",{sessionId}));
  }), [client,diffLoader]);
  const loadDiffReference = useCallback(() => diffLoader.load(async () => {
    const value = diffLoader.getState().value, sessionId = sessionIdRef.current;
    if (!value || !sessionId) throw new Error("DIFF_REFERENCE_UNAVAILABLE");
    return expandWorkspaceDiff(value,async (reference) => new TextDecoder("utf-8",{fatal:true}).decode(await client.readContent(reference,sessionId)));
  }), [client,diffLoader]);
  const interrupt = useCallback(() => run(() => client.command("session.interrupt",client.getNegotiatedHello()?.capabilities.includes(WEB_SESSION_CATALOG_CAPABILITY) && sessionIdRef.current ? {sessionId:sessionIdRef.current} : {})), [client,run]);
  const respondInteraction = useCallback(async (method:string,request:InteractionRespondApprovalRequest | QuestionRespondRequest): Promise<InteractionResponse> => {
    if (request.sessionId !== sessionIdRef.current) throw new Error("INTERACTION_SELECTION_CHANGED");
    const response = InteractionResponseSchema.parse(await client.command(method,request));
    if (response.interactionId !== request.interactionId) throw new Error("INTERACTION_RESPONSE_MISMATCH");
    void refreshInteractions(); return response;
  }, [client,refreshInteractions]);

  const typedInteractionsAvailable = client.getProjectionMode() === "canonical" && Boolean(client.getNegotiatedHello()?.capabilities.includes(INTERACTION_CAPABILITY));
  const online = connection.connection === "online";
  const ready = online && connection.sync === "synced" && Boolean(selectedSessionId) && (client.getProjectionMode() === "legacy" || replicaState?.interactionsAuthoritative === true && !replicaState.stale);
  return { client,connection,bootstrap,snapshot,items,hostStatus,profiles,pendingCommands,error,cacheError,replicaState,selectedSessionId,sessions,deviceScopes,draft,drafts,
    status:connectionLabel(connection),online,ready,readOnly:!ready,typedInteractionsAvailable,
    pair,selectHost,selectSession,loadMoreSessions,nextSessionId,sendPrompt,queryCommandReceipt,sendSavedCommand,forgetLocalHost,forgetState,revokeRemoteSelf,remoteRevokeState,interrupt,
    loadItemContent,itemLoads,diffState,loadDiff,loadDiffReference,interactionState,refreshInteractions,
    onApprove:(request:InteractionRespondApprovalRequest) => respondInteraction("interaction.respondApproval",request), onAnswer:(request:QuestionRespondRequest) => respondInteraction("question.respond",request), run,setError };
}
