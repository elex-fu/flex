import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { clientRecords, storedCommands } from "./helpers.js";
import type { ClientDraft } from "@flyx/client-core";

type Stats = { sessions: number; processes: number; nativeSessions: number; loadedRuntimes: number; writeReceipts: Array<{ method: string; count: number }> };
/** Durable write families owned by the Recovery/Diff/Worktree panels. */
const PANEL_WRITE_METHODS = /^(checkpoint\.|worktree\.|session\.recovery\.)/;
async function startCoreHost(script = "core-host-main.ts", marker = "FLYX_CORE_BROWSER_READY") {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), script);
  const child = spawn(process.execPath, ["--import", "tsx", path], { cwd: resolve(dirname(path), "../../.."), env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = "";
  child.stderr!.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-8000); });
  const ready = await new Promise<{ address: string; token: string }>((yes, no) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); no(new Error(`Core browser Host readiness timeout: ${errors}`)); }, 30_000);
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); const match = new RegExp(`^${marker} (.+)$`, "m").exec(output); if (match) { clearTimeout(timer); yes(JSON.parse(match[1]!) as { address: string; token: string }); output = ""; } });
    child.once("error", (error) => { clearTimeout(timer); no(error); });
    child.once("exit", (code) => { clearTimeout(timer); no(new Error(`Core browser Host exited ${code}: ${errors}`)); });
  });
  return { ...ready, stats: () => stats(child), stop: () => stop(child) };
}
let controlId = 0;
function stats(child: ChildProcess): Promise<Stats> {
  const id = ++controlId;
  return new Promise((yes, no) => {
    const timer = setTimeout(() => { child.off("message", receive); no(new Error("Core browser stats timeout")); }, 5000);
    const receive = (value: unknown) => { if (value && typeof value === "object" && "id" in value && value.id === id) { clearTimeout(timer); child.off("message", receive); yes(value as unknown as Stats); } };
    child.on("message", receive); child.send!({ id, action: "stats" });
  });
}
function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((yes) => { const timer = setTimeout(() => { child.kill("SIGKILL"); yes(); }, 10_000); child.once("exit", () => { clearTimeout(timer); yes(); }); child.kill("SIGTERM"); });
}
async function pairCore(page: Page, fixture: Awaited<ReturnType<typeof startCoreHost>>) {
  await page.goto(fixture.address);
  await page.getByPlaceholder("配对 Token").fill(fixture.token);
  await page.getByRole("button", { name: "配对并连接", exact: true }).click();
  await expect(page.locator(".connection[role=status]")).toHaveText("已同步");
  const catalog = page.getByRole("region", { name: "会话与资源", exact: true });
  await expect(catalog.getByRole("button", { name: "Initial session", exact: true })).toBeVisible();
  return catalog;
}

test.describe("real Gateway and Web core Session controls", () => {
  test("creates, renames, archives and unarchives metadata without constructing any Provider", async ({ page }) => {
    const fixture = await startCoreHost();
    try {
      const catalog = await pairCore(page, fixture);
      await catalog.getByLabel("新会话名称", { exact: true }).fill("A new browser session");
      await catalog.getByRole("button", { name: "创建并选择会话", exact: true }).click();
      await expect(catalog.getByLabel("会话名称", { exact: true })).toHaveValue("A new browser session");
      await expect.poll(() => fixture.stats()).toMatchObject({ sessions: 2, processes: 0, nativeSessions: 0, loadedRuntimes: 0 });
      await catalog.getByLabel("会话名称", { exact: true }).fill("Renamed browser session");
      await catalog.getByRole("button", { name: "保存名称", exact: true }).click();
      await expect(catalog.getByLabel("会话名称", { exact: true })).toHaveValue("Renamed browser session");
      await catalog.getByRole("button", { name: "归档会话", exact: true }).click();
      await expect(catalog.getByRole("button", { name: "取消归档", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "发送任务", exact: true })).toBeDisabled();
      await catalog.getByRole("button", { name: "取消归档", exact: true }).click();
      await expect(catalog.getByRole("button", { name: "归档会话", exact: true })).toBeEnabled();
      const writes = (await storedCommands(page)).filter((command) => ["session.createNew", "session.rename", "session.archive", "session.unarchive"].includes(command.method));
      expect(writes.map((command) => command.method).sort()).toEqual(["session.createNew", "session.rename", "session.archive", "session.unarchive"].sort());
      await page.reload();
      await expect(catalog.getByRole("button", { name: "Renamed browser session", exact: true })).toBeVisible();
      expect((await storedCommands(page)).filter((command) => command.method === "session.createNew")).toHaveLength(1);
      expect(await fixture.stats()).toMatchObject({ sessions: 2, processes: 0, nativeSessions: 0, loadedRuntimes: 0 });
      await page.screenshot({ path: test.info().outputPath("real-core-session-controls.png"), fullPage: true });
    } finally { await fixture.stop(); }
  });
  test("retains per-Session drafts across rapid selection and displays real activation reasons", async ({ page }) => {
    const fixture = await startCoreHost();
    try {
      const catalog = await pairCore(page, fixture);
      await page.locator("textarea").fill("Initial session draft");
      await expect.poll(async () => (await clientRecords<ClientDraft>(page, "drafts")).some((draft) => draft.text === "Initial session draft")).toBe(true);
      await catalog.getByLabel("新会话名称", { exact: true }).fill("Isolated draft session");
      await catalog.getByRole("button", { name: "创建并选择会话", exact: true }).click();
      await expect(catalog.getByLabel("会话名称", { exact: true })).toHaveValue("Isolated draft session");
      await page.locator("textarea").fill("Second session draft");
      await catalog.getByRole("button", { name: "Initial session", exact: true }).click();
      await expect(page.locator("textarea")).toHaveValue("Initial session draft");
      await catalog.getByRole("button", { name: "Isolated draft session", exact: true }).click();
      await expect(page.locator("textarea")).toHaveValue("Second session draft");
      await catalog.getByRole("button", { name: "核对执行条件", exact: true }).click();
      await expect(catalog).toContainText("WORKSPACE_NOT_ACTIVATED");
      await expect(catalog).toContainText("PROVIDER_NOT_ACTIVATED");
      expect((await storedCommands(page)).some((command) => command.method === "session.startTurn")).toBe(false);
      expect(await fixture.stats()).toMatchObject({ sessions: 2, processes: 0, nativeSessions: 0, loadedRuntimes: 0 });
    } finally { await fixture.stop(); }
  });
});

test.describe("core panels without a Provider or Git backend", () => {
  test("keeps the Recovery entry unavailable with a concrete reason and issues no recovery writes", async ({ page }) => {
    const fixture = await startCoreHost();
    try {
      const catalog = await pairCore(page, fixture);
      const recovery = page.getByRole("region", { name: "恢复核对", exact: true });
      await expect(recovery).toBeVisible();
      await expect(recovery.getByRole("button", { name: "检查原执行", exact: true })).toBeDisabled();
      await expect(recovery).toContainText("当前快照没有待核对的原 Turn");
      // Refreshing the authoritative snapshot must not conjure a recoverable Turn.
      await catalog.getByRole("button", { name: "刷新目录与状态", exact: true }).click();
      await expect(recovery.getByRole("button", { name: "检查原执行", exact: true })).toBeDisabled();
      await expect(recovery).toContainText("当前快照没有待核对的原 Turn");
      const commands = await storedCommands(page);
      expect(commands.filter((command) => command.method === "session.interrupt" || command.method.startsWith("session.recovery."))).toEqual([]);
      const stats = await fixture.stats();
      expect(stats).toMatchObject({ sessions: 1, processes: 0, nativeSessions: 0, loadedRuntimes: 0 });
      expect(stats.writeReceipts).toEqual([]);
    } finally { await fixture.stop(); }
  });

  test("disables Turn Diff with a concrete reason when the Host has no checkpoint capability", async ({ page }) => {
    const fixture = await startCoreHost();
    try {
      await pairCore(page, fixture);
      const diff = page.getByRole("region", { name: "Turn 变更与回退", exact: true });
      await expect(diff).toBeVisible();
      await expect(diff).toContainText("此 Host 未提供检查点 Diff。现有 Workspace Diff 可查看当前未提交变更。");
      await expect(diff).not.toContainText("查看所选任务 Diff");
      expect((await storedCommands(page)).filter((command) => command.method.startsWith("checkpoint."))).toEqual([]);
      const stats = await fixture.stats();
      expect(stats).toMatchObject({ sessions: 1, processes: 0, nativeSessions: 0, loadedRuntimes: 0 });
      expect(stats.writeReceipts).toEqual([]);
    } finally { await fixture.stop(); }
  });

  test("disables the Worktree panel with a concrete reason and issues no worktree commands", async ({ page }) => {
    const fixture = await startCoreHost();
    try {
      await pairCore(page, fixture);
      const worktrees = page.getByRole("region", { name: "隔离工作区", exact: true });
      await expect(worktrees).toBeVisible();
      await expect(worktrees).toContainText("此 Host 未提供托管 Worktree。可在上方选择现有已登记工作区创建会话。");
      await expect(worktrees.getByRole("button", { name: "刷新工作区", exact: true })).toBeDisabled();
      await expect(worktrees).not.toContainText("创建隔离工作区");
      expect((await storedCommands(page)).filter((command) => command.method.startsWith("worktree."))).toEqual([]);
      const stats = await fixture.stats();
      expect(stats).toMatchObject({ sessions: 1, processes: 0, nativeSessions: 0, loadedRuntimes: 0 });
      expect(stats.writeReceipts).toEqual([]);
    } finally { await fixture.stop(); }
  });
});

test.describe("worktree creation uplink with a trusted local execution port", () => {
  test("accepts a managed worktree creation and keeps exactly the original two receipts", async ({ page }) => {
    const fixture = await startCoreHost("core-host-execution-main.ts", "FLYX_CORE_EXECUTION_READY");
    try {
      const catalog = await pairCore(page, fixture);
      const worktrees = page.getByRole("region", { name: "隔离工作区", exact: true });
      await expect(worktrees.getByRole("button", { name: "刷新工作区", exact: true })).toBeEnabled();
      const create = worktrees.getByRole("button", { name: "创建隔离工作区", exact: true });
      await expect(create).toBeEnabled();
      await create.click();
      const receipt = worktrees.getByText("工作区回执：");
      await expect(receipt).toBeVisible();
      // The accepted receipt holds the operation at admission time; poll the
      // original operation until the managed checkout is confirmed complete.
      await expect.poll(async () => {
        await worktrees.getByRole("button", { name: "核对原工作区操作", exact: true }).click({ timeout: 2_000 }).catch(() => {});
        return (await receipt.textContent()) ?? "";
      }, { timeout: 60_000 }).toContain("completed");
      // Two separate receipts: the worktree operation and the stable Session command.
      const continueButton = worktrees.getByRole("button", { name: "使用上方 Provider 创建会话", exact: true });
      await expect(continueButton).toBeEnabled();
      await continueButton.click();
      await expect(catalog.getByLabel("会话名称", { exact: true })).toHaveValue("Isolated session");
      const commands = await storedCommands(page);
      expect(commands.filter((command) => command.method === "worktree.create")).toHaveLength(1);
      const sessionCreates = commands.filter((command) => command.method === "session.createNew");
      expect(sessionCreates).toHaveLength(1);
      expect(sessionCreates[0]!.commandId).toMatch(/^worktree-session:/);
      const stats = await fixture.stats();
      expect(stats).toMatchObject({ sessions: 2, nativeSessions: 0, loadedRuntimes: 0 });
      expect(stats.writeReceipts).toEqual([{ method: "worktree.create", count: 1 }]);
      await page.screenshot({ path: test.info().outputPath("core-worktree-uplink.png"), fullPage: true });
    } finally { await fixture.stop(); }
  });
});
