/** Recoverable Commander exit when a candidate generation was never acknowledged. */
export const COMMANDER_REVIEW_UNACKNOWLEDGED = "commander_review_unacknowledged";

export function commanderReviewPrompt(reviewGenerationId: number): string {
  return `Candidate review generation ${reviewGenerationId} is still owed. The previous turn did not return a successful record_target_result tool result. Call record_target_result now with completed or pending and reviewGenerationId ${reviewGenerationId}. Prose is not an acknowledgement.`;
}
