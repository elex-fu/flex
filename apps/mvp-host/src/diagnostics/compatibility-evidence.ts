import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { assertPrivateDirectory, OperationsError } from "../operations/operation-files.js";

export type NativeCompatibilityEvidence = {
  provider: "claude" | "codex";
  kind: "turn" | "approval" | "interrupt" | "recovery";
  result: "passed" | "failed" | "skipped" | "unsupported";
  nativeEvent: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  nativeRequestId?: string;
  attemptId: string;
  evidenceCode: string;
};

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** Only adapters/recovery inspectors may call this after observing native facts. */
export class CompatibilityEvidenceRecorder {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly enabled = process.env.FLYX_TEST_CONTROLLED_ENTRY === "1", private readonly runId = process.env.FLYX_COMPATIBILITY_RUN_ID) {}
  record(evidence: NativeCompatibilityEvidence): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const task = this.queue.then(async () => {
      await assertPrivateDirectory(dirname(resolve(this.path)));
      if (!/^[a-zA-Z][a-zA-Z0-9._/-]{0,127}$/.test(evidence.nativeEvent)
        || !/^[A-Z][A-Z0-9_]{0,95}$/.test(evidence.evidenceCode) || !evidence.attemptId || !this.runId || !/^[a-zA-Z0-9-]{1,128}$/.test(this.runId)) throw new OperationsError("COMPATIBILITY_EVIDENCE_INVALID");
      const record = {
        v: 1, source: "native", runId: this.runId, provider: evidence.provider, kind: evidence.kind, result: evidence.result,
        nativeEvent: evidence.nativeEvent, evidenceCode: evidence.evidenceCode, attemptIdHash: hash(evidence.attemptId),
        ...(evidence.nativeSessionId ? { nativeSessionIdHash: hash(evidence.nativeSessionId) } : {}),
        ...(evidence.nativeTurnId ? { nativeTurnIdHash: hash(evidence.nativeTurnId) } : {}),
        ...(evidence.nativeRequestId ? { nativeRequestIdHash: hash(evidence.nativeRequestId) } : {}),
        at: new Date().toISOString(),
      };
      const file = await open(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new OperationsError("OPERATIONS_UNSAFE_FILE");
        await file.writeFile(JSON.stringify(record) + "\n");
        await file.sync();
      } finally { await file.close(); }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  async drain(): Promise<void> { await this.queue; }
}
