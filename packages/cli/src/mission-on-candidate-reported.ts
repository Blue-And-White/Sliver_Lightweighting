/**
 * Mission Commander handling for Room `onCandidateReported`.
 * Extracted from main.ts so product-path tests lock the wakeCommander=false contract
 * (C2/same-gen repair must not mint pending or a wake).
 */
export type MissionCandidateReportedEvent = {
  fingerprint: string;
  status: "reported" | "duplicate";
  /** When false, Host already has this fingerprint — C2/same-gen repair only. */
  wakeCommander?: boolean;
  reviewGenerationId?: number;
};

export type ApplyMissionCandidateReportedResult = "skipped_no_wake" | "woken";

/**
 * Sole Mission entry for candidate-report events from a Room.
 * Tracker/pending updates happen only through `pushCandidateReportWake`.
 */
export function applyMissionCandidateReported(input: {
  targetId: string;
  event: MissionCandidateReportedEvent;
  noteReviewing: (targetId: string) => void;
  pushCandidateReportWake: (wake: {
    targetId: string;
    status: "reported" | "duplicate";
    reviewGenerationId: number;
  }) => void;
}): ApplyMissionCandidateReportedResult {
  // Tracker is the sole pending authority. wakeCommander=false is C2/same-gen
  // repair — never mint pending or a wake from this path.
  if (input.event.wakeCommander === false) {
    return "skipped_no_wake";
  }
  input.noteReviewing(input.targetId);
  input.pushCandidateReportWake({
    targetId: input.targetId,
    status: input.event.status,
    reviewGenerationId: input.event.reviewGenerationId ?? 1,
  });
  return "woken";
}
