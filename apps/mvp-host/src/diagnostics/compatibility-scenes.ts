import { compatibilityDigest } from "./compatibility-integrity.js";

/**
 * Scene registry (design: docs/design/interactive-scenes.md §4).
 *
 * A compatibility scene is an ordered set of independently verified scenario
 * segments. The `basic` segment is the c3 turn baseline; each interactive
 * capability (approval / interrupt / reconnect) gets its own segment with its
 * own fixed prompt and command-id family, so a run of a registered set proves
 * exactly the capabilities of that set on one runId — which is what
 * same-run activation binding (newestPassedArtifact / sceneManifestFor)
 * requires for multi-capability destination activation.
 *
 * Pure data + derivations only; no I/O, no store access.
 */
export type CompatibilitySceneSegmentId = "basic" | "approval" | "interrupt" | "reconnect";
export type CompatibilitySceneSegment = Readonly<{
  id: CompatibilitySceneSegmentId;
  /** Fixed per scene version; pinned end-to-end by the scene policy. */
  prompt: string;
  /** Segment turns per run. Every scene keeps the 10-turn basic baseline. */
  repetitions: number;
  /** Command-id family size for this segment (one command per turn). */
  commandCount: number;
  capability: "turn" | "approval" | "interrupt" | "reconnect";
}>;

export const COMPATIBILITY_SCENE_BASIC_PROMPT = "回复 OK 两个字母，不要做任何其他事";
/** The approval prompt forces a disk-writing tool call in the workspace. */
export const COMPATIBILITY_SCENE_APPROVAL_PROMPT = "在当前工作区创建文件 approval-scene.txt，内容为 OK，然后回复 DONE，不要做任何其他事";
/** The interrupt prompt runs long enough to be interrupted mid-turn. */
export const COMPATIBILITY_SCENE_INTERRUPT_PROMPT = "从 1 数到 50，每数一个数字就输出一次，不要做任何其他事";
/** The reconnect turn reuses the basic prompt; the restart is the event. */
export const COMPATIBILITY_SCENE_RECONNECT_PROMPT = COMPATIBILITY_SCENE_BASIC_PROMPT;

export const BASIC_SEGMENT: CompatibilitySceneSegment = Object.freeze({
  id: "basic", prompt: COMPATIBILITY_SCENE_BASIC_PROMPT, repetitions: 10, commandCount: 10, capability: "turn",
});
const APPROVAL_SEGMENT: CompatibilitySceneSegment = Object.freeze({
  id: "approval", prompt: COMPATIBILITY_SCENE_APPROVAL_PROMPT, repetitions: 2, commandCount: 2, capability: "approval",
});
const INTERRUPT_SEGMENT: CompatibilitySceneSegment = Object.freeze({
  id: "interrupt", prompt: COMPATIBILITY_SCENE_INTERRUPT_PROMPT, repetitions: 1, commandCount: 1, capability: "interrupt",
});
const RECONNECT_SEGMENT: CompatibilitySceneSegment = Object.freeze({
  id: "reconnect", prompt: COMPATIBILITY_SCENE_RECONNECT_PROMPT, repetitions: 1, commandCount: 1, capability: "reconnect",
});

/** sceneVersion -> ordered segments. Registry insertion order is irrelevant; lookups are by key. */
export const SCENE_REGISTRY: ReadonlyMap<string, readonly CompatibilitySceneSegment[]> = new Map([
  ["flyx-c3-basic-v1", Object.freeze([BASIC_SEGMENT])],
  ["flyx-c4-approval-v1", Object.freeze([BASIC_SEGMENT, APPROVAL_SEGMENT])],
  ["flyx-c5-interrupt-v1", Object.freeze([BASIC_SEGMENT, INTERRUPT_SEGMENT])],
  ["flyx-c6-reconnect-v1", Object.freeze([BASIC_SEGMENT, RECONNECT_SEGMENT])],
  ["flyx-c7-interactive-v1", Object.freeze([BASIC_SEGMENT, APPROVAL_SEGMENT, INTERRUPT_SEGMENT, RECONNECT_SEGMENT])],
]);

export type CompatibilitySceneCapability = "turn" | "approval" | "interrupt" | "reconnect";

/** Resolve a scene's ordered segments; undefined for unregistered versions. */
export function sceneSegments(sceneVersion: string): readonly CompatibilitySceneSegment[] | undefined {
  return SCENE_REGISTRY.get(sceneVersion);
}

/** Capabilities a run of this scene proves (ordered, unique). */
export function sceneCapabilities(sceneVersion: string): readonly CompatibilitySceneCapability[] | undefined {
  const segments = sceneSegments(sceneVersion);
  return segments?.map((segment) => segment.capability);
}

/** The sceneVersion registered for exactly this ordered segment id set. */
export function sceneVersionForSegments(ids: readonly CompatibilitySceneSegmentId[]): string | undefined {
  for (const [sceneVersion, segments] of SCENE_REGISTRY) {
    if (segments.length === ids.length && segments.every((segment, index) => segment.id === ids[index])) return sceneVersion;
  }
  return undefined;
}

/** Ordered unique prompts of a scene, in consumption order (assertStart accepts exactly these). */
export function scenePrompts(sceneVersion: string): readonly string[] {
  const segments = sceneSegments(sceneVersion);
  if (!segments) throw Object.assign(new Error("COMPATIBILITY_SCENE_VERSION_UNSUPPORTED"), { code: "COMPATIBILITY_SCENE_VERSION_UNSUPPORTED" });
  return [...new Set(segments.map((segment) => segment.prompt))];
}

/** Segment for one of the scene's prompts (unique prompts guaranteed by scenePrompts). */
export function sceneSegmentForPrompt(sceneVersion: string, prompt: string): CompatibilitySceneSegment | undefined {
  return sceneSegments(sceneVersion)?.find((segment) => segment.prompt === prompt);
}

function sceneCommandPrefix(sceneVersion: string, runId: string): string {
  return compatibilityDigest({ sceneVersion, runId }).slice(0, 32);
}

/**
 * Flat, in consumption order: basic slots first, then each non-basic segment's
 * slots in registry order. The legacy c3 basic family keeps its existing shape
 * (`compat-<prefix>-<n>`, digest over the c3 sceneVersion) so c3 evidence,
 * tickets and configs remain valid; other scenes use
 * `compat-<digest({sceneVersion,runId}).slice(0,32)>-<segmentId>-<index>`.
 */
export function compatibilitySceneCommandIds(sceneVersion: string, runId: string): readonly string[] {
  const segments = sceneSegments(sceneVersion);
  if (!segments) {
    throw Object.assign(new Error("COMPATIBILITY_SCENE_VERSION_UNSUPPORTED"), { code: "COMPATIBILITY_SCENE_VERSION_UNSUPPORTED" });
  }
  const prefix = sceneCommandPrefix(sceneVersion, runId);
  if (sceneVersion === "flyx-c3-basic-v1") {
    // Legacy family preserved byte-for-byte with the pre-registry derivation.
    return Object.freeze(Array.from({ length: BASIC_SEGMENT.commandCount }, (_, index) => `compat-${prefix}-${index + 1}`));
  }
  const ids: string[] = [];
  for (const segment of segments) {
    for (let index = 0; index < segment.commandCount; index += 1) {
      // c3 basic slots inside a newer scene use the segment-tagged shape; only
      // the flyx-c3-basic-v1 version itself emits the legacy family.
      ids.push(`compat-${prefix}-${segment.id}-${index + 1}`);
    }
  }
  return Object.freeze(ids);
}

/** Command-id family of one segment, in order. */
export function sceneSegmentCommandIds(sceneVersion: string, runId: string, segmentId: CompatibilitySceneSegmentId): readonly string[] {
  const segments = sceneSegments(sceneVersion);
  const segment = segments?.find((entry) => entry.id === segmentId);
  if (!segments || !segment) {
    throw Object.assign(new Error("COMPATIBILITY_SCENE_VERSION_UNSUPPORTED"), { code: "COMPATIBILITY_SCENE_VERSION_UNSUPPORTED" });
  }
  const prefix = sceneCommandPrefix(sceneVersion, runId);
  return Object.freeze(Array.from({ length: segment.commandCount }, (_, index) =>
    sceneVersion === "flyx-c3-basic-v1" ? `compat-${prefix}-${index + 1}` : `compat-${prefix}-${segment.id}-${index + 1}`));
}

/** Total command slots a run of this scene consumes (sum over segments). */
export function sceneCommandCount(sceneVersion: string): number {
  return sceneSegments(sceneVersion)?.reduce((total, segment) => total + segment.commandCount, 0) ?? 0;
}
