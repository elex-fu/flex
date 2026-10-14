import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "./jsonl-decoder.js";

describe("bounded native JSONL", () => {
  it("enforces the byte cap before receiving newline and frees retained chunks", () => {
    const lines: string[] = []; const errors: string[] = [];
    const decoder = new JsonlDecoder(8, (line) => lines.push(line), (error) => errors.push(error.message));
    decoder.write(Buffer.from("12345678")); expect(decoder.bufferedBytes).toBe(8);
    decoder.write(Buffer.from("9")); expect(decoder.bufferedBytes).toBe(0);
    decoder.write(Buffer.from("\n{}\n"));
    expect(lines).toEqual([]); expect(errors).toEqual(["CODEX_JSONL_FRAME_TOO_LARGE"]);
  });
  it("supports UTF8 split at every byte and multiple lines in one chunk", () => {
    const lines: string[] = []; const errors: Error[] = [];
    const decoder = new JsonlDecoder(64, (line) => lines.push(line), (error) => errors.push(error));
    for (const byte of Buffer.from('{"text":"你好🌍"}\n')) decoder.write(Buffer.from([byte]));
    decoder.write(Buffer.from("{}\n[]\n")); decoder.end();
    expect(lines).toEqual(['{"text":"你好🌍"}', "{}", "[]"]); expect(errors).toEqual([]);
  });
  it("rejects invalid UTF8 and truncated final JSONL", () => {
    const errors: string[] = [];
    new JsonlDecoder(8, () => {}, (error) => errors.push(error.message)).write(Buffer.from([0xff, 10]));
    const decoder = new JsonlDecoder(8, () => {}, (error) => errors.push(error.message));
    decoder.write(Buffer.from("{}")); decoder.end();
    expect(errors).toEqual(["CODEX_JSONL_INVALID_UTF8_OR_FRAME", "CODEX_JSONL_TRUNCATED_FRAME"]);
  });
});
