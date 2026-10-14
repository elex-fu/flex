import type { PendingCommand } from "@flyx/client-core";
export function canSendSavedCommand(command: PendingCommand): boolean {
  return command.state === "queued" && command.dispatchState === "not_dispatched" && command.outcomeUnknown !== true && !command.method.startsWith("access.");
}
export function needsCommandReview(command: PendingCommand): boolean { return command.state !== "terminal" || command.outcomeUnknown === true || command.error !== undefined; }
