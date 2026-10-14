import { validateTreeStopEvidence } from "../lifecycle/managed-process-evidence.js";
import type { ProcessIdentity } from "../lifecycle/process-inspector.js";
import { openReadOnly } from "../storage/open-store.js";
import { inspectSchema, SUPPORTED_SCHEMA_VERSION } from "../storage/migrations/schema-version.js";

/** Read-only inventory for the offline CLI. Never kills, resumes or repairs a Producer. */
export function verifyOfflineHostQuiescence(databasePath: string): boolean {
  const store = openReadOnly(databasePath);
  try {
    // An older inventory cannot establish that every launch was journaled.
    if (inspectSchema(store.db).version !== SUPPORTED_SCHEMA_VERSION) return false;
    const exists = (sql: string) => Boolean(store.db.prepare(sql).get());
    if (exists("SELECT 1 FROM sessions WHERE active_turn_id IS NOT NULL OR recovery_state='blocked' LIMIT 1")
      || exists("SELECT 1 FROM turns WHERE status IN ('queued','running','waiting_approval','interrupting','outcome_unknown') LIMIT 1")
      || exists("SELECT 1 FROM execution_intents WHERE state IN ('pending','claimed','dispatching','acknowledged','outcome_unknown') LIMIT 1")
      || exists("SELECT 1 FROM catalog_runtime_operations WHERE state<>'completed' LIMIT 1")
      || exists("SELECT 1 FROM session_catalog WHERE residency_state<>'unloaded' LIMIT 1")) return false;
    const rows = store.db.prepare(`SELECT p.state,p.pid,p.process_group,p.session_id,p.turn_id,i.identity_json,s.proof_json
      FROM managed_processes p LEFT JOIN managed_process_identities i ON i.process_id=p.id
      LEFT JOIN managed_process_stop_proofs s ON s.process_id=p.id`).all() as Array<{
        state: string; pid: number | null; process_group: number | null; session_id: string | null; turn_id: string | null;
        identity_json: string | null; proof_json: string | null;
      }>;
    for (const row of rows) {
      if (row.state === "not_spawned") {
        if (row.pid !== null || row.process_group !== null || row.identity_json || row.proof_json) return false;
        continue;
      }
      if (row.state !== "stopped" || !row.identity_json || !row.proof_json) return false;
      const identity = JSON.parse(row.identity_json) as ProcessIdentity;
      if (identity.pid !== row.pid) return false;
      validateTreeStopEvidence(JSON.parse(row.proof_json), identity);
    }
    // Migrated/legacy terminals without launch inventory do not prove process exit.
    const turns = store.db.prepare("SELECT id,session_id FROM turns").all() as Array<{ id: string; session_id: string }>;
    if (turns.some((turn) => !rows.some((row) => row.turn_id === turn.id && row.session_id === turn.session_id))) return false;
    // These helper operations may have crossed external boundaries outside a Turn.
    if (exists("SELECT 1 FROM worktree_operations WHERE state IN ('pending','running','outcome_unknown') LIMIT 1")
      || exists("SELECT 1 FROM checkpoint_revert_operations WHERE status NOT IN ('completed','rolled_back') LIMIT 1")
      || exists("SELECT 1 FROM checkpoint_captures WHERE status='capturing' LIMIT 1")) return false;
    return true;
  } catch { return false; }
  finally { store.close(); }
}
