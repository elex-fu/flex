import { ContentRefSchema, type ContentRef } from "@flyx/mvp-protocol";
import { isRecord } from "./timeline.js";
export interface WebWorkspaceDiff {
  branch?: string; head?: string; dirty?: boolean; files: Array<{ path: string }>;
  diff: string; truncated: boolean; bounded: boolean; requiresUpgrade: boolean;
  baselineWarning?: string; payloadRef?: ContentRef; diffRef?: ContentRef;
  payloadLoaded?: boolean; diffLoaded?: boolean;
}
/** A payloadRef envelope is a loading state, not an empty/full Diff. */
export function parseWorkspaceDiff(value: unknown): WebWorkspaceDiff {
  if (!isRecord(value)) throw new Error("DIFF_RESPONSE_INVALID");
  const marker = isRecord(value.boundedContent) ? value.boundedContent : undefined;
  const payloadRef = value.payloadRef ? ContentRefSchema.parse(value.payloadRef) : undefined;
  const diffRef = value.diffRef ? ContentRefSchema.parse(value.diffRef) : undefined;
  if (!payloadRef && (typeof value.diff !== "string" || !Array.isArray(value.files) || typeof value.dirty !== "boolean")) {
    if (marker?.truncated !== true) throw new Error("DIFF_RESPONSE_INVALID");
  }
  const files = Array.isArray(value.files) ? value.files.map((file) => { if (!isRecord(file) || typeof file.path !== "string") throw new Error("DIFF_RESPONSE_INVALID"); return { path: file.path }; }) : [];
  return { files, diff: typeof value.diff === "string" ? value.diff : "", truncated: value.truncated === true, bounded: marker?.truncated === true, requiresUpgrade: marker?.requiresUpgrade === true,
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}), ...(typeof value.head === "string" ? { head: value.head } : {}), ...(typeof value.dirty === "boolean" ? { dirty: value.dirty } : {}),
    ...(typeof value.baselineWarning === "string" ? { baselineWarning: value.baselineWarning } : {}), ...(payloadRef ? { payloadRef } : {}), ...(diffRef ? { diffRef } : {}) };
}
export async function expandWorkspaceDiff(value: WebWorkspaceDiff, read: (ref: ContentRef) => Promise<string>): Promise<WebWorkspaceDiff> {
  if (value.payloadRef) return { ...parseWorkspaceDiff(JSON.parse(await read(value.payloadRef))), payloadLoaded: true };
  if (value.diffRef) { const { diffRef: _loadedRef, ...rest } = value; return { ...rest, diff: await read(value.diffRef), diffLoaded: true }; }
  throw new Error("DIFF_REFERENCE_UNAVAILABLE");
}
