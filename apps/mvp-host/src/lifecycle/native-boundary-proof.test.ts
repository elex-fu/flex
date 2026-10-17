import { describe, expect, it } from "vitest";
import {
  appendNativeRawProcessEvidence, isNativeRawLaunchEvidence, isNativeRawProcessEvidence, nativeRawEvidenceLedger,
  NativeRawEvidenceError, NATIVE_RAW_PROCESS_EVIDENCE_VERSION, type NativeRawExitEvidenceV1, type NativeRawLaunchEvidenceV1, type NativeRawProcessEvidence,
} from "./native-boundary-proof.js";

const launch: NativeRawLaunchEvidenceV1 = { version: 1, kind: "original_launch", platform: "darwin", backend: "macos_seatbelt", pid: 4242, launchDigest: "a".repeat(64), observedAt: "2026-01-01T00:00:00.000Z" };
const exit: NativeRawExitEvidenceV1 = { version: 1, kind: "root_exit", pid: 4242, code: 0, signal: null, observedAt: "2026-01-01T00:00:01.000Z" };

describe("versioned native raw launch evidence ledger", () => {
  it("freezes the original launch identity and appends later observations beside it", () => {
    const ledger = nativeRawEvidenceLedger(launch);
    expect(ledger).toMatchObject({ version: NATIVE_RAW_PROCESS_EVIDENCE_VERSION, launch: { version: 1, kind: "original_launch", pid: 4242 } });
    expect(ledger.later).toEqual([]); expect(Object.isFrozen(ledger)).toBe(true); expect(Object.isFrozen(ledger.launch)).toBe(true);
    const appended = appendNativeRawProcessEvidence(ledger, exit);
    expect(appended.launch).toBe(ledger.launch);
    expect(appended.later).toEqual([exit]); expect(Object.isFrozen(appended.later)).toBe(true);
    expect(ledger.later).toEqual([]);
  });
  it("refuses to replace the original launch and leaves the stored ledger untouched", () => {
    const ledger = nativeRawEvidenceLedger(launch); const mutated = appendNativeRawProcessEvidence(ledger, exit);
    const replacement: NativeRawLaunchEvidenceV1 = { ...launch, pid: 9999, launchDigest: "b".repeat(64), observedAt: "2026-01-01T00:00:02.000Z" };
    expect(() => appendNativeRawProcessEvidence(mutated, replacement)).toThrow(NativeRawEvidenceError);
    try { appendNativeRawProcessEvidence(mutated, replacement); } catch (error) { expect(error).toMatchObject({ code: "NATIVE_RAW_EVIDENCE_CONFLICT", retryable: false }); }
    expect(mutated).toEqual(appendNativeRawProcessEvidence(ledger, exit));
    expect(JSON.stringify(mutated)).toContain(launch.launchDigest);
  });
  it("rejects a root exit for another PID", () => {
    const ledger = nativeRawEvidenceLedger(launch);
    expect(() => appendNativeRawProcessEvidence(ledger, { ...exit, pid: 4243 })).toThrow("NATIVE_RAW_EVIDENCE_CONFLICT");
    expect(ledger.later).toEqual([]);
  });
  it("rejects unknown versions and malformed records instead of guessing", () => {
    const ledger = nativeRawEvidenceLedger(launch);
    expect(isNativeRawLaunchEvidence({ ...launch, version: 2 })).toBe(false);
    expect(isNativeRawProcessEvidence({ ...exit, version: 2 })).toBe(false);
    expect(isNativeRawProcessEvidence({ ...exit, code: 1.5 })).toBe(false);
    expect(isNativeRawProcessEvidence({ ...exit, signal: 9 })).toBe(false);
    expect(() => nativeRawEvidenceLedger({ ...launch, launchDigest: "not-a-digest" })).toThrow("NATIVE_RAW_EVIDENCE_INVALID");
    expect(() => appendNativeRawProcessEvidence(ledger, { ...exit, observedAt: "" })).toThrow("NATIVE_RAW_EVIDENCE_INVALID");
    expect(() => appendNativeRawProcessEvidence({ ...ledger, version: 2 } as unknown as ReturnType<typeof nativeRawEvidenceLedger>, exit)).toThrow("NATIVE_RAW_EVIDENCE_INVALID");
  });
  it("does not accept a raw launch observation as later evidence", () => {
    const ledger = nativeRawEvidenceLedger(launch);
    const anotherLaunch: NativeRawProcessEvidence = { ...launch, pid: 4242, launchDigest: "c".repeat(64) };
    expect(() => appendNativeRawProcessEvidence(ledger, anotherLaunch)).toThrow("NATIVE_RAW_EVIDENCE_CONFLICT");
  });
});
