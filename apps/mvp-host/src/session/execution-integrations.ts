import type { CheckpointService } from "../checkpoint/checkpoint-service.js";
import type { CheckpointContext } from "../checkpoint/types.js";
import type { ExecutionIntentRow } from "../orchestration/command-contract.js";
import type { DispatchContext } from "../provider/types.js";
import type { WorkspaceLease } from "../workspace/workspace-lease.js";

/** Host-owned resource/view/native binding; RPC payloads never construct this context. */
export type ExecutionCheckpointBinding = {
  service: Pick<CheckpointService, "captureBefore" | "captureAfter"> & { drain?(): Promise<void>; seal?(): void };
  contextFor(intent: ExecutionIntentRow, dispatch: DispatchContext, lease: WorkspaceLease): CheckpointContext & { turnId: string; attemptId: string };
};
