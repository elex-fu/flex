import type Database from "better-sqlite3";

/** Private launch/stop facts; existing process state is never upgraded into a proof. */
export const MANAGED_PROCESS_EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_process_identities (
  process_id TEXT PRIMARY KEY REFERENCES managed_processes(id),
  identity_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS managed_process_boundaries (
  process_id TEXT PRIMARY KEY REFERENCES managed_processes(id),
  proof_json TEXT NOT NULL,
  launch_digest TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS managed_process_stop_proofs (
  process_id TEXT PRIMARY KEY REFERENCES managed_processes(id),
  proof_json TEXT NOT NULL
);
`;

export function validateProcessEvidenceSchema(db: Database.Database): void {
  for (const [table, values] of Object.entries({
    managed_process_identities: ["identity_json"],
    managed_process_boundaries: ["proof_json", "launch_digest"],
    managed_process_stop_proofs: ["proof_json"],
  })) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number; notnull: number }>;
    const keys = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
    const references = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string; to: string }>;
    if (keys.length !== 1 || keys[0]!.name !== "process_id" ||
        values.some((name) => !columns.find((column) => column.name === name)?.notnull) ||
        !references.some((reference) => reference.table === "managed_processes" && reference.from === "process_id" && reference.to === "id")) {
      throw new Error(`SCHEMA_INVALID: migration 005 process evidence table ${table}`);
    }
  }
}
