import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SqliteStore } from "../storage/db.js";
import type { HostOwnerHandle } from "../lifecycle/host-owner.js";
import { ManagedProcessRegistry, SqliteProcessJournal, type ManagedProcessRecord, type ProcessStopResult } from "../lifecycle/managed-process-registry.js";
import { managedLaunchOrderLogFor } from "../lifecycle/managed-launch-order-log.js";
import { SystemProcessInspector } from "../lifecycle/process-inspector.js";
import { prepareNativeExecutionBoundary, type NativeBoundaryAssessment } from "../lifecycle/native-execution-boundary.js";
import { inspectNativeBoundaryStop } from "../lifecycle/native-boundary-proof.js";
import { PRODUCER_STOP_DEADLINE_MS } from "./managed-runtime.js";
import { hasManagedStopContract } from "../lifecycle/managed-stop-contract.js";
import { validateTreeStopEvidence } from "../lifecycle/managed-process-evidence.js";
import { dispatchContextForTurn, type DispatchContext, type ProviderId } from "./types.js";
import type { ManagedRuntimeOptions } from "./managed-runtime.js";

/** Private Host resources and Native auth/history roots never share the workspace grant. */
export class HostManagedRuntime {
  readonly options: ManagedRuntimeOptions;
  private readonly registries = new Set<ManagedProcessRegistry>();
  private readonly turnRegistries = new Map<string, Set<ManagedProcessRegistry>>();
  private readonly stops = new Map<string, ProcessStopResult>();
  private assessment: Promise<NativeBoundaryAssessment> | undefined;
  private closing = false;
  private closePromise: Promise<ProcessStopResult> | undefined;
  constructor(private readonly host: { store: SqliteStore; owner: HostOwnerHandle; sessionId: string; runtimeId: string; workspace: string; provider: ProviderId; privateRoots?: readonly string[]; nativeStateRoots?: readonly string[]; boundaryFactory?: typeof prepareNativeExecutionBoundary; assertDispatch?: (context:DispatchContext)=>void }) {
    this.options = {
      executionBoundary: () => this.prepare(),
      ...(host.assertDispatch ? { assertDispatch: host.assertDispatch } : {}),
      inspectionContext: () => {
        const id = `probe-${randomUUID()}`;
        return dispatchContextForTurn(id, { hostOwnerId: host.owner.ownerId, hostOwnerGeneration: host.owner.generation, sessionId: host.sessionId, flyxTurnId: id, runtimeId: `${host.runtimeId}:probe`, runtimeGeneration: 1, attemptId: randomUUID() });
      },
      processRegistryFactory: (context, proof) => {
        if (this.closing) throw new Error("RUNTIME_CLOSING");
        host.owner.assertActive();
        const fixed = dispatchContextForTurn(context.flyxTurnId, context);
        if (fixed.hostOwnerId !== host.owner.ownerId || fixed.hostOwnerGeneration !== host.owner.generation || fixed.sessionId !== host.sessionId) throw new Error("NATIVE_LAUNCH_CONTEXT_MISMATCH");
        const registry = new ManagedProcessRegistry({ journal: new SqliteProcessJournal(host.store.db, managedLaunchOrderLogFor(host.owner.databasePath)), context: () => fixed,
          ...(proof && hasManagedStopContract(proof) ? { stopMode: "managed_process_group" as const } : {}), verifyDescendantStop: (record) => this.verifyStop(record) });
        this.registries.add(registry);
        const registered = this.turnRegistries.get(key(fixed)) ?? new Set<ManagedProcessRegistry>();
        registered.add(registry); this.turnRegistries.set(key(fixed), registered); return registry;
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
    // No per-attempt registry was ever created: the durable pre-invocation path
    // owns an empty Provider set. Additional Git/helper proofs are checked by Host composition.
    if (!this.turnRegistries.has(key(context))) return true;
    const proof = this.stops.get(key(context));
    return !!proof?.stopped && [...this.turnRegistries.get(key(context))!].every((registry)=>registry.records().every((record) => {
      if (record.state === "not_spawned") return true;
      if (record.state !== "stopped" || !record.stopProof) return false;
      try { validateTreeStopEvidence(record.stopProof, record.processIdentity, record.boundaryEvidence, record.processGroup); return true; } catch { return false; }
    }));
  }
  async closeTurnAndWait(context: DispatchContext, deadlineMs = PRODUCER_STOP_DEADLINE_MS): Promise<ProcessStopResult> {
    const results = await Promise.all([...(this.turnRegistries.get(key(context)) ?? [])].map((registry) => registry.closeAndWait(deadlineMs)));
    const result = { stopped: results.every((value) => value.stopped), treeStopped: results.every((value) => value.treeStopped), records: results.flatMap((value) => value.records) };
    this.stops.set(key(context), result); return result;
  }
  closeAndWait(deadlineMs = PRODUCER_STOP_DEADLINE_MS): Promise<ProcessStopResult> {
    this.closing = true;
    this.closePromise ??= (async () => {
      const deadlineAt=Date.now()+Math.max(0,deadlineMs);
      // Start stopping known producers before awaiting any in-flight preparer.
      const registryStops=Promise.all([...this.registries].map((registry)=>registry.closeAndWait(Math.max(0,deadlineAt-Date.now()))));
      const preparer=this.assessment ? this.assessment.then(()=>true,()=>false) : Promise.resolve(true);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const completed=await Promise.race([Promise.all([preparer,registryStops]),new Promise<undefined>((resolve)=>{timer=setTimeout(()=>resolve(undefined),Math.max(0,deadlineAt-Date.now()));})]);
        if(!completed)return {stopped:false,treeStopped:false,records:[...this.registries].flatMap((registry)=>registry.records())};
        const [prepared,results]=completed;
        return {stopped:prepared&&results.every((result)=>result.stopped),treeStopped:prepared&&results.every((result)=>result.treeStopped),records:results.flatMap((result)=>result.records)};
      } finally {if(timer)clearTimeout(timer);}
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
