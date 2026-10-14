// Build-time inspection only; this module must never enter the Expo app graph.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const nodeBuiltins = new Set(require("node:module").builtinModules);
// These are explicit RN-compatible JavaScript packages, not Node runtime APIs.
const mappedJsHelpers = new Set(["buffer", "punycode", "assert"]);
const HERMES_MAGIC = "c61fbc03c103191f";
const HERMES_VERSION = 96; // Expo SDK 54 / React Native 0.81.5.
function requireFact(condition, message) { if (!condition) throw new Error(message); }
function auditSources(map) {
  requireFact(map.version === 3 && Array.isArray(map.sources) && Array.isArray(map.sourcesContent) && map.sources.length === map.sourcesContent.length, "SOURCE_MAP_REQUIRED");
  const sources = new Map();
  for (let index = 0; index < map.sources.length; index++) {
    const name = map.sources[index], content = map.sourcesContent[index];
    requireFact(typeof name === "string" && typeof content === "string", "SOURCE_CONTENT_REQUIRED");
    requireFact(!sources.has(name), "DUPLICATE_SOURCE_MODULE");
    requireFact(!/(?:\.test\.[cm]?[jt]sx?$|test-setup\.[jt]s$|\/apps\/mobile\/scripts\/|\/packages\/(?:mvp-host|mvp-relay)\/|crypto-browserify|node-libs|node:crypto)/.test(name), "NON_NATIVE_MODULE: " + name);
    const imports = content.matchAll(/(?:from\s*|require\(\s*|import\(\s*)["']([^"']+)["']/g);
    for (const match of imports) {
      const specifier = match[1];
      requireFact(!specifier.startsWith("node:") && (!nodeBuiltins.has(specifier) || mappedJsHelpers.has(specifier)), "NODE_RUNTIME_IMPORT: " + name + " -> " + specifier);
      if (mappedJsHelpers.has(specifier)) requireFact(map.sources.some((source) => typeof source === "string" && source.includes("/node_modules/" + specifier + "/")), "JS_HELPER_SOURCE_REQUIRED: " + specifier);
    }
    sources.set(name, content);
  }
  const module = (suffix) => {
    const entries = [...sources].filter(([name]) => name.endsWith(suffix));
    requireFact(entries.length === 1, "NATIVE_MODULE_REQUIRED: " + suffix);
    return entries[0][1];
  };
  const entry = module("/apps/mobile/index.ts");
  const install = entry.search(/import\s*["']\.\/src\/platform\/install["']/);
  const app = entry.search(/require\(\s*["']\.\/App["']/);
  requireFact(install >= 0 && app > install, "NATIVE_GLOBALS_MUST_PRECEDE_APP");
  requireFact(module("/apps/mobile/src/platform/install.ts").includes("ExpoCrypto.getRandomValues"), "EXPO_NATIVE_CSPRNG_REQUIRED");
  requireFact(module("/apps/mobile/src/platform/crypto.ts").includes("createNativeCrypto"), "NATIVE_CRYPTO_PROVIDER_REQUIRED");
  module("/packages/client-core/dist/client.js");
  module("/packages/client-core/dist/session-client.js");
  const noble = module("/packages/secure-channel/dist/noble-provider.js");
  requireFact(noble.includes("chacha20poly1305") && noble.includes("blake2s") && noble.includes("x25519"), "SHARED_NOISE_PROVIDER_REQUIRED");
  const salty = module("/node_modules/salty-crypto/dist/salty-crypto.mjs");
  requireFact(!salty.includes("WebAssembly") && /if\s*\(\s*crypto\s*&&\s*crypto\.getRandomValues\s*\)/.test(salty), "SALTY_NATIVE_RANDOM_BRANCH_REQUIRED");
  return { mappedModules: sources.size, optionalNodeRandomBridgeMapped: [...sources.keys()].some((name) => name.endsWith("/apps/mobile/src/platform/node-random.ts")) };
}
function inspectHermes(bytes) {
  requireFact(bytes.length >= 12 && bytes.subarray(0, 8).toString("hex") === HERMES_MAGIC, "HERMES_BYTECODE_REQUIRED");
  const version = bytes.readUInt32LE(8);
  requireFact(version === HERMES_VERSION, "HERMES_VERSION_UNVERIFIED: " + version);
  return { bytes: bytes.length, bytecodeVersion: version, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function auditNativeExport(directory) {
  const root = path.resolve(directory);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "metadata.json"), "utf8"));
  requireFact(metadata.version === 0 && metadata.bundler === "metro", "METRO_EXPORT_REQUIRED");
  const bundles = [];
  for (const platform of ["android", "ios"]) {
    const relative = metadata.fileMetadata?.[platform]?.bundle;
    requireFact(typeof relative === "string" && relative.endsWith(".hbc") && !path.isAbsolute(relative), "PLATFORM_HERMES_BUNDLE_REQUIRED: " + platform);
    const bundle = path.resolve(root, relative);
    requireFact(bundle.startsWith(root + path.sep), "EXPORT_PATH_ESCAPE");
    const bytecode = inspectHermes(fs.readFileSync(bundle));
    const graph = auditSources(JSON.parse(fs.readFileSync(bundle + ".map", "utf8")));
    bundles.push({ platform, path: bundle, ...bytecode, ...graph });
  }
  return { bundler: "metro", nativeDeviceExecutionVerified: false, bundles };
}
module.exports = { auditSources, inspectHermes, auditNativeExport };
if (require.main === module) {
  try {
    requireFact(process.argv.length === 3, "Usage: node scripts/verify-native-export.cjs <export-directory>");
    process.stdout.write(JSON.stringify(auditNativeExport(process.argv[2]), null, 2) + "\n");
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : "NATIVE_EXPORT_AUDIT_FAILED") + "\n"); process.exitCode = 1; }
}
