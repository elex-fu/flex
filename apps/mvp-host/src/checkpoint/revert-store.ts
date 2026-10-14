import type Database from "better-sqlite3";
import type { CheckpointRevertOperation } from "@flyx/mvp-protocol";
import type { RevertOperation, RevertRecoveryEvidence } from "./revert-types.js";
import { CheckpointError } from "./types.js";

/** No second connection or constructor DDL. All operation mutations join Engine's commit hook. */
export class RevertStore {
  private sealed=false;
  constructor(readonly db: Database.Database) {}
  seal():void {this.sealed=true;}
  private assertOpen():void {if(this.sealed)throw new CheckpointError("REVERT_SEALED","Revert journal is sealed");}
  require(operationId: string, sessionId: string, actorId?: string): RevertOperation {
    this.assertOpen();
    const row = this.db.prepare("SELECT operation_json FROM checkpoint_revert_operations WHERE operation_id = ?").get(operationId) as {operation_json:string}|undefined;
    if (!row) throw new CheckpointError("REVERT_NOT_FOUND", "Revert operation does not exist");
    const operation = JSON.parse(row.operation_json) as RevertOperation;
    if (operation.sessionId !== sessionId || actorId && operation.actorId !== actorId) throw new CheckpointError("REVERT_SCOPE_MISMATCH", "Revert belongs to another actor or Session");
    return operation;
  }
  listBlocked(sessionId: string): RevertOperation[] {
    this.assertOpen();
    return (this.db.prepare("SELECT operation_json FROM checkpoint_revert_operations WHERE session_id = ? AND status NOT IN ('completed','rolled_back') ORDER BY created_at")
      .all(sessionId) as Array<{operation_json:string}>).map((row) => JSON.parse(row.operation_json) as RevertOperation);
  }
  insert(operation: RevertOperation): void {
    this.inTransaction();
    this.db.prepare(`INSERT INTO checkpoint_revert_operations (operation_id,session_id,actor_id,command_id,plan_id,revision,stage,status,operation_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(operation.operationId,operation.sessionId,operation.actorId,operation.commands[0]!.commandId,
        operation.plan.planId,operation.revision,operation.stage,operation.status,JSON.stringify(operation),operation.createdAt,operation.updatedAt);
    this.steps(operation);
  }
  save(operation: RevertOperation, expectedRevision: number): void {
    this.inTransaction();
    if (operation.revision !== expectedRevision + 1 || this.db.prepare(`UPDATE checkpoint_revert_operations
      SET revision=?,stage=?,status=?,operation_json=?,updated_at=? WHERE operation_id=? AND revision=?`)
      .run(operation.revision,operation.stage,operation.status,JSON.stringify(operation),operation.updatedAt,operation.operationId,expectedRevision).changes !== 1) {
      throw new CheckpointError("REVERT_REVISION_CONFLICT", "Revert journal changed");
    }
    this.steps(operation);
  }
  blockGate(operation: RevertOperation, predecessor?: string): void {
    this.inTransaction();
    const session = this.db.prepare("SELECT recovery_state,recovery_revision,active_turn_id FROM sessions WHERE id=?").get(operation.sessionId) as {recovery_state:string;recovery_revision:number;active_turn_id?:string};
    if (!session || session.active_turn_id) throw new CheckpointError("WORKSPACE_BUSY", "An original Turn is still attached");
    if (predecessor) {
      const old = this.db.prepare("SELECT operation_id,recovery_revision,state FROM checkpoint_revert_gates WHERE session_id=?").get(operation.sessionId) as {operation_id:string;recovery_revision:number;state:string}|undefined;
      if (!old || old.state !== "blocked" || old.operation_id !== predecessor || session.recovery_state !== "blocked" || session.recovery_revision !== old.recovery_revision) throw new CheckpointError("RECOVERY_BLOCKED", "Another recovery gate owns this Session");
    } else if (session.recovery_state !== "idle") throw new CheckpointError("RECOVERY_BLOCKED", "Another recovery gate already owns this Session");
    operation.gateRecoveryRevision = session.recovery_revision + 1;
    if (this.db.prepare("UPDATE sessions SET recovery_state='blocked',recovery_revision=recovery_revision+1 WHERE id=? AND recovery_revision=? AND active_turn_id IS NULL")
      .run(operation.sessionId,session.recovery_revision).changes !== 1) throw new CheckpointError("RECOVERY_EVIDENCE_STALE", "Session recovery gate changed");
    this.db.prepare(`INSERT INTO checkpoint_revert_gates(session_id,operation_id,recovery_revision,state) VALUES(?,?,?,'blocked')
      ON CONFLICT(session_id) DO UPDATE SET operation_id=excluded.operation_id,recovery_revision=excluded.recovery_revision,state='blocked'`)
      .run(operation.sessionId,operation.operationId,operation.gateRecoveryRevision);
  }
  assertGate(operation: RevertOperation): void {
    this.assertOpen();
    const row = this.db.prepare(`SELECT gate.operation_id,gate.recovery_revision,gate.state,session.recovery_state,session.recovery_revision AS actual_revision,session.active_turn_id
      FROM checkpoint_revert_gates gate JOIN sessions session ON session.id=gate.session_id WHERE gate.session_id=?`).get(operation.sessionId) as
      {operation_id:string;recovery_revision:number;state:string;recovery_state:string;actual_revision:number;active_turn_id?:string}|undefined;
    if (!row || row.operation_id !== operation.operationId || row.state !== "blocked" || row.recovery_state !== "blocked" || row.recovery_revision !== operation.gateRecoveryRevision || row.actual_revision !== operation.gateRecoveryRevision || row.active_turn_id) {
      throw new CheckpointError("RECOVERY_BLOCKED", "Revert no longer owns the exact recovery gate");
    }
  }
  releaseGate(operation: RevertOperation): void {
    this.inTransaction(); this.assertGate(operation);
    if (this.db.prepare("UPDATE sessions SET recovery_state='idle',recovery_revision=recovery_revision+1 WHERE id=? AND recovery_state='blocked' AND recovery_revision=? AND active_turn_id IS NULL")
      .run(operation.sessionId,operation.gateRecoveryRevision).changes !== 1) throw new CheckpointError("RECOVERY_EVIDENCE_STALE", "Recovery gate changed before final projection");
    this.db.prepare("UPDATE checkpoint_revert_gates SET state='released' WHERE session_id=? AND operation_id=? AND recovery_revision=?")
      .run(operation.sessionId,operation.operationId,operation.gateRecoveryRevision);
  }
  putEvidence(evidence: RevertRecoveryEvidence): void {
    this.assertOpen();
    this.db.prepare(`INSERT INTO checkpoint_revert_evidence(evidence_id,operation_id,session_id,actor_id,evidence_json,expires_at) VALUES(?,?,?,?,?,?)`)
      .run(evidence.evidenceId,evidence.operationId,evidence.sessionId,evidence.actorId,JSON.stringify(evidence),evidence.expiresAt);
  }
  evidence(evidenceId: string, operationId: string, sessionId: string, actorId: string): RevertRecoveryEvidence {
    this.assertOpen();
    const row = this.db.prepare("SELECT evidence_json,consumed_by FROM checkpoint_revert_evidence WHERE evidence_id=? AND operation_id=? AND session_id=? AND actor_id=?")
      .get(evidenceId,operationId,sessionId,actorId) as {evidence_json:string;consumed_by?:string}|undefined;
    if (!row) throw new CheckpointError("RECOVERY_EVIDENCE_STALE", "Evidence does not belong to this actor and operation");
    return {...JSON.parse(row.evidence_json) as RevertRecoveryEvidence,...(row.consumed_by ? {consumedBy:row.consumed_by}: {})};
  }
  consumeEvidence(evidence: RevertRecoveryEvidence, commandId: string): void {
    this.inTransaction();
    if (this.db.prepare("UPDATE checkpoint_revert_evidence SET consumed_by=? WHERE evidence_id=? AND consumed_by IS NULL")
      .run(commandId,evidence.evidenceId).changes !== 1) throw new CheckpointError("RECOVERY_EVIDENCE_STALE", "Recovery evidence was already consumed");
  }
  private steps(operation: RevertOperation): void {
    const stepInsert = this.db.prepare(`INSERT INTO checkpoint_revert_steps(operation_id,step_id,ordinal,kind,state,step_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(operation_id,step_id) DO UPDATE SET state=excluded.state,step_json=excluded.step_json`);
    const attemptInsert = this.db.prepare(`INSERT INTO checkpoint_revert_step_attempts(attempt_id,operation_id,step_id,state,attempt_json) VALUES(?,?,?,?,?)
      ON CONFLICT(attempt_id) DO UPDATE SET state=excluded.state,attempt_json=excluded.attempt_json`);
    for (const step of operation.steps) {
      stepInsert.run(operation.operationId,step.stepId,step.ordinal,step.kind,step.state,JSON.stringify(step));
      for (const attempt of step.attempts) attemptInsert.run(attempt.attemptId,operation.operationId,step.stepId,attempt.state,JSON.stringify(attempt));
    }
  }
  private inTransaction(): void { this.assertOpen();if (!this.db.inTransaction) throw new Error("REVERT_ENGINE_TRANSACTION_REQUIRED"); }
}
export function publicRevertOperation(operation: RevertOperation): CheckpointRevertOperation {
  return {operationId:operation.operationId,sessionId:operation.sessionId,checkpointId:operation.targetCheckpointId,mode:operation.mode,
    stage:operation.stage,status:operation.status,revision:operation.revision,sessionRevision:operation.sessionRevision,
    totalSteps:operation.steps.length,appliedSteps:operation.steps.filter((step) => step.state === "applied").length,
    ...(operation.safetyCheckpointId ? {safetyCheckpointId:operation.safetyCheckpointId}: {}),...(operation.errorCode ? {errorCode:operation.errorCode}: {}),
    ...(operation.newEpoch ? {epoch:operation.newEpoch}: {}),recoveryRequired:operation.status !== "completed" && operation.status !== "rolled_back",
    ...(operation.parentOperationId ? {parentOperationId:operation.parentOperationId}: {})};
}
