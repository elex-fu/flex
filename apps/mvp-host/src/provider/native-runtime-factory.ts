import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SqliteStore } from "../storage/db.js";
import type { HostOwnerHandle } from "../lifecycle/host-owner.js";
import { ManagedProcessRegistry, SqliteProcessJournal, type ManagedProcessRecord, type ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import { SystemProcessInspector } from "../lifecycle/process-inspector.js";
import { prepareNativeExecutionBoundary, type NativeBoundaryAssessment } from "../lifecycle/native-execution-boundary.js";
import { inspectNativeBoundaryStop } from "../lifecycle/native-boundary-proof.js";
import { dispatchContextForTurn, type DispatchContext, type ProviderId } from "./types.js";
import type { ManagedRuntimeOptions } from "./managed-runtime.js";

/** Private Host resources and Native auth/history roots never share the workspace grant. */
export class HostManagedRuntime {
  readonly options: ManagedRuntimeOptions;
  private readonly registries = new Set<ManagedProcessRegistry>();
  private readonly stops = new Map<string, ProcessStopResult>();
  private assessment: Promise<NativeBoundaryAssessment> | undefined;
  private closing = false;
  private closePromise: Promise<ProcessStopResult> | undefined;
  constructor(private readonly host: { store: SqliteStore; owner: HostOwnerHandle; sessionId: string; runtimeId: string; workspace: string; provider: ProviderId; privateRoots?: readonly string[]; nativeStateRoots?: readonly string[]; boundaryFactory?: typeof prepareNativeExecutionBoundary }) {
    this.options = {
      executionBoundary: () => this.prepare(),
      inspectionContext: () => {
        const id = `probe-${randomUUID()}`;
        return dispatchContextForTurn(id, { hostOwnerId: host.owner.ownerId, hostOwnerGeneration: host.owner.generation, sessionId: host.sessionId, flyxTurnId: id, runtimeId: `${host.runtimeId}:probe`, runtimeGeneration: 1, attemptId: randomUUID() });
      },
      processRegistryFactory: (context) => {
        if (this.closing) throw new Error("RUNTIME_CLOSING");
        host.owner.assertActive();
        const fixed = dispatchContextForTurn(context.flyxTurnId, context);
        if (fixed.hostOwnerId !== host.owner.ownerId || fixed.hostOwnerGeneration !== host.owner.generation || fixed.sessionId !== host.sessionId) throw new Error("NATIVE_LAUNCH_CONTEXT_MISMATCH");
        const registry = new ManagedProcessRegistry({ journal: new SqliteProcessJournal(host.store.db), context: () => fixed, verifyDescendantStop: (record) => this.verifyStop(record) });
        this.registries.add(registry); return registry;
      },
      onProcessStop: (context, result) => this.stops.set(key(context), result),
    };
  }
  prepare(): Promise<NativeBoundaryAssessment> {
    if (this.closing) return Promise.reject(new Error("RUNTIME_CLOSING"));
    const nativeStateRoots = this.host.nativeStateRoots ?? (this.host.provider === "codex" ? [process.env.CODEX_HOME ?? join(homedir(), ".codex")] : [process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")]);
    const privateRoots = [ ...(this.host.owner.databasePath !== ":memory:" ? [dirname(this.host.owner.databasePath)] : []), ...(this.host.owner.identityDirectory ? [this.host.owner.identityDirectory] : []), ...(this.host.owner.coordinationDirectory ? [this.host.owner.coordinationDirectory] : []), ...(this.host.privateRoots ?? []) ];
    this.assessment ??= (this.host.boundaryFactory ?? prepareNativeExecutionBoundary)({ workspaceRoot: this.host.workspace, nativeStateRoots, privateRoots });
    return this.assessment;
  }
  canReleaseWorkspace(context: DispatchContext): boolean {
    const proof = this.stops.get(key(context));
    return !!proof?.stopped && proof.treeStopped && proof.records.every((record) => record.state === "not_spawned" || record.state === "stopped" && record.stopProof?.kind === "verified-tree-stop");
  }
  closeAndWait(deadlineMs = 5_000): Promise<ProcessStopResult> {
    this.closing = true;
    this.closePromise ??= (async () => {
      // Boundary self-tests are preparers too: a late assessment cannot prove
      // shutdown safe while its helper processes are still running.
      await this.assessment;
      const results = await Promise.all([...this.registries].map((registry) => registry.closeAndWait(deadlineMs)));
      return { stopped: results.every((result) => result.stopped), treeStopped: results.every((result) => result.treeStopped), records: results.flatMap((result) => result.records) };
    })();
    return this.closePromise;
  }
  sealJournals(): void { for (const registry of this.registries) registry.sealJournal(); }
  async disposeBoundary(): Promise<void> { const assessment = await this.assessment; if (assessment?.ready) await assessment.boundary.dispose(); }
  private async verifyStop(record: ManagedProcessRecord) {
    const assessment = await this.assessment;
    if (!assessment?.ready || !record.processIdentity || !record.boundaryEvidence || !this.host.store.db.open || JSON.stringify(assessment.proof) !== JSON.stringify(record.boundaryEvidence.proof)) return undefined;
    const observed = inspectNativeBoundaryStop(record.boundaryEvidence.proof, record.processIdentity, new SystemProcessInspector(), (proof, identity) => {
      const boundary = this.host.store.db.prepare("SELECT proof_json,launch_digest FROM managed_process_boundaries WHERE process_id = ?").get(record.id) as { proof_json: string; launch_digest: string } | undefined;
      const birth = this.host.store.db.prepare("SELECT identity_json FROM managed_process_identities WHERE process_id = ?").get(record.id) as { identity_json: string } | undefined;
      return boundary?.proof_json === JSON.stringify(proof) && boundary.launch_digest === record.boundaryEvidence!.launchDigest && birth?.identity_json === JSON.stringify(identity);
    });
    return observed.state === "stopped" && observed.sourceId && observed.identityDigest && observed.contractId ? { kind: "verified-tree-stop" as const, sourceId: observed.sourceId, identityDigest: observed.identityDigest, contractId: observed.contractId } : undefined;
  }
}
function key(context: DispatchContext): string { return JSON.stringify([context.hostOwnerId, context.hostOwnerGeneration, context.sessionId, context.flyxTurnId, context.runtimeId, context.runtimeGeneration, context.attemptId]); }
