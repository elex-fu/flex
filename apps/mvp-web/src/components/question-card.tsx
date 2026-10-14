import { useEffect, useState, type CSSProperties } from "react";
import type { Interaction, InteractionResponse, QuestionRespondRequest } from "@flyx/mvp-protocol";
import { buildQuestionResponse, emptyQuestionDraft, interactionReadiness, interactionStatusLabel, toggleQuestionOption, type InteractionReadiness } from "./interaction-card-helpers.js";
export type QuestionCardProps = {
  interaction: Extract<Interaction, {
    kind: "question";
  }>;
  workspaceLabel: string;
  readiness: InteractionReadiness;
  onRespond: (request: QuestionRespondRequest) => Promise<InteractionResponse>;
};
const control: CSSProperties = { minHeight: 44, width: "100%", padding: "10px 12px", borderRadius: 8 };
export function QuestionCard({ interaction, workspaceLabel, readiness, onRespond }: QuestionCardProps) {
  const [draft, setDraft] = useState(() => emptyQuestionDraft(interaction));
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<InteractionResponse>();
  const [error, setError] = useState("");
  useEffect(() => { setDraft(emptyQuestionDraft(interaction)); setReceipt(undefined); setBusy(false); setError(""); }, [interaction.interactionId, interaction.version]);
  useEffect(() => { setError(""); }, [readiness.sourceRevision]);
  const state = interactionReadiness(interaction, readiness);
  const enabled = state.ready && !busy && !receipt && !error;
  let valid = true;
  try {
    buildQuestionResponse(interaction, draft);
  }
  catch {
    valid = false;
  }
  const submit = async () => {
    if (!enabled)
      return;
    setBusy(true);
    setError("");
    try {
      const request = buildQuestionResponse(interaction, draft);
      setReceipt(await onRespond(request));
    }
    catch {
      setError("Response was not accepted. Refresh the request before retrying; your draft is still here.");
    }
    finally {
      setBusy(false);
    }
  };
  return <section aria-label="Question request" data-interaction-id={interaction.interactionId} style={{ padding: 16, border: "1px solid currentColor", borderRadius: 12 }}>
  <p>{workspaceLabel} · {interaction.request.blocking ? "Turn needs an answer" : "Provider question"}</p>
  <p role="status">{busy ? "Sending response…" : receipt ? interactionStatusLabel(receipt.status) : state.reason || interactionStatusLabel(interaction.status)}</p>
  <fieldset disabled={!enabled} style={{ border: 0, padding: 0, margin: 0 }}>
   {interaction.request.questions.map((question) => {
      const answer = draft[question.questionId] ?? { optionIds: [], text: "" };
      return <fieldset key={question.questionId} style={{ border: 0, padding: 0, margin: "16px 0" }}>
     <legend><strong>{question.header}</strong></legend><p>{question.question}</p>
     {question.multiSelect && <p>Select one or more options.</p>}
     {question.options.map((option) => <label key={option.optionId} style={{ display: "block", padding: "12px 0", minHeight: 44 }}>
      <input type={question.multiSelect ? "checkbox" : "radio"} name={question.questionId} checked={answer.optionIds.includes(option.optionId)} onChange={() => setDraft((previous) => ({ ...previous, [question.questionId]: toggleQuestionOption(question, answer, option.optionId) }))}/>{" "}
      <strong>{option.label}</strong><span style={{ display: "block", marginLeft: 24 }}>{option.description}</span>
      {option.preview && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginLeft: 24 }}>{option.preview}</pre>}
     </label>)}
     {question.allowFreeText && <label style={{ display: "block" }}>Your answer
      <input aria-label={`${question.header}: your answer`} type={question.secret ? "password" : "text"} autoComplete="off" maxLength={2048} value={answer.text} style={control} onChange={(event) => { const text = event.currentTarget.value; setDraft((previous) => ({ ...previous, [question.questionId]: { text, optionIds: text ? [] : answer.optionIds } })); }}/>
     </label>}
    </fieldset>;
    })}
   <button type="button" style={control} disabled={!enabled || !valid} onClick={() => void submit()}>Send answer</button>
  </fieldset>
  {error && <p role="alert">{error}</p>}
 </section>;
}
