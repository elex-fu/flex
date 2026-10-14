import { describe, it, expect } from "vitest";
import { WorktreeRequestSchema, WorktreeRefSchema } from "./worktree-api.js";
describe("managed worktree resource contracts", () => {
  it("accepts only registered repository IDs, generated worktree IDs and validated refs", () => {
    expect(WorktreeRequestSchema.parse({ kind: "create", repositoryId: "registered" })).toMatchObject({ ref: "HEAD", branchMode: "detached" });
    for (const ref of ["--upload-pack=evil", "../repo", "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/a//b", "main", "HEAD~2", "refs/heads/x;touch"]) expect(WorktreeRefSchema.safeParse(ref).success).toBe(false);
    expect(WorktreeRefSchema.safeParse("refs/heads/main").success).toBe(true);
    expect(WorktreeRefSchema.safeParse("a".repeat(40)).success).toBe(true);
    expect(WorktreeRequestSchema.safeParse({ kind: "create", repositoryId: "registered", path: "/etc" }).success).toBe(false);
    expect(WorktreeRequestSchema.safeParse({ kind: "archive", worktreeId: "/etc", expectedRevision: 1 }).success).toBe(false);
  });
});
