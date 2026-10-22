import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_REVERT_HELPER_SCHEMA = 1;
const MAX_MESSAGES = 10_000;
const MAX_BYTES = 16 * 1024 * 1024;
type HelperRequest = { schema: 1; method: "read" | "fork"; sessionId: string; dir: string; upToMessageId?: string };
export interface ClaudeNativeHistorySdk {
  getSessionInfo(sessionId: string, options: { dir: string }): Promise<{ sessionId: string } | undefined>;
  getSessionMessages(sessionId: string, options: { dir: string; includeSystemMessages: true; limit: number }): Promise<unknown[]>;
  forkSession(sessionId: string, options: { dir: string; upToMessageId: string }): Promise<{ sessionId: string }>;
}
/** Local SDK history APIs only. This controlled helper never calls query(),
 * submits a prompt, discovers candidate forks, or rewrites transcript arrays. */
export async function runNativeRevertHelper(input: unknown, sdk: ClaudeNativeHistorySdk): Promise<unknown> {
  const request = input as HelperRequest;
  if (!request || request.schema !== 1 || !["read", "fork"].includes(request.method) || typeof request.sessionId !== "string" || !request.sessionId || request.sessionId.length > 1024 ||
    typeof request.dir !== "string" || !isAbsolute(request.dir) || resolve(request.dir) !== request.dir || Object.keys(request).some((key) => !["schema", "method", "sessionId", "dir", "upToMessageId"].includes(key))) throw new Error("NATIVE_HELPER_REQUEST_INVALID");
  const info = await sdk.getSessionInfo(request.sessionId, { dir: request.dir });
  if (!info || info.sessionId !== request.sessionId) throw new Error("NATIVE_HELPER_SESSION_NOT_FOUND");
  const messages = await sdk.getSessionMessages(request.sessionId, { dir: request.dir, includeSystemMessages: true, limit: MAX_MESSAGES + 1 });
  if (!Array.isArray(messages) || messages.length > MAX_MESSAGES || Buffer.byteLength(JSON.stringify(messages)) > MAX_BYTES) throw new Error("NATIVE_HELPER_HISTORY_BUDGET");
  const ids = new Set<string>();
  for (const value of messages) {
    const message = value as Record<string, unknown>;
    if (!message || typeof message.uuid !== "string" || !message.uuid || message.session_id !== request.sessionId || !["user", "assistant", "system"].includes(String(message.type)) || ids.has(message.uuid)) throw new Error("NATIVE_HELPER_HISTORY_INVALID");
    ids.add(message.uuid);
  }
  if (request.method === "read") return { schema: 1, sessionId: request.sessionId, messages };
  if (typeof request.upToMessageId !== "string" || !ids.has(request.upToMessageId)) throw new Error("NATIVE_HELPER_MESSAGE_NOT_FOUND");
  const fork = await sdk.forkSession(request.sessionId, { dir: request.dir, upToMessageId: request.upToMessageId });
  if (!fork || typeof fork.sessionId !== "string" || !fork.sessionId || fork.sessionId === request.sessionId) throw new Error("NATIVE_HELPER_FORK_INVALID");
  return { schema: 1, sessionId: fork.sessionId };
}

async function main(): Promise<void> {
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const part of process.stdin) { const chunk = Buffer.from(part as Uint8Array); bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error("NATIVE_HELPER_REQUEST_BUDGET"); chunks.push(chunk); }
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const result = await runNativeRevertHelper(JSON.parse(Buffer.concat(chunks).toString("utf8")), sdk);
    process.stdout.write(JSON.stringify(result));
  } catch { process.stdout.write(JSON.stringify({ schema: 1, error: "NATIVE_HELPER_FAILED" })); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
