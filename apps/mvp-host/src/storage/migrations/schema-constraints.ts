import type Database from "better-sqlite3";

type ForeignKey = {
  columns: readonly string[];
  parent: string;
  target: readonly string[];
  onUpdate?: string;
  onDelete?: string;
};
export type TableContract = {
  columns: readonly string[];
  primaryKey: readonly string[];
  nullable?: readonly string[];
  unique?: ReadonlyArray<readonly string[]>;
  foreignKeys?: readonly ForeignKey[];
  constraints?: readonly string[];
};
const normalize = (sql: string): string => sql.toLowerCase().replace(/[\s"`\[\]]/g, "").replace(/;+$/, "");
function invalid(name: string): never { throw new Error(`SCHEMA_INVALID: ${name}`); }
function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("Invalid schema identifier");
  return name;
}

/** Check declared constraints without executing CREATE, ALTER or repair SQL. */
export function validateTableContracts(db: Database.Database, contracts: Readonly<Record<string, TableContract>>): void {
  for (const [table, contract] of Object.entries(contracts)) {
    const columns = db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as Array<{ name: string; pk: number; notnull: number }>;
    for (const name of contract.columns) {
      const column = columns.find((value) => value.name === name);
      if (!column || (!column.pk && !column.notnull && !contract.nullable?.includes(name))) invalid(`${table}.${name}`);
    }
    const key = columns.filter((value) => value.pk).sort((a, b) => a.pk - b.pk).map((value) => value.name);
    if (key.join() !== contract.primaryKey.join()) invalid(`${table} primary key`);
    for (const unique of contract.unique ?? []) validateUniqueIndex(db, table, unique);
    const refs = db.prepare(`PRAGMA foreign_key_list(${identifier(table)})`).all() as Array<{
      id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string;
    }>;
    for (const expected of contract.foreignKeys ?? []) {
      const found = [...new Set(refs.map((value) => value.id))].some((id) => {
        const parts = refs.filter((value) => value.id === id).sort((a, b) => a.seq - b.seq);
        return parts.length === expected.columns.length && parts.every((value, index) =>
          value.table === expected.parent && value.from === expected.columns[index] && value.to === expected.target[index]
          && (!expected.onUpdate || value.on_update === expected.onUpdate)
          && (!expected.onDelete || value.on_delete === expected.onDelete));
      });
      if (!found) invalid(`${table} ${expected.columns.join()} relation`);
    }
    if (contract.constraints?.length) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
      if (!row?.sql || contract.constraints.some((fragment) => !normalize(row.sql).includes(normalize(fragment)))) invalid(`${table} constraint`);
    }
  }
}

export function validateUniqueIndex(db: Database.Database, table: string, expected: readonly string[], predicate?: string, name?: string): void {
  const indexes = db.prepare(`PRAGMA index_list(${identifier(table)})`).all() as Array<{ name: string; unique: number; partial: number }>;
  const found = indexes.some((index) => {
    if (!index.unique || Boolean(index.partial) !== Boolean(predicate) || (name && index.name !== name)) return false;
    const columns = db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name) as Array<{ name: string }>;
    if (columns.map((value) => value.name).join() !== expected.join()) return false;
    if (!predicate) return true;
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(index.name) as { sql: string } | undefined;
    const sql = row?.sql ? normalize(row.sql) : "";
    return Boolean(sql) && sql.slice(sql.indexOf("where")) === normalize(predicate);
  });
  if (!found) invalid(`${table} ${name ?? expected.join()} uniqueness`);
}
