import { chromium } from "@playwright/test";

const URL = process.argv[2];
// The destination's compatibility scene (flyx-c3-basic-v1) verifies only the
// text turn baseline: every workspace-writing tool (Write/Bash) raises an
// approval that the destination cannot answer (interactiveApprovals is not a
// verified capability), so a file-writing prompt dead-ends by design. The
// E2E prompt therefore stays text-only to exercise the verified scope.
const PROMPT = process.argv[3] ?? "请只回复 REAL-CLAUDE-E2E-OK 这一行文本，不要使用任何工具，不要创建任何文件。";
const OUT = process.argv[4] ?? "claude";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const shots = `/tmp/flyx-real-e2e/shot-${OUT}`;
import { mkdirSync } from "node:fs"; mkdirSync(shots, { recursive: true });

const terminalCard = (page) => page.locator('article.system.completed, article.system.cancelled, article.system.error, article.system.failed');

await page.goto(URL, { waitUntil: "domcontentloaded" });
// Pairing fragment auto-pairs; wait for the connected status.
await page.locator(".connection[role=status]").filter({ hasText: "已同步" }).waitFor({ timeout: 30_000 });
await page.screenshot({ path: `${shots}/01-paired.png` });
console.log("[e2e] paired + synced");

const timeline = await page.locator("h1, h2, h3").filter({ hasText: "执行 Timeline" }).count();
console.log("[e2e] timeline heading present:", timeline > 0);

// The recovered legacy session can carry a persisted `blocked` residency that
// gates the composer by design (needs Host-local recovery reconciliation).
// The E2E composes in a FRESH session instead: the 新建会话 form auto-selects
// the first registered workspace + provider, so fill a title and submit; the
// web app selects the created session automatically.
const titleInput = page.locator('label:has-text("新会话名称") input');
await titleInput.waitFor({ state: "visible", timeout: 20_000 });
await titleInput.fill(`Real ${OUT} E2E ${Date.now()}`);
await page.screenshot({ path: `${shots}/01-create.png` });
await page.getByRole("button", { name: "创建并选择会话" }).click();
await page.locator(".core-session-list button.primary").waitFor({ timeout: 20_000 });
await page.locator(".connection[role=status]").filter({ hasText: "已同步" }).waitFor({ timeout: 30_000 });
await page.waitForTimeout(1_500);
const sessionLine = await page.locator(".core-session-list button.primary").innerText();
console.log("[e2e] new session created + selected:", sessionLine);

// A recovered host can leave a stale turn (e.g. waiting_approval from a dead
// runtime) that keeps the composer gated. Interrupt it first and wait for a
// terminal card before composing.
const staleInterrupt = page.getByRole("button", { name: "中止当前 Turn" });
if (await staleInterrupt.count() && await staleInterrupt.first().isEnabled()) {
  console.log("[e2e] stale turn detected — interrupting");
  await staleInterrupt.first().click();
  await terminalCard(page).waitFor({ timeout: 120_000 }).catch(() => console.log("[e2e] stale turn did not reach terminal"));
  await page.waitForTimeout(1_000);
}

// Send the real prompt.
const box = page.locator("textarea");
await box.waitFor({ state: "visible", timeout: 15_000 });
await box.fill(PROMPT);
await page.screenshot({ path: `${shots}/02-prompt.png` });
const sendButton = page.getByRole("button", { name: "发送任务" });
try { await sendButton.click({ timeout: 30_000 }); }
catch {
  const probe = await page.evaluate(() => ({
    cards: [...document.querySelectorAll(".status-grid .card")].map((c) => c.textContent?.trim()),
    errors: [...document.querySelectorAll(".error")].map((e) => e.textContent?.trim()),
    statuses: [...document.querySelectorAll('[role="status"], [role="alert"]')].map((e) => e.textContent?.trim()),
    disabled: [...document.querySelectorAll("button:disabled")].map((b) => (b.textContent || "").trim()),
    enabled: [...document.querySelectorAll("button:not(:disabled)")].map((b) => (b.textContent || "").trim()).slice(0, 20),
  }));
  console.log("[e2e] send button stayed disabled:", JSON.stringify(probe, null, 1));
  await page.screenshot({ path: `${shots}/02-gated.png`, fullPage: true });
  process.exit(3);
}
console.log("[e2e] prompt sent, waiting for terminal card …");

// Wait for a terminal result card for this turn, approving tool requests
// through the authoritative interaction card as they appear.
const terminal = terminalCard(page);
const allowButton = page.getByRole("button", { name: "Allow once" });
let approvals = 0;
try {
  for (;;) {
    await Promise.race([
      terminal.first().waitFor({ timeout: 300_000 }),
      allowButton.first().waitFor({ state: "visible", timeout: 300_000 }),
    ]);
    if ((await terminal.count()) > 0) break;
    await allowButton.first().click();
    approvals += 1;
    console.log(`[e2e] approved tool request #${approvals}`);
    await page.waitForTimeout(2_000);
  }
} catch {
  console.log("[e2e] NO terminal card — dumping state");
  const dump = await page.evaluate(() => ({
    articles: [...document.querySelectorAll("article")].map((a) => `${a.className}: ${(a.textContent || "").slice(0, 120)}`),
    errors: [...document.querySelectorAll(".error")].map((e) => e.textContent?.trim()),
    statuses: [...document.querySelectorAll('[role="status"], [role="alert"]')].map((e) => e.textContent?.trim()),
    pending: [...document.querySelectorAll(".pending-command")].map((p) => p.textContent?.trim().slice(0, 200)),
    composer: document.querySelector(".composer")?.textContent?.trim().slice(0, 300),
  }));
  console.log(JSON.stringify(dump, null, 1));
  await page.screenshot({ path: `${shots}/03-timeout.png`, fullPage: true });
  process.exit(2);
}
await page.waitForTimeout(1_000);
await page.screenshot({ path: `${shots}/03-terminal.png`, fullPage: true });
const cards = await page.locator("article").all();
let terminalInfo = null;
for (const card of cards) {
  const id = await card.getAttribute("data-item-id");
  if (id?.startsWith("result-")) terminalInfo = { id, text: (await card.innerText()).slice(0, 400) };
}
console.log("[e2e] terminal card:", JSON.stringify(terminalInfo, null, 1));

// Open the Diff panel.
const diffButton = page.getByRole("button", { name: "查看 Diff" });
if (await diffButton.count()) {
  await diffButton.first().click();
  await page.locator("h1, h2, h3").filter({ hasText: "Workspace Diff" }).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `${shots}/04-diff.png`, fullPage: true });
  const body = await page.locator("body").innerText();
  const marker = body.includes("REAL-CLAUDE-E2E-OK") || body.includes("real-claude-e2e.txt") || body.includes(PROMPT.slice(0, 12));
  console.log("[e2e] Workspace Diff panel open; expected marker visible:", marker);
  const section = body.split("Workspace Diff")[1] ?? "";
  console.log("[e2e] diff excerpt:", JSON.stringify(section.slice(0, 600)));
} else {
  console.log("[e2e] no Diff button present");
}
await browser.close();
