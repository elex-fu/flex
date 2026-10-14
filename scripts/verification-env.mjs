import { spawnSync } from "node:child_process";

const REAL_PROVIDER_FLAGS = [
  "RUN_REAL_CLAUDE_SPIKE", "RUN_REAL_CLAUDE_FLOW", "RUN_REAL_INTERRUPT",
  "RUN_REAL_CODEX_SPIKE", "RUN_REAL_CODEX_FLOW",
];

/** Product verification is deterministic even when the caller opted into a spike. */
export function verificationEnvironment(base = process.env) {
  const env = { ...base };
  for (const key of [...REAL_PROVIDER_FLAGS, ...Object.keys(env).filter((key) => key.startsWith("RUN_REAL_"))]) {
    env[key] = "0";
  }
  return env;
}

export function runPnpm(args, cwd, { capture = false } = {}) {
  const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    cwd, env: verificationEnvironment(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("pnpm " + args.join(" ") + " failed (exit " + result.status + ")" +
      (capture ? "\n" + result.stdout + result.stderr : ""));
  }
  return result.stdout;
}
