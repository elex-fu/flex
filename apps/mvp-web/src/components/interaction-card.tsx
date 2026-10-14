import { useEffect, useState } from "react";
import type { Interaction, InteractionRespondApprovalRequest, InteractionResponse, QuestionRespondRequest } from "@flyx/mvp-protocol";
import { QuestionCard } from "./question-card.js";
import { buildApprovalResponse, interactionReadiness, interactionStatusLabel, type InteractionReadiness } from "./interaction-card-helpers.js";
export type InteractionCardProps = {
  interaction: Interaction;
  workspaceLabel: string;
  readiness: InteractionReadiness;
  onApprove: (request: InteractionRespondApprovalRequest) => Promise<InteractionResponse>;
  onAnswer: (request: QuestionRespondRequest) => Promise<InteractionResponse>;
};
export function InteractionCard(props: InteractionCardProps) {
  return props.interaction.kind === "question" ? <QuestionCard key={`${props.interaction.interactionId}:${props.interaction.version}`} interaction={props.interaction} workspaceLabel={props.workspaceLabel} readiness={props.readiness} onRespond={props.onAnswer}/>
    : <ApprovalInteractionCard key={`${props.interaction.interactionId}:${props.interaction.version}`} {...props} interaction={props.interaction}/>;
}
function ApprovalInteractionCard({ interaction, workspaceLabel, readiness, onApprove }: Omit<InteractionCardProps, "interaction"> & {
  interaction: Extract<Interaction, {
    kind: "approval";
  }>;
}) {
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<InteractionResponse>();
  const [error, setError] = useState("");
  useEffect(() => { setBusy(false); setReceipt(undefined); setError(""); }, [interaction.interactionId, interaction.version]);
  useEffect(() => { setError(""); }, [readiness.sourceRevision]);
  const state = interactionReadiness(interaction, readiness);
  const enabled = state.ready && !busy && !receipt && !error;
  const respond = async (action: "allow_once" | "deny") => {
    if (!enabled)
      return;
    setBusy(true);
    setError("");
    try {
      setReceipt(await onApprove(buildApprovalResponse(interaction, action)));
    }
    catch {
      setError("Response was not accepted. Refresh this request before retrying.");
    }
    finally {
      setBusy(false);
    }
  };
  return <section aria-label="Approval request" data-interaction-id={interaction.interactionId} style={{ padding: 16, border: "1px solid currentColor", borderRadius: 12 }}>
  <p>{workspaceLabel} · {interaction.request.toolName}</p><h3>{interaction.request.title || "Approve this action"}</h3>
  {interaction.request.reason && <p>{interaction.request.reason}</p>}
  {interaction.request.commandPreview && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{interaction.request.commandPreview}</pre>}
  {interaction.request.filePreviews?.map((file, index) => <p key={index}>{file}</p>)}
  <p role="status">{busy ? "Sending response…" : receipt ? interactionStatusLabel(receipt.status) : state.reason || interactionStatusLabel(interaction.status)}</p>
  <div style={{ display: "flex", gap: 12 }}>{interaction.allowedActions.map((action) => <button key={action} disabled={!enabled} style={{ minHeight: 44, flex: 1, padding: 12 }} onClick={() => void respond(action)}>
   {action === "allow_once" ? "Allow once" : "Deny"}</button>)}</div>
  {error && <p role="alert">{error}</p>}
 </section>;
}
