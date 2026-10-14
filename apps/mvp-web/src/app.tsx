import { useEffect, useMemo, useState } from "react";
import type { TimelineItem } from "@flyx/mvp-protocol";
import { isRecord } from "./timeline.js";
import { useHost, type DeviceList, type WorkspaceDiff } from "./use-host.js";

function shortFingerprint(value: string): string {
  return value.replace(/^sha256:/, "").slice(0, 24).match(/.{1,4}/g)?.join(" ") ?? value;
}

function commandLabel(method: string): string {
  return ({ "session.startTurn": "发送任务", "session.interrupt": "中止 Turn", "approval.respond": "审批" } as Record<string, string>)[method] ?? (method.startsWith("access.") ? "设备授权操作" : method);
}

export function App({ initialPairing }: { initialPairing?: string | undefined }) {
  const host = useHost(initialPairing);
  const { bootstrap, snapshot, items, hostStatus, status, connection, ready } = host;
  const [prompt, setPrompt] = useState("");
  const [pairingInput, setPairingInput] = useState("");
  const [deviceName, setDeviceName] = useState("Flyx 浏览器");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [qrAvailable, setQrAvailable] = useState(true);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [devices, setDevices] = useState<DeviceList | null>(null);
  const [devicesBusy, setDevicesBusy] = useState(false);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const profile = connection.profile;
  const currentDevice = devices?.devices.find((device) => device.id === devices.currentDeviceId);
  const canAdmin = currentDevice?.scopes.includes("access:admin") ?? false;
  const relayIntent = connection.transportKind === "relay" || profile?.endpoints.some((endpoint) => endpoint.kind === "relay-wss") || /(?:#|&)offer=/.test(initialPairing ?? "") || /(?:#|&)offer=/.test(pairingInput);
  const approvalItems = useMemo(() => items.filter((item) => item.kind === "approval" && item.status === "pending"), [items]);
  const unresolvedCommands = host.pendingCommands.filter((command) => ["queued", "sent", "receipt_unknown"].includes(command.state));
  const provider = bootstrap?.provider ?? snapshot?.session.provider ?? "claude";
  const providerName = provider === "codex" ? "Codex" : "Claude";

  useEffect(() => { setDiff(null); setDevices(null); setConfirmRevokeAll(false); }, [profile?.hostId, snapshot?.session.id]);

  const pair = async () => {
    if (!pairingInput.trim() || pairingBusy) return;
    setPairingBusy(true);
    try { await host.pair(pairingInput, deviceName); }
    finally { setPairingBusy(false); setPairingInput(""); }
  };
  const sendPrompt = async () => {
    const value = prompt.trim();
    if (!value || !ready) return;
    setPrompt("");
    await host.sendPrompt(value);
  };
  const loadDevices = async () => {
    setDevicesBusy(true);
    try {
      const result = await host.run(() => host.client.request<DeviceList>("access.listDevices", {}));
      if (result) setDevices(result);
    } finally { setDevicesBusy(false); }
  };
  const revokeDevice = async (deviceId: string) => {
    setDevicesBusy(true);
    try {
      const result = await host.run(() => host.client.command("access.revokeDevice", { deviceId }));
      if (result) await loadDevices();
    } finally { setDevicesBusy(false); }
  };
  const revokeAll = async () => {
    setConfirmRevokeAll(false);
    setDevicesBusy(true);
    try {
      const result = await host.run(() => host.client.command<{ revoked: number }>("access.revokeAll", {}));
      if (result) await host.logout();
    } finally { setDevicesBusy(false); }
  };
  const approval = async (approvalId: string, action: "allow_once" | "deny") => {
    if (ready) await host.run(() => host.client.command("approval.respond", { approvalId, action }));
  };
  const loadDiff = async () => {
    if (!snapshot || !ready) return;
    const result = await host.run(() => host.client.request<WorkspaceDiff>("session.getDiff", { sessionId: snapshot.session.id }));
    if (result) setDiff(result);
  };

  return <main className="shell">
    <header className="topbar"><div><span className="eyebrow">FLYX / {providerName.toUpperCase()}</span><h1>远程执行台</h1></div><div className="topbar-actions"><span role="status" className={`connection ${!ready ? "offline" : ""}`}>{status}</span>{snapshot && <button className="ghost" onClick={() => void host.logout()}>退出配对</button>}</div></header>
    {!snapshot && <section className="card pairing">
      <h2>连接电脑 Host</h2><p>扫描电脑终端上的二维码，或粘贴一次性 Token、配对链接。二维码包含 Host 指纹，配对前请与电脑核对。</p>
      {!relayIntent && <div className="pairing-qr"><div className="qr-canvas" data-testid="pairing-qr">{qrAvailable ? <img src="/api/pairing/qrcode" alt="扫码配对二维码" onError={() => setQrAvailable(false)} /> : <span className="qr-unavailable">二维码暂不可用<em>请使用下方 Token 或配对链接</em></span>}</div></div>}
      {profile && <div className="pairing-identity"><span className="label">Host 指纹</span><code data-testid="pairing-fingerprint">{shortFingerprint(profile.fingerprint)}</code><small>{profile.label}</small></div>}
      <label className="field-label" htmlFor="device-name">本设备名称</label><input id="device-name" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={80} autoComplete="off" />
      <label className="field-label" htmlFor="pairing-token">一次性配对凭证</label><input id="pairing-token" type="password" value={pairingInput} onChange={(event) => setPairingInput(event.target.value)} placeholder="配对 Token" autoComplete="off" autoCapitalize="none" spellCheck={false} />
      <button onClick={() => void pair()} disabled={pairingBusy || !pairingInput.trim()}>{pairingBusy ? "配对中…" : "配对并连接"}</button>
      <p className="pairing-note">Relay 配对通过端到端加密发送；电脑端确认后生效。请勿将配对链接发给他人。</p>
      {host.error && <p className="error" role="alert">{host.error}</p>}
    </section>}
    {snapshot && <>
      <section className="status-grid"><div className="card"><span className="label">工作区</span><strong>{bootstrap ? `${providerName} / default` : "加载中"}</strong><small>{hostStatus?.git.branch ?? snapshot.session.activityState}{hostStatus?.git.dirty ? " · dirty" : ""}</small></div><div className="card"><span className="label">{providerName}</span><strong>{hostStatus?.provider.runtimeVersion ?? "检查中"}</strong><small>{hostStatus?.provider.transport ?? "Provider"}</small></div><div className="card"><span className="label">待审批</span><strong>{approvalItems.length}</strong><small>{snapshot.session.headSequence > 0 ? "可继续对话" : "新会话"}</small></div></section>
      <details className="connection-details card">
        <summary><span>连接与设备</span><span className="muted">{connection.transportKind === "relay" ? "Relay · 端到端加密" : "Direct / Tailscale"} · {status}</span></summary>
        <div className="connection-content">
          {host.profiles.length > 1 && <label className="field-label">已配对 Host<select value={profile?.hostId ?? ""} onChange={(event) => void host.selectHost(event.target.value)}>{host.profiles.map((saved) => <option key={saved.hostId} value={saved.hostId}>{saved.label}</option>)}</select></label>}
          {profile && <><div className="identity-details"><span className="label">已固定 Host 身份</span><strong>{profile.label}</strong><code data-testid="host-fingerprint" title={profile.fingerprint}>{shortFingerprint(profile.fingerprint)}</code><small>切换路径时验证同一指纹。指纹变化需重新配对。</small></div>
          <ul className="endpoint-list" aria-label="连接路径">{profile.endpoints.map((endpoint) => {
            const current = endpoint.id === connection.endpointId;
            const url = endpoint.kind === "relay-wss" ? endpoint.relayUrl : endpoint.baseUrl;
            const kind = endpoint.kind === "relay-wss" ? "Relay" : endpoint.source === "tailscale" ? "Tailscale" : "Direct";
            return <li key={endpoint.id} className={current ? "endpoint active" : "endpoint"}><div><strong>{kind}{current ? " · 当前路径" : ""}</strong><span className="endpoint-url">{url}</span><small>{endpoint.availability === "available" ? "可用" : endpoint.availability === "unavailable" ? "不可达" : "待检测"}{endpoint.lastRttMs !== undefined ? ` · ${Math.round(endpoint.lastRttMs)} ms` : ""}</small></div><button className="ghost" disabled={current} onClick={() => void host.run(() => host.client.preferEndpoint(endpoint.id))}>使用此路径</button></li>;
          })}</ul></>}
          <p className="security-note" data-testid="security-level">{connection.securityLevel === "http-only-cookie" ? "设备保护：HttpOnly 浏览器会话。凭据不能由页面脚本直接读取。" : "设备保护：浏览器短期凭据，设备密钥仅驻留内存；不具备硬件密钥保护。"}{connection.transportKind === "relay" ? " Relay 可见连接元数据，不能读取任务和代码内容。" : ""}</p>
          <div className="section-actions"><button className="ghost" onClick={() => void loadDevices()} disabled={!ready || devicesBusy}>{devicesBusy ? "读取中…" : "管理设备"}</button><button className="ghost" onClick={() => host.client.reconnect()}>重新连接</button></div>
          {devices && <section className="devices" aria-label="已配对设备"><h3>已配对设备</h3><ul className="device-list">{devices.devices.map((device) => <li key={device.id}><div><strong>{device.displayName || device.platform || "浏览器设备"}{device.id === devices.currentDeviceId ? " · 本设备" : ""}</strong><small>{device.revokedAt ? "已撤销" : "有效"} · {device.credentialKind === "browser-session" ? "浏览器会话" : device.credentialKind}{device.lastSeenAt ? ` · 最近活动 ${new Date(device.lastSeenAt).toLocaleString()}` : ""}</small></div>{!device.revokedAt && (device.id === devices.currentDeviceId || canAdmin) && <button className="danger" disabled={!ready || devicesBusy} onClick={() => device.id === devices.currentDeviceId ? void host.logout() : void revokeDevice(device.id)}>{device.id === devices.currentDeviceId ? "撤销本设备" : "撤销设备"}</button>}</li>)}</ul>
          {canAdmin && <div className="revoke-all">{confirmRevokeAll ? <><p>所有设备（包括本设备）会立即断开，之后需在电脑端重新配对。</p><div className="section-actions"><button className="danger" disabled={!ready || devicesBusy} onClick={() => void revokeAll()}>确认撤销所有设备</button><button className="ghost" onClick={() => setConfirmRevokeAll(false)}>取消</button></div></> : <button className="ghost" disabled={!ready || devicesBusy} onClick={() => setConfirmRevokeAll(true)}>撤销所有设备</button>}</div>}</section>}
        </div>
      </details>
      {unresolvedCommands.length > 0 && <section className="outbox card" aria-label="待确认命令"><h2>待确认命令</h2><p className="muted">连接恢复后会先检查 Host 回执。结果未知的命令不会自动重新执行。</p>{unresolvedCommands.map((command) => <div className="pending-command" key={command.commandId}><div><strong>{commandLabel(command.method)}</strong><small>{command.state === "queued" ? "尚未发送" : command.state === "sent" ? "等待回执" : "回执待确认"}{command.outcomeUnknown ? " · 执行结果未知，请在电脑上检查" : command.method.startsWith("access.") ? " · 请在设备管理中核对授权结果" : ""}</small></div>{command.state !== "sent" && !command.method.startsWith("access.") && <button className="ghost" disabled={!ready || command.outcomeUnknown === true} onClick={() => void host.retryCommand(command.commandId)}>核对并重试原命令</button>}</div>)}</section>}
      <section className="timeline card"><div className="section-head"><h2>执行 Timeline</h2><div className="section-actions"><button className="ghost" disabled={!ready} onClick={() => void loadDiff()}>查看 Diff</button><button className="ghost" onClick={() => window.location.reload()}>刷新恢复</button></div></div>{items.length === 0 && <p className="muted">等待 {providerName} 事件…</p>}{items.map((item) => <TimelineCard key={item.itemId} item={item} providerName={providerName} onApproval={approval} disabled={!ready} />)}</section>
      {diff && <section className="diff card"><div className="section-head"><h2>Workspace Diff</h2><span className="item-status">{diff.dirty ? "有变更" : "clean"}</span></div><p className="muted">{diff.branch ?? "unknown"}{diff.head ? ` · ${diff.head.slice(0, 8)}` : ""} · {diff.files.length} files</p>{diff.baselineWarning && <p className="error">{diff.baselineWarning}</p>}{diff.files.length > 0 && <ul className="file-list">{diff.files.map((file) => <li key={file.path}>{file.path}</li>)}</ul>}<pre>{diff.diff || "没有未提交变更"}{diff.truncated ? "\n\n[已截断]" : ""}</pre></section>}
      <section className="composer card"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={`让 ${providerName} 修改 fixture、运行测试，或继续上一个任务…`} disabled={!ready || snapshot.session.activityState !== "idle"} /><div className="composer-actions"><button className="primary" onClick={() => void sendPrompt()} disabled={!ready || !prompt.trim() || snapshot.session.activityState !== "idle" || unresolvedCommands.some((command) => command.method === "session.startTurn")}>发送任务</button><button className="danger" onClick={() => void host.run(() => host.client.command("session.interrupt", {}))} disabled={!ready || !snapshot.activeTurn || snapshot.session.activityState === "outcome_unknown"}>中止当前 Turn</button></div></section>
      {host.error && <p className="error" role="alert">{host.error}</p>}
    </>}
  </main>;
}

function TimelineCard({ item, providerName, onApproval, disabled = false }: { item: TimelineItem; providerName: string; onApproval: (id: string, action: "allow_once" | "deny") => void; disabled?: boolean }) {
  const content = isRecord(item.content) ? item.content : { value: item.content };
  const title = item.kind === "assistant_message" ? providerName : item.kind === "tool_call" ? String(content.toolName ?? "Tool") : item.kind === "approval" ? `需要批准：${String(content.toolName ?? "Tool")}` : item.kind === "user_message" ? "你" : item.kind === "error" ? "错误" : "系统";
  const body = content.text ?? content.message ?? content.output ?? content.error ?? content.value ?? JSON.stringify(content, null, 2);
  return <article className={`timeline-item ${item.kind} ${item.status}`}><div className="item-title"><span>{title}</span><span className="item-status">{item.status}</span></div><pre>{typeof body === "string" ? body : JSON.stringify(body, null, 2)}</pre>{item.kind === "approval" && item.status === "pending" && typeof content.approvalId === "string" && <div className="approval-actions"><button className="primary" disabled={disabled} onClick={() => onApproval(content.approvalId as string, "allow_once")}>允许一次</button><button className="danger" disabled={disabled} onClick={() => onApproval(content.approvalId as string, "deny")}>拒绝</button></div>}</article>;
}
