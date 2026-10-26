# Interactive capability scenes: approval / interrupt / reconnect (c4–c7)

Status: design accepted 2026-10-24; **implemented and fully verified 2026-10-25 (both providers)**. Companion of `docs/core-capabilities-technical-design.md` §6.3.

Verification record (2026-10-25, macOS real runs, commit `5dfa372`):

- **Claude r8** (`.flyx-evidence/*/scene-claude-interactive-r8`): det+real passed;
  real layer 10/10 basic turns, approval ×2 (allow→file written / deny→denied),
  interrupt (turn.cancelled), reconnect (host restart + post-restart turn);
  native evidence complete, invalid 0. Destination `dest-claude`: import →
  activation verify/activate → `interactiveApprovals` published → **web
  approval-card E2E**: card raised in browser, respond → native confirmation
  in UI, file written on allow; activation survives host boot.
- **Codex r7** (`.flyx-evidence/codex-measured-runtime-pending/scene-codex-interactive-r7`):
  `det=passed real=passed current=fully-verified`; real layer 10/10 basic turns
  (46–179 s each), **approval ×2** (196 s / 252 s — first codex approval cards
  ever observed), interrupt (turn.cancelled, 167 s), reconnect (graceful
  verified shutdown, host restart, post-restart turn completed); native
  evidence `complete:true`, `invalid:0`, counts turn:13/approval:2/interrupt:1/
  reconnect:1. Destination `dest-codex`: import → activation verify/activate →
  capabilities `interactiveApprovals,interrupt,resumeConversation,
  streamingText,workspaceWrite`; boot check clean (no withdrawal).
- Root causes found and fixed on the way (all in `5dfa372`):
  - `PRODUCER_STOP_DEADLINE_MS = 30_000` threaded through
    orchestrator/adapters/runtimes — the previous 5 s finalize bound was
    exceeded by codex app-server tree stop verification, flipping healthy
    turns into `RUNTIME_STOP_UNVERIFIED` retention (codex r2/r4).
  - run-matrix: interrupt now waits for `provider.turn.bound` (an interrupt
    before the native turn binds has no target and strands the turn in
    outcome_unknown), approval-card wait 300 s (codex backend latency),
    stopHost SIGKILL grace 45 s (covers the host's 30 s verified stop).
  - §6 fail-closed risk covered by `macos-managed-execution.trust.test.ts`:
    the verified destination endorsement sceneVersion threads into
    `macosExecutionFactsTrust`, so an imported c7 activation survives boot.
  - Codex r6 approval-rep1 timeout root cause: model went off-script and
    requested access outside the workspace; the adapter's workspace guard
    auto-declined (`CODEX_APPROVAL_OUTSIDE_WORKSPACE`) — correct fail-closed
    behavior, not a defect; rerun (r7) passed.

Remaining follow-ups (tracked as tasks #28–#31, #18; 2026-10-26):

- **#29 Web 端 interrupt 入口统一**：计划 §C8 记录 Web 中断仍走
  `host.interrupt` 未统一到本场景已验证的 `session.interrupt` 路径；统一后
  对标 dest-claude 网页审批卡 E2E 做一次网页端真实中断验证（本场景目前
  的 interrupt 证据来自 compat RPC 驱动，网页面板未单独留档）。
- **#28 Web 四面板浏览器 E2E**（Recovery/Diff/Worktree/Revert，A5/A6/A13
  其余部分）：与交互场景无依赖，属 C8 收尾。
- **#30 resume（新会话续接）生产实测**：本场景的 reconnect 段验证的是
  Host 重启+重启后新 turn；`resumeConversation` 能力已随 endorsement 发布，
  但"新会话续接原 native 会话"尚无独立生产实测记录（矩阵内 turn 2+ 的
  `resumeSessionId` 自动续接不算独立验收）。
- **#31 进程重启找回原 worktree 创建操作**：C7 剩余，与交互场景无关。
- **#18 物理手机验收**：R9 唯一硬阻塞（缺 adb 设备），网络切换/后台恢复
  待硬件。
- 非目标不变：question 场景（`structuredQuestions`）与
  `conversationRewind` 仍未实现，registry 已预留段位。

## 1. Problem

On a destination host any disk-writing provider tool dead-ends on an approval card
that cannot be answered. This is enforced, not accidental:

- `catalog-interactions.effective(entry,"interactiveApprovals")` requires the
  capability in **both** `providerInstance.policyCapabilities` and
  `workspace.capabilities` (plus `typeof adapter.respondApproval === "function"`,
  which both real adapters implement).
- When it is missing, every public projection marks the card
  `responseAvailable:false` and `authorizeAnswer` throws
  `PROVIDER_CAPABILITY_UNVERIFIED` (`catalog-interactions.ts:286-293, 327-336`).
- The destination bootstrap (`destination-bootstrap.mjs:91-104`) deliberately
  publishes only `["streamingText","workspaceWrite"]`, because the c3 basic
  scene (`flyx-c3-basic-v1`, prompt "回复 OK 两个字母，不要做任何其他事") can
  only ever prove the `turn` baseline — it never elicits an approval request,
  an interrupt or a post-restart resume, so no evidence exists to endorse
  `interactiveApprovals` / `interrupt` / `resumeConversation`.

The same applies in weaker forms to interrupt (the capability only gates the
web composer control surface, `host-catalog.ts:368`) and reconnect
(`resumeConversation`), but per design §6.3 the destination must not publish a
capability its imported evidence does not verify, so all three need scene runs.

## 2. Reference implementations (t3code / paseo research summary)

Both projects route native provider approval hooks through a pending-request
map and forward a responder; the shape is identical for Claude (Agent SDK
`canUseTool` control requests) and Codex (app-server
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/tool/requestUserInput`):

- pending map keyed by native request id (`toolUseID` / `approvalId ?? itemId`);
- `respondToPermission(agentId, requestId, response)` looks the map up,
  resolves the native callback, and (paseo) starts a follow-up turn when the
  native result carries `followUpPrompt`;
- supersede/cleanup: unanswered approvals are denied when superseded or the
  turn ends; interrupt is delivered as `turn/interrupt`.

Flyx already mirrors this at the adapter level
(`claude/adapter.ts:392-434,590-618`; `codex/adapter.ts:334-351,700-752`) and at
the interaction level (`interaction-service.ts` ingest → `interaction.requested`
→ `respond` → `recordDelivery` with native-ack evidence). What is missing is
the **compatibility evidence chain**: no scene elicits these behaviors, the
recorder never records them, provenance rejects them, import cannot carry them,
and the destination cannot publish them.

## 3. Design constraints discovered in code (the hard ones)

1. **Same-run activation binding.** `newestPassedArtifact`
   (`host-activation-load.ts:364-387`) and `sceneManifestFor`
   (`native-history-manifest.ts:110-144`) require the turn baseline AND every
   policy-required scenario capability (map: `interrupt→interrupt`,
   `interactiveApprovals→approval`, `structuredQuestions→question`,
   `resumeConversation→reconnect`) on the **same runId, entryDigest and
   artifact digest**. Comment on record: *"One approval or a record from
   another build cannot activate general task execution."*
   Consequence: a destination whose policy requests N interactive capabilities
   must be activated by one run proving all N. Per-capability scenes can only
   activate destinations that request exactly that one capability.
2. **In-scene recovery inspection is currently unreachable in real runs.** The
   scene host's provider record carries `DEFAULT_POLICY` (includes
   `interrupt`, `interactiveApprovals`, `resumeConversation`), so
   `sceneManifestFor`'s required set is {turn, approval, interrupt, reconnect};
   c3 runs carry only turn records → no scene manifest → no in-scene recovery
   inspection → no recovery records. All real evidence dirs today
   (`.flyx-evidence/cli-2.1.216_node-24.18.0/*/native.jsonl`) contain exactly
   10 `turn/turn/passed` records and nothing else. A combined interactive
   scene is therefore also the first scene that makes the in-scene recovery
   inspection reachable in a real run.
3. **Scene policy pinning.** `compatibility-scene-policy.ts` pins one prompt
   (`COMPATIBILITY_BASIC_PROMPT`), one 10-slot in-order command-id family
   (`compatibilitySceneCommandIds` digests `{sceneVersion, runId}`), and
   `payload.resumeSessionId === session.providerSessionId` (turns 2+ are
   already resume turns because `decider.ts:37` adds `resumeSessionId`
   automatically). Any new scene must pin its own prompts, command families
   and consumption rules the same way.
4. **Recorder + provenance accept only turn/recovery.**
   `createCompatibilityCommittedRecorder` emits kind `turn` (and `recovery`);
   `resolveManagedNativeProvenance` whitelists
   `["turn","interrupt","stop","recovery"]` and pins `nativeSourceId` to the
   turn's exactly-1 native-terminal event (`turn.completed` for passed turns /
   `turn.cancelled` for failed ones). Approval evidence needs a different
   anchor (the interaction row's native request id + its native-ack delivery),
   reconnect needs a post-restart resume anchor.
5. **sceneVersion is pinned in five places** (authorize ticket, readiness
   stamp, recorder context, evidence records + trust filter defaults in
   `compatibility-evidence.ts:348,357`, import acceptance
   `compatibility-import.ts:27,59,66,80`). All must become registry-driven.
6. **Import types capabilities as `("turn"|"recovery")[]`**
   (`compatibility-import.ts:97`) and requires ≥10 deduped passed turn records
   — every scene therefore keeps 10 basic turns as its baseline.
7. **Any host source change invalidates every existing real evidence chain**
   (entryDigest changes → source runs AND destination activations must be
   re-run). This is accepted; the re-verification chain is part of the plan.

## 4. Scene registry (the design)

New module `apps/mvp-host/src/diagnostics/compatibility-scenes.ts`. A scene is
a **set of segments**; each interactive capability gets its own segment with
its own fixed prompt, command-id family, driving semantics and evidence kind —
this is the "each capability gets its own scene" requirement, realized as
independently verified, independently recordable scenario segments. A run
executes one registered set; the set's sceneVersion is a stable registry
constant.

| set (segments)                      | sceneVersion            | proven capabilities | purpose |
|-------------------------------------|-------------------------|---------------------|---------|
| `[basic]`                           | `flyx-c3-basic-v1`      | turn                | existing baseline (unchanged, back-compat) |
| `[basic,approval]`                  | `flyx-c4-approval-v1`   | turn, approval      | focused approval verification |
| `[basic,interrupt]`                 | `flyx-c5-interrupt-v1`  | turn, interrupt     | focused interrupt verification |
| `[basic,reconnect]`                 | `flyx-c6-reconnect-v1`  | turn, reconnect     | focused reconnect verification |
| `[basic,approval,interrupt,reconnect]` | `flyx-c7-interactive-v1` | turn, approval, interrupt, reconnect | destination activation run |

Registry API (pure, no I/O):

```ts
export type CompatibilitySceneSegmentId = "basic" | "approval" | "interrupt" | "reconnect";
export type CompatibilitySceneSegment = Readonly<{
  id: CompatibilitySceneSegmentId;
  prompt: string;            // fixed per scene version
  repetitions: number;       // segment turns per run (basic: 10)
  commandCount: number;      // command-id family size
  capability: "turn" | "approval" | "interrupt" | "reconnect";
}>;
export const SCENE_REGISTRY: ReadonlyMap<string, readonly CompatibilitySceneSegment[]>; // sceneVersion -> ordered segments
export function sceneSegments(sceneVersion: string): readonly CompatibilitySceneSegment[] | undefined;
export function sceneVersionForSegments(ids: readonly CompatibilitySceneSegmentId[]): string | undefined;
export function scenePrompts(sceneVersion: string): readonly string[];      // ordered, unique
export function compatibilitySceneCommandIds(sceneVersion: string, runId: string): readonly string[]; // flat, in consumption order
```

`compatibilitySceneCommandIds` stays deterministic:
`compat-${digest({sceneVersion, runId}).slice(0,32)}-<segmentId>-<index>` and
the legacy basic family keeps its existing shape
(`compat-<prefix>-<n>`, digest over `{sceneVersion:"flyx-c3-basic-v1", runId}`)
so c3 evidence, tickets and configs remain valid.

### Segment semantics

- **basic** — today's behavior: 10 turns of `COMPATIBILITY_BASIC_PROMPT`, one
  command per turn, in order; recorder records kind `turn`.
- **approval** — fixed prompt that forces a disk-writing tool call in the
  workspace, e.g. “在当前工作区创建文件 approval-scene.txt，内容为 OK，然后回复
  DONE，不要做任何其他事”。 Driving (run-matrix, real layer only): wait
  `approval.requested` for the turn → `approval.respond` (`allow_once` on the
  first repetition, `deny` on the second) → await terminal. The turn still
  completes normally (deny denies the tool, the model finishes the turn), so
  the turn baseline stays intact. Recorder records one kind `approval` entry
  per **confirmed** interaction row of that turn (native-ack delivery), with
  `capability:"approval"`, `nativeRequestIdHash` from the interaction row.
- **interrupt** — fixed prompt that runs long enough to interrupt, e.g. “从 1
  数到 50，每数一个数字就输出一次，不要做任何其他事”。 Driving: wait
  `turn.started` → `session.interrupt` → terminal must be `turn.cancelled`.
  Recorder records kind `interrupt` (result `passed` iff the turn terminal is
  `turn.cancelled` AND a `session.interrupt` receipt exists binding that turn),
  with `stopRecordDigest` per provenance rules.
- **reconnect** — after the basic segment, run-matrix **restarts the scene host
  process** (SIGTERM → respawn with identical env/DB/identity; readiness is
  re-awaited for the same run), then starts the reconnect turn whose prompt is
  the basic prompt; `decider` automatically attaches
  `resumeSessionId === providerSessionId`. Recorder records kind `reconnect`
  for a completed turn whose start intent carried `resumeSessionId` equal to a
  provider session id established by a turn from an **earlier host owner
  generation** (post-restart resume is what distinguishes reconnect from the
  every-turn resume c3 already does).

### Scene policy changes (`compatibility-scene-policy.ts`)

- The ticket's `sceneVersion` resolves through the registry; unknown version →
  `COMPATIBILITY_SCENE_VERSION_UNSUPPORTED`.
- `assertStart` accepts a prompt only if it is one of the scene's prompts and
  the commandId belongs to the matching segment family.
- `assertAcceptInCommit` consumption: the flat in-order command list still
  governs — basic slots first (10, in order), then each non-basic segment's
  slots in registry order. The prompt-in-intent/turn pinning and
  `resumeSessionId` pinning are unchanged; the per-prompt check uses the
  segment prompt.
- `assertDispatch`/`assertObservation` pin the segment prompt per command.
- Interrupt/approval/respond commands themselves are NOT scene-reserved: they
  flow through the ordinary control path (the scene policy never sees them;
  the interrupt receipt check for recorder evidence uses the store).

### Where sceneVersion threads through

`authorizeCompatibilityRun` gains the scene version as an input (default c3)
and stamps it in the ticket; `assertSource`, readiness stamp, recorder context
stamp, evidence `record` context, `readCompatibilityEvidence` trust filter and
import acceptance all take the version from the ticket/registry instead of the
`flyx-c3-basic-v1` constant. `compatibility-readiness.ts` keeps
`COMPATIBILITY_SCENE_VERSION` as the c3 constant for back-compat.

## 5. Recorder + provenance

`createCompatibilityCommittedRecorder.afterCommittedNativeStop(context)`
extends (single hook site, orchestrator unchanged except the interface stays
the same — all new facts are re-derived from the store by DispatchContext):

1. **turn** (unchanged): terminal `turn.completed` → kind `turn` passed.
   A `turn.cancelled` terminal with NO interrupt intent on that turn stays the
   current behavior (kind `turn` result `failed`).
2. **interrupt**: turn terminal `turn.cancelled` AND a command receipt of
   method `session.interrupt` whose control bound this turn (store query) →
   kind `interrupt`, result `passed` iff cancelled; `nativeSourceId` = the
   terminal event sourceId; `stopRecordDigest` from the stop facts (same as
   today's interrupt/stop provenance contract).
3. **approval**: after recording the turn record, enumerate `interactions`
   rows for (session, turn, attempt) with `status="confirmed"` (native-ack
   delivery) and `native_request_id` present → one record per row, kind
   `approval`, `capability:"approval"`, result `passed`, `nativeRequestIdHash`
   = digest of the native request id, `launchRef`/`stopRef` = the turn's
   process refs. Dedup key `nativeSessionIdHash:nativeRequestIdHash`
   (matches `nativeCounts`).
4. **reconnect**: turn completed AND the start intent payload carried
   `resumeSessionId` equal to the session's pre-restart `providerSessionId`
   AND the turn's `dispatchContext.hostOwnerGeneration` differs from the
   generation of the intent that established that provider session id → kind
   `reconnect`, result `passed` iff the turn completed.

`resolveManagedNativeProvenance` kind whitelist becomes
`["turn","interrupt","stop","recovery","approval","reconnect"]` with:

- `approval`: same launch-row/snapshot/binding derivation as turn, but the
  anchor is the interaction: exactly one `interactions` row with the turn's
  attempt/runtime ids, matching `nativeRequestIdHash`, delivery evidence kind
  `native-ack`, and the native method's provider routing consistent with
  `methodMatches` (codex `item/*`). `nativeSourceId` is not compared to the
  terminal event (an approval is not a terminal); it carries the interaction
  row digest anchor.
- `reconnect`: turn branch plus the resume pin (payload `resumeSessionId` on
  the start intent + generation delta as above); terminal match stays
  `turn.completed` for passed.

`compatibility-evidence.ts` `NativeCompatibilityEvidence` already types these
kinds and per-kind native id requirements (`approval/question` passed requires
`nativeRequestIdHash`) — only the recorder/provenance/import sides change.

## 6. Import + destination publication

- `compatibility-import.ts`: ticket sceneVersion must resolve in the registry;
  evidence entries are filtered by the ticket's sceneVersion (already
  compared, now registry-sourced); capability union typing widens to
  `("turn"|"recovery"|"approval"|"interrupt"|"reconnect")[]`. The ≥10-turn
  requirement is unchanged (every scene keeps 10 basic turns).
- `destination-bootstrap.mjs` gains `--capabilities` (e.g.
  `approval,interrupt,reconnect`): it maps evidence capabilities to policy
  names (`approval→interactiveApprovals`, `interrupt→interrupt`,
  `reconnect→resumeConversation`) and publishes them in BOTH
  `workspaces[0].capabilities` and `providerInstances[0].policyCapabilities`
  alongside `streamingText` (+`workspaceWrite` as today). The activation CLI /
  import step refuses publication of capabilities the imported endorsement
  does not carry (import already signs the capability list; the bootstrap
  publishes a subset of it, never more).
- `newestPassedArtifact`/`sceneManifestFor` stay as-is: with the c7 combined
  run imported, the destination's required set {turn, approval, interrupt,
  reconnect} is satisfied on that one run — and the production recovery
  manifest additionally needs the recovery entry on the same run, which the
  in-scene recovery inspection (now reachable, constraint 2) records.

The destination approval card then renders answerable:
`effective("interactiveApprovals")` = published policy ∩ workspace ∩ real
adapter `respondApproval`.

## 7. run-matrix + configs

- `run-matrix.mjs`: `--scene basic|approval|interrupt|reconnect|interactive`
  (default basic). The deterministic layer always runs the basic segment only
  (the deterministic adapter does not emit approval requests); the real layer
  runs the full scene set. `MATRIX_SCENE_UNSUPPORTED` is removed for
  registered scenes; scene/segment prompts come from the registry via the
  imported dist module (same pattern as `composeCandidateArtifact`).
- Per-scene driving (real layer): approval (as §4), interrupt (as §4),
  reconnect = host restart + resumed turn (as §4). The host restart requires
  run-matrix to spawn the host per layer (already does) and re-await readiness
  with the same runId; the readiness check accepts re-started hosts (pid
  changes; readiness file re-written by the new process).
- New config files `config/claude-compatibility-{approval,interrupt,reconnect,interactive}.json`
  derived from `config/claude-compatibility.json` with per-scene
  `sceneVersion`, `matrixPrompt` (basic prompt stays), `realRequirements`
  (`approval:2`, `interrupt:1`, `reconnect:1` per scene) and
  `capabilities` lists. `config/claude-compatibility.json` is user-modified
  and stays untouched.
- `evidence.mjs`: `compatibilitySceneCommandIds` moves to the registry
  (imported from dist); `parseReadiness`/`parseNativeEvidence`/evaluate take
  the scene's sceneVersion; `evaluateVerification`'s `nativeComplete` uses the
  scene's required counts; `capabilityMatches` unchanged.

## 8. Verification plan (per standing directive)

1. Unit tests: registry (version↔segments, command families, c3 back-compat),
   scene policy (per-segment prompt/command pinning, consumption order),
   recorder (turn/interrupt/approval/reconnect evidence incl. dedup),
   provenance (approval interaction anchor, reconnect generation pin),
   import (sceneVersion registry acceptance, capability typing), destination
   publication mapping.
2. Full existing suites (pnpm -r test) — 1376+ passing baseline.
3. dist rebuild → new entryDigest → deterministic matrix both providers,
   all scenes.
4. Real chain per standing goal: fresh `--prepare` + `authorize` +
   `run-matrix --real --scene interactive` for claude and codex (c3 regression
   optional), destination re-bootstrap with `--capabilities
   approval,interrupt,reconnect`, import, activation verify/activate, and web
   verification that an approval card on the destination is answerable
   (respond allow → tool executes; respond deny → tool denied).
5. Commit + push after each completed task; more testing per directive.

## 9. Non-goals

- `structuredQuestions` (question scene) and `conversationRewind` stay
  unimplemented; the registry accepts future segments.
- No changes to `config/claude-compatibility.json` (user-modified).
- No remote/mobile approval UX changes beyond the capability becoming
  answerable; the deadlock fix is the destination capability publication.
- Secrets policy unchanged: no tokens logged or persisted; auth mode checks
  remain keychain-existence-only.
