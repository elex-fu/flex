import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoreControls, MemoryClientStore, type CoreControlPort, type CoreControlState } from "@flyx/client-core";
import type { RecoveryEvidence, SessionSummaryV2 } from "@flyx/mvp-protocol";
import { CorePanelsView } from "../src/components/core-panels.js";
import type { useHost } from "../src/use-host.js";

const session: SessionSummaryV2 = { sessionId: "session", workspaceId: "workspace", providerInstanceId: "provider", provider: "codex", title: "Work on documentation", status: "active", activityState: "outcome_unknown", revision: 12, headSequence: 1, residency: "blocked", nativeSessionAvailable: true, createdAt: "2026-10-22", updatedAt: "2026-10-22" };
const evidence: RecoveryEvidence = { sessionId: "session", turnId: "original-turn", attemptId: "private-ui-attempt", evidenceId: "original-evidence", recoveryRevision: 8, observedAt: "2026-10-22", expiresAt: "2099-10-22", processState: "stopped", workspaceState: "clear", nativeState: "unknown", nextSteps: ["inspect", "acknowledge"] };
function render(patch: Partial<CoreControlState> = {}, options: { capabilities?: boolean; online?: boolean; scopes?: string[] } = {}) {
  let calls = 0;
  const port: CoreControlPort = { store: new MemoryClientStore(), supportsCapability: () => options.capabilities !== false, getState: () => ({ connection: "online", sync: "synced", transportGeneration: 1, pairingRequired: false }), request: async () => { calls++; throw new Error("render must not read"); }, command: async () => { calls++; throw new Error("render must not write"); }, queryCommandReceipt: async () => { calls++; throw new Error("render must not query"); }, retrySynchronization: async () => { calls++; } };
  const controls = new CoreControls(port);
  const host = { online: options.online !== false, connection: { sync: options.online === false ? "unknown" : "synced" }, deviceScopes: options.scopes ?? ["session:write"], selectedSessionId: "session", items: [], pendingCommands: [] } as unknown as ReturnType<typeof useHost>;
  const state: CoreControlState = { sessions: [session], includeArchived: false, workspaces: [{ workspaceId: "workspace", label: "My repository", kind: "local", state: "active", repositoryId: "repository" }], providers: [{ providerInstanceId: "provider", provider: "codex", state: "configured", verification: { state: "verified" } }], snapshot: { session, pendingApprovals: [], activeTurn: { id: "original-turn", sessionId: "session", commandId: "task", status: "outcome_unknown", prompt: "Update docs" } }, worktrees: [], flows: [], ...patch };
  const html = renderToStaticMarkup(createElement(CorePanelsView, { host, controls, state }));
  assert.equal(calls, 0);
  return html;
}
test("Recovery renders only Host nextSteps and keeps unknown acknowledgement initially explicit", () => {
  const html = render({ recovery: evidence });
  assert.match(html, /我确认原执行结果仍未知/);
  assert.match(html, /<button class="danger" disabled="">确认未知结果<\/button>/);
  assert.doesNotMatch(html, /按此证据核对终态/);
  assert.match(html, /重新检查证据/);
  assert.doesNotMatch(html, /private-ui-attempt|original-evidence/);
});
test("local-inspection evidence renders a concrete computer-side action and no recovery write", () => {
  const html = render({ recovery: { ...evidence, nextSteps: ["inspect", "local_inspection"] } });
  assert.match(html, /Host 要求本地检查/);
  assert.doesNotMatch(html, /确认未知结果<\/button>|按此证据核对终态/);
});
test("resource catalog names and read permission are visible without starting a runtime", () => {
  const html = render({}, { scopes: ["session:read"] });
  assert.match(html, /My repository/);
  assert.match(html, /此设备只有读取权限/);
  assert.match(html, /只登记绑定；发送任务时才启动 Provider/);
  assert.match(html, /改用其他 Provider 时请新建会话/);
  assert.match(html, /<button type="submit" disabled="">创建并选择会话<\/button>/);
});
test("missing actual capabilities show actionable reasons and preserve the separate raw Workspace Diff", () => {
  const html = render({}, { capabilities: false });
  assert.match(html, /请升级 Host 后管理会话/);
  assert.match(html, /请在电脑端核对原任务/);
  assert.match(html, /现有 Workspace Diff 可查看当前未提交变更/);
  assert.doesNotMatch(html, /执行完整回退<\/button>/);
});
test("expired recovery evidence and offline status cannot render enabled reconcile actions", () => {
  for (const online of [true, false]) {
    const html = render({ recovery: { ...evidence, expiresAt: "2000-01-01", nextSteps: ["reconcile"] } }, { online });
    assert.match(html, /已过期，请重新检查/);
    assert.match(html, /<button disabled="">按此证据核对终态<\/button>/);
  }
});
test("Worktree flow displays two receipts and asks to inspect the original operation after a timeout", () => {
  const html = render({ flows: [{ command: { commandId: "original-create", hostId: "host", method: "worktree.create", payloadHash: "hash", payload: { sessionId: "session" }, createdAt: "2026-10-22", state: "receipt_unknown", outcomeUnknown: true }, sessionCommandId: "worktree-session:original-create" }] });
  assert.match(html, /工作区回执：receipt_unknown · 结果未知/);
  assert.match(html, /会话回执：尚未创建/);
  assert.match(html, /核对原工作区操作/);
  assert.match(html, /超时或刷新后只核对原命令，不创建第二份资源/);
});
