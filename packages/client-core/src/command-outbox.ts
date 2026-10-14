import { ClientError, errorInfo, isRecord, payloadHash, Signal } from "./common.js";
import type { ClientStore, PendingCommand, Unsubscribe } from "./types.js";

export type CommandSender = (method: string, payload: unknown, commandId?: string) => Promise<unknown>;
export type OutboxOptions = { supportsAccessReceipts?: () => boolean };
const catalogMutations = new Set(["session.createNew", "session.rename", "session.archive", "session.unarchive", "session.closeRuntime"]);
export class CommandOutbox {
  private changed = new Signal<PendingCommand[]>();
  private inFlight = new Map<string, Promise<unknown>>();
  private receiptQueries = new Map<string, Promise<{ found: boolean; queried: boolean; command: PendingCommand }>>();
  constructor(private store: ClientStore, readonly hostId: string, private request: CommandSender, private options: OutboxOptions = {}) {}
  onChange(handler: (commands: PendingCommand[]) => void): Unsubscribe { return this.changed.subscribe(handler); }
  async list(): Promise<PendingCommand[]> { return (await this.store.listCommands(this.hostId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  get hasUnresolvedWrites(): boolean { return this.inFlight.size > 0; }
  private async save(command: PendingCommand): Promise<void> { await this.store.putCommand(command); this.changed.emit(await this.list()); }

  async execute<T>(method: string, payload: unknown, commandId: string = crypto.randomUUID()): Promise<T> {
    if (["access.pair", "access.refresh"].includes(method)) throw new ClientError("EPHEMERAL_ACCESS_OPERATION", "Pairing and credential refresh use the authorization flow");
    const hash = await payloadHash(method, payload);
    const existing = await this.store.getCommand(commandId);
    if (existing) {
      if (existing.hostId !== this.hostId || existing.method !== method || existing.payloadHash !== hash) throw new ClientError("COMMAND_ID_CONFLICT", "This command ID belongs to a different operation");
      return this.retry<T>(commandId);
    }
    const command: PendingCommand = { commandId, hostId: this.hostId, method, payloadHash: hash, payload: structuredClone(payload), createdAt: new Date().toISOString(), state: "queued", dispatchState: "not_dispatched" };
    // This transaction completes before the first byte is sent.
    await this.save(command);
    return this.send(command) as Promise<T>;
  }

  private send(command: PendingCommand): Promise<unknown> {
    const pending = this.inFlight.get(command.commandId);
    if (pending) return pending;
    const run = this.sendOnce(command).finally(() => { this.inFlight.delete(command.commandId); });
    this.inFlight.set(command.commandId, run);
    return run;
  }

  private async sendOnce(command: PendingCommand): Promise<unknown> {
    const dispatched: PendingCommand = { ...command, state: "sent", dispatchState: "possibly_dispatched" };
    await this.save(dispatched);
    try {
      const result = await this.request(command.method, command.payload, command.commandId);
      let catalogState: "accepted" | "completed" | "failed" | "cancelled" | "outcome_unknown" | undefined;
      if (catalogMutations.has(command.method)) {
        const receipt = isRecord(result) && isRecord(result.receipt) ? result.receipt : undefined;
        if (!receipt || receipt.commandId !== command.commandId || typeof receipt.state !== "string" || !["accepted", "completed", "failed", "cancelled", "outcome_unknown"].includes(receipt.state)) throw new ClientError("INVALID_RPC_RESPONSE", "Catalog mutation did not return a matching authoritative receipt");
        catalogState = receipt.state as typeof catalogState;
      }
      if (catalogState === "outcome_unknown" || !catalogMutations.has(command.method) && isRecord(result) && result.status === "outcome_unknown") {
        await this.save({ ...dispatched, state: "receipt_unknown", result, outcomeUnknown: true });
        throw new ClientError("OUTCOME_UNKNOWN", "Host cannot confirm this operation's outcome; it will not be replayed");
      }
      await this.save({ ...dispatched, state: catalogState !== undefined && catalogState !== "accepted" ? "terminal" : "accepted", result });
      return result;
    } catch (error) {
      const info = errorInfo(error);
      const uncertain = ["REQUEST_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_REPLACED", "NOT_CONNECTED", "RESYNC_REQUIRED", "OUTCOME_UNKNOWN"].includes(info.code) || catalogMutations.has(command.method) && info.code === "INVALID_RPC_RESPONSE";
      const current = await this.store.getCommand(command.commandId) ?? dispatched;
      await this.save({ ...current, state: uncertain ? "receipt_unknown" : "terminal", error: info, ...(info.code === "OUTCOME_UNKNOWN" ? { outcomeUnknown: true } : {}) });
      throw error;
    }
  }

  private reconcileOne(command: PendingCommand): Promise<{ found: boolean; queried: boolean; command: PendingCommand }> {
    if (command.state === "terminal" && !command.outcomeUnknown) return Promise.resolve({ found: true, queried: false, command });
    const pending = this.receiptQueries.get(command.commandId);
    if (pending) return pending;
    const query = this.queryReceiptOnce(command).finally(() => this.receiptQueries.delete(command.commandId));
    this.receiptQueries.set(command.commandId, query);
    return query;
  }

  private async queryReceiptOnce(command: PendingCommand): Promise<{ found: boolean; queried: boolean; command: PendingCommand }> {
    // Older Hosts have no access receipts. A failed self-revoke also cannot
    // restore the actor's permission merely to read its receipt.
    const access = command.method.startsWith("access.");
    if (access && !this.options.supportsAccessReceipts?.()) return { found: false, queried: false, command };
    const receipt = await this.request(access ? "access.getReceipt" : "command.getReceipt", { commandId: command.commandId });
    if (!isRecord(receipt) || typeof receipt.found !== "boolean") throw new ClientError("INVALID_RECEIPT", "Host returned an invalid command receipt");
    if (access && receipt.commandId !== command.commandId || receipt.commandId !== undefined && receipt.commandId !== command.commandId) throw new ClientError("INVALID_RECEIPT", "Host receipt belongs to another command");
    if (!receipt.found) {
      const possiblyDispatched = command.dispatchState === "possibly_dispatched" || command.state !== "queued" || command.outcomeUnknown;
      const next: PendingCommand = possiblyDispatched
        ? { ...command, state: "receipt_unknown", outcomeUnknown: true, dispatchState: "possibly_dispatched" }
        : command;
      await this.save(next);
      return { found: false, queried: true, command: next };
    }
    if (receipt.method !== undefined && receipt.method !== command.method) throw new ClientError("COMMAND_ID_CONFLICT", "Host receipt refers to a different operation");
    if (!["accepted", "completed", "failed", "cancelled", "outcome_unknown"].includes(String(receipt.state))) throw new ClientError("INVALID_RECEIPT", "Host returned an invalid receipt state");
    const outcomeUnknown = receipt.state === "outcome_unknown";
    const next: PendingCommand = {
      ...command,
      state: outcomeUnknown ? "receipt_unknown" : receipt.state === "accepted" ? "accepted" : "terminal",
      result: receipt.response,
      ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
    };
    delete next.error;
    if (!outcomeUnknown) delete next.outcomeUnknown;
    await this.save(next);
    return { found: true, queried: true, command: next };
  }

  /** Reconnect only queries receipts. It never sends a stored mutation. */
  async reconcile(): Promise<void> {
    for (const command of await this.list()) {
      if (command.state !== "terminal" && !this.inFlight.has(command.commandId)) await this.reconcileOne(command);
    }
  }

  /** Explicit read-only review also works for accepted and outcome-unknown operations. */
  async queryReceipt(commandId: string): Promise<PendingCommand> {
    const command = await this.store.getCommand(commandId);
    if (!command || command.hostId !== this.hostId) throw new ClientError("COMMAND_NOT_FOUND", "Pending command does not exist for this Host");
    const review = await this.reconcileOne(command);
    if (!review.queried && !review.found) throw new ClientError("CAPABILITY_UNSUPPORTED", "Host has not negotiated access receipt queries; review device status instead");
    return review.command;
  }

  /** An explicit user retry retains the original ID and first resolves uncertainty. */
  async retry<T>(commandId: string): Promise<T> {
    const inFlight = this.inFlight.get(commandId);
    if (inFlight) return inFlight as Promise<T>;
    const stored = await this.store.getCommand(commandId);
    if (!stored || stored.hostId !== this.hostId) throw new ClientError("COMMAND_NOT_FOUND", "Pending command does not exist for this Host");
    const { found, queried, command } = await this.reconcileOne(stored);
    if (!queried && !found) throw new ClientError("REVIEW_REQUIRED", "Review device status before repeating an uncertain access operation");
    if (command.outcomeUnknown) throw new ClientError("OUTCOME_UNKNOWN", "Host cannot confirm this operation's outcome; review it on the Host before proceeding");
    if (found) {
      if (command.error) throw new ClientError(command.error.code, command.error.message);
      return command.result as T;
    }
    if (command.method.startsWith("access.")) throw new ClientError("REVIEW_REQUIRED", "Review device status before repeating an uncertain access operation");
    if (command.dispatchState === "possibly_dispatched" || command.state !== "queued") throw new ClientError("OUTCOME_UNKNOWN", "This operation may already have been dispatched and will not be replayed");
    return this.send(command) as Promise<T>;
  }
}
