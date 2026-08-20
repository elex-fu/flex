import { appendFileSync, readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

const PAIRING_TOKEN = () => process.env.FLYX_E2E_PAIRING_TOKEN!;

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
function claimToken(): string {
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
  await page.goto(baseUrl());
  await expect(page.getByRole("heading", { name: "连接电脑 Host" })).toBeVisible();
  await page.getByPlaceholder("配对 Token").fill(token);
  await page.getByRole("button", { name: "配对并连接" }).click();
  await expect(page.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 15_000 });
  return token;
}

/** Send a prompt through the composer. */
export async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.locator("textarea").fill(text);
  await page.getByRole("button", { name: "发送任务" }).click();
  // The deterministic Turn can finish before the click's state update lands,
  // so assert durable progress instead of the transient disabled state.
  await expect(page.locator("article", { hasText: text }).first()).toBeVisible({ timeout: 15_000 });
}

export async function waitForIdle(page: Page): Promise<void> {
  // The composer textarea is only gated on the session activity state; the
  // send button is additionally disabled while the prompt box is empty.
  await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
}
