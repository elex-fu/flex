import { expect, test } from "@playwright/test";
import { baseUrl, pair, sendPrompt, waitForIdle } from "./helpers";

/**
 * Pairing-token claiming, pairing, prompting and idle helpers live in
 * ./helpers so the resilience specs share the exact same browser flows.
 */

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
    await verify.goto(baseUrl());
    await expect(verify.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 15_000 });
    await expect(verify.getByText("deterministic result: slow scenario completed").last()).toBeVisible({ timeout: 30_000 });
    await waitForIdle(verify);
  });

  test("offline local forget preserves the HttpOnly cookie and blocks automatic bootstrap on reload", async ({ page, context }) => {
    await pair(page);
    await page.locator("textarea").fill("local draft to delete");
    await expect(page.getByRole("status").filter({hasText:"草稿按 Host"})).toBeVisible();
    expect((await context.cookies()).some((cookie) => cookie.name === "flyx_session" && cookie.httpOnly)).toBe(true);
    await context.setOffline(true);
    await page.getByRole("button", { name: "移除本地 Host", exact:true }).click();
    await page.getByRole("button", { name: "确认移除本地记录", exact:true }).click();
    await expect(page.getByText(/已移除本地.*并停止自动连接/)).toBeVisible();
    expect((await context.cookies()).some((cookie) => cookie.name === "flyx_session" && cookie.httpOnly)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("flyx:web:automatic-bootstrap:v1"))).toBe("blocked");
    await context.setOffline(false);
    const authRequests:string[]=[];
    page.on("request",(request) => {if (/\/api\/auth\/|\/api\/(?:snapshot|bootstrap|status)(?:\?|$)/.test(request.url())) authRequests.push(new URL(request.url()).pathname);});
    await page.reload();
    await expect(page.getByRole("heading", { name: "连接电脑 Host" })).toBeVisible();
    await page.waitForTimeout(300);
    expect(authRequests).toEqual([]);
    expect((await context.cookies()).some((cookie) => cookie.name === "flyx_session" && cookie.httpOnly)).toBe(true);
    const stored=await page.evaluate(() => new Promise<Record<string,number>>((resolve,reject) => {
      const open=indexedDB.open("flyx-client-v1");open.onerror=()=>reject(open.error);open.onsuccess=()=>{
        const db=open.result;const names=["profiles","commands","drafts"].filter((name)=>db.objectStoreNames.contains(name));const tx=db.transaction(names,"readonly");const counts:Record<string,number>={};
        for(const name of names){const read=tx.objectStore(name).count();read.onsuccess=()=>{counts[name]=read.result;};}
        tx.oncomplete=()=>{db.close();resolve(counts);};tx.onabort=()=>{db.close();reject(tx.error);};
      };
    }));
    expect(Object.values(stored).every((count)=>count===0)).toBe(true);
    await pair(page);
    expect(await page.evaluate(() => localStorage.getItem("flyx:web:automatic-bootstrap:v1"))).toBeNull();
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
