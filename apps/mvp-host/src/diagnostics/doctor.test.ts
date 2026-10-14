import { describe, expect, it } from "vitest";
import { createTestHostOwner } from "../lifecycle/host-owner.js";
import { openOwned } from "../storage/open-store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../storage/migrations/schema-version.js";
import { collectDoctor, normalizeUsage } from "./doctor.js";

describe("sanitized doctor", () => {
  it("reports aggregates and withholds session diagnostics without session scope", () => {
    const owner = createTestHostOwner(); const store = openOwned({ databasePath: ":memory:", owner });
    try {
      const session = store.createSession("/private/account-secret/workspace");
      store.acceptTurn({ authSubjectId: "secret-device", sessionId: session.id, turnId: "turn-1", commandId: "command-1", requestHash: "hash", prompt: "private-body-and-api-key", generation: 1 });
      const context = {
        db: store.db, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
        owner: { mode: "runtime" as const, state: "active" as const },
        readiness: { status: "ready" as const, reasonCodes: [] },
        providers: [{ provider: "codex" as const, verification: "unverified" as const, cliVersion: "1.0.0", executable: "/private/user/codex", authMode: "unknown" as const, capabilities: [], usage: { costUsd: 0 } }],
      };
      const remote = collectDoctor({ ...context, access: { kind: "remote", scopes: new Set(["host:read"]) } });
      expect(remote.activity).toBeUndefined();
      expect(remote.timeline).toBeUndefined();
      expect(remote.content).toBeUndefined();
      expect(remote.queues).toBeUndefined();
      expect(remote.schema.writable).toBe(true);
      expect(remote.providers?.[0]).toMatchObject({ executableName: "codex", usage: { source: "unknown", availability: "unavailable" } });
      const local = collectDoctor({ ...context, access: { kind: "local" } });
      expect(local.activity).toEqual({ activeTurns: 1, unknownTurns: 0, activeIntents: 1, unknownIntents: 0 });
      expect(local.content).toMatchObject({ available: true, refs: 0, logicalRefBytes: 0, bytes: 0, expiredRefs: 0 });
      expect(local.checkpoints).toEqual({ available: false });
      for (const secret of ["/private", "account-secret", "private-body", "secret-device"]) expect(JSON.stringify(local)).not.toContain(secret);
      expect(() => collectDoctor({ ...context, access: { kind: "remote", scopes: new Set(["session:read"]) } })).toThrow("FORBIDDEN");
    } finally { store.close(); owner.release(); }
  });
  it("reports invalid declared constraints without repairing or reading unsupported aggregates", () => {
    const owner = createTestHostOwner(); const store = openOwned({ databasePath: ":memory:", owner });
    try {
      store.db.exec("DROP INDEX one_active_timeline_epoch");
      const result = collectDoctor({ db: store.db, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION + 100, access: { kind: "local" }, owner: { mode: "runtime", state: "active" }, readiness: { status: "ready", reasonCodes: [] } });
      expect(result.schema).toMatchObject({ supportedVersion: SUPPORTED_SCHEMA_VERSION, writable: false });
      expect(result.readiness.reasonCodes).toContain("SCHEMA_INVALID"); expect(result.activity).toBeUndefined();
      expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'one_active_timeline_epoch'").get()).toBeUndefined();
    } finally { store.close(); owner.release(); }
  });

  it("does not call a placeholder zero free or claim readiness after restore/future schema", () => {
    expect(normalizeUsage({ costUsd: 0 })).toEqual({ source: "unknown", availability: "unavailable" });
    expect(normalizeUsage({ source: "native", availability: "available", costUsd: 0 })).toEqual({ source: "native", availability: "available", costUsd: 0 });
    expect(normalizeUsage({ source: "native", availability: "available" })).toEqual({ source: "unknown", availability: "unavailable" });
    expect(normalizeUsage({ source: "unknown", availability: "available", costUsd: 0 })).toEqual({ source: "unknown", availability: "unavailable" });
    const owner = createTestHostOwner(); const store = openOwned({ databasePath: ":memory:", owner });
    try {
      store.db.pragma("user_version = 999");
      store.db.prepare("INSERT INTO host_state VALUES ('restore_readiness', ?, 'now')").run(JSON.stringify({ v: 1, status: "external_state_unverified", restoredAt: "2026-10-01T00:00:00.000Z", backupCreatedAt: "2026-09-01T00:00:00.000Z", possibleDispatchIntents: 0, relayRegistrationInvalidated: false, reasonCodes: ["RESTORE_GIT_STATE_UNVERIFIED", "RESTORE_PROVIDER_HISTORY_UNVERIFIED"] }));
      const result = collectDoctor({ db: store.db, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION, access: { kind: "local" }, owner: { mode: "runtime", state: "active" }, readiness: { status: "ready", reasonCodes: [] } });
      expect(result.schema.writable).toBe(false);
      expect(result.readiness).toEqual({ status: "blocked", reasonCodes: ["SCHEMA_TOO_NEW", "RESTORE_GIT_STATE_UNVERIFIED", "RESTORE_PROVIDER_HISTORY_UNVERIFIED"] });
    } finally { store.close(); owner.release(); }
  });
});
