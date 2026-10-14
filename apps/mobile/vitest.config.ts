import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "../../packages/secure-channel/src/**/*.test.ts"], setupFiles: ["src/platform/test-setup.ts"], exclude: ["dist/**"] }, resolve: { alias: {
  "@flyx/client-core": path.resolve(import.meta.dirname, "../../packages/client-core/src/index.ts"),
  "@flyx/mvp-protocol": path.resolve(import.meta.dirname, "../../packages/mvp-protocol/src/index.ts"),
  "@flyx/secure-channel": path.resolve(import.meta.dirname, "../../packages/secure-channel/src/index.ts"),
} } });
