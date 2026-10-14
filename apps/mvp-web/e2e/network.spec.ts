import { expect, test } from "@playwright/test";
import { encodeDirectPairingFragment, type HostDescriptorV1 } from "@flyx/mvp-protocol";
import { baseUrl, claimToken, pair, sendPrompt, waitForIdle } from "./helpers";

test.describe("Host identity and transport-neutral Web", () => {
  test("#pair pins the Host and removes its grant before the exchange request", async ({ page, request }) => {
    const descriptorResponse = await request.get(`${baseUrl()}/.well-known/flyx-host`);
    expect(descriptorResponse.ok()).toBe(true);
    const descriptor = await descriptorResponse.json() as HostDescriptorV1;
    const fragment = encodeDirectPairingFragment({
      v: 1,
      hostId: descriptor.hostId,
      hostPublicKey: descriptor.hostPublicKey,
      signingPublicKey: descriptor.signingPublicKey,
      fingerprint: descriptor.fingerprint,
      endpoint: baseUrl(),
      grant: claimToken(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    let locationAtExchange: string | undefined;
    await page.route("**/api/pairing/exchange", async (route) => {
      locationAtExchange = await page.evaluate(() => window.location.href);
      await route.continue();
    });
    await page.goto(`${baseUrl()}/${fragment}`);
    await expect(page.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 15_000 });
    expect(locationAtExchange).toBe(`${baseUrl()}/`);
    await page.getByText("连接与设备", { exact: true }).click();
    await expect(page.getByTestId("host-fingerprint")).toHaveAttribute("title", descriptor.fingerprint);
    await expect(page.getByTestId("security-level")).toContainText("HttpOnly 浏览器会话。凭据不能由页面脚本直接读取。");
  });

  test("Direct bootstrap, snapshot, Timeline and Diff use RPC without business HTTP", async ({ page }) => {
    const forbiddenRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/(?:bootstrap|snapshot|status)(?:\?|$)|\/api\/session\/[^/]+\/(?:timeline|diff)/.test(request.url())) forbiddenRequests.push(request.url());
    });
    await pair(page);
    await sendPrompt(page, "scenario:text");
    await waitForIdle(page);
    await expect(page.getByText("deterministic result: text scenario completed").last()).toBeVisible();
    await page.getByRole("button", { name: "查看 Diff" }).click();
    await expect(page.getByRole("heading", { name: "Workspace Diff" })).toBeVisible();
    await page.reload();
    await expect(page.getByText("deterministic result: text scenario completed").last()).toBeVisible();
    expect(forbiddenRequests).toEqual([]);
  });

  test("device management lists this browser and self-revocation closes its lease", async ({ page }) => {
    await pair(page);
    await page.getByText("连接与设备", { exact: true }).click();
    await page.getByRole("button", { name: "管理设备" }).click();
    await expect(page.getByRole("region", { name: "已配对设备" })).toBeVisible();
    await expect(page.getByRole("button", { name: "撤销本设备" })).toBeEnabled();
    await page.getByRole("button", { name: "撤销本设备" }).click();
    await expect(page.getByRole("heading", { name: "连接电脑 Host" })).toBeVisible();
    const ticketStatus = await page.evaluate(async () => (await fetch("/api/auth/websocket-ticket", { method: "POST" })).status);
    expect(ticketStatus).toBe(401);
    await page.reload();
    await expect(page.getByRole("heading", { name: "连接电脑 Host" })).toBeVisible();
  });

  test("a malformed Relay offer is scrubbed and fails before contacting Host HTTP APIs", async ({ page }) => {
    const apiRequests: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url()); });
    await page.goto(`${baseUrl()}/#offer=invalid-offer`);
    await expect(page).toHaveURL(`${baseUrl()}/`);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading", { name: "执行 Timeline" })).toHaveCount(0);
    expect(apiRequests).toEqual([]);
  });

  test("production page enforces Trusted Types and loads no third-party scripts", async ({ page }) => {
    const response = await page.goto(baseUrl());
    const policy = response?.headers()["content-security-policy"];
    expect(policy).toContain("require-trusted-types-for 'script'");
    expect(policy).toContain("trusted-types 'none'");
    const result = await page.evaluate(() => {
      let unsafeHtmlBlocked = false;
      try { document.createElement("div").innerHTML = "<b>untrusted</b>"; }
      catch (error) { unsafeHtmlBlocked = error instanceof TypeError; }
      return { unsafeHtmlBlocked, foreignScripts: [...document.scripts].map((script) => script.src).filter((src) => src && new URL(src).origin !== window.location.origin) };
    });
    expect(result.unsafeHtmlBlocked).toBe(true);
    expect(result.foreignScripts).toEqual([]);
  });
});
