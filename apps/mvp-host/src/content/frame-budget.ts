import { MAX_APPLICATION_FRAME_BYTES } from "@flyx/mvp-protocol";

export const DEFAULT_RESPONSE_BUDGET_BYTES = 192 * 1024;
export class FrameBudgetError extends Error {
  readonly code = "RESPONSE_TOO_LARGE";
  readonly retryable = false;
  constructor() { super("Response exceeds the negotiated byte budget"); this.name = "FrameBudgetError"; }
}

/** Every measurement includes JSON escaping and the complete application envelope. */
export class FrameBudget {
  readonly maxFrameBytes: number;
  readonly limit: number;
  constructor(options: { maxFrameBytes?: number; responseBytes?: number } = {}) {
    this.maxFrameBytes = Math.min(MAX_APPLICATION_FRAME_BYTES, positive(options.maxFrameBytes ?? MAX_APPLICATION_FRAME_BYTES));
    this.limit = Math.min(this.maxFrameBytes, positive(options.responseBytes ?? DEFAULT_RESPONSE_BUDGET_BYTES));
  }
  bytes(frame: unknown): number {
    const encoded = JSON.stringify(frame);
    if (encoded === undefined) throw new FrameBudgetError();
    return Buffer.byteLength(encoded, "utf8");
  }
  fits(frame: unknown): boolean { return this.bytes(frame) <= this.limit; }
  assert(frame: unknown): void { if (!this.fits(frame)) throw new FrameBudgetError(); }
  encode(frame: unknown): string { this.assert(frame); return JSON.stringify(frame); }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Invalid frame budget");
  return value;
}

export function utf8Prefix(value: string, maxBytes: number): string {
  const data = Buffer.from(value, "utf8");
  return data.subarray(0, utf8End(data, Math.min(data.length, maxBytes))).toString("utf8");
}

/** data must include the byte following end when a larger input exists. */
export function utf8End(data: Uint8Array, end: number): number {
  while (end > 0 && end < data.length && (data[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}
