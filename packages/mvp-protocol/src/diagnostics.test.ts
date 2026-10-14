import { describe, expect, it } from "vitest";
import { HostDiagnosticsSchema, UsageEvidenceSchema, VerifiedProviderEvidenceSchema } from "./diagnostics.js";

describe("diagnostics contract", () => {
  it("requires explicit provenance and an available cost value", () => {
    expect(UsageEvidenceSchema.safeParse({ source: "unknown", availability: "available", costUsd: 0 }).success).toBe(false);
    expect(UsageEvidenceSchema.safeParse({ source: "native", availability: "available" }).success).toBe(false);
    expect(UsageEvidenceSchema.safeParse({ source: "unknown", availability: "unavailable" }).success).toBe(true);
    expect(UsageEvidenceSchema.safeParse({ source: "estimated", availability: "available", costUsd: 1.5 }).success).toBe(true);
  });
  it("rejects body and credential additions to a sanitized response", () => {
    const safe = { v: 1, generatedAt: "2026-10-01T00:00:00.000Z", owner: { mode: "read_only", state: "unverified" }, readiness: { status: "read_only", reasonCodes: [] }, schema: { migrationVersion: 3, userVersion: 0, supportedVersion: 3, writable: false } };
    expect(HostDiagnosticsSchema.safeParse(safe).success).toBe(true);
    expect(HostDiagnosticsSchema.safeParse({ ...safe, body: "private prompt" }).success).toBe(false);
    expect(HostDiagnosticsSchema.safeParse({ ...safe, relay: { status: "connected", relayCredential: "secret" } }).success).toBe(false);
  });
  it("versions cannot become arbitrary account or path strings", () => {
    const provider = { provider: "claude", verification: "unverified", capabilities: [], usage: { source: "unknown", availability: "unavailable" } };
    expect(VerifiedProviderEvidenceSchema.safeParse({ ...provider, cliVersion: "2.1.220" }).success).toBe(true);
    expect(VerifiedProviderEvidenceSchema.safeParse({ ...provider, cliVersion: "/private/account/token" }).success).toBe(false);
  });
});
