import fs from "node:fs";
import path from "node:path";

/**
 * Legacy fixed-endpoint/preflight compatibility only. The standard Commander
 * path passes structured `--sample-size` directly and never supplies fromBrief.
 * `maxConcurrentRooms` remains active-room capacity, not a sample cap.
 */
export function resolveSampleSizeCeiling(input: {
  explicit?: number;
  fromBrief?: number;
  maxConcurrent: number;
}): number | undefined {
  if (input.explicit !== undefined) return input.explicit;
  if (input.fromBrief === undefined) return undefined;
  if (input.fromBrief === input.maxConcurrent) return undefined;
  return input.fromBrief;
}

/**
 * Mission `--sample-size N`: admit at most N distinct targets
 * for the whole run. `retry` only re-enters an id already admitted this run;
 * a new targetId cannot bypass the cap by setting retry.
 */
export function missionSampleAdmission(input: {
  sampleSize: number | undefined;
  admittedTargetIds: ReadonlySet<string>;
  targetId: string;
  retry: boolean;
}): { accepted: true } | { accepted: false; reason: "sample_size_reached"; sampleSize: number; admitted: number } {
  const { sampleSize, admittedTargetIds, targetId, retry } = input;
  const alreadyAdmitted = admittedTargetIds.has(targetId);
  if (retry && alreadyAdmitted) return { accepted: true };
  if (sampleSize !== undefined && !alreadyAdmitted && admittedTargetIds.size >= sampleSize) {
    return {
      accepted: false,
      reason: "sample_size_reached",
      sampleSize,
      admitted: admittedTargetIds.size,
    };
  }
  return { accepted: true };
}

/**
 * A target that already settled solved, or whose platform board is explicitly
 * completed, is not a retry slot. A failed or missing platform read is not
 * completion and does not by itself block retry.
 */
export function missionSolvedTargetReentry(input: {
  targetId: string;
  settled: readonly { targetId: string; outcome?: string }[];
  platformCompleted: boolean;
}): { accepted: true } | { accepted: false; reason: "target_already_solved" } {
  const locallySolved = input.settled.some((row) => row.targetId === input.targetId && row.outcome === "solved");
  if (locallySolved || input.platformCompleted) return { accepted: false, reason: "target_already_solved" };
  return { accepted: true };
}

/**
 * When every admissible target is already solved and nothing is still queued,
 * the Mission should stop instead of opening that target again.
 */
export function missionAdmissibleTerminal(input: {
  onlyBoardIds: readonly string[] | undefined;
  sampleSize: number | undefined;
  settled: readonly { targetId: string; outcome?: string }[];
  active: number;
  queued: number;
}): "all_completed" | "sample_completed" | undefined {
  if (input.active > 0 || input.queued > 0) return undefined;
  const solved = new Set(
    input.settled.filter((row) => row.outcome === "solved").map((row) => row.targetId),
  );
  if (solved.size === 0) return undefined;
  const only = input.onlyBoardIds?.filter(Boolean) ?? [];
  if (only.length > 0 && only.every((id) => solved.has(id))) {
    return input.sampleSize !== undefined ? "sample_completed" : "all_completed";
  }
  if (only.length === 0 && input.sampleSize !== undefined && solved.size >= input.sampleSize) {
    return "sample_completed";
  }
  return undefined;
}

/**
 * Structured `--only` ids. Empty means the Commander may queue any board the
 * platform lists. A pin refuses every other id before start.
 */
export function missionOnlyBoardAdmission(input: {
  onlyBoardIds: readonly string[] | undefined;
  targetId: string;
}): { accepted: true } | { accepted: false; reason: "outside_only"; onlyBoardIds: string[] } {
  const only = input.onlyBoardIds?.filter(Boolean) ?? [];
  if (only.length === 0) return { accepted: true };
  if (only.includes(input.targetId)) return { accepted: true };
  return { accepted: false, reason: "outside_only", onlyBoardIds: [...only] };
}

export const FOREIGN_MISSION_REPLAY_ERROR = "replay 属于另一份 Mission";

/**
 * No checkpoint starts a run. The same fingerprint resumes. A different
 * fingerprint refuses the directory before any later write.
 */
export function openMissionReplay(input: {
  checkpointText: string | undefined;
  missionFingerprint: string;
}): "fresh" | "resume" {
  if (input.checkpointText === undefined) return "fresh";
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.checkpointText);
  } catch (err) {
    throw new Error(
      `Mission Commander recovery state is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Mission Commander recovery state is invalid");
  }
  const fingerprint = (parsed as { missionFingerprint?: unknown }).missionFingerprint;
  if (fingerprint !== input.missionFingerprint) throw new Error(FOREIGN_MISSION_REPLAY_ERROR);
  return "resume";
}

/**
 * Retry after a finished attempt. Checkpoint presence is not an input.
 * A solved target, an active attempt, or a finished Mission stays closed.
 */
export function freshAttemptRetryDecision(input: {
  missionTerminal: boolean;
  targetSolved: boolean;
  platformCompleted: boolean;
  targetActive: boolean;
  roomExpired: boolean;
  previousStopReason?: string;
}):
  | { allowed: false; reason: "mission_terminal" | "target_already_solved" | "target_already_active" }
  | { allowed: true; freshAttempt: boolean } {
  if (input.missionTerminal) return { allowed: false, reason: "mission_terminal" };
  if (input.targetSolved || input.platformCompleted) return { allowed: false, reason: "target_already_solved" };
  if (input.targetActive) return { allowed: false, reason: "target_already_active" };
  return {
    allowed: true,
    freshAttempt:
      input.roomExpired ||
      input.previousStopReason === "timeout" ||
      input.previousStopReason === "coordination_failure",
  };
}

/** Retain discovered targets that are both incomplete and inside an optional --only pin. */
export function updateMissionFirstPassTargets(input: {
  discoveredTargetIds: Set<string>;
  boards: readonly { boardId: string; isCompleted: boolean }[];
  onlyBoardIds?: readonly string[];
}): void {
  const only = input.onlyBoardIds ? new Set(input.onlyBoardIds) : undefined;
  for (const board of input.boards) {
    if (board.isCompleted || (only && !only.has(board.boardId))) {
      input.discoveredTargetIds.delete(board.boardId);
    } else {
      input.discoveredTargetIds.add(board.boardId);
    }
  }
}

/** Count room budgets, not the number of Worker processes used to resume them. */
export function logicalAttemptCounts(
  results: readonly { targetId: string; logicalAttemptKey?: string }[],
): Record<string, number> {
  const keys = new Map<string, Set<string>>();
  results.forEach((row, index) => {
    const target = keys.get(row.targetId) ?? new Set<string>();
    target.add(row.logicalAttemptKey ?? `legacy:${index}`);
    keys.set(row.targetId, target);
  });
  return Object.fromEntries([...keys].map(([targetId, attempts]) => [targetId, attempts.size]));
}

/** Read the checkpoint. Does not create or modify the replay directory. */
export function readMissionReplayCheckpoint(dir: string, missionFingerprint: string): "fresh" | "resume" {
  const file = path.join(dir, "mission-session-state.json");
  const checkpointText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  return openMissionReplay({ checkpointText, missionFingerprint });
}
