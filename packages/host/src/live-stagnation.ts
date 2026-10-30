import {
  countNamedCalls,
  countNoToolTurns,
  countToolCalls,
  lastNamedCallTurnIndex,
  sumAssistantTextBytes,
  type LiveRunTurn,
} from "./live-run-ledger.ts";

export const LIVE_STAGNATION_MIN_TURNS = 80;
export const LIVE_STAGNATION_MIN_TOOL_CALLS = 80;
export const LIVE_STAGNATION_RECENT_CANDIDATE_TURNS = 10;
export const LIVE_STAGNATION_MIN_WALL_MS = 8 * 60 * 1000;
export const LIVE_STAGNATION_MIN_WALL_TOOL_CALLS = 15;
export const LIVE_STAGNATION_MIN_NO_TOOL_TURNS = 8;
export const LIVE_STAGNATION_MIN_NO_TOOL_TEXT_BYTES = 64 * 1024;
export const LIVE_STAGNATION_HIGH_COST_MIN_WALL_MS = 12 * 60 * 1000;
export const LIVE_STAGNATION_HIGH_COST_MIN_TURNS = 25;
export const LIVE_STAGNATION_HIGH_COST_MIN_TOOL_CALLS = 20;
export const LIVE_STAGNATION_HIGH_COST_MIN_TOTAL_TOKENS = 150_000;
export const LIVE_REPETITION_RISK_MIN_WALL_MS = 5 * 60 * 1000;
export const LIVE_REPETITION_RISK_MIN_TURNS = 10;
export const LIVE_REPETITION_RISK_MIN_TOOL_CALLS = 8;
export const LIVE_NO_TURN_ACTIVITY_IDLE_MS = 5 * 60 * 1000;
export const LIVE_NO_TURN_ACTIVITY_MIN_TURNS = 8;
export const LIVE_NO_TURN_ACTIVITY_MIN_TOOL_CALLS = 8;
export const LIVE_CANDIDATE_CHECKPOINT_MIN_TURNS = 30;
export const LIVE_CANDIDATE_CHECKPOINT_MIN_TOOL_CALLS = 30;
export const LIVE_CANDIDATE_CHECKPOINT_MIN_EVIDENCE_AGE_TURNS = 4;

export interface LiveStagnationProgress {
  state?: string;
  repeatedAxisCount?: number;
  candidateEvidenceCount?: number;
  candidateEvidenceAgeTurns?: number;
  offTargetProbeCount?: number;
  hostFileProbeCount?: number;
}

export interface LiveStagnationInput {
  turns: LiveRunTurn[];
  accepted: boolean;
  reported: boolean;
  candidateCount: number;
  progress?: LiveStagnationProgress;
  elapsedMs?: number;
  minTurns?: number;
  minToolCalls?: number;
  minWallMs?: number;
  minWallToolCalls?: number;
  highCostMinWallMs?: number;
  highCostMinTurns?: number;
  highCostMinToolCalls?: number;
  highCostMinTotalTokens?: number;
}

export interface LiveNoTurnActivityInput {
  turns: LiveRunTurn[];
  accepted: boolean;
  reported: boolean;
  candidateCount: number;
  candidateEvidenceCount?: number;
  lastActivityMs?: number;
  nowMs?: number;
  idleMs?: number;
  minTurns?: number;
  minToolCalls?: number;
}

/** Stop a root that is alive as a process but has stopped producing new DSH turns or wire requests. */
export function shouldStopForNoTurnActivity(input: LiveNoTurnActivityInput): boolean {
  if (input.accepted || input.reported || input.candidateCount > 0) return false;
  if ((input.candidateEvidenceCount ?? 0) > 0) return false;
  if (input.lastActivityMs === undefined) return false;
  if (input.turns.length < (input.minTurns ?? LIVE_NO_TURN_ACTIVITY_MIN_TURNS)) return false;
  if (countToolCalls(input.turns) < (input.minToolCalls ?? LIVE_NO_TURN_ACTIVITY_MIN_TOOL_CALLS)) return false;
  return (input.nowMs ?? Date.now()) - input.lastActivityMs >= (input.idleMs ?? LIVE_NO_TURN_ACTIVITY_IDLE_MS);
}

/** Generic cost guard for a live attempt that is still broad-searching without a candidate. */
export function shouldStopForLiveStagnation(input: LiveStagnationInput): boolean {
  if (input.accepted || input.reported || input.candidateCount > 0) return false;
  if ((input.progress?.candidateEvidenceCount ?? 0) > 0) return false;
  if (
    countToolCalls(input.turns) >= minWallToolCallsForText(input) &&
    countNoToolTurns(input.turns) >= LIVE_STAGNATION_MIN_NO_TOOL_TURNS &&
    sumAssistantTextBytes(input.turns) >= LIVE_STAGNATION_MIN_NO_TOOL_TEXT_BYTES &&
    !recentCandidateTool(input.turns) &&
    hasBroadSearchSignal(input)
  ) {
    return true;
  }
  const minTurns = input.minTurns ?? LIVE_STAGNATION_MIN_TURNS;
  const minToolCalls = input.minToolCalls ?? LIVE_STAGNATION_MIN_TOOL_CALLS;
  const toolCalls = countToolCalls(input.turns);
  const minWallMs = input.minWallMs ?? LIVE_STAGNATION_MIN_WALL_MS;
  const minWallToolCalls = input.minWallToolCalls ?? LIVE_STAGNATION_MIN_WALL_TOOL_CALLS;
  if (
    (input.elapsedMs ?? 0) >= LIVE_REPETITION_RISK_MIN_WALL_MS &&
    input.turns.length >= LIVE_REPETITION_RISK_MIN_TURNS &&
    toolCalls >= LIVE_REPETITION_RISK_MIN_TOOL_CALLS &&
    !recentCandidateTool(input.turns) &&
    hasRepetitionRiskSignal(input)
  ) {
    return true;
  }
  if (
    (input.elapsedMs ?? 0) >= minWallMs &&
    toolCalls >= minWallToolCalls &&
    !recentCandidateTool(input.turns) &&
    hasWallClockStagnationSignal(input)
  ) {
    return true;
  }
  if (
    (input.elapsedMs ?? 0) >= (input.highCostMinWallMs ?? LIVE_STAGNATION_HIGH_COST_MIN_WALL_MS) &&
    input.turns.length >= (input.highCostMinTurns ?? LIVE_STAGNATION_HIGH_COST_MIN_TURNS) &&
    toolCalls >= (input.highCostMinToolCalls ?? LIVE_STAGNATION_HIGH_COST_MIN_TOOL_CALLS) &&
    sumTotalTokens(input.turns) >= (input.highCostMinTotalTokens ?? LIVE_STAGNATION_HIGH_COST_MIN_TOTAL_TOKENS) &&
    !recentCandidateTool(input.turns)
  ) {
    return true;
  }
  if (input.turns.length < minTurns) return false;
  if (toolCalls < minToolCalls) return false;
  if (recentCandidateTool(input.turns)) return false;
  return hasBroadSearchSignal(input);
}

function minWallToolCallsForText(input: LiveStagnationInput): number {
  return input.minWallToolCalls ?? LIVE_STAGNATION_MIN_WALL_TOOL_CALLS;
}

/** Candidate evidence is present but the current root is not converging on verify/submit. */
export function shouldStopForCandidateCheckpoint(input: LiveStagnationInput): boolean {
  if (input.accepted || input.reported) return false;
  if ((input.progress?.candidateEvidenceCount ?? 0) <= 0 && input.candidateCount <= 0) return false;
  const minTurns = input.minTurns ?? LIVE_CANDIDATE_CHECKPOINT_MIN_TURNS;
  const minToolCalls = input.minToolCalls ?? LIVE_CANDIDATE_CHECKPOINT_MIN_TOOL_CALLS;
  if (input.turns.length < minTurns) return false;
  if (countToolCalls(input.turns) < minToolCalls) return false;
  if ((input.progress?.candidateEvidenceAgeTurns ?? 0) < LIVE_CANDIDATE_CHECKPOINT_MIN_EVIDENCE_AGE_TURNS) return false;
  if (recentCandidateTool(input.turns)) return false;
  return true;
}

function recentCandidateTool(turns: LiveRunTurn[]): boolean {
  const lastVerify = lastNamedCallTurnIndex(turns, "verify_candidate") ?? -Infinity;
  const lastSubmit = lastNamedCallTurnIndex(turns, "submit_candidate") ?? -Infinity;
  const last = Math.max(lastVerify, lastSubmit);
  return Number.isFinite(last) && turns.length - last <= LIVE_STAGNATION_RECENT_CANDIDATE_TURNS;
}

function hasBroadSearchSignal(input: LiveStagnationInput): boolean {
  const progress = input.progress;
  if (progress?.state === "broad_search") return true;
  if ((progress?.repeatedAxisCount ?? 0) >= 3) return true;
  if ((progress?.offTargetProbeCount ?? 0) >= 3) return true;
  const todoCalls = countNamedCalls(input.turns, "todo_write");
  const lastTodo = lastNamedCallTurnIndex(input.turns, "todo_write");
  if (todoCalls >= 5 && lastTodo !== null && input.turns.length - lastTodo >= 10) return true;
  return false;
}

function hasRepetitionRiskSignal(input: LiveStagnationInput): boolean {
  const progress = input.progress;
  return progress?.state === "repetition_risk" || (progress?.repeatedAxisCount ?? 0) >= 1;
}

function hasWallClockStagnationSignal(input: LiveStagnationInput): boolean {
  const progress = input.progress;
  if (progress?.state === "broad_search" || progress?.state === "repetition_risk") return true;
  if ((progress?.repeatedAxisCount ?? 0) >= 1) return true;
  if ((progress?.offTargetProbeCount ?? 0) >= 3) return true;
  if ((progress?.hostFileProbeCount ?? 0) >= 1) return true;
  return false;
}

function sumTotalTokens(turns: LiveRunTurn[]): number {
  return turns.reduce((total, turn) => total + (turn.usage?.totalTokens ?? 0), 0);
}
