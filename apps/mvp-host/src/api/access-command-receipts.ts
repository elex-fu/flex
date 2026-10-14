import { createHash } from "node:crypto";
import { z } from "zod";
import { AccessError } from "../auth/connection-authorizer.js";
import type { DeviceRegistry, ConnectionPrincipal } from "../auth/device-registry.js";
import type { CommandReceiptRow, CommandReceiptState } from "../storage/db.js";

export const ACCESS_RECEIPTS_CAPABILITY = "access-receipts-v1";
export const ACCESS_COMMAND_METHODS = ["access.revokeSelf", "access.revokeDevice", "access.revokeAll", "access.revokeAllDevices"] as const;
export type AccessCommandMethod = typeof ACCESS_COMMAND_METHODS[number];
export type AccessReceiptContext = {
  subjectId: string;
  leaseId: string;
  transportGeneration: number;
  protocolVersion: number;
  capabilities: ReadonlySet<string>;
};
export type AccessReceipt =
  | { found: false; commandId: string }
  | { found: true; commandId: string; method: AccessCommandMethod; state: CommandReceiptState; response: unknown; updatedAt: string };
export type AccessRevocationEvent = {
  actorId: string;
  commandId: string;
  method: AccessCommandMethod;
  allDevices: boolean;
  deviceId?: string;
  revokedCount: number;
};
export type AccessCommandReceiptOptions = { onRevoked?(event: AccessRevocationEvent): void | Promise<void> };
const CommandId = z.string().min(1).max(128);
const Empty = z.object({}).strict();
const DevicePayload = z.object({ deviceId: z.string().min(1).max(128) }).strict();
const GetReceipt = z.object({ commandId: CommandId }).strict();
const Command = z.object({ method: z.enum(ACCESS_COMMAND_METHODS), commandId: CommandId, payload: z.unknown() }).strict();
const STATES: readonly CommandReceiptState[] = ["accepted", "completed", "failed", "cancelled", "outcome_unknown"];
function methodScope(method: AccessCommandMethod): "access:self" | "access:admin" { return method === "access.revokeSelf" ? "access:self" : "access:admin"; }
function assertScope(principal: ConnectionPrincipal, scope: string): void {
  if (!principal.scopes.has(scope)) throw new AccessError("FORBIDDEN", "This device does not have " + scope + " permission");
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AccessError("PROTOCOL_INVALID", "Access command payload is invalid");
  return result.data;
}
/** Hash every semantic input, including the exact alias and request format. No Session is invented. */
export function accessCommandRequestHash(method: AccessCommandMethod, payload: { deviceId: string } | Record<string, never>): string {
  return createHash("sha256").update(JSON.stringify({ domain: ACCESS_RECEIPTS_CAPABILITY, requestFormatVersion: 2, method, payload })).digest("hex");
}

/** Credential mutations and receipts use the DeviceRegistry's owned shared SQLite connection. */
export class AccessCommandReceipts {
  constructor(readonly devices: DeviceRegistry, private readonly options: AccessCommandReceiptOptions = {}) {}
  ready(): boolean {
    const db = this.devices.store.db;
    if (!db.open || db.readonly || !["owned", "test-fixture"].includes(this.devices.store.mode)) return false;
    try {
      const columns = new Set((db.prepare("PRAGMA table_info(command_receipts)").all() as Array<{ name: string }>).map((row) => row.name));
      return ["auth_subject_id", "command_id", "method", "request_hash", "request_format_version", "target_session_id", "state", "response_json", "created_at", "updated_at"].every((column) => columns.has(column));
    } catch { return false; }
  }
  command(raw: unknown, context: AccessReceiptContext): unknown {
    const request = parse(Command, raw);
    const payload = request.method === "access.revokeDevice" ? parse(DevicePayload, request.payload) : parse(Empty, request.payload);
    const requestHash = accessCommandRequestHash(request.method, payload);
    return this.devices.credentialTransaction((afterCommit) => {
      const actor = this.authorize(context);
      assertScope(actor, methodScope(request.method));
      const existing = this.devices.store.getCommandReceipt(actor.deviceId, request.commandId);
      if (existing) {
        if (existing.method !== request.method || existing.requestHash !== requestHash || existing.requestFormatVersion !== 2 || existing.targetSessionId !== undefined) throw new AccessError("COMMAND_ID_REUSED", "Command ID belongs to another request");
        this.validateReceipt(existing);
        return existing.response;
      }
      let changed: boolean | number, response: { ok: true; revoked: boolean } | { revoked: number }, deviceId: string | undefined;
      const allDevices = request.method === "access.revokeAll" || request.method === "access.revokeAllDevices";
      if (allDevices) { changed = this.devices.revokeAll(actor.deviceId); response = { revoked: changed }; }
      else {
        deviceId = request.method === "access.revokeSelf" ? actor.deviceId : (payload as { deviceId: string }).deviceId;
        changed = request.method === "access.revokeSelf" ? this.devices.revokeSelf(actor.deviceId) : this.devices.revokeDevice(actor.deviceId, deviceId);
        response = { ok: true, revoked: changed };
      }
      this.devices.store.putCommandReceipt({ authSubjectId: actor.deviceId, commandId: request.commandId, method: request.method, requestHash, requestFormatVersion: 2, state: "completed", response });
      if (changed && this.options.onRevoked) {
        const event: AccessRevocationEvent = { actorId: actor.deviceId, commandId: request.commandId, method: request.method, allDevices, ...(deviceId ? { deviceId } : {}), revokedCount: typeof changed === "number" ? changed : 1 };
        afterCommit(() => this.options.onRevoked!(event));
      }
      return response;
    });
  }
  getReceipt(raw: unknown, context: AccessReceiptContext): AccessReceipt {
    if (this.devices.store.db.inTransaction) throw new AccessError("CREDENTIAL_COMMIT_REQUIRED", "Access receipts require the outer transaction to commit");
    const request = parse(GetReceipt, raw), actor = this.authorize(context);
    assertScope(actor, "access:self");
    const receipt = this.devices.store.getCommandReceipt(actor.deviceId, request.commandId);
    if (!receipt || !(ACCESS_COMMAND_METHODS as readonly string[]).includes(receipt.method)) return { found: false, commandId: request.commandId };
    const method = receipt.method as AccessCommandMethod;
    assertScope(actor, methodScope(method));
    this.validateReceipt(receipt);
    return { found: true, commandId: receipt.commandId, method, state: receipt.state, response: receipt.response, updatedAt: receipt.updatedAt };
  }
  private authorize(context: AccessReceiptContext): ConnectionPrincipal {
    if (!this.ready()) throw new AccessError("ACCESS_RECEIPTS_UNAVAILABLE", "Access command receipts are unavailable");
    const actor = this.devices.assertLease(context.leaseId, context.transportGeneration);
    if (actor.deviceId !== context.subjectId) throw new AccessError("DEVICE_UNAUTHORIZED", "Access receipts belong to the authenticated actor");
    if (context.protocolVersion !== 2 || actor.protocolVersion !== 2) throw new AccessError("PROTOCOL_INCOMPATIBLE", "Access receipts require protocol version 2");
    const saved = this.devices.store.getProtocolSession(actor.leaseId);
    if (!context.capabilities.has(ACCESS_RECEIPTS_CAPABILITY) || !saved?.capabilities.includes(ACCESS_RECEIPTS_CAPABILITY)) throw new AccessError("CAPABILITY_REQUIRED", "Access command receipt capability is required");
    return actor;
  }
  private validateReceipt(receipt: CommandReceiptRow): void {
    if (!STATES.includes(receipt.state) || ![1, 2].includes(receipt.requestFormatVersion ?? 1) || receipt.targetSessionId !== undefined) throw new AccessError("ACCESS_RECEIPT_INVALID", "Access receipt is unavailable for this request");
  }
}
