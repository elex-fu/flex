export const MANAGED_PROCESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_processes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_generation INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  pid INTEGER,
  process_group INTEGER,
  tree_control TEXT NOT NULL CHECK(tree_control IN ('process_group','unavailable')),
  state TEXT NOT NULL CHECK(state IN ('launching','running','root_exited','stopped','not_spawned','unknown')),
  error_code TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS managed_processes_owner ON managed_processes(owner_id, state);
`;
