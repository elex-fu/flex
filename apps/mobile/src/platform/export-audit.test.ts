import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const { auditSources, inspectHermes } = createRequire(import.meta.url)("../../scripts/verify-native-export.cjs") as {
  auditSources(value: unknown): { mappedModules: number; optionalNodeRandomBridgeMapped: boolean };
  inspectHermes(value: Buffer): { bytes: number; bytecodeVersion: number; sha256: string };
};
function graph() {
  return { version: 3, sources: [
    "/apps/mobile/index.ts", "/apps/mobile/src/platform/install.ts", "/apps/mobile/src/platform/crypto.ts", "/packages/client-core/dist/client.js", "/packages/client-core/dist/session-client.js", "/packages/secure-channel/dist/noble-provider.js", "/node_modules/salty-crypto/dist/salty-crypto.mjs",
  ], sourcesContent: [
    'import "./src/platform/install"; const App = require("./App").default;', "installNativeGlobals({ fill: ExpoCrypto.getRandomValues });", "export function createNativeCrypto() {}", "export class FlyxClient {}", "export class SessionClient {}", "const provider = { chacha20poly1305, blake2s, x25519 };", 'if(crypto&&crypto.getRandomValues) useNative(); else optionalRequire("crypto");',
  ] };
}
describe("actual native export evidence guard", () => {
  it("requires Hermes bytecode rather than a renamed JS file and records its digest", () => {
    const bytes = Buffer.alloc(16); Buffer.from("c61fbc03c103191f", "hex").copy(bytes); bytes.writeUInt32LE(96, 8);
    expect(inspectHermes(bytes)).toMatchObject({ bytes: 16, bytecodeVersion: 96, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(() => inspectHermes(Buffer.from("plain JavaScript"))).toThrow("HERMES_BYTECODE_REQUIRED");
    bytes.writeUInt32LE(97, 8); expect(() => inspectHermes(bytes)).toThrow("HERMES_VERSION_UNVERIFIED");
  });
  it("rejects accidental Node crypto imports, test fixtures, and missing typed client modules", () => {
    expect(auditSources(graph())).toEqual({ mappedModules: 7, optionalNodeRandomBridgeMapped: false });
    const documentation = graph(); documentation.sourcesContent[3] += ' /* Example asset: require("path/to/file") */'; expect(auditSources(documentation)).toMatchObject({ mappedModules: 7 });
    const helper = graph(); helper.sourcesContent[3] = 'import { Buffer } from "buffer";'; expect(() => auditSources(helper)).toThrow("JS_HELPER_SOURCE_REQUIRED"); helper.sources.push("/node_modules/buffer/index.js"); helper.sourcesContent.push("export const Buffer = {}; "); expect(auditSources(helper)).toMatchObject({ mappedModules: 8 });
    const imported = graph(); imported.sourcesContent[3] = 'import { webcrypto } from "node:crypto";'; expect(() => auditSources(imported)).toThrow("NODE_RUNTIME_IMPORT");
    const fixture = graph(); fixture.sources.push("/apps/mobile/src/platform/test-setup.ts"); fixture.sourcesContent.push("fixture"); expect(() => auditSources(fixture)).toThrow("NON_NATIVE_MODULE");
    const missing = graph(); missing.sources.splice(4, 1); missing.sourcesContent.splice(4, 1); expect(() => auditSources(missing)).toThrow("NATIVE_MODULE_REQUIRED");
  });
  it("requires native globals before App and the Salty JS engine’s native random branch", () => {
    const reordered = graph(); reordered.sourcesContent[0] = 'const App = require("./App"); import "./src/platform/install";'; expect(() => auditSources(reordered)).toThrow("NATIVE_GLOBALS_MUST_PRECEDE_APP");
    const browserLoader = graph(); browserLoader.sourcesContent[6] = "WebAssembly.instantiate(bytes)"; expect(() => auditSources(browserLoader)).toThrow("SALTY_NATIVE_RANDOM_BRANCH_REQUIRED");
  });
});
