import type Database from "better-sqlite3";
import { CONTENT_SCHEMA_SQL } from "./006-content.js";
import { TIMELINE_SCHEMA_SQL } from "./006-timeline.js";
import { validateViewsSchema, VIEWS_SCHEMA_VERSION } from "./006-views-schema.js";

/** SQL metadata only. Building epochs are prepared separately before capabilities are advertised. */
export function applyViewsSchemaMigration(db: Database.Database, appliedAt = new Date().toISOString()): void {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(VIEWS_SCHEMA_VERSION)) {
      validateViewsSchema(db);
      return;
    }
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get()) throw new Error("VIEWS_MIGRATION_REQUIRES_005");
    db.exec(CONTENT_SCHEMA_SQL);
    db.exec(TIMELINE_SCHEMA_SQL);
    validateViewsSchema(db);
    db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(VIEWS_SCHEMA_VERSION, appliedAt);
  })();
}
