import { HostWorktrees, type HostWorktreesOptions } from "./host-worktrees.js";
import { WorktreeScheduler } from "./worktree-scheduler.js";

/** One Host composition: only HostWorktrees owns durable claim/dispatch CAS. */
export function createScheduledHostWorktrees(options: HostWorktreesOptions & { schedulerLimit?: number }) {
  let scheduler: WorktreeScheduler | undefined;
  const worktrees = new HostWorktrees({ ...options, accepted: (intent) => {
    scheduler?.accepted(intent);
    options.accepted?.(intent);
  } });
  scheduler = new WorktreeScheduler({ store: worktrees.execution,
    owner: { id: options.owner.ownerId, generation: options.owner.generation },
    dispatch: (intentId) => worktrees.dispatchAccepted(intentId),
    ...(options.schedulerLimit !== undefined ? { limit: options.schedulerLimit } : {}),
  });
  const ownedScheduler = scheduler;
  // Application starts the startup scan only after all ports and markReady commit.
  const stopAdmission = () => { ownedScheduler.seal(); worktrees.stopAdmission(); };
  return {
    worktrees, scheduler: ownedScheduler,
    start: () => ownedScheduler.scan(), scan: () => ownedScheduler.scan(), stopAdmission,
    seal: () => { stopAdmission(); worktrees.seal(); },
    closeAndWait: async (deadlineMs = 5000) => {
      stopAdmission();
      const deadline = Date.now() + Math.max(0, deadlineMs);
      const report = await worktrees.closeAndWait(Math.max(0, deadline - Date.now()));
      const schedulerDrained = await ownedScheduler.drain(Math.max(0, deadline - Date.now()));
      return { ...report, drained: report.drained && schedulerDrained, clean: report.clean && schedulerDrained,
        state: report.clean && schedulerDrained ? "stopped" as const : "recovery_required" as const };
    },
  };
}
