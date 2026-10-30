/**
 * Atomic pending ack for Mission candidate review:
 * Room hold first, Mission tracker second — never leave split ack watermarks.
 */
export async function ackPendingRoomThenMission(input: {
  /** Clear Project "reviewing" before waking workers (SlotPool seat still held by active job). */
  noteReviewReleased: () => void;
  /** Room CandidateReviewHold resolve + GoalReview signal. */
  recordRoomPending: () => void | Promise<void>;
  /** MissionCandidateReviewTracker.ackReviewGeneration + pending set update. */
  applyMissionAck: () => void;
  /** Unblock waitWhileProjectReviewing waiters. */
  signalReviewReleased: () => void;
}): Promise<void> {
  input.noteReviewReleased();
  await Promise.resolve(input.recordRoomPending());
  input.applyMissionAck();
  input.signalReviewReleased();
}
