export type IntelKind = "observation" | "primitive_signal" | "candidate_chain";
export type PromoteSource = "tool_pipeline" | "notebook" | "manual" | "member_publish";
export type PromoteRejection =
  | "missing_artifact_ref"
  | "unsupported_claim"
  | "negative_polarity"
  | "nogood_language"
  | "missing_next_objective_check"
  | "manual_promote_disabled"
  | "notebook_promote_disabled"
  | "artifact_ref_escapes_attempt";

const NOGOOD = [
  /已证伪/,
  /不存在/,
  /死路/,
  /蜜罐/,
  /已排除/,
  /优先级最高/,
  /三个人都/,
  /\bnogood\b/i,
  /\bfalsified\b/i,
  /\bdead[- ]path\b/i,
  /\bdoes not exist\b/i,
  /\bhoney\s*pot\b/i,
  /\bhighest priority\b/i,
  /\bshould be abandoned\b/i,
];

export function hasNogoodLanguage(text: string): boolean {
  return NOGOOD.some((re) => re.test(text));
}

export function classifyPolarity(text: string): "positive" | "negative" | "neutral" {
  if (hasNogoodLanguage(text)) return "negative";
  if (/(未命中|未形成|暂时 park|park as unresolved|no hit|did not)/i.test(text)) return "negative";
  if (/(status=\d+|hash=|locator=|oracle pass|accepted)/i.test(text)) return "positive";
  return "neutral";
}

export function promoteGate(input: {
  artifactRef?: string;
  toolCallId?: string;
  polarity?: "positive" | "negative" | "neutral";
  text: string;
  nextObjectiveCheck?: string;
  source: PromoteSource;
}): { ok: true } | { ok: false; reason: PromoteRejection } {
  // Formal member publish tools use member_publish — not blocked by the old manual ban.
  if (input.source === "member_publish") {
    const artifact = (input.artifactRef ?? "").trim();
    const toolCall = (input.toolCallId ?? "").trim();
    if (!artifact && !toolCall) return { ok: false, reason: "unsupported_claim" };
    return { ok: true };
  }
  if (input.source === "manual") return { ok: false, reason: "manual_promote_disabled" };
  if (input.source !== "tool_pipeline") return { ok: false, reason: "notebook_promote_disabled" };
  const artifact = (input.artifactRef ?? "").trim();
  const toolCall = (input.toolCallId ?? "").trim();
  if (!artifact && !toolCall) return { ok: false, reason: "unsupported_claim" };
  if (!artifact) return { ok: false, reason: "missing_artifact_ref" };
  const polarity = input.polarity ?? classifyPolarity(input.text);
  if (polarity === "negative") return { ok: false, reason: "negative_polarity" };
  if (hasNogoodLanguage(input.text) || hasNogoodLanguage(input.nextObjectiveCheck ?? "")) {
    return { ok: false, reason: "nogood_language" };
  }
  if (!(input.nextObjectiveCheck ?? "").trim()) return { ok: false, reason: "missing_next_objective_check" };
  return { ok: true };
}
