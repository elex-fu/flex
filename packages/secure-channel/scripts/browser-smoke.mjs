import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createNoiseResponder, generateNoiseKeyPair } from "../dist/index.js";

// The workspace Web app owns the browser test runtime and browser installation.
const webRequire = createRequire(new URL("../../../apps/mvp-web/package.json", import.meta.url));
const { chromium } = webRequire("@playwright/test");
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
  bundle: true, platform: "browser", format: "iife", globalName: "FlyxSecure",
  minify: true, write: false,
});
const script = bundle.outputFiles[0].text;
const server = createServer((request, response) => {
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'none'; base-uri 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", request.url === "/noise.js" ? "text/javascript" : "text/html");
  response.end(request.url === "/noise.js" ? script : '<!doctype html><script src="/noise.js"></script>');
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.evaluate(() => typeof process === "undefined" && typeof Buffer === "undefined" && typeof require === "undefined"), true);
  for (const pattern of ["NK", "IK"]) {
    const host = await generateNoiseKeyPair();
    const binding = { hostId: "host-browser-smoke", routeId: "browser-smoke-route-0123456789abcdef", connectionId: `browser-smoke-connection-${pattern}`, protocol: { min: 2, max: 2 } };
    const responder = await createNoiseResponder({ pattern, binding, staticKey: host.secretKey, limits: { rekeyAfterMessages: 2 } });
    const initial = await page.evaluate(async ({ pattern, binding, publicKey }) => {
      const device = await FlyxSecure.generateNoiseKeyPair();
      window.smokeHandshake = await FlyxSecure.createNoiseInitiator({ pattern, binding,
        remoteStaticKey: Uint8Array.from(publicKey), ...(pattern === "IK" ? { staticKey: device.secretKey } : {}),
        limits: { rekeyAfterMessages: 2 } });
      return { frame: Array.from(window.smokeHandshake.writeMessage()), devicePublicKey: Array.from(device.publicKey) };
    }, { pattern, binding, publicKey: Array.from(host.publicKey) });
    responder.readMessage(Uint8Array.from(initial.frame));
    const response = responder.writeMessage();
    await page.evaluate((frame) => {
      window.smokeHandshake.readMessage(Uint8Array.from(frame));
      window.smokeSession = window.smokeHandshake.finish();
      delete window.smokeHandshake;
    }, Array.from(response));
    const session = responder.finish();
    if (pattern === "IK") assert.deepEqual(Array.from(session.remoteStaticKey), initial.devicePublicKey);
    for (let index = 0; index < 5; index += 1) {
      const length = index === 4 ? 256 * 1024 : 80;
      const encrypted = await page.evaluate(({ length, value }) => Array.from(window.smokeSession.encrypt(new Uint8Array(length).fill(value))), { length, value: index + 1 });
      const plaintext = session.decrypt(Uint8Array.from(encrypted));
      assert.equal(plaintext.byteLength, length);
      assert(plaintext.every((value) => value === index + 1));
    }
    assert.equal(session.counters.receiveEpoch, 2);
    const reply = session.encrypt(new TextEncoder().encode("node-to-browser"));
    assert.equal(await page.evaluate((frame) => new TextDecoder().decode(window.smokeSession.decrypt(Uint8Array.from(frame))), Array.from(reply)), "node-to-browser");
    const tampered = session.encrypt(new Uint8Array([1, 2, 3]));
    tampered[tampered.length - 1] ^= 1;
    assert.equal(await page.evaluate((frame) => {
      try { window.smokeSession.decrypt(Uint8Array.from(frame)); return "accepted"; }
      catch (error) { return `${error.code}:${window.smokeSession.destroyed}`; }
    }, Array.from(tampered)), "AUTHENTICATION_FAILED:true");
    session.destroy(); responder.destroy(); host.secretKey.fill(0);
    results.push(`${pattern}: browser↔Node, maximum frame, rekey, tamper-close passed`);
  }
  process.stdout.write(JSON.stringify({ browser: browser.version(), browserBundleBytes: bundle.outputFiles[0].contents.length,
    csp: "no unsafe-eval; no external connections", results }, null, 2) + "\n");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
