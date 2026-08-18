import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Build output contains compiled `*.test.js` files as well.  Running
    // those copies makes the result depend on whether a previous build was
    // performed and can execute stale tests twice; product tests are the
    // TypeScript sources under src/.
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**"],
  },
});
