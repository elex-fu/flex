import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const URL = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
mkdirSync("/tmp/flyx-real-e2e/diag", { recursive: true });
page.on("console", (m) => console.log("[page]", m.type(), m.text().slice(0, 200)));

await page.goto(URL, { waitUntil: "domcontentloaded" });
try {
  await page.locator(".connection[role=status]").filter({ hasText: "已同步" }).waitFor({ timeout: 30_000 });
} catch { console.log("[diag] NOT synced; status text:", await page.locator(".connection").first().innerText().catch(() => "?")); }
console.log("[diag] status:", await page.locator(".connection").first().innerText().catch(() => "?"));
// Select the first session like the real driver does, then report state.
// The session catalog panel loads asynchronously after pairing — wait for it.
const sessionButton = page.locator(".core-session-list button").first();
try {
  await sessionButton.waitFor({ state: "visible", timeout: 20_000 });
  console.log("[diag] session button:", JSON.stringify(await sessionButton.innerText().catch(() => "?")));
  await sessionButton.click();
  await page.waitForTimeout(3_000);
  const btn = page.getByRole("button", { name: "发送任务" });
  console.log("[diag] after select — send enabled:", await btn.isEnabled().catch(() => "?"));
  const dom = await page.evaluate(() => ({
    uls: [...document.querySelectorAll("ul")].map((u) => u.className),
    sessionButtons: [...document.querySelectorAll(".core-session-list button")].map((b) => (b.textContent || "").trim()),
  }));
  console.log("[diag] dom:", JSON.stringify(dom));
} catch (e) {
  console.log("[diag] session list never appeared:", String(e).slice(0, 200));
  const dom = await page.evaluate(() => ({
    uls: [...document.querySelectorAll("ul")].map((u) => u.className),
    allButtons: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).slice(0, 50),
  }));
  console.log("[diag] dom fallback:", JSON.stringify(dom, null, 1));
}
console.log("[diag] after select, status:", await page.locator(".connection").first().innerText().catch(() => "?"));
console.log("[diag] after select, body excerpt:\n" + (await page.locator("body").innerText()).slice(0, 1500));
await page.screenshot({ path: "/tmp/flyx-real-e2e/diag/after-select.png", fullPage: true });
const box = page.locator("textarea");
console.log("[diag] textarea count:", await box.count(), "enabled:", await box.isEnabled().catch(() => "?"));
await box.fill("诊断文本");
await page.waitForTimeout(4_000);
const button = page.getByRole("button", { name: "发送任务" });
console.log("[diag] send button count:", await button.count(), "enabled:", await button.isEnabled().catch(() => "?"));
console.log("[diag] textarea value:", JSON.stringify(await box.inputValue()));
// Probe the gating signals: status grid cards + error paragraphs + composer status.
const probe = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".status-grid .card")].map((c) => c.textContent?.trim());
  const errors = [...document.querySelectorAll(".error")].map((e) => e.textContent?.trim());
  const statuses = [...document.querySelectorAll('[role="status"], [role="alert"]')].map((e) => e.textContent?.trim());
  return { cards, errors, statuses };
});
console.log("[diag] gating probe:", JSON.stringify(probe, null, 1));
await page.screenshot({ path: "/tmp/flyx-real-e2e/diag/state.png", fullPage: true });
const body = await page.locator("body").innerText();
console.log("[diag] body excerpt:\n" + body.slice(0, 1200));
// Inspect persisted host state the web app keeps (scopes etc.).
const storage = await page.evaluate(() => ({ local: { ...localStorage }, sessionKeys: Object.keys(sessionStorage) }));
console.log("[diag] localStorage:", JSON.stringify(storage.local).slice(0, 800));
await browser.close();
