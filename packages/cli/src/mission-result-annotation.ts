import { authoritativePlatformCount, platformRoomCompleted, type SlotResult } from "@silver/host";

export type MissionSettlement = "platform_solved" | "room_exhausted" | "process_ended";

export type MissionTargetReviewRow = {
  targetId: string;
  status: "completed" | "pending" | "exhausted";
  reason: string;
  workerResultNumber: number;
  reviewedAt: string;
};

export type AnnotatedMissionResult = SlotResult & {
  localOutcome?: string;
  platformStatus?: "completed" | "pending" | "exhausted";
  settlement?: MissionSettlement;
};

/** Commander completed is stored only when Host already persisted a platform solve. */
export function commanderStoredTargetStatus(input: {
  requested: "completed" | "pending";
  platformSolved: boolean;
}): "completed" | "pending" | "exhausted" {
  if (input.requested !== "completed") return "pending";
  return input.platformSolved ? "completed" : "exhausted";
}

/** Keep the latest review per targetId (last write wins). */
export function latestMissionTargetReviews(
  reviews: readonly MissionTargetReviewRow[],
): MissionTargetReviewRow[] {
  const latest = new Map<string, MissionTargetReviewRow>();
  for (const review of reviews) latest.set(review.targetId, review);
  return [...latest.values()];
}

/** Admitted targets without a matching completed platform review are unresolved, including active rooms. */
export function unresolvedMissionTargetIds(
  results: readonly SlotResult[],
  reviews: readonly MissionTargetReviewRow[],
  admittedTargetIds: readonly string[] = [],
): string[] {
  const attempts = new Map<string, number>();
  for (const targetId of admittedTargetIds) attempts.set(targetId, 0);
  for (const result of results) attempts.set(result.targetId, (attempts.get(result.targetId) ?? 0) + 1);
  const latest = new Map(latestMissionTargetReviews(reviews).map((review) => [review.targetId, review]));
  return [...attempts].flatMap(([targetId, workerResultNumber]) => {
    const review = latest.get(targetId);
    return review?.status === "completed" && review.workerResultNumber === workerResultNumber ? [] : [targetId];
  });
}

/**
 * Local Worker ledger outcome vs Commander platform review — do not conflate.
 * When platform completed but the Worker ledger is failed/empty, surface
 * `platform_completed` and keep the local outcome under `localOutcome`.
 */
function reviewKey(targetId: string, workerResultNumber: number): string {
  return `${targetId}:${workerResultNumber}`;
}

/** Last review wins for each (targetId, workerResultNumber) pair. */
export function reviewsByWorkerAttempt(
  reviews: readonly MissionTargetReviewRow[],
): Map<string, MissionTargetReviewRow> {
  const latest = new Map<string, MissionTargetReviewRow>();
  for (const review of reviews) latest.set(reviewKey(review.targetId, review.workerResultNumber), review);
  return latest;
}

function withDefined<T extends object>(
  row: T,
  extra: {
    localOutcome?: string;
    platformStatus: "completed" | "pending" | "exhausted";
    settlement?: MissionSettlement;
    outcome?: string;
    reason?: string;
  },
): T & AnnotatedMissionResult {
  const out: AnnotatedMissionResult = { ...(row as SlotResult), platformStatus: extra.platformStatus };
  if (extra.localOutcome !== undefined) out.localOutcome = extra.localOutcome;
  if (extra.settlement !== undefined) out.settlement = extra.settlement;
  if (extra.outcome !== undefined) out.outcome = extra.outcome;
  if (extra.reason !== undefined) out.reason = extra.reason;
  return out as T & AnnotatedMissionResult;
}

function inferEndedSettlement(row: SlotResult): MissionSettlement | undefined {
  const reason = row.reason ?? "";
  if (/stopReason=timeout\b/.test(reason)) return "room_exhausted";
  if (row.outcome === "solved") return "platform_solved";
  if (row.outcome === "failed" || row.outcome === "stalled" || row.outcome === "candidate") return "process_ended";
  return undefined;
}

export function annotateMissionResultsWithPlatform(
  results: readonly SlotResult[],
  reviews: readonly MissionTargetReviewRow[],
): AnnotatedMissionResult[] {
  const byAttempt = reviewsByWorkerAttempt(reviews);
  const seen = new Map<string, number>();
  return results.map((row) => {
    const workerResultNumber = (seen.get(row.targetId) ?? 0) + 1;
    seen.set(row.targetId, workerResultNumber);
    const review = byAttempt.get(reviewKey(row.targetId, workerResultNumber));
    if (!review) {
      const settlement = inferEndedSettlement(row);
      if (!settlement) return { ...row };
      if (settlement === "room_exhausted") return { ...row, settlement, platformStatus: "exhausted" };
      return { ...row, settlement };
    }
    if (review.status === "exhausted") {
      return withDefined(row, {
        ...(row.outcome !== undefined ? { localOutcome: row.outcome } : {}),
        platformStatus: "exhausted",
        settlement: "room_exhausted",
      });
    }
    if (review.status === "completed" && row.outcome !== "solved") {
      return withDefined(row, {
        localOutcome: row.outcome ?? "failed",
        platformStatus: "completed",
        settlement: "platform_solved",
        outcome: "platform_completed",
        reason: [
          row.reason,
          "local Worker outcome is not Host-accepted; authoritative platform status=completed",
        ]
          .filter(Boolean)
          .join("; "),
      });
    }
    return withDefined(row, {
      ...(row.outcome !== undefined ? { localOutcome: row.outcome } : {}),
      platformStatus: review.status,
      ...(review.status === "completed" ? { settlement: "platform_solved" as const } : {}),
    });
  });
}

/** Host-observed board counts. A missing row or a failed read is not an incomplete board. */
export type ContestBoardObservation = "completed" | "incomplete" | "unknown";

export function observeContestBoard(input: {
  readFailed?: boolean;
  board?: { flagCount?: number; correctFlagCount?: number; isCompleted?: boolean };
}): ContestBoardObservation {
  if (input.readFailed || input.board === undefined) return "unknown";
  const progress = {
    ...(input.board.correctFlagCount !== undefined ? { correctFlagCount: input.board.correctFlagCount } : {}),
    ...(input.board.flagCount !== undefined ? { totalFlagCount: input.board.flagCount } : {}),
  };
  const count = authoritativePlatformCount(progress);
  if (count) return count.completed ? "completed" : "incomplete";
  return platformRoomCompleted({
    ...progress,
    ...(input.board.isCompleted !== undefined ? { completed: input.board.isCompleted } : {}),
  })
    ? "completed"
    : "unknown";
}

export function contestBoardCompleted(board: {
  flagCount?: number;
  correctFlagCount?: number;
  isCompleted?: boolean;
} | undefined): boolean {
  if (!board) return false;
  return observeContestBoard({ board }) === "completed";
}

/**
 * A stalled Group must not erase a board the platform has already completed.
 * Without that completion, a stalled project stays stalled.
 */
export function slotOutcomeAfterContestBoard(input: {
  outcome?: string;
  projectStatus?: string;
  boardCompleted: boolean;
}): string | undefined {
  if (input.boardCompleted) return "solved";
  if (input.projectStatus === "stalled") return "stalled";
  return input.outcome;
}

/** One terminal solved row per target. Earlier non-solved attempts stay. */
export function collapseTerminalSolvedResults<T extends { targetId: string; outcome?: string }>(
  results: readonly T[],
): T[] {
  const solved = new Set<string>();
  const out: T[] = [];
  for (const row of results) {
    if (row.outcome === "solved") {
      if (solved.has(row.targetId)) continue;
      solved.add(row.targetId);
    }
    out.push(row);
  }
  return out;
}
export function officialContestRoomTerminal(input: {
  outcome?: string;
  platformVerdicts?: ReadonlyArray<{
    correctFlagCount?: number;
    totalFlagCount?: number;
    completed?: boolean;
  }>;
}): boolean {
  if (input.outcome === "solved") return true;
  return (input.platformVerdicts ?? []).some((row) => row.completed === true);
}

export function officialContestCompletedReview(input: {
  targetId: string;
  workerResultNumber: number;
  reviewedAt?: string;
}): MissionTargetReviewRow {
  return {
    targetId: input.targetId,
    status: "completed",
    reason: "platform accepted and platformCompleted; Host closed the contest board",
    workerResultNumber: input.workerResultNumber,
    reviewedAt: input.reviewedAt ?? new Date().toISOString(),
  };
}
