/** Common next step after a Lead result. */
export type LeadResultStep = "candidate_review" | "natural_idle" | "leave";

export function nextLeadResultStep(input: {
  aborted: boolean;
  roomClosed: boolean;
  dshSessionId?: string;
  candidateReviewPending: boolean;
  naturalIdle: boolean;
}): LeadResultStep {
  if (input.roomClosed || input.aborted) return "leave";
  if (input.candidateReviewPending) return "candidate_review";
  if (input.naturalIdle && input.dshSessionId) return "natural_idle";
  return "leave";
}

export function officialTeamLeadCanTakeSerialPrompt(input: {
  keepAlive: boolean;
  prompting: boolean;
  active: boolean;
  aborted: boolean;
}): boolean {
  return input.keepAlive && input.active && !input.prompting && !input.aborted;
}
