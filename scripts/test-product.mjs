import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFixtureRepository } from "./provision-fixture-workspace.mjs";
import { runPnpm } from "./verification-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await ensureFixtureRepository();
runPnpm(["test:tooling"], root);
// Workspace exports resolve to dist. Build the shared test dependencies in this
// checkout so product tests work both before and after a production build.
runPnpm(["--filter", "@flyx/mvp-protocol", "--filter", "@flyx/secure-channel", "--filter", "@flyx/client-core",
  "--filter", "@flyx/mvp-relay", "-r", "build"], root);
runPnpm(["--filter", "@flyx/*", "--filter", "!@flyx/claude-fixtures", "-r", "--if-present", "test"], root);
