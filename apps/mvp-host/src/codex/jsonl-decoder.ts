/** Limits the buffered bytes during receipt, before readline could allocate an unbounded line. */
export class JsonlDecoder {
  private chunks: Buffer[] = [];
  private size = 0;
  private failed = false;
  constructor(private readonly maxBytes: number, private readonly onLine: (line: string) => void, private readonly onError: (error: Error) => void) {}
  write(chunk: Buffer): void {
    if (this.failed) return;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const part = chunk.subarray(offset, end);
      if (this.size + part.byteLength > this.maxBytes) { this.fail("CODEX_JSONL_FRAME_TOO_LARGE"); return; }
      // Copy only the bounded portion; a tiny slice must not retain a large input Buffer.
      if (part.byteLength) { this.chunks.push(Buffer.from(part)); this.size += part.byteLength; }
      if (newline < 0) return;
      const bytes = Buffer.concat(this.chunks, this.size);
      this.chunks = []; this.size = 0;
      try { this.onLine(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { this.fail("CODEX_JSONL_INVALID_UTF8_OR_FRAME"); return; }
      if (this.failed) return;
      offset = newline + 1;
    }
  }
  end(): void { if (this.size) this.fail("CODEX_JSONL_TRUNCATED_FRAME"); }
  get bufferedBytes(): number { return this.size; }
  private fail(code: string): void { this.failed = true; this.chunks = []; this.size = 0; this.onError(new Error(code)); }
}
