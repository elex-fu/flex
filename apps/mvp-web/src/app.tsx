import { useEffect, useMemo, useRef, useState } from "react";
import type { PendingCommand } from "@flyx/client-core";
import type { TimelineItem } from "@flyx/mvp-protocol";
import { InteractionCard } from "./components/interaction-card.js";
import { CorePanels } from "./components/core-panels.js";
import { canSendSavedCommand, needsCommandReview } from "./command-review.js";
import { isRecord } from "./timeline.js";
import { getWebHostRuntimes, type WebHostRuntimes } from "./host-runtimes.js";
import { useHost, type DeviceList } from "./use-host.js";
import type { WebLoadState } from "./selection-loader.js";

function shortFingerprint(value:string):string { return value.replace(/^sha256:/,"").slice(0,24).match(/.{1,4}/g)?.join(" ") ?? value; }
function commandLabel(method:string):string { return ({"session.startTurn":"发送任务","session.interrupt":"中止 Turn","approval.respond":"审批","interaction.respondApproval":"审批","question.respond":"回答问题"} as Record<string,string>)[method] ?? (method.startsWith("access.") ? "设备授权操作" : method); }
function commandState(command:PendingCommand):string {
  if (command.outcomeUnknown) return "执行结果未知";
  return ({queued:"已保存，尚未派发",sent:"等待 Host 回执",receipt_unknown:"回执待核对",accepted:"Host 已受理，等待终态",terminal:"命令已结束"} as const)[command.state];
}
export function App({initialPairing,runtimes = getWebHostRuntimes()}:{initialPairing?:string | undefined;runtimes?:WebHostRuntimes}) {
  const host = useHost(runtimes);
  const {bootstrap,snapshot,items,hostStatus,status,connection,ready} = host;
  const [pairingInput,setPairingInput] = useState(""), [deviceName,setDeviceName] = useState("Flyx 浏览器"), [pairingBusy,setPairingBusy] = useState(false);
  const [qrAvailable,setQrAvailable] = useState(true), [devices,setDevices] = useState<DeviceList | null>(null), [devicesBusy,setDevicesBusy] = useState(false);
  const [confirmRevokeAll,setConfirmRevokeAll] = useState(false), [confirmForget,setConfirmForget] = useState(false), [accessNotice,setAccessNotice] = useState("");
  const deviceOperationRef = useRef(0);
  const profile = connection.profile;
  const currentDevice = devices?.devices.find((device) => device.id === devices.currentDeviceId);
  const canAdmin = currentDevice?.scopes.includes("access:admin") ?? false;
  const relayIntent = connection.transportKind === "relay" || profile?.endpoints.some((endpoint) => endpoint.kind === "relay-wss") || /(?:#|&)offer=/.test(initialPairing ?? "") || /(?:#|&)offer=/.test(pairingInput);
  const approvalItems = useMemo(() => items.filter((item) => item.kind === "approval" && item.status === "pending"),[items]);
  const reviewCommands = host.pendingCommands.filter(needsCommandReview);
  const visibleCommands = reviewCommands.slice(-40);
  const startTurnPending = reviewCommands.some((command) => command.method === "session.startTurn" && command.state !== "terminal" && (!isRecord(command.payload) || typeof command.payload.sessionId !== "string" || command.payload.sessionId === host.selectedSessionId));
  const provider = bootstrap?.provider ?? snapshot?.session.provider;
  const providerName = provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : "Provider";
  const hasView = Boolean(profile && (host.selectedSessionId || items.length > 0));
  const diff = host.diffState.value;
  const interactions = host.interactionState.value;
  const interactionsReady = ready && host.interactionState.status === "ready";
  const legacyApprovalReady = ready && snapshot?.session.activityState === "waiting_approval" && snapshot.activeTurn?.status === "waiting_approval";
  const workspaceLabel = profile?.label ?? "当前 Host";
  const forgetting = host.forgetState.status === "removing";
  const sessionCanCompose = snapshot?.session.status !== "archived" && !["blocked", "closing"].includes(snapshot?.session.residency ?? "");

  useEffect(() => { setDevices(null); setConfirmRevokeAll(false); setConfirmForget(false); setAccessNotice(""); deviceOperationRef.current++; setDevicesBusy(false); },[profile?.hostId]);
  const pair = async () => {
    const input = pairingInput.trim(); if (!input || pairingBusy) return;
    setPairingBusy(true);
    try { if (await host.pair(input,deviceName)) setPairingInput((current) => current.trim() === input ? "" : current); }
    finally { setPairingBusy(false); }
  };
  const loadDevices = async () => {
    const runtime = host.client, operation = ++deviceOperationRef.current;
    setDevicesBusy(true);
    try { const result = await host.run(() => runtime.request<DeviceList>("access.listDevices",{})); if (result && runtimes.getCurrent() === runtime && deviceOperationRef.current === operation) { if (!Array.isArray(result.devices)) throw new Error("设备目录以引用返回，尚未读取完整内容"); setDevices(result); } }
    catch (cause) { if (runtimes.getCurrent() === runtime && deviceOperationRef.current === operation) host.setError(cause instanceof Error ? cause.message : "设备目录读取失败"); }
    finally { if (runtimes.getCurrent() === runtime && deviceOperationRef.current === operation) setDevicesBusy(false); }
  };
  const revokeDevice = async (deviceId:string) => {
    const runtime = host.client, operation = ++deviceOperationRef.current;
    setDevicesBusy(true);
    try { const result = await host.run(() => runtime.revokeRemoteDevice(deviceId)); if (result && runtimes.getCurrent() === runtime && deviceOperationRef.current === operation) await loadDevices(); }
    finally { if (runtimes.getCurrent() === runtime && deviceOperationRef.current === operation) setDevicesBusy(false); }
  };
  const revokeAll = async () => {
    const runtime = host.client, operation = ++deviceOperationRef.current;
    setConfirmRevokeAll(false); setDevicesBusy(true);
    try { const result = await host.run(() => runtime.command<{revoked:number}>("access.revokeAll",{})); if (result && runtimes.getCurrent() === runtime && deviceOperationRef.current === operation && Number.isInteger(result.revoked)) { setDevices(null); setAccessNotice(`Host 已确认撤销 ${result.revoked} 个设备。本地记录仍保留。`); } }
    finally { if (runtimes.getCurrent() === runtime && deviceOperationRef.current === operation) setDevicesBusy(false); }
  };
  const legacyApproval = async (approvalId:string,action:"allow_once" | "deny") => { if (legacyApprovalReady && host.deviceScopes.includes("approval:write")) await host.run(() => host.client.command("approval.respond",{approvalId,action})); };

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow">FLYX / {providerName.toUpperCase()}</span><h1>远程执行台</h1></div><div className="topbar-actions"><span role="status" className={`connection ${!ready ? "offline" : ""}`}>{status}</span>{profile && <button className="ghost" disabled={forgetting} onClick={() => setConfirmForget(true)}>移除本地 Host</button>}</div></header>
    {host.forgetState.status === "removed" && <p role="status">已移除本地 {host.forgetState.label} 的应用记录、草稿和缓存，并停止自动连接。电脑上的设备授权未因此撤销。</p>}
    {host.forgetState.status === "failed" && <p role="alert" className="error">本地移除失败：{host.forgetState.error}</p>}
    {confirmForget && profile && <section className="card"><h2>移除本地 {profile.label}</h2><p>会删除应用保存的 Host 资料、应用凭据、草稿、命令和缓存，并停止自动连接。此操作离线可用；电脑端授权仍需另行撤销。</p>{connection.securityLevel === "http-only-cookie" && <p>同源 HttpOnly 会话 Cookie 仍由 Host 管理。要取消电脑端授权，请单独撤销本设备授权。</p>}<div className="section-actions"><button className="danger" disabled={forgetting} onClick={() => {setConfirmForget(false);void host.forgetLocalHost();}}>{forgetting ? "删除中…" : "确认移除本地记录"}</button><button className="ghost" onClick={() => setConfirmForget(false)}>取消</button></div></section>}
    {host.profiles.length > 0 && (host.profiles.length > 1 || !profile) && <section className="card"><label className="field-label">已配对 Host<select value={profile?.hostId ?? ""} onChange={(event) => void host.selectHost(event.target.value)}>{!profile && <option value="">选择 Host</option>}{host.profiles.map((saved) => <option key={saved.hostId} value={saved.hostId}>{saved.label}</option>)}</select></label></section>}
    {(!hasView || connection.pairingRequired) && <section className="card pairing">
      <h2>连接电脑 Host</h2><p>扫描电脑终端上的二维码，或粘贴一次性 Token、配对链接。配对前请与电脑核对 Host 指纹。</p>
      {!relayIntent && <div className="pairing-qr"><div className="qr-canvas" data-testid="pairing-qr">{qrAvailable ? <img src="/api/pairing/qrcode" alt="扫码配对二维码" onError={() => setQrAvailable(false)}/> : <span className="qr-unavailable">二维码暂不可用<em>请使用下方 Token 或配对链接</em></span>}</div></div>}
      {profile && <div className="pairing-identity"><span className="label">Host 指纹</span><code data-testid="pairing-fingerprint">{shortFingerprint(profile.fingerprint)}</code><small>{profile.label}</small></div>}
      <label className="field-label" htmlFor="device-name">本设备名称</label><input id="device-name" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} autoComplete="off"/>
      <label className="field-label" htmlFor="pairing-token">一次性配对凭证</label><input id="pairing-token" type="password" value={pairingInput} onChange={(event) => setPairingInput(event.target.value)} placeholder="配对 Token" autoComplete="off" autoCapitalize="none" spellCheck={false}/>
      <button onClick={() => void pair()} disabled={pairingBusy || !pairingInput.trim()}>{pairingBusy ? "配对中…" : "配对并连接"}</button><p className="pairing-note">Relay 配对通过端到端加密发送；电脑端确认后生效。请勿将配对链接发给他人。</p>
    </section>}
    {profile && <details className="connection-details card"><summary><span>连接与设备</span><span className="muted">{connection.transportKind === "relay" ? "Relay · 端到端加密" : "Direct / Tailscale"} · {status}</span></summary><div className="connection-content">
      <div className="identity-details"><span className="label">已固定 Host 身份</span><strong>{profile.label}</strong><code data-testid="host-fingerprint" title={profile.fingerprint}>{shortFingerprint(profile.fingerprint)}</code><small>切换路径时验证同一指纹。指纹变化需重新配对。</small></div>
      <ul className="endpoint-list" aria-label="连接路径">{profile.endpoints.map((endpoint) => { const current = endpoint.id === connection.endpointId; const url = endpoint.kind === "relay-wss" ? endpoint.relayUrl : endpoint.baseUrl; const kind = endpoint.kind === "relay-wss" ? "Relay" : endpoint.source === "tailscale" ? "Tailscale" : "Direct"; return <li key={endpoint.id} className={current ? "endpoint active" : "endpoint"}><div><strong>{kind}{current ? " · 当前路径" : ""}</strong><span className="endpoint-url">{url}</span><small>{endpoint.availability === "available" ? "可用" : endpoint.availability === "unavailable" ? "不可达" : "待检测"}</small></div><button className="ghost" disabled={current} onClick={() => void host.run(() => host.client.preferEndpoint(endpoint.id))}>使用此路径</button></li>; })}</ul>
      <p className="security-note" data-testid="security-level">{connection.securityLevel === "http-only-cookie" ? "设备保护：HttpOnly 浏览器会话。凭据不能由页面脚本直接读取。" : "设备保护：浏览器短期凭据，设备密钥仅驻留内存。"}{connection.transportKind === "relay" ? " Relay 可见连接元数据，不能读取任务和代码内容。" : ""}</p>
      <div className="section-actions"><button className="ghost" onClick={() => void loadDevices()} disabled={!host.online || devicesBusy}>{devicesBusy ? "读取中…" : "管理设备"}</button><button className="ghost" onClick={() => host.client.reconnect()}>重新连接</button><button className="danger" disabled={!ready || host.remoteRevokeState.status === "sending"} onClick={() => void host.revokeRemoteSelf()}>{host.remoteRevokeState.status === "sending" ? "撤销中…" : "撤销本设备授权"}</button></div>
      {host.remoteRevokeState.status === "acknowledged" && <p role="status">Host 已确认撤销本设备授权。本地草稿和缓存仍保留。</p>}{host.remoteRevokeState.status === "unknown" && <p className="error" role="alert">未收到授权撤销确认：{host.remoteRevokeState.error}。请在 Host 或重新配对后核对授权状态。</p>}{accessNotice && <p role="status">{accessNotice}</p>}
      {devices && <section className="devices" aria-label="已配对设备"><h3>已配对设备</h3><ul className="device-list">{devices.devices.map((device) => <li key={device.id}><div><strong>{device.displayName || device.platform || "浏览器设备"}{device.id === devices.currentDeviceId ? " · 本设备" : ""}</strong><small>{device.revokedAt ? "已撤销" : "有效"} · {device.credentialKind === "browser-session" ? "浏览器会话" : device.credentialKind}</small></div>{!device.revokedAt && (device.id === devices.currentDeviceId || canAdmin) && <button className="danger" disabled={!ready || devicesBusy} onClick={() => device.id === devices.currentDeviceId ? void host.revokeRemoteSelf() : void revokeDevice(device.id)}>{device.id === devices.currentDeviceId ? "撤销本设备授权" : "撤销设备授权"}</button>}</li>)}</ul>{canAdmin && <div className="revoke-all">{confirmRevokeAll ? <><p>所有设备（包括本设备）会断开，之后需在电脑端重新配对。</p><div className="section-actions"><button className="danger" disabled={!ready || devicesBusy} onClick={() => void revokeAll()}>确认撤销所有设备</button><button className="ghost" onClick={() => setConfirmRevokeAll(false)}>取消</button></div></> : <button className="ghost" disabled={!ready || devicesBusy} onClick={() => setConfirmRevokeAll(true)}>撤销所有设备授权</button>}</div>}</section>}
    </div></details>}
    {visibleCommands.length > 0 && <section className="outbox card" aria-label="命令回执核对"><h2>命令回执核对</h2><p className="muted">核对只读取 Host 回执。结果未知的命令不会重新发送。{reviewCommands.length > visibleCommands.length ? ` 显示最近 ${visibleCommands.length} 条。` : ""}</p>{visibleCommands.map((command) => <div className="pending-command" key={command.commandId}><div><strong>{commandLabel(command.method)}</strong><small>{commandState(command)}{command.error ? ` · ${command.error.message}` : ""}</small></div><button className="ghost" disabled={!host.online} onClick={() => void host.queryCommandReceipt(command.commandId)}>核对 Host 回执</button>{canSendSavedCommand(command) && <button className="ghost" disabled={!ready} onClick={() => void host.sendSavedCommand(command.commandId)}>发送已保存命令</button>}</div>)}</section>}
    {profile && !connection.pairingRequired && <CorePanels host={host} />}
    {hasView && <>
      {snapshot?.session.activityState === "outcome_unknown" && <p className="error" role="status">执行状态需要 Host 恢复核对。草稿可以继续编辑；核对完成前不能发起新任务。</p>}
      {host.readOnly && <p className="error" role="status">当前视图只读，正在等待已验证的 Host 同步。草稿可在本地编辑；同步完成后才能发送。</p>}
      {host.cacheError && <p className="error" role="status">本地缓存不可用：{host.cacheError}。连接仍会继续同步。</p>}
      <section className="status-grid"><div className="card"><span className="label">Session</span><strong>{snapshot?.session.title || host.sessions.find((session) => session.id === host.selectedSessionId)?.title || "当前会话"}</strong><small>{hostStatus?.git?.branch ?? snapshot?.session.activityState ?? "缓存视图"}</small></div><div className="card"><span className="label">{providerName}</span><strong>{hostStatus?.provider?.runtimeVersion ?? "等待 Host 验证"}</strong><small>{hostStatus?.provider?.transport ?? ""}</small></div><div className="card"><span className="label">待交互</span><strong>{interactions?.interactions.filter((item) => item.status === "pending").length ?? approvalItems.length}</strong><small>{host.selectedSessionId}</small></div></section>
      {host.typedInteractionsAvailable && <section className="card"><div className="section-head"><h2>问题与审批</h2><button className="ghost" disabled={!ready || host.interactionState.status === "loading"} onClick={() => void host.refreshInteractions()}>{host.interactionState.status === "loading" ? "核对中…" : "刷新当前请求"}</button></div>{host.interactionState.error && <p role="alert" className="error">当前请求未核实：{host.interactionState.error}</p>}{interactions?.hasMore && <p className="muted">请求目录还有更多内容，当前仅显示这一页。</p>}{interactions?.interactions.map((interaction) => <InteractionCard key={interaction.interactionId} interaction={interaction} workspaceLabel={workspaceLabel} readiness={{online:host.online,synced:ready,authoritative:interactionsReady,approvalWrite:interactions.approvalWrite,sourceRevision:interactions.sourceRevision}} onApprove={host.onApprove} onAnswer={host.onAnswer}/>)}</section>}
      <section className="timeline card"><div className="section-head"><h2>执行 Timeline</h2><div className="section-actions"><button className="ghost" disabled={!ready || host.diffState.status === "loading"} onClick={() => void host.loadDiff()}>查看 Diff</button><button className="ghost" disabled={!host.online} onClick={() => void host.run(() => host.client.retrySynchronization())}>重新核对视图</button></div></div>{items.length === 0 && <p className="muted">等待 {providerName} 事件…</p>}{items.map((item) => <TimelineCard key={item.itemId} item={item} providerName={providerName} onApproval={legacyApproval} legacy={!host.typedInteractionsAvailable && host.deviceScopes.includes("approval:write")} approvalDisabled={!legacyApprovalReady} disabled={!ready} loadState={host.itemLoads[`${host.replicaState?.replicaGeneration}:${item.itemId}:${item.revision}`]} onLoad={() => void host.loadItemContent(item.itemId)}/>)}</section>
      {host.diffState.status !== "idle" && <section className="diff card"><div className="section-head"><h2>Workspace Diff</h2><span className="item-status">{host.diffState.status === "loading" ? "读取中…" : diff?.dirty === undefined ? "元数据尚未读取" : diff.dirty ? "有变更" : "clean"}</span></div>{host.diffState.error && <p className="error" role="alert">{host.diffState.error}</p>}{diff && <><p className="muted">{diff.branch ?? "分支未读取"}{diff.head ? ` · ${diff.head.slice(0,8)}` : ""}{!diff.payloadRef ? ` · ${diff.files.length} files` : ""}</p>{diff.baselineWarning && <p className="error">{diff.baselineWarning}</p>}{diff.files.length > 0 && <ul className="file-list">{diff.files.slice(0,100).map((file) => <li key={file.path}>{file.path}</li>)}</ul>}{diff.files.length > 100 && <p className="muted">当前显示前 100 个文件，共 {diff.files.length} 个。</p>}{(diff.payloadRef || diff.diffRef) && <p className="muted">内容以引用返回，尚未读取完整数据。<button className="ghost" disabled={!ready || host.diffState.status === "loading"} onClick={() => void host.loadDiffReference()}>读取 {diff.payloadRef ? "Diff 数据" : "Diff 内容"}（{(diff.payloadRef ?? diff.diffRef)!.bytes} bytes）</button></p>}{diff.requiresUpgrade && <p className="error">Host 返回了截断摘要，当前协议无法读取剩余内容。</p>}{!diff.payloadRef && <pre>{diff.diff || (diff.bounded ? "当前只收到摘要" : "没有未提交变更")}{diff.truncated ? "\n\n[生成或传输时已截断]" : ""}{diff.bounded && !diff.diffLoaded ? "\n[当前为预览]" : ""}</pre>}</>}</section>}
      <section className="composer card"><textarea value={host.draft.text} onChange={(event) => host.drafts.edit(event.target.value)} placeholder={`让 ${providerName} 修改代码、运行测试，或继续上一个任务…`} disabled={!host.draft.key || forgetting} maxLength={16*1024}/><p className="muted" role="status">{host.draft.loading ? "正在读取本地草稿，新编辑会保留" : host.draft.saving ? "正在保存本地草稿…" : "草稿按 Host 和 Session 保存"}</p>{host.draft.error && <p className="error" role="alert">{host.draft.error}</p>}<div className="composer-actions"><button className="primary" onClick={() => void host.sendPrompt()} disabled={!ready || !sessionCanCompose || !host.deviceScopes.includes("session:write") || !host.draft.text.trim() || host.draft.submitting || snapshot?.session.activityState !== "idle" || Boolean(snapshot?.activeTurn) || startTurnPending}>发送任务</button><button className="danger" onClick={() => void host.interrupt()} disabled={!ready || !snapshot?.activeTurn || snapshot.session.activityState === "outcome_unknown"}>中止当前 Turn</button></div></section>
    </>}
    {host.error && <p className="error" role="alert">{host.error}</p>}
  </main>;
}
function TimelineCard({item,providerName,onApproval,legacy,disabled,approvalDisabled,loadState,onLoad}:{item:TimelineItem;providerName:string;onApproval:(id:string,action:"allow_once" | "deny")=>void;legacy:boolean;disabled:boolean;approvalDisabled:boolean;loadState?:WebLoadState<unknown> | undefined;onLoad:()=>void}) {
  const content = isRecord(item.content) ? item.content : {value:item.content};
  const title = item.kind === "assistant_message" ? providerName : item.kind === "tool_call" ? String(content.toolName ?? "Tool") : item.kind === "approval" ? `需要批准：${String(content.toolName ?? "Tool")}` : item.kind === "user_message" ? "你" : item.kind === "error" ? "错误" : content.projectionKind === "question" ? "问题" : "系统";
  const body = content.text ?? content.message ?? content.output ?? content.error ?? content.value ?? JSON.stringify(content,null,2);
  const toolInput = item.kind === "tool_call" ? content.input : undefined;
  const hasReference = (isRecord(content.contentRef) || isRecord(content.metadataRef)) && content.contentLoaded !== true;
  return <article data-item-id={item.itemId} className={`timeline-item ${item.kind} ${item.status}`}><div className="item-title"><span>{title}</span><span className="item-status">{item.status}</span></div>{toolInput !== undefined && <pre aria-label="工具输入">{typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput,null,2)}</pre>}<pre>{typeof body === "string" ? body : JSON.stringify(body,null,2)}</pre>{hasReference && <div><button className="ghost" disabled={disabled || loadState?.status === "loading"} onClick={onLoad}>{loadState?.status === "loading" ? "加载内容中…" : loadState?.status === "error" ? "重新加载内容" : "按需加载内容"}</button>{loadState?.error && <p className="error" role="alert">{loadState.error}</p>}</div>}{legacy && item.kind === "approval" && item.status === "pending" && typeof content.approvalId === "string" && <div className="approval-actions"><button className="primary" disabled={disabled || approvalDisabled} onClick={() => onApproval(content.approvalId as string,"allow_once")}>允许一次</button><button className="danger" disabled={disabled || approvalDisabled} onClick={() => onApproval(content.approvalId as string,"deny")}>拒绝</button></div>}</article>;
}
