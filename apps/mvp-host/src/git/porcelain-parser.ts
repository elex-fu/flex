export type GitStatusFile = {
  path: string;
  index: string;
  worktree: string;
  originalPath?: string;
};

export type ParsedPorcelainStatus = {
  branch?: string;
  unborn: boolean;
  dirty: boolean;
  files: GitStatusFile[];
  filesTruncated: boolean;
};

/** Parse complete `git status --porcelain=v1 -z` records, optionally with --branch. */
export function parsePorcelainV1Z(output: string, maxFiles = Number.MAX_SAFE_INTEGER): ParsedPorcelainStatus {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new Error("Invalid Git status file limit");
  if (output && !output.endsWith("\0")) throw new Error("Incomplete Git porcelain status record");
  const fields = output ? output.slice(0, -1).split("\0") : [];
  let cursor = 0;
  let branch: string | undefined;
  let unborn = false;
  const header = fields[0];
  if (header?.startsWith("## ")) {
    const description = header.slice(3);
    unborn = description.startsWith("No commits yet on ") || description.startsWith("Initial commit on ");
    branch = description.replace(/^(?:No commits yet on |Initial commit on )/, "").split("...")[0];
    if (!branch) throw new Error("Invalid Git porcelain branch header");
    cursor++;
  }

  const files: GitStatusFile[] = [];
  let fileCount = 0;
  while (cursor < fields.length) {
    const field = fields[cursor++]!;
    if (field.length < 4 || field[2] !== " " || !/^[ MADRCUT?!]{2}$/.test(field.slice(0, 2))) {
      throw new Error("Invalid Git porcelain status record");
    }
    const index = field[0]!;
    const worktree = field[1]!;
    const path = field.slice(3);
    // -z puts the destination first, then the unadorned source path in its
    // own NUL field. Either status column can describe a rename or copy.
    const moved = index === "R" || index === "C" || worktree === "R" || worktree === "C";
    const originalPath = moved ? fields[cursor++] : undefined;
    if (moved && !originalPath) throw new Error("Incomplete Git porcelain rename/copy record");
    fileCount++;
    if (files.length < maxFiles) {
      files.push({ path, index, worktree, ...(originalPath !== undefined ? { originalPath } : {}) });
    }
  }
  return { ...(branch ? { branch } : {}), unborn, dirty: fileCount > 0, files, filesTruncated: fileCount > maxFiles };
}
