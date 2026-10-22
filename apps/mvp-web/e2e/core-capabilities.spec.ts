import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { clientRecords, storedCommands } from "./helpers.js";
import type { ClientDraft } from "@flyx/client-core";

type Stats = { sessions: number; processes: number; nativeSessions: number; loadedRuntimes: number };
async function startCoreHost() {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "core-host-main.ts");
  const child = spawn(process.execPath, ["--import", "tsx", path], { cwd: resolve(dirname(path), "../../.."), env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = "";
  child.stderr!.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-8000); });
  const ready = await new Promise<{ address: string; token: string }>((yes, no) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); no(new Error(`Core browser Host readiness timeout: ${errors}`)); }, 20_000);
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); const match = /^FLYX_CORE_BROWSER_READY (.+)$/m.exec(output); if (match) { clearTimeout(timer); yes(JSON.parse(match[1]!) as { address: string; token: string }); output = ""; } });
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
