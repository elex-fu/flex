import { RecoveryCapability, RecoveryInspectPayloadSchema, RecoveryReconcilePayloadSchema, RecoveryAcknowledgePayloadSchema, RecoveryEvidenceSchema, RecoveryOperationSchema } from "@flyx/mvp-protocol";
import type { RecoveryInspectPayload, RecoveryReconcilePayload, RecoveryAcknowledgePayload, RecoveryEvidence, RecoveryOperation } from "@flyx/mvp-protocol";
import { ClientError } from "./common.js";

export interface RecoveryClientOptions {
  /** Must reflect this connection's negotiated hello, not a locally assumed capability. */
  supports(capability: string): boolean;
  request(method: string, payload: unknown): Promise<unknown>;
  /** Use the existing durable command path; uncertain writes remain receipt-query-only. */
  command(method: string, payload: unknown, commandId: string): Promise<unknown>;
}

/** Structural FlyxClient port, keeping recovery on its existing negotiated/durable transport. */
export interface RecoveryClientPort {
  supportsCapability(capability: string): boolean;
  request(method: string, payload: unknown): Promise<unknown>;
  command(method: string, payload: unknown, commandId?: string): Promise<unknown>;
}

export function createRecoveryClient(port: RecoveryClientPort): RecoveryClient {
  return new RecoveryClient({
    supports: (capability) => port.supportsCapability(capability),
    request: (method, payload) => port.request(method, payload),
    command: (method, payload, commandId) => port.command(method, payload, commandId),
  });
}

export class RecoveryClient {
  constructor(private readonly options: RecoveryClientOptions) {}
  async inspect(original: RecoveryInspectPayload): Promise<RecoveryEvidence> {
    this.assertSupported();
    const payload = RecoveryInspectPayloadSchema.parse(original);
    const result = RecoveryEvidenceSchema.parse(await this.options.request("session.recovery.inspect", payload));
    this.assertOriginal(payload, result);
    return result;
  }
  async reconcile(original: RecoveryReconcilePayload, commandId: string): Promise<RecoveryOperation> {
    return this.write("session.recovery.reconcile", RecoveryReconcilePayloadSchema.parse(original), commandId);
  }
  async acknowledge(original: RecoveryAcknowledgePayload, commandId: string): Promise<RecoveryOperation> {
    return this.write("session.recovery.acknowledge", RecoveryAcknowledgePayloadSchema.parse(original), commandId);
  }
  private async write(method: string, payload: RecoveryReconcilePayload | RecoveryAcknowledgePayload, commandId: string): Promise<RecoveryOperation> {
    this.assertSupported();
    if (!commandId || new TextEncoder().encode(commandId).byteLength > 128) throw new ClientError("COMMAND_ID_REQUIRED", "Recovery needs its own explicit command ID");
    const result = RecoveryOperationSchema.parse(await this.options.command(method, payload, commandId));
    this.assertOriginal(payload, result);
    if (result.recoveryRevision < payload.expectedRecoveryRevision) throw new ClientError("RECOVERY_RESPONSE_STALE", "Recovery response predates the inspected execution");
    return result;
  }
  private assertSupported(): void {
    if (!this.options.supports(RecoveryCapability)) throw new ClientError("CAPABILITY_REQUIRED", "This Host connection has not negotiated Session recovery");
  }
  private assertOriginal(original: RecoveryInspectPayload, response: { sessionId: string; turnId: string; attemptId?: string | undefined }): void {
    if (response.sessionId !== original.sessionId || response.turnId !== original.turnId || original.attemptId && response.attemptId !== original.attemptId) {
      throw new ClientError("RECOVERY_RESPONSE_IDENTITY_MISMATCH", "Recovery response belongs to another original execution");
    }
  }
}
