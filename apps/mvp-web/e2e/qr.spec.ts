import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const BASE_URL = () => process.env.FLYX_E2E_BASE_URL!;
const PAIRING_TOKEN = () => process.env.FLYX_E2E_PAIRING_TOKEN!;

// Minted by the deterministic Host in global setup and handed to every worker
// through the environment; each token is a one-time pairing grant.
const availableTokens: string[] = JSON.parse(process.env.FLYX_E2E_PAIRING_TOKENS ?? "[]");

/**
 * Claim a dedicated one-time pairing token.  Duplicates the file-counter
 * mechanism from mvp.spec.ts: the counter lives in FLYX_E2E_CLAIM_FILE so it
 * survives Playwright worker restarts and is shared with the other spec files
 * in the same run, keeping every claimed token unconsumed.
 */
function claimToken(): string {
  const claimFile = process.env.FLYX_E2E_CLAIM_FILE;
  if (!claimFile) return availableTokens.shift() ?? PAIRING_TOKEN();
  appendFileSync(claimFile, "x\n");
  const claimed = readFileSync(claimFile, "utf8").split("\n").length - 1;
  return availableTokens[claimed - 1] ?? PAIRING_TOKEN();
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test.describe("QR pairing (design doc 5.7)", () => {
  test("pairing screen renders the scannable QR SVG", async ({ page }) => {
    await page.goto(BASE_URL());
    await expect(page.getByRole("heading", { name: "连接电脑 Host" })).toBeVisible();
    await expect(page.getByTestId("pairing-qr").locator("svg")).toBeVisible({ timeout: 10_000 });
  });

  test("?pair=<token> auto-pairs straight into the Timeline", async ({ page }) => {
    const token = claimToken();
    // This is exactly the URL a phone camera opens after scanning the QR.
    await page.goto(`${BASE_URL()}/?pair=${encodeURIComponent(token)}`);
    await expect(page.getByRole("heading", { name: "执行 Timeline" })).toBeVisible({ timeout: 15_000 });
    // The one-time grant is scrubbed from the address bar after the exchange.
    await expect(page).not.toHaveURL(/pair=/);
  });

  test("the QR endpoint is anonymous and leaks no local paths", async ({ request }) => {
    const response = await request.get(`${BASE_URL()}/api/pairing/qrcode`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/svg+xml");
    const svg = await response.text();
    expect(svg).toContain("<svg");
    // The QR encodes only the pairing URL.  The fixture workspace root (and
    // any other absolute local path) must never appear in the SVG markup,
    // neither must the raw pairing grant itself.
    expect(svg).not.toContain(repoRoot);
    expect(svg).not.toContain("claude-fixtures");
    expect(svg).not.toContain(PAIRING_TOKEN());
  });
});
