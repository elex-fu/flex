import { describe, expect, it } from "vitest";
import { compatibilityDigest } from "./compatibility-integrity.js";
import {
  compatibilitySceneCommandIds,
  sceneCapabilities,
  sceneCommandCount,
  scenePrompts,
  sceneSegmentCommandIds,
  sceneSegments,
  sceneVersionForSegments,
  SCENE_REGISTRY,
  COMPATIBILITY_SCENE_APPROVAL_PROMPT,
  COMPATIBILITY_SCENE_BASIC_PROMPT,
  COMPATIBILITY_SCENE_INTERRUPT_PROMPT,
} from "./compatibility-scenes.js";

const runId = "scenes-test-run";

describe("compatibility scene registry", () => {
  it("registers exactly the five designed scene sets", () => {
    expect([...SCENE_REGISTRY.keys()].sort()).toEqual([
      "flyx-c3-basic-v1", "flyx-c4-approval-v1", "flyx-c5-interrupt-v1", "flyx-c6-reconnect-v1", "flyx-c7-interactive-v1",
    ]);
    for (const [sceneVersion, segments] of SCENE_REGISTRY) {
      expect(sceneVersionForSegments(segments.map((segment) => segment.id))).toBe(sceneVersion);
      expect(sceneCapabilities(sceneVersion)?.[0]).toBe("turn");
    }
  });

  it("keeps the legacy c3 basic command family byte-for-byte", () => {
    const legacyPrefix = compatibilityDigest({ sceneVersion: "flyx-c3-basic-v1", runId }).slice(0, 32);
    const legacy = Array.from({ length: 10 }, (_, index) => `compat-${legacyPrefix}-${index + 1}`);
    expect([...compatibilitySceneCommandIds("flyx-c3-basic-v1", runId)]).toEqual(legacy);
    expect(sceneSegmentCommandIds("flyx-c3-basic-v1", runId, "basic")).toEqual(legacy);
    expect(sceneCommandCount("flyx-c3-basic-v1")).toBe(10);
  });

  it("orders the combined interactive scene flat command list: basic, approval, interrupt, reconnect", () => {
    const ids = compatibilitySceneCommandIds("flyx-c7-interactive-v1", runId);
    expect(ids).toHaveLength(14);
    expect(new Set(ids).size).toBe(14);
    const prefix = compatibilityDigest({ sceneVersion: "flyx-c7-interactive-v1", runId }).slice(0, 32);
    expect(ids[0]).toBe(`compat-${prefix}-basic-1`);
    expect(ids[9]).toBe(`compat-${prefix}-basic-10`);
    expect(ids[10]).toBe(`compat-${prefix}-approval-1`);
    expect(ids[11]).toBe(`compat-${prefix}-approval-2`);
    expect(ids[12]).toBe(`compat-${prefix}-interrupt-1`);
    expect(ids[13]).toBe(`compat-${prefix}-reconnect-1`);
    expect(sceneCommandCount("flyx-c7-interactive-v1")).toBe(14);
  });

  it("emits distinct families per scene version and prompt per segment", () => {
    const c3 = compatibilitySceneCommandIds("flyx-c3-basic-v1", runId);
    const c4 = compatibilitySceneCommandIds("flyx-c4-approval-v1", runId);
    expect(c3.some((id) => c4.includes(id))).toBe(false);
    expect(scenePrompts("flyx-c4-approval-v1")).toEqual([COMPATIBILITY_SCENE_BASIC_PROMPT, COMPATIBILITY_SCENE_APPROVAL_PROMPT]);
    expect(scenePrompts("flyx-c5-interrupt-v1")).toEqual([COMPATIBILITY_SCENE_BASIC_PROMPT, COMPATIBILITY_SCENE_INTERRUPT_PROMPT]);
    // reconnect reuses the basic prompt, so its scene has one prompt
    expect(scenePrompts("flyx-c6-reconnect-v1")).toEqual([COMPATIBILITY_SCENE_BASIC_PROMPT]);
    expect(scenePrompts("flyx-c7-interactive-v1")).toEqual([
      COMPATIBILITY_SCENE_BASIC_PROMPT, COMPATIBILITY_SCENE_APPROVAL_PROMPT, COMPATIBILITY_SCENE_INTERRUPT_PROMPT,
    ]);
  });

  it("refuses unknown scene versions", () => {
    expect(sceneSegments("flyx-c99-unknown-v1")).toBeUndefined();
    expect(sceneVersionForSegments(["basic", "reconnect", "approval"])).toBeUndefined();
    expect(() => scenePrompts("flyx-c99-unknown-v1")).toThrow("COMPATIBILITY_SCENE_VERSION_UNSUPPORTED");
    expect(() => compatibilitySceneCommandIds("flyx-c99-unknown-v1", runId)).toThrow("COMPATIBILITY_SCENE_VERSION_UNSUPPORTED");
    expect(() => sceneSegmentCommandIds("flyx-c99-unknown-v1", runId, "basic")).toThrow("COMPATIBILITY_SCENE_VERSION_UNSUPPORTED");
  });
});
