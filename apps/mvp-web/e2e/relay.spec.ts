import { expect, test } from "@playwright/test";
import { sendPrompt, waitForIdle } from "./helpers";
import { NETWORK_FIXTURE_CHROMIUM_ARGS, startNetworkHost, type NetworkFixture } from "./network-host";

// The deterministic fixture uses one embedded local certificate. Restrict
// Chromium's trust exception to that certificate's SPKI; the app still
// requires WSS and verifies the pinned Noise/descriptor identity on every
// connection. Do not use ignoreHTTPSErrors, which would trust arbitrary certs.
test.use({ launchOptions: { args: [...NETWORK_FIXTURE_CHROMIUM_ARGS] } });

function pairingUrl(fixture: NetworkFixture, index: number): string {
  const offer = fixture.offers[index]!;
  return offer.startsWith("https://") ? offer : `${fixture.appUrl}/${offer}`;
}

test.describe("Hosted Web through the real E2EE Relay", () => {
  let network: Awaited<ReturnType<typeof startNetworkHost>>;
  test.beforeAll(async () => { network = await startNetworkHost(); });
  test.afterAll(async () => { await network?.stop(); });

  test("pair, stream, approve, recover, switch endpoints and remotely revoke an active browser", async ({ browser }) => {
    test.setTimeout(120_000);
    const ownerContext = await browser.newContext();
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const owner = await ownerContext.newPage();
    const phone = await phoneContext.newPage();
    const forbiddenBusinessHttp: string[] = [];
    owner.on("request", (request) => {
      if (/\/api\/(?:bootstrap|snapshot|status)(?:\?|$)|\/api\/session\/[^/]+\/(?:timeline|diff)/.test(request.url())) forbiddenBusinessHttp.push(request.url());
    });
    try {
      // Make the actual Host HTTP origin unreachable while validating Relay.
      await owner.route(`${network.fixture.hostUrl}/**`, (route) => route.abort());
      await owner.goto(pairingUrl(network.fixture, 0));
      await expect(owner.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 20_000 });
      await expect(owner).toHaveURL(`${network.fixture.appUrl}/`);
      await owner.getByText("连接与设备", { exact: true }).click();
      await expect(owner.getByTestId("host-fingerprint")).toHaveAttribute("title", network.fixture.fingerprint);
      await expect(owner.getByTestId("security-level")).toContainText("Relay 可见连接元数据");
      await sendPrompt(owner, "scenario:text");
      await expect(owner.getByText("deterministic result: text scenario completed").last()).toBeVisible();
      await waitForIdle(owner);
      await sendPrompt(owner, "scenario:approval");
      const approval = owner.locator("article.approval").filter({ has: owner.getByRole("button", { name: "允许一次" }) }).last();
      await approval.getByRole("button", { name: "允许一次" }).click();
      await expect(owner.getByText("deterministic result: approval scenario completed").last()).toBeVisible();
      await waitForIdle(owner);
      await owner.getByRole("button", { name: "查看 Diff" }).click();
      await expect(owner.getByRole("heading", { name: "Workspace Diff" })).toBeVisible();

      // Reload destroys the memory static key. A bounded refresh credential
      // rebinds a new key, then IK restores the same Host and Timeline.
      await owner.reload();
      await expect(owner.getByText("deterministic result: approval scenario completed").last()).toBeVisible({ timeout: 20_000 });
      await waitForIdle(owner);
      await sendPrompt(owner, "scenario:slow");
      await ownerContext.setOffline(true);
      await owner.waitForTimeout(1_000);
      await ownerContext.setOffline(false);
      await expect(owner.getByText("deterministic result: slow scenario completed").last()).toBeVisible({ timeout: 20_000 });
      await waitForIdle(owner);
      expect(forbiddenBusinessHttp).toEqual([]);

      // Re-enable the pinned HTTPS alternative and switch both directions.
      await owner.unroute(`${network.fixture.hostUrl}/**`);
      await owner.getByText("连接与设备", { exact: true }).click();
      const direct = owner.locator("li.endpoint").filter({ hasText: /Direct|Tailscale/ });
      await direct.getByRole("button", { name: "使用此路径" }).click();
      await expect(direct).toHaveClass(/active/, { timeout: 20_000 });
      await expect(owner.getByRole("status")).toHaveText("已同步");
      await expect(owner.getByTestId("host-fingerprint")).toHaveAttribute("title", network.fixture.fingerprint);
      const relay = owner.locator("li.endpoint").filter({ hasText: "Relay" });
      await relay.getByRole("button", { name: "使用此路径" }).click();
      await expect(relay).toHaveClass(/active/, { timeout: 20_000 });

      await phone.goto(pairingUrl(network.fixture, 1));
      await expect(phone.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 20_000 });
      await owner.getByRole("button", { name: "管理设备" }).click();
      const remoteDevice = owner.locator(".device-list li").filter({ hasNotText: "本设备" });
      await expect(remoteDevice).toHaveCount(1);
      await remoteDevice.getByRole("button", { name: "撤销设备", exact: true }).click();
      await expect(phone.getByRole("heading", { name: "连接电脑 Host" })).toBeVisible({ timeout: 10_000 });
      await expect(owner.getByRole("status")).toHaveText("已同步");
      await expect(owner.getByText("deterministic result: slow scenario completed").last()).toHaveCount(1);
    } finally { await ownerContext.close(); await phoneContext.close(); }
  });
});
