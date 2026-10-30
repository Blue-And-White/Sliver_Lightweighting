import type { SlotResult } from "@silver/host";
import type { PlatformAdmissionRecord } from "./platform-admission.ts";
import { latestMissionTargetReviews, type MissionTargetReviewRow } from "./mission-result-annotation.ts";

export function sampleSizeSettledTargetIds(input: {
  sampleSize: number | undefined;
  platformAdmissions: readonly PlatformAdmissionRecord[];
  results: readonly SlotResult[];
  reviews: readonly MissionTargetReviewRow[];
  slots: { active: number; queued: number } | undefined;
}): string[] | undefined {
  if (!input.sampleSize) return undefined;
  if (!input.slots || input.slots.active > 0 || input.slots.queued > 0) return undefined;
  const admitted = [...new Set(input.platformAdmissions.map((row) => row.targetId).filter(Boolean))];
  if (admitted.length < input.sampleSize) return undefined;
  const latest = new Map(latestMissionTargetReviews(input.reviews).map((review) => [review.targetId, review]));
  for (const targetId of admitted) {
    const resultCount = input.results.filter((row) => row.targetId === targetId).length;
    if (resultCount < 1) return undefined;
    const review = latest.get(targetId);
    if (!review || review.workerResultNumber !== resultCount) return undefined;
  }
  return admitted;
}

export type SampleSizeTerminalKind = "sample_completed" | "partial_failed" | "failed";

export function terminalReleasesContestTargets(
  terminalKind: string | undefined,
  sampleSizeSettled = false,
): boolean {
  return (
    terminalKind === "all_completed" ||
    terminalKind === "sample_completed" ||
    terminalKind === "platform_ended" ||
    terminalKind === "operator_stop" ||
    (sampleSizeSettled && (terminalKind === "partial_failed" || terminalKind === "failed"))
  );
}

/**
 * Wording for a finished `--sample-size` slice. This is not platform completion
 * and must not close targets that were never admitted.
 */
export function sampleSizeTerminal(input: {
  admittedTargetIds: readonly string[];
  results: readonly SlotResult[];
  reviews: readonly MissionTargetReviewRow[];
}): { terminalKind: SampleSizeTerminalKind; reason: string } {
  const latest = new Map(latestMissionTargetReviews(input.reviews).map((review) => [review.targetId, review]));
  const solved: string[] = [];
  const unsolved: string[] = [];
  for (const targetId of input.admittedTargetIds) {
    const review = latest.get(targetId);
    const outcome = [...input.results].reverse().find((row) => row.targetId === targetId)?.outcome;
    if (review?.status === "completed" && outcome === "solved") solved.push(targetId);
    else unsolved.push(targetId);
  }
  const admitted = input.admittedTargetIds.join(", ");
  if (unsolved.length === 0) {
    return {
      terminalKind: "sample_completed",
      reason:
        `sample-size limit reached; all admitted targets solved: ${admitted}. ` +
        "The platform was not exhausted and unadmitted targets were not closed.",
    };
  }
  if (solved.length === 0) {
    return {
      terminalKind: "failed",
      reason: `sample-size limit reached; all admitted targets settled without a platform solve: ${admitted}`,
    };
  }
  return {
    terminalKind: "partial_failed",
    reason:
      `sample-size limit reached; admitted targets settled with unsolved work: ${unsolved.join(", ")}. ` +
      `Solved: ${solved.join(", ")}. Unadmitted targets were not closed.`,
  };
}
