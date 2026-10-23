import type Database from "better-sqlite3";

const hash = /^[a-f0-9]{64}$/;

/**
 * A trusted original SDK result receipt (design §8.2). The anchor is captured
 * from the Provider's actual result event at arrival time; it is never
 * inferred from transcript text, Flyx Turn numbering or CLI version probes.
 */
export type NativeTerminalReceipt = Readonly<{
  sessionId: string;
  turnId: string;
  attemptId: string;
  provider: "claude" | "codex";
  nativeSessionId: string;
  contextDigest: string;
  resultUuid: string;
  resultDigest: string;
  interruptAcknowledged?: true;
}>;

type ReceiptRow = {
  session_id: string; turn_id: string; attempt_id: string; provider: string;
  native_session_id: string; context_digest: string; result_uuid: string; result_digest: string;
  interrupt_acknowledged: number; recorded_at: string;
};

export class NativeTerminalReceiptError extends Error {
  constructor(readonly code: "NATIVE_RECEIPT_INVALID") { super(code); this.name = "NativeTerminalReceiptError"; }
}

function invalid(): never { throw new NativeTerminalReceiptError("NATIVE_RECEIPT_INVALID"); }

/** Durable write/read surface for table `native_terminal_receipts` (migration 012). */
export class NativeTerminalReceiptStore {
  constructor(private readonly db: Database.Database) {}

  /** First receipt per immutable attempt wins; later writes are refusals, never overwrites. */
  record(receipt: NativeTerminalReceipt, at = new Date().toISOString()): void {
    if (receipt.provider !== "claude" && receipt.provider !== "codex") invalid();
    for (const [value, label] of [[receipt.sessionId, "sessionId"], [receipt.turnId, "turnId"], [receipt.attemptId, "attemptId"],
      [receipt.nativeSessionId, "nativeSessionId"], [receipt.resultUuid, "resultUuid"]] as const) {
      if (typeof value !== "string" || !value.trim() || value.length > 256) invalid();
    }
    if (!hash.test(receipt.contextDigest) || !hash.test(receipt.resultDigest)) invalid();
    this.db.prepare(`INSERT INTO native_terminal_receipts
      (session_id,turn_id,attempt_id,provider,native_session_id,context_digest,result_uuid,result_digest,interrupt_acknowledged,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,turn_id,attempt_id) DO NOTHING`)
      .run(receipt.sessionId, receipt.turnId, receipt.attemptId, receipt.provider, receipt.nativeSessionId,
        receipt.contextDigest, receipt.resultUuid, receipt.resultDigest, receipt.interruptAcknowledged === true ? 1 : 0, at);
  }

  find(sessionId: string, turnId: string, attemptId: string): NativeTerminalReceipt | undefined {
    if (typeof sessionId !== "string" || typeof turnId !== "string" || typeof attemptId !== "string") return undefined;
    const row = this.db.prepare(`SELECT * FROM native_terminal_receipts WHERE session_id=? AND turn_id=? AND attempt_id=?`)
      .get(sessionId, turnId, attemptId) as ReceiptRow | undefined;
    if (!row) return undefined;
    if (row.provider !== "claude" && row.provider !== "codex" || !hash.test(String(row.context_digest)) || !hash.test(String(row.result_digest))
      || !String(row.result_uuid).trim() || !String(row.native_session_id).trim()) return undefined;
    return Object.freeze({ sessionId: row.session_id, turnId: row.turn_id, attemptId: row.attempt_id,
      provider: row.provider, nativeSessionId: row.native_session_id, contextDigest: row.context_digest,
      resultUuid: row.result_uuid, resultDigest: row.result_digest,
      ...(row.interrupt_acknowledged === 1 ? { interruptAcknowledged: true as const } : {}) });
  }
}
