import { ListSessionsV2ResponseSchema, ListSessionsV2Schema, SESSION_CATALOG_CAPABILITY, SessionSnapshotV2Schema } from "@flyx/mvp-protocol";
import { isRecord, type Snapshot } from "./timeline.js";
export const WEB_SESSION_CATALOG_CAPABILITY = SESSION_CATALOG_CAPABILITY;
export interface WebSessionChoice { id: string; title: string; provider: "claude" | "codex"; activityState: string; status: string }
export interface WebSessionPage { sessions: WebSessionChoice[]; nextSessionId?: string }
export function parseWebSessionPage(value: unknown): WebSessionPage {
  const page = ListSessionsV2ResponseSchema.parse(value);
  return { sessions: page.sessions.map((session) => ({id:session.sessionId,title:session.title,provider:session.provider,activityState:session.activityState,status:session.status})), ...(page.nextSessionId ? {nextSessionId:page.nextSessionId} : {}) };
}
export async function loadWebSessionPage(request:(method:string,payload:unknown)=>Promise<unknown>,afterSessionId?:string):Promise<WebSessionPage> {
  return parseWebSessionPage(await request("session.list",ListSessionsV2Schema.parse({limit:50,includeArchived:false,...(afterSessionId ? {afterSessionId} : {})})));
}
/** The public V2 name is sessionId; the legacy presentation model uses id. */
export function normalizeWebSnapshot(value:unknown):Snapshot {
  if (!isRecord(value) || !isRecord(value.session)) throw new Error("SNAPSHOT_RESPONSE_INVALID");
  if (typeof value.session.sessionId === "string") {
    const parsed = SessionSnapshotV2Schema.parse(value);
    return {session:{id:parsed.session.sessionId,provider:parsed.session.provider,activityState:parsed.session.activityState,headSequence:parsed.session.headSequence},pendingApprovals:parsed.pendingApprovals as Snapshot["pendingApprovals"],...(parsed.activeTurn ? {activeTurn:{id:parsed.activeTurn.id,status:parsed.activeTurn.status,prompt:parsed.activeTurn.prompt}} : {})};
  }
  const session = value.session;
  if (typeof session.id !== "string" || (session.provider !== "claude" && session.provider !== "codex") || typeof session.activityState !== "string" || !Number.isSafeInteger(session.headSequence)) throw new Error("SNAPSHOT_RESPONSE_INVALID");
  return value as unknown as Snapshot;
}
