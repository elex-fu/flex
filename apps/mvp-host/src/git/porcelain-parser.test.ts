import { describe, expect, it } from "vitest";
import { parsePorcelainV1Z } from "./porcelain-parser.js";

describe("porcelain v1 NUL status records", () => {
  it("preserves rename/copy destinations and source metadata from either status column", () => {
    const parsed = parsePorcelainV1Z("## main...origin/main [ahead 1]\0R  Renamed README.md\0README.md\0 C 复制 空格.txt\0source -> file.txt\0 M 普通 文件.txt\0");
    expect(parsed.branch).toBe("main");
    expect(parsed.unborn).toBe(false);
    expect(parsed.files).toEqual([
      { index: "R", worktree: " ", path: "Renamed README.md", originalPath: "README.md" },
      { index: " ", worktree: "C", path: "复制 空格.txt", originalPath: "source -> file.txt" },
      { index: " ", worktree: "M", path: "普通 文件.txt" },
    ]);
  });

  it("keeps unquoted whitespace, newlines and Unicode filename bytes", () => {
    const path = '  weird\n名字\t"quote"\\file.txt';
    const originalPath = "## source\nname";
    expect(parsePorcelainV1Z(` R ${path}\0${originalPath}\0?? next file\0`).files).toEqual([
      { index: " ", worktree: "R", path, originalPath },
      { index: "?", worktree: "?", path: "next file" },
    ]);
  });

  it("limits complete records rather than NUL fields and consumes discarded rename sources", () => {
    const records = Array.from({ length: 201 }, (_, index) => `R  new-${index}\0old-${index}\0`).join("");
    const parsed = parsePorcelainV1Z(`## main\0${records}`, 200);
    expect(parsed.files).toHaveLength(200);
    expect(parsed.files.at(-1)).toEqual({ index: "R", worktree: " ", path: "new-199", originalPath: "old-199" });
    expect(parsed.filesTruncated).toBe(true);
    expect(parsed.dirty).toBe(true);
    expect(parsePorcelainV1Z(`## main\0${records}`, 201).filesTruncated).toBe(false);
    expect(parsePorcelainV1Z("?? hidden-by-limit\0", 0)).toMatchObject({ files: [], dirty: true, filesTruncated: true });
  });

  for (const header of ["No commits yet on main", "Initial commit on main"]) {
    it(`recognizes unborn branch header: ${header}`, () => {
      expect(parsePorcelainV1Z(`## ${header}\0A  first.txt\0`)).toMatchObject({ branch: "main", unborn: true, dirty: true });
    });
  }

  it("parses clean, detached, untracked and unmerged status without losing the first file", () => {
    expect(parsePorcelainV1Z("## HEAD (no branch)\0")).toMatchObject({ branch: "HEAD (no branch)", dirty: false, unborn: false, files: [] });
    expect(parsePorcelainV1Z("UU conflict.txt\0?? untracked.txt\0").files).toEqual([
      { index: "U", worktree: "U", path: "conflict.txt" },
      { index: "?", worktree: "?", path: "untracked.txt" },
    ]);
    expect(parsePorcelainV1Z("").filesTruncated).toBe(false);
  });

  for (const output of [" M truncated", "R  missing-source\0", "R  destination\0\0", "?? \0", "Z  invalid\0", "?? valid\0\0"]) {
    it(`rejects incomplete/malformed records: ${JSON.stringify(output)}`, () => {
      expect(() => parsePorcelainV1Z(output)).toThrow();
    });
  }
});
