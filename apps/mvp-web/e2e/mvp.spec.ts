import { appendFileSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const BASE_URL = () => process.env.FLYX_E2E_BASE_URL!;
const PAIRING_TOKEN = () => process.env.FLYX_E2E_PAIRING_TOKEN!;

const availableTokens: string[] = JSON.parse(process.env.FLYX_E2E_PAIRING_TOKENS ?? "[]");

/**
 * Claim a dedicated one-time pairing token.  The counter lives in a file so
 * it survives Playwright worker restarts (a failed test recycles the worker
 * and would otherwise reset an in-memory queue and re-serve consumed tokens).
 */
function claimToken(): string {
  const claimFile = process.env.FLYX_E2E_CLAIM_FILE;
  if (!claimFile) return availableTokens.shift() ?? PAIRING_TOKEN();
  appendFileSync(claimFile, "x\n");
  const claimed = readFileSync(claimFile, "utf8").split("\n").length - 1;
  return availableTokens[claimed - 1] ?? PAIRING_TOKEN();
}

/** Pair a fresh browser context like a phone entering the one-time token. */
async function pair(page: Page): Promise<string> {
  const token = claimToken();
  await page.goto(BASE_URL());
  await expect(page.getByRole("heading", { name: "连接电脑 Host" })).toBeVisible();
  await page.getByPlaceholder("配对 Token").fill(token);
  await page.getByRole("button", { name: "配对并连接" }).click();
  await expect(page.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 15_000 });
  return token;
}

/** Send a prompt through the composer. */
async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.locator("textarea").fill(text);
  await page.getByRole("button", { name: "发送任务" }).click();
  // The deterministic Turn can finish before the click's state update lands,
  // so assert durable progress instead of the transient disabled state.
  await expect(page.locator("article", { hasText: text }).first()).toBeVisible({ timeout: 15_000 });
}

async function waitForIdle(page: Page): Promise<void> {
  // The composer textarea is only gated on the session activity state; the
  // send button is additionally disabled while the prompt box is empty.
  await expect(page.locator("textarea")).toBeEnabled({ timeout: 30_000 });
}

test.describe("Flyx MVP deterministic browser E2E", () => {
  test("pairing shows the timeline and rejects a replayed token", async ({ page }) => {
    const token = await pair(page);
    // The one-time token cannot be exchanged twice.
    const replay = await page.evaluate(async (replayToken) => {
      const response = await fetch("/api/pairing/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: replayToken }),
      });
      return response.status;
    }, token);
    expect(replay).toBe(403);
  });

  test("text scenario streams a reply and reaches the terminal state", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:text");
    // Scenario 3: a streaming partial merged into the completed message must
    // not duplicate the body text in the Timeline projection.
    const reply = page.locator("article.assistant_message", { hasText: "deterministic reply" }).last();
    await expect(reply).toBeVisible();
    await expect((await reply.textContent())?.match(/deterministic reply: text scenario finished/g)).toHaveLength(1);
    await expect(page.getByText("deterministic result: text scenario completed")).toBeVisible();
    await waitForIdle(page);
  });

  test("tool scenario shows tool call output", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:tool");
    await expect(page.getByText("npm test")).toBeVisible();
    await expect(page.getByText("1 passing")).toBeVisible();
    await expect(page.getByText("deterministic result: tool scenario completed")).toBeVisible();
    await waitForIdle(page);
  });

  test("approval scenario allows a tool once and completes", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:approval");
    // The session Timeline accumulates items from earlier tests, so always
    // interact with the newest pending approval card.
    const pending = page.locator("article.approval", { has: page.getByRole("button", { name: "允许一次" }) }).last();
    await expect(pending).toBeVisible({ timeout: 15_000 });
    await pending.getByRole("button", { name: "允许一次" }).click();
    await expect(page.getByText("deterministic result: approval scenario completed").last()).toBeVisible();
    await waitForIdle(page);
  });

  test("approval scenario denies the tool and still terminates", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:approval");
    const pending = page.locator("article.approval", { has: page.getByRole("button", { name: "拒绝" }) }).last();
    await expect(pending).toBeVisible({ timeout: 15_000 });
    await pending.getByRole("button", { name: "拒绝" }).click();
    await expect(page.getByText("denied by user").last()).toBeVisible();
    await waitForIdle(page);
  });

  test("fail scenario surfaces an error item", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:fail");
    await expect(page.getByText("deterministic failure injected by the test scenario").last()).toBeVisible();
    await waitForIdle(page);
  });

  test("interrupt cancels a slow turn", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:slow");
    await expect(page.getByRole("button", { name: "中止当前 Turn" })).toBeEnabled();
    await page.getByRole("button", { name: "中止当前 Turn" }).click();
    await expect(page.getByText("Turn cancelled").last()).toBeVisible({ timeout: 15_000 });
    await waitForIdle(page);
  });

  test("diff view shows workspace baseline without changes", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:text");
    await waitForIdle(page);
    // Scenario 6: the Diff projection renders baseline, file list and a
    // unified diff; the deterministic adapter never touches the workspace.
    await page.getByRole("button", { name: "查看 Diff" }).click();
    await expect(page.getByRole("heading", { name: "Workspace Diff" })).toBeVisible();
    await expect(page.getByText("没有未提交变更")).toBeVisible();
  });

  test("follow-up turn reuses the same provider session", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:text");
    await waitForIdle(page);
    await sendPrompt(page, "scenario:text");
    await waitForIdle(page);
    // Scenario 7: both Turns must carry the same provider session id, which
    // the deterministic adapter keeps stable like a resumed conversation.
    const sessionIds = await page.evaluate(async () => {
      const snapshot = await fetch("/api/snapshot", { cache: "no-store" }).then((r) => r.json());
      const timeline = await fetch(`/api/session/${snapshot.session.id}/timeline`, { cache: "no-store" }).then((r) => r.json());
      const events = timeline.events as Array<{ type: string; payload: Record<string, unknown> }>;
      return events
        .filter((event) => event.type === "provider.session.init")
        .map((event) => event.payload.providerSessionId);
    });
    expect(sessionIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sessionIds).size).toBe(1);
  });

  test("closing the page does not cancel a running turn", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:slow");
    // Scenario 12: the provider keeps running after the browser leaves.
    await page.close();
    await page.waitForTimeout(1_000).catch(() => undefined);
    // A fresh page in the same context shares the HttpOnly session cookie;
    // verify the Turn survived the page closure and reached its terminal state.
    const verify = await page.context().newPage();
    await verify.goto(BASE_URL());
    await expect(verify.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 15_000 });
    await expect(verify.getByText("deterministic result: slow scenario completed").last()).toBeVisible({ timeout: 30_000 });
    await waitForIdle(verify);
  });

  test("logout invalidates the cookie and websocket tickets", async ({ page }) => {
    await pair(page);
    // Scenario 16: after logout the old cookie can no longer mint a ticket.
    const ticket = await page.evaluate(async () => {
      const response = await fetch("/api/auth/websocket-ticket", { method: "POST" });
      return response.status;
    });
    expect(ticket).toBe(200);
    await page.getByRole("button", { name: "退出配对" }).click();
    await expect(page.getByRole("heading", { name: "连接电脑 Host" })).toBeVisible({ timeout: 15_000 });
    const rejected = await page.evaluate(async () => {
      const response = await fetch("/api/auth/websocket-ticket", { method: "POST" });
      return response.status;
    });
    expect(rejected).toBe(401);
  });

  test("page refresh replays the persisted timeline", async ({ page }) => {
    await pair(page);
    await sendPrompt(page, "scenario:text");
    await expect(page.getByText("deterministic result: text scenario completed").last()).toBeVisible();
    await waitForIdle(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("deterministic result: text scenario completed").last()).toBeVisible();
  });
});
