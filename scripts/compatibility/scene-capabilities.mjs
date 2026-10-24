// Design §6 (interactive scenes): destination capability publication mapping.
// Evidence scene capabilities map to the destination policy/workspace
// capability names the activation gate and the web approval card read
// (effective("interactiveApprovals") = policy ∩ workspace ∩ real adapter
// respondApproval). The bootstrap publishes a subset of the imported
// endorsement's capability list, never more; unknown or duplicated scene
// names are a usage refusal, not a silent skip.
export const SCENE_CAPABILITY_POLICY = new Map([
  ["approval", "interactiveApprovals"],
  ["interrupt", "interrupt"],
  ["reconnect", "resumeConversation"],
]);

/** Parses a comma-separated --capabilities value into ordered policy names. */
export function parseSceneCapabilities(input) {
  if (input === undefined) return [];
  if (typeof input !== "string") throw new Error("BOOTSTRAP_USAGE");
  const names = input.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  const policies = [];
  for (const name of names) {
    const policy = SCENE_CAPABILITY_POLICY.get(name);
    if (!policy) throw new Error("BOOTSTRAP_CAPABILITY_UNKNOWN:" + name);
    if (policies.includes(policy)) throw new Error("BOOTSTRAP_CAPABILITY_DUPLICATE:" + name);
    policies.push(policy);
  }
  return policies;
}
