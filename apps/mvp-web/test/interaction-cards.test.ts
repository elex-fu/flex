import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionSchema, type Interaction } from "@flyx/mvp-protocol";
import { InteractionCard } from "../src/components/interaction-card.js";
import { buildApprovalResponse, buildQuestionResponse, emptyQuestionDraft, interactionReadiness, interactionStatusLabel, toggleQuestionOption } from "../src/components/interaction-card-helpers.js";
const common = { interactionId: "interaction", sessionId: "session", turnId: "turn", version: 7, status: "pending", deliveryState: "none", evidenceKind: "native_request", createdAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-15T00:10:00.000Z", responseAvailable: true };
const question = InteractionSchema.parse({ ...common, kind: "question", allowedActions: ["answer"], request: { blocking: true, questions: [{ questionId: "question", header: "Choice", question: "Pick an option", multiSelect: true, allowFreeText: true, secret: true, options: [{ optionId: "option-1", label: "One", description: "First", preview: "<script>alert(1)</script>" }, { optionId: "option-2", label: "Two", description: "Second" }] }] } }) as Extract<Interaction, {
  kind: "question";
}>;
const approval = InteractionSchema.parse({ ...common, kind: "approval", allowedActions: ["allow_once", "deny"], request: { toolName: "Bash", title: "Run tests", reason: "Check the change", commandPreview: "npm test", filePreviews: ["src/main.ts"] } }) as Extract<Interaction, {
  kind: "approval";
}>;
const ready = { online: true, synced: true, authoritative: true, approvalWrite: true, sourceRevision: 1, now: "2026-10-15T00:01:00.000Z" };
function render(value: Interaction, readiness = ready): string { return renderToStaticMarkup(createElement(InteractionCard, { interaction: value, workspaceLabel: "Workspace A", readiness, onAnswer: async () => { throw new Error("unused"); }, onApprove: async () => { throw new Error("unused"); } })); }
test("cached, incomplete, offline, expired and unverified interactions cannot produce runnable buttons", () => {
  assert.equal(interactionReadiness(question, ready).ready, true);
  for (const state of [{ online: false }, { synced: false }, { authoritative: false }, { approvalWrite: false }, { now: "2026-10-15T00:11:00.000Z" }]) {
    const readiness = { ...ready, ...state };
    assert.equal(interactionReadiness(question, readiness).ready, false);
    assert.match(render(question, readiness), /disabled/);
  }
  for (const status of ["responding", "delivered", "confirmed", "expired", "superseded", "outcome_unknown"] as const)
    assert.equal(interactionReadiness({ ...question, status }, ready).ready, false);
  assert.equal(interactionReadiness({ ...question, responseAvailable: false }, ready).ready, false);
});
test("cards show workspace, reason, execution previews and escaped text with secret input", () => {
  const questionHtml = render(question);
  assert.match(questionHtml, /Workspace A/);
  assert.match(questionHtml, /type="password"/);
  assert.match(questionHtml, /&lt;script&gt;/);
  assert.doesNotMatch(questionHtml, /<script>/);
  assert.match(questionHtml, /min-height:44px/);
  const approvalHtml = render(approval);
  for (const text of ["Workspace A", "Run tests", "Check the change", "npm test", "src/main.ts", "Allow once", "Deny"])
    assert.ok(approvalHtml.includes(text));
});
test("typed reply builders retain authority version and only stable option IDs", () => {
  const draft = emptyQuestionDraft(question);
  assert.throws(() => buildQuestionResponse(question, draft));
  draft.question = toggleQuestionOption(question.request.questions[0]!, draft.question!, "option-2");
  draft.question = toggleQuestionOption(question.request.questions[0]!, draft.question, "option-1");
  assert.deepEqual(buildQuestionResponse(question, draft), { sessionId: "session", interactionId: "interaction", expectedVersion: 7, answers: [{ questionId: "question", optionIds: ["option-1", "option-2"] }] });
  assert.throws(() => toggleQuestionOption(question.request.questions[0]!, draft.question!, "One"));
  draft.question = { optionIds: ["option-1"], text: "custom" };
  assert.deepEqual(buildQuestionResponse(question, draft).answers, [{ questionId: "question", optionIds: [], text: "custom" }]);
  draft.question = { optionIds: [], text: " ".repeat(10) };
  assert.throws(() => buildQuestionResponse(question, draft));
  assert.deepEqual(buildApprovalResponse(approval, "deny"), { sessionId: "session", interactionId: "interaction", expectedVersion: 7, action: "deny" });
  assert.throws(() => buildApprovalResponse({ ...approval, allowedActions: ["deny"] }, "allow_once"));
});
test("status copy distinguishes reservation, local delivery, native confirmation and unknown delivery", () => {
  assert.match(interactionStatusLabel("accepted"), /reserved/);
  assert.match(interactionStatusLabel("delivered"), /locally/);
  assert.match(interactionStatusLabel("confirmed"), /Native/);
  assert.match(interactionStatusLabel("outcome_unknown"), /unconfirmed/);
  assert.notEqual(interactionStatusLabel("delivered"), interactionStatusLabel("confirmed"));
});
