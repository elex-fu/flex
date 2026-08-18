import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolvePathForCheck } from "./adapter.js";

describe("Claude adapter workspace path invariant", () => {
  it("rejects parent segments before normalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "flyx-path-"));
    try {
      expect(await resolvePathForCheck("sub/../outside.txt", root)).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes an existing symlink before checking the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "flyx-path-"));
    const outside = await mkdtemp(join(tmpdir(), "flyx-outside-"));
    try {
      await mkdir(join(root, "links"));
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(root, "links", "outside"));
      const resolved = await resolvePathForCheck(join(root, "links", "outside", "secret.txt"), resolve(root));
      expect(resolved).toBe(await realpath(join(root, "links", "outside", "secret.txt")));
      expect(resolved === root || resolved.startsWith(`${root}/`)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
