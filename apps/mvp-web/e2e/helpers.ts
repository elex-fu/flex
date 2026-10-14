import { appendFileSync, readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

const PAIRING_TOKEN = () => process.env.FLYX_E2E_PAIRING_TOKEN!;
let nextPairingClient = 1;

/**
 * Current Host base URL.  Read from the environment on every call because
 * the resilience specs restart the Host onto a new random port.
 */
export function baseUrl(): string {
  const url = process.env.FLYX_E2E_BASE_URL;
  if (!url) throw new Error("FLYX_E2E_BASE_URL is not set; did global setup run?");
  return url;
}

/**
 * Claim a dedicated one-time pairing token.  The counter lives in a file so
 * it survives Playwright worker restarts (a failed test recycles the worker
 * and would otherwise reset an in-memory queue and re-serve consumed tokens).
 * The token pool is re-read from the environment on every call so specs that
 * restart the Host (which mints a fresh pool) keep handing out valid grants.
 */
export function claimToken(): string {
  const availableTokens: string[] = JSON.parse(process.env.FLYX_E2E_PAIRING_TOKENS ?? "[]");
  const claimFile = process.env.FLYX_E2E_CLAIM_FILE;
  if (!claimFile) return availableTokens.shift() ?? PAIRING_TOKEN();
  appendFileSync(claimFile, "x\n");
  const claimed = readFileSync(claimFile, "utf8").split("\n").length - 1;
  return availableTokens[claimed - 1] ?? PAIRING_TOKEN();
}

/** Pair a fresh browser context like a phone entering the one-time token. */
export async function pair(page: Page): Promise<string> {
  const token = claimToken();
  // The Host intentionally enforces a per-IP pairing-attempt budget.  Each
  // browser test models a separate phone, so give it a deterministic fixture
  // address to keep the suite from tripping the production guardrail.
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `198.18.0.${nextPairingClient++}` });
  await page.goto(baseUrl());
  await expect(page.getByRole("heading", { name: "连接电脑 Host" })).toBeVisible();
  await page.getByPlaceholder("配对 Token").fill(token);
  await page.getByRole("button", { name: "配对并连接" }).click();
  await expect(page.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 15_000 });
  return token;
}

export type SubmittedTurn = { commandId: string; turnId: string };
type StoredCommand = { commandId: string; method: string; createdAt: string; payload?: { prompt?: string }; result?: { turnId?: string } };
const submittedTurns = new WeakMap<Page, SubmittedTurn>();

/** Read the durable write identity through the same storage used by Direct and Relay. */
async function storedCommands(page: Page): Promise<StoredCommand[]> {
  return page.evaluate(() => new Promise<StoredCommand[]>((resolve, reject) => {
    const open = indexedDB.open("flyx-client-v1", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("commands", "readonly");
      const request = tx.objectStore("commands").getAll();
      tx.oncomplete = () => { db.close(); resolve(request.result as StoredCommand[]); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}

/** Send a prompt and wait for this command's accepted Turn, even for repeated text. */
export async function sendPrompt(page: Page, text: string): Promise<SubmittedTurn> {
  const previous = new Set((await storedCommands(page)).map((command) => command.commandId));
  await page.locator("textarea").fill(text);
  await page.getByRole("button", { name: "发送任务" }).click();
  let submitted: SubmittedTurn | undefined;
  await expect.poll(async () => {
    const command = (await storedCommands(page)).find((candidate) => !previous.has(candidate.commandId)
      && candidate.method === "session.startTurn" && candidate.payload?.prompt === text && candidate.result?.turnId);
    submitted = command?.result?.turnId ? { commandId: command.commandId, turnId: command.result.turnId } : undefined;
    return submitted;
  }, { timeout: 15_000, message: "This prompt must have its own durable commandId and accepted turnId" }).toBeTruthy();
  if (!submitted) throw new Error("Prompt was not accepted");
  submittedTurns.set(page, submitted);
  return submitted;
}

export async function waitForIdle(page: Page, expected?: SubmittedTurn): Promise<void> {
  let submitted = expected ?? submittedTurns.get(page);
  if (!submitted) {
    const command = (await storedCommands(page)).filter((candidate) => candidate.method === "session.startTurn" && candidate.result?.turnId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (command?.result?.turnId) submitted = { commandId: command.commandId, turnId: command.result.turnId };
  }
  if (!submitted) throw new Error("waitForIdle requires a submitted command and Turn");
  const result = JSON.stringify("result-" + submitted.turnId);
  const error = JSON.stringify("error-" + submitted.turnId);
  // Assistant completion is not a Turn terminal. Scope this wait to the
  // committed completed/failed/cancelled card for the command just submitted.
  await expect(page.locator("article.system.completed[data-item-id=" + result + "], article.system.cancelled[data-item-id=" + result + "], article.error.failed[data-item-id=" + error + "]"))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
}
