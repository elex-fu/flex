import type { ClientState, PendingCommand } from "@flyx/client-core";

export interface NativeReceiptPort {
  getState(): ClientState;
  replica: { getState(): { sessionId?: string | undefined; replicaGeneration: number } };
  queryCommandReceipt(commandId: string): Promise<PendingCommand>;
  retrySynchronization(): Promise<unknown>;
}
/** Receipt review only reads the original command, then refreshes live authority.
 * A cached receipt cannot locally release a Session or trigger a resend. */
export async function reviewNativeReceipt(client: NativeReceiptPort, commandId: string, stillSelected: () => boolean): Promise<PendingCommand | undefined> {
  const original = client.getState(), selection = client.replica.getState();
  const hostId = original.profile?.hostId, transportGeneration = original.transportGeneration, sessionId = selection.sessionId, replicaGeneration = selection.replicaGeneration;
  const current = (requireOriginalReplica: boolean) => {
    const state = client.getState(), replica = client.replica.getState();
    return stillSelected() && state.connection === "online" && state.profile?.hostId === hostId && state.transportGeneration === transportGeneration && replica.sessionId === sessionId && (!requireOriginalReplica || replica.replicaGeneration === replicaGeneration);
  };
  const command = await client.queryCommandReceipt(commandId);
  if (!current(true)) return;
  if (/^(?:session\.|checkpoint\.|worktree\.)/.test(command.method)) await client.retrySynchronization();
  return current(false) ? command : undefined;
}
