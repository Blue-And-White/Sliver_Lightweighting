import { challengeBundleFromBoard, type ChallengeBundle } from "./challenge-bundle.ts";
import { SlotPool, type SlotResult } from "./slot-pool.ts";
import {
  ContestEndedError,
  ContestSlotFullError,
  contestTargetUrl,
  preflightContestBoard,
  type ContestBoardRow,
  type ContestPlatform,
  type ContestSubmitVerdict,
} from "./contest-platform.ts";
import { mergePlatformAcceptanceSnapshots, platformRoomCompleted } from "./acceptance-progress.ts";
import { mergeLiveWireSummaries, type LiveRunDiagnostic, type LiveRunWireSummary } from "./live-run-ledger.ts";
import { ROOM_DEFAULT_TIMEOUT_MS } from "./room-clock.ts";

/** Per-challenge room wall clock for a Host contest run. Shared by every root/member. */
export const CONTEST_SOLVER_TIMEOUT_MS = ROOM_DEFAULT_TIMEOUT_MS;
/** Default: no chat-turn hard cap. Explicit positive maxTurns still enforced. */
export const CONTEST_SOLVER_MAX_TURNS = 0;
/** Max fresh roots for technical recovery (transport), not strategy/stagnation. */
export const CONTEST_SOLVER_MAX_ROOT_SESSIONS = 2;

/** Contest solvers use a room wall clock; turn caps are opt-in only. */
export function contestSolverBudget(override: { timeoutMs?: number; maxTurns?: number } = {}): {
  timeoutMs: number;
  maxTurns: number;
} {
  return {
    timeoutMs: override.timeoutMs && override.timeoutMs > 0 ? Math.floor(override.timeoutMs) : CONTEST_SOLVER_TIMEOUT_MS,
    maxTurns:
      override.maxTurns === 0
        ? 0
        : override.maxTurns && override.maxTurns > 0
          ? Math.floor(override.maxTurns)
          : CONTEST_SOLVER_MAX_TURNS,
  };
}

const LLM_DEAD = /\bdsh:\s*(SERVER|EMPTY_RESPONSE|MALFORMED_RESPONSE|STREAM_CLOSED)\b/i;
const LLM_DEAD_HALT_AFTER = 3;

/** Solver died in the LLM adapter before any tool call. Do not keep opening challenges. */
export function isLlmDeadSolver(solved: Pick<ContestSolveResult, "outcome" | "toolCalls" | "error">): boolean {
  if ((solved.toolCalls ?? 0) > 0) return false;
  if (solved.outcome === "reported") return false;
  return LLM_DEAD.test(solved.error ?? "");
}

/** Solver entered the loop, then the provider transport started failing. */
export function isLlmTransportDeadSolver(solved: Pick<ContestSolveResult, "outcome" | "wire" | "error">): boolean {
  if (solved.outcome === "reported") return false;
  if ((solved.wire?.failedRequests ?? 0) <= 0) return false;
  if (solved.wire?.errors.some((row) => row.status >= 500) === true) return true;
  return LLM_DEAD.test(solved.error ?? "");
}

export interface ContestSolveJob {
  boardId: string;
  targetUrl: string;
  flagCount: number;
  bundle?: ChallengeBundle;
  rootSession?: number;
  previousStopReason?: string;
  previousProgress?: ContestProgressSummary;
  previousDiagnostics?: LiveRunDiagnostic[];
  signal?: AbortSignal;
}

export interface ContestSolveResult extends SlotResult {
  platformVerdicts?: ContestSubmitVerdict[];
  leftoverRaw?: string[];
  stopReason?: string;
  acpStopReason?: string;
  dshSessionId?: string;
  startFailed?: boolean;
  wire?: LiveRunWireSummary;
  progress?: ContestProgressSummary;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptSkillGestures?: string[];
  promptSkillGestureCount?: number;
  replayPath?: string;
  reportPath?: string;
  rootSessions?: number;
  rootStopReasons?: Record<string, number>;
  rootAttempts?: ContestRootAttemptSummary[];
  diagnostics?: LiveRunDiagnostic[];
}

export interface ContestRootAttemptSummary {
  rootSession: number;
  outcome?: string;
  stopReason?: string;
  acpStopReason?: string;
  dshSessionId?: string;
  turns?: number;
  toolCalls?: number;
  wireFailures?: number;
  replayPath?: string;
  reportPath?: string;
  promptSkillGestures?: string[];
  promptSkillGestureCount?: number;
  diagnostics?: LiveRunDiagnostic[];
}

export interface ContestProgressSummary {
  state?: string;
  observations?: string[];
  focusObjective?: string;
  focusReason?: string;
  candidateEvidence?: { title: string; artifactRef?: string }[];
  repeatedAxisCount?: number;
  testedAxisCount?: number;
  candidateEvidenceCount?: number;
  artifactCount?: number;
  offTargetProbeCount?: number;
  hostFileProbeCount?: number;
  workMemoryState?: string;
  workMemoryNextCheckCount?: number;
  workMemoryEvidenceCount?: number;
  workMemoryHypothesisCount?: number;
  workMemoryNextChecks?: string[];
  workMemoryEvidence?: string[];
  workMemoryHypotheses?: string[];
  assetCounts?: Record<string, number>;
  explorationCounts?: Record<string, number>;
  findingStatusCounts?: Record<string, number>;
  findingKindCounts?: Record<string, number>;
}

export function formatFreshRootProgressBrief(input: {
  previousStopReason: string;
  previousProgress?: ContestProgressSummary;
  previousDiagnostics?: LiveRunDiagnostic[];
}): string {
  const progress = input.previousProgress;
  const summary = [
    `previous_stop=${input.previousStopReason}`,
    input.previousDiagnostics?.length ? `previous_diagnostics=${input.previousDiagnostics.join("|")}` : undefined,
    progress?.testedAxisCount !== undefined ? `tested_axes=${progress.testedAxisCount}` : undefined,
    progress?.candidateEvidenceCount !== undefined ? `candidate_evidence=${progress.candidateEvidenceCount}` : undefined,
    progress?.artifactCount !== undefined ? `artifacts=${progress.artifactCount}` : undefined,
  ].filter(Boolean).join(", ");
  const lines = [`Prior root session bookkeeping: ${summary || `previous_stop=${input.previousStopReason}`}.`];
  for (const candidate of progress?.candidateEvidence?.slice(0, 2) ?? []) {
    const locator = candidate.artifactRef ? ` artifact=${candidate.artifactRef}` : "";
    lines.push(`- candidate_evidence: ${compactBriefText(candidate.title, 120)}.${locator}`);
  }
  lines.push("Prior-root artifact references are historical and may point outside the current attempt artifact root.");
  lines.push("Treat this as weak progress accounting, not as a route verdict.");
  return lines.join("\n");
}

export interface ContestChallengeResult {
  boardId: string;
  outcome?: string;
  stopReason?: string;
  wallTimeMs?: number;
  turns?: number;
  toolCalls?: number;
  noToolTurns?: number;
  maxNoToolStreak?: number;
  lengthStops?: number;
  assistantTextBytes?: number;
  maxAssistantTextBytes?: number;
  promptSkillGestureCount?: number;
  promptSkillGestures?: string[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  skillCalls?: number;
  todoCalls?: number;
  lastTodoTurn?: number | null;
  turnsSinceTodo?: number | null;
  fingerprintCount?: number;
  platformCorrect: number;
  platformWrong: number;
  awarded: number;
  cumulativeScore: number;
  verifiedButUnsubmitted?: number;
  platformCompleted?: boolean;
  startFailed?: boolean;
  wire?: LiveRunWireSummary;
  progress?: ContestProgressSummary;
  replayPath?: string;
  reportPath?: string;
  rootSessions?: number;
  rootStopReasons?: Record<string, number>;
  rootAttempts?: ContestRootAttemptSummary[];
  diagnostics?: LiveRunDiagnostic[];
  error?: string;
}

export interface ContestSummary {
  schema: "silver.contest-summary.v1";
  maxConcurrent: number;
  solverMaxConcurrent: number;
  solverMaxRootSessions: number;
  solverTimeoutMs?: number;
  solverMaxTurns?: number;
  solverBudgetSource?: string;
  sampleSize?: number;
  sampledBoardIds?: string[];
  totalListed: number;
  scheduled: number;
  settled: number;
  accepted: number;
  partial: number;
  wrong: number;
  reported: number;
  candidate: number;
  failed: number;
  stalled: number;
  startFailed?: number;
  skipped: number;
  pending: number;
  awarded: number;
  cumulativeScore: number;
  verifiedButUnsubmitted: number;
  maxActive: number;
  rootSessions?: number;
  freshRootSessions?: number;
  stopReasons?: Record<string, number>;
  rootStopReasons?: Record<string, number>;
  wireRequests?: number;
  wireFailures?: number;
  maxWireBodyBytes?: number;
  maxWireMessageCount?: number;
  maxWireToolCount?: number;
  maxWireToolBytes?: number;
  maxWireSystemBytes?: number;
  messageCountDrops?: number;
  noToolTurns?: number;
  maxNoToolStreak?: number;
  lengthStops?: number;
  assistantTextBytes?: number;
  maxAssistantTextBytes?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  staleTodoRuns?: number;
  thinkingRequests?: number;
  thinkingDisabledRequests?: number;
  thinkingUnknownRequests?: number;
  promptSkillGestureCount?: number;
  promptSkillGestures?: Record<string, number>;
  skillCalls?: number;
  todoCalls?: number;
  progressStates?: Record<string, number>;
  offTargetProbeCount?: number;
  hostFileProbeCount?: number;
  workMemoryStates?: Record<string, number>;
  workMemoryNextCheckCount?: number;
  workMemoryEvidenceCount?: number;
  workMemoryHypothesisCount?: number;
  assetCounts?: Record<string, number>;
  explorationCounts?: Record<string, number>;
  findingStatusCounts?: Record<string, number>;
  findingKindCounts?: Record<string, number>;
  diagnostics?: Partial<Record<LiveRunDiagnostic, number>>;
  missionDone: boolean;
  wallTimeMs: number;
  error?: string;
  challenges: ContestChallengeResult[];
}

export type ContestLifecycleEvent =
  | { type: "challenge-start"; boardId: string }
  | { type: "challenge-close"; boardId: string };

/** Project the last contest run's opened-but-not-closed challenges from its append-only event log. */
export function recoverableContestTargets(eventLog: string): string[] {
  const open = new Set<string>();
  for (const line of eventLog.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "mission") {
      open.clear();
      const recovered = Array.isArray(event.recoveredBoardIds) ? event.recoveredBoardIds : [];
      for (const boardId of recovered) {
        if (typeof boardId === "string" && boardId) open.add(boardId);
      }
      continue;
    }
    const boardId =
      typeof event.boardId === "string"
        ? event.boardId
        : typeof event.targetId === "string"
          ? event.targetId
          : "";
    if (!boardId) continue;
    if (event.type === "challenge-start" || event.type === "challenge-recover" || event.type === "solver-start") {
      open.add(boardId);
      continue;
    }
    if (event.type === "challenge-close") {
      open.delete(boardId);
      continue;
    }
    if (
      event.type === "submit" &&
      event.correct === true &&
      typeof event.correctFlagCount === "number" &&
      typeof event.totalFlagCount === "number" &&
      event.totalFlagCount > 0 &&
      event.correctFlagCount >= event.totalFlagCount
    ) {
      open.delete(boardId);
    }
  }
  return [...open].sort();
}

function hasOpenContestLease(row: ContestBoardRow): boolean {
  return row.containerAddr.length > 0 || /^(available|running|started|starting)$/i.test(row.containerStatus);
}

export type ContestRecoveryDisposition = "resumable" | "already-closed" | "platform-completed" | "missing";

/** Reconcile interrupted challenge leases with the board. Open targets are adopted by the next runner. */
export async function recoverContestTargets(
  platform: ContestPlatform,
  boardIds: string[],
): Promise<Array<{ boardId: string; disposition: ContestRecoveryDisposition }>> {
  if (boardIds.length === 0) return [];
  const board = await platform.list();
  preflightContestBoard(board);
  const byId = new Map(board.map((row) => [row.boardId, row]));
  const recovered: Array<{ boardId: string; disposition: ContestRecoveryDisposition }> = [];
  for (const boardId of [...new Set(boardIds)].sort()) {
    const row = byId.get(boardId);
    if (!row) {
      recovered.push({ boardId, disposition: "missing" });
      continue;
    }
    if (row.isCompleted) {
      recovered.push({ boardId, disposition: "platform-completed" });
      continue;
    }
    if (!hasOpenContestLease(row)) {
      recovered.push({ boardId, disposition: "already-closed" });
      continue;
    }
    recovered.push({ boardId, disposition: "resumable" });
  }
  return recovered;
}

export interface ContestRunnerInput {
  platform: ContestPlatform;
  maxConcurrent: number;
  /** Optional LLM/solver concurrency. Platform slot capacity remains maxConcurrent. */
  solverMaxConcurrent?: number;
  /** Optional reporting-only per-solver budget metadata. Actual enforcement stays in solve(). */
  solverBudget?: {
    timeoutMs: number;
    maxTurns: number;
    source?: string;
  };
  closeAfterEach: boolean;
  contestTimeoutMs: number;
  all?: boolean;
  /** When set, only these board ids are started. Missing ids fail closed. */
  only?: string[];
  /** Optional small-sample run over the current pending board. Ignored when `only` is set. */
  sampleSize?: number;
  random?: () => number;
  signal?: AbortSignal;
  solve: (job: ContestSolveJob) => Promise<ContestSolveResult>;
  /** Fresh DSH root sessions for generic recovery on the same opened challenge. */
  maxRootSessions?: number;
  /** Durable challenge lifecycle sink owned by the Host launcher. */
  onLifecycle?: (event: ContestLifecycleEvent) => void;
  submitLeftover?: (boardId: string, raw: string) => Promise<ContestSubmitVerdict>;
  pollMs?: number;
  startTimeoutMs?: number;
  now?: () => number;
}

export async function runContest(input: ContestRunnerInput): Promise<ContestSummary> {
  const startedAt = (input.now ?? Date.now)();
  const pollMs = input.pollMs ?? 2000;
  const startTimeoutMs = input.startTimeoutMs ?? 60_000;
  const solverMaxConcurrent = normalizeSolverMaxConcurrent(input.solverMaxConcurrent, input.maxConcurrent);
  const solverMaxRootSessions = Math.max(1, Math.floor(input.maxRootSessions ?? CONTEST_SOLVER_MAX_ROOT_SESSIONS));
  const all = input.all !== false;
  let listed: ContestBoardRow[] = [];
  try {
    listed = await input.platform.list();
    preflightContestBoard(listed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      schema: "silver.contest-summary.v1",
      maxConcurrent: input.maxConcurrent,
      solverMaxConcurrent,
      solverMaxRootSessions,
      totalListed: 0,
      scheduled: 0,
      settled: 0,
      accepted: 0,
      partial: 0,
      wrong: 0,
      reported: 0,
      candidate: 0,
      failed: 0,
      stalled: 0,
      skipped: 0,
      pending: 0,
      awarded: 0,
      cumulativeScore: 0,
      verifiedButUnsubmitted: 0,
      maxActive: 0,
      missionDone: false,
      wallTimeMs: (input.now ?? Date.now)() - startedAt,
      error: message,
      challenges: [],
    };
  }
  if (input.only?.length) {
    const want = new Set(input.only);
    const missing = input.only.filter((id) => !listed.some((row) => row.boardId === id));
    if (missing.length > 0) {
      const message = `contest board id not found: ${missing.join(", ")}`;
      return {
        schema: "silver.contest-summary.v1",
        maxConcurrent: input.maxConcurrent,
        solverMaxConcurrent,
        solverMaxRootSessions,
        totalListed: listed.length,
        scheduled: 0,
        settled: 0,
        accepted: 0,
        partial: 0,
        wrong: 0,
        reported: 0,
        candidate: 0,
        failed: 0,
        stalled: 0,
        skipped: 0,
        pending: 0,
        awarded: 0,
        cumulativeScore: 0,
        verifiedButUnsubmitted: 0,
        maxActive: 0,
        missionDone: false,
        wallTimeMs: (input.now ?? Date.now)() - startedAt,
        error: message,
        challenges: [],
      };
    }
  }
  const pinned = input.only?.length ? new Set(input.only) : undefined;
  const skipped = listed.filter((row) => (pinned ? pinned.has(row.boardId) : all) && row.isCompleted);
  const eligible = listed.filter((row) => (pinned ? pinned.has(row.boardId) : true) && !(all && row.isCompleted));
  const sampleSize = pinned ? undefined : normalizeSampleSize(input.sampleSize, eligible.length);
  const sampleTarget = sampleSize ?? eligible.length;
  const sampleCandidates = sampleSize ? sampleContestRows(eligible, sampleSize, input.random ?? Math.random) : eligible;
  const pending: ContestBoardRow[] = [];
  let nextPending = 0;
  let samplePotentialSolvers = 0;
  const byId = new Map(listed.map((row) => [row.boardId, row]));
  const results = new Map<string, ContestChallengeResult>();
  let peakActive = 0;
  let consecutiveLlmDead = 0;
  let llmDeadHalt: string | undefined;
  const solveLimiter = new AsyncSemaphore(solverMaxConcurrent);
  const aborted = () => input.signal?.aborted === true;
  const openChallenges = new Set<string>();
  const closingChallenges = new Map<string, Promise<void>>();
  const closeErrors = new Map<string, string[]>();
  const lifecycleStarted = new Set<string>();
  const recordChallengeStart = (boardId: string): void => {
    if (lifecycleStarted.has(boardId)) return;
    lifecycleStarted.add(boardId);
    input.onLifecycle?.({ type: "challenge-start", boardId });
  };
  const closeChallenge = async (boardId: string): Promise<void> => {
    if (!input.closeAfterEach || !openChallenges.has(boardId)) return;
    const existing = closingChallenges.get(boardId);
    if (existing) return existing;
    const closing = input.platform
      .close(boardId)
      .then(() => {
        openChallenges.delete(boardId);
        input.onLifecycle?.({ type: "challenge-close", boardId });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "close failed";
        const current = closeErrors.get(boardId) ?? [];
        current.push(message);
        closeErrors.set(boardId, current);
      })
      .finally(() => {
        closingChallenges.delete(boardId);
      });
    closingChallenges.set(boardId, closing);
    return closing;
  };
  const closeOpenChallenges = async (): Promise<void> => {
    await Promise.all([...openChallenges].map((boardId) => closeChallenge(boardId)));
  };
  const takeCloseError = (boardId: string): string | undefined => {
    const messages = closeErrors.get(boardId);
    if (!messages?.length) return undefined;
    closeErrors.delete(boardId);
    return messages.join("; ");
  };
  const cleanupOnAbort = () => {
    void closeOpenChallenges();
  };
  input.signal?.addEventListener("abort", cleanupOnAbort, { once: true });
  const interruptedResult = (row: ContestBoardRow, targetUrl: string, error?: string): ContestSolveResult => ({
    targetId: row.boardId,
    targetUrl,
    outcome: "failed",
    stopReason: "interrupted",
    error: error ?? abortErrorMessage(input.signal),
  });

  const waitAvailable = async (boardId: string): Promise<string[]> => {
    const deadline = (input.now ?? Date.now)() + startTimeoutMs;
    while ((input.now ?? Date.now)() < deadline) {
      if (aborted()) return [];
      const row = (await input.platform.list()).find((item) => item.boardId === boardId);
      if (row && row.containerAddr.length > 0) return row.containerAddr;
      await sleep(pollMs, input.signal);
    }
    return [];
  };

  const pool = new SlotPool(input.maxConcurrent, async (job) => {
    const row = byId.get(job.targetId);
    if (!row) {
      return { targetId: job.targetId, targetUrl: job.targetUrl, error: "unknown challenge", outcome: "failed" };
    }
    if (aborted()) return interruptedResult(row, job.targetUrl);
    let addrs = [...row.containerAddr];
    if (hasOpenContestLease(row)) {
      if (input.closeAfterEach) openChallenges.add(row.boardId);
      recordChallengeStart(row.boardId);
      if (addrs.length === 0) addrs = await waitAvailable(row.boardId);
    } else {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (aborted()) return interruptedResult(row, job.targetUrl);
        try {
          const started = await input.platform.start(row.boardId);
          if (input.closeAfterEach) openChallenges.add(row.boardId);
          recordChallengeStart(row.boardId);
          addrs = started.containerAddr.length > 0 ? started.containerAddr : await waitAvailable(row.boardId);
          break;
        } catch (err) {
          if (err instanceof ContestEndedError) {
            pool.halt();
            return {
              targetId: row.boardId,
              targetUrl: job.targetUrl,
              outcome: "failed",
              error: err.message,
            };
          }
          if (err instanceof ContestSlotFullError) {
            await sleep(pollMs, input.signal);
            continue;
          }
          throw err;
        }
      }
    }
    if (addrs.length === 0) {
      await closeChallenge(row.boardId);
      const closeError = takeCloseError(row.boardId);
      return {
        targetId: row.boardId,
        targetUrl: job.targetUrl,
        outcome: "failed",
        startFailed: true,
        error: ["start returned no container_addr", closeError].filter(Boolean).join("; "),
      };
    }
    const bundle = challengeBundleFromBoard(row, addrs);
    const targetUrl = bundle?.targetUrl ?? contestTargetUrl(addrs[0]!);
    if (input.closeAfterEach) openChallenges.add(row.boardId);
    recordChallengeStart(row.boardId);
    const attempts: ContestSolveResult[] = [];
    const maxRootSessions = solverMaxRootSessions;
    let solved: ContestSolveResult;
    for (let rootSession = 0; rootSession < maxRootSessions; rootSession += 1) {
      try {
        solved = await solveLimiter.run(() => {
          if (aborted()) return Promise.resolve(interruptedResult(row, targetUrl));
          const previous = attempts[attempts.length - 1];
          return input.solve({
            boardId: row.boardId,
            targetUrl,
            flagCount: row.flagCount,
            ...(bundle ? { bundle } : {}),
            rootSession,
            ...(previous?.stopReason ? { previousStopReason: previous.stopReason } : {}),
            ...(previous?.progress ? { previousProgress: previous.progress } : {}),
            ...(previous?.diagnostics?.length ? { previousDiagnostics: previous.diagnostics } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
        });
      } catch (err) {
        solved = {
          targetId: row.boardId,
          targetUrl,
          outcome: "failed",
          ...(aborted() ? { stopReason: "interrupted" } : {}),
          error: aborted() ? abortErrorMessage(input.signal) : err instanceof Error ? err.message : String(err),
        };
      }
      applyContestDiagnostics(solved);
      attempts.push(solved);
      if (!shouldStartFreshRoot(solved, rootSession, maxRootSessions, aborted())) break;
    }
    solved = mergeRootSessionResults(row.boardId, targetUrl, attempts);
    const leftover = solved.leftoverRaw ?? [];
    const verdicts = [...(solved.platformVerdicts ?? [])];
    if (input.submitLeftover) {
      for (const raw of leftover) {
        try {
          verdicts.push(await input.submitLeftover(row.boardId, raw));
        } catch (err) {
          solved.error = err instanceof Error ? err.message : "submit leftover failed";
        }
      }
    }
    const verifiedButUnsubmitted = input.submitLeftover ? 0 : leftover.length;
    if (input.closeAfterEach) {
      await closeChallenge(row.boardId);
      const closeError = takeCloseError(row.boardId);
      if (closeError) solved.error = [solved.error, closeError].filter(Boolean).join("; ");
    }
    const platformCorrect = verdicts.filter((row) => row.correct === true && row.duplicate !== true).length;
    const platformWrong = verdicts.filter((row) => row.correct === false && row.duplicate !== true).length;
    const last = verdicts[verdicts.length - 1];
    const platformCount = mergePlatformAcceptanceSnapshots(verdicts);
    const platformProgress = (platformCount?.accepted ?? 0) > 0;
    const platformCompleted = platformCount?.completed ?? verdicts.some(platformRoomCompleted);
    const recorded: ContestChallengeResult = {
      boardId: row.boardId,
      outcome: contestOutcomeFromVerdicts({
        platformCompleted,
        platformProgress,
        platformCorrect,
        platformWrong,
        ...(solved.outcome ? { fallback: solved.outcome } : {}),
        ...(solved.stopReason ? { stopReason: solved.stopReason } : {}),
      }),
      platformCorrect,
      platformWrong,
      awarded: verdicts.reduce((sum, row) => sum + (row.awarded ?? 0), 0),
      cumulativeScore: platformCount?.cumulativeScore ?? last?.cumulativeScore ?? 0,
    };
    if (verifiedButUnsubmitted > 0) recorded.verifiedButUnsubmitted = verifiedButUnsubmitted;
    if (solved.stopReason) recorded.stopReason = solved.stopReason;
    if (solved.wallTimeMs !== undefined) recorded.wallTimeMs = solved.wallTimeMs;
    if (solved.turns !== undefined) recorded.turns = solved.turns;
    if (solved.toolCalls !== undefined) recorded.toolCalls = solved.toolCalls;
    if (solved.noToolTurns !== undefined) recorded.noToolTurns = solved.noToolTurns;
    if (solved.maxNoToolStreak !== undefined) recorded.maxNoToolStreak = solved.maxNoToolStreak;
    if (solved.lengthStops !== undefined) recorded.lengthStops = solved.lengthStops;
    if (solved.assistantTextBytes !== undefined) recorded.assistantTextBytes = solved.assistantTextBytes;
    if (solved.maxAssistantTextBytes !== undefined) recorded.maxAssistantTextBytes = solved.maxAssistantTextBytes;
    if (solved.promptTokens !== undefined) recorded.promptTokens = solved.promptTokens;
    if (solved.completionTokens !== undefined) recorded.completionTokens = solved.completionTokens;
    if (solved.totalTokens !== undefined) recorded.totalTokens = solved.totalTokens;
    if (solved.promptSkillGestures?.length) recorded.promptSkillGestures = solved.promptSkillGestures;
    if (solved.promptSkillGestureCount !== undefined) recorded.promptSkillGestureCount = solved.promptSkillGestureCount;
    if (solved.skillCalls !== undefined) recorded.skillCalls = solved.skillCalls;
    if (solved.todoCalls !== undefined) recorded.todoCalls = solved.todoCalls;
    if (solved.lastTodoTurn !== undefined) recorded.lastTodoTurn = solved.lastTodoTurn;
    if (solved.turnsSinceTodo !== undefined) recorded.turnsSinceTodo = solved.turnsSinceTodo;
    if (solved.fingerprintCount !== undefined) recorded.fingerprintCount = solved.fingerprintCount;
    if (solved.rootSessions !== undefined) recorded.rootSessions = solved.rootSessions;
    if (solved.rootStopReasons) recorded.rootStopReasons = solved.rootStopReasons;
    if (solved.rootAttempts) recorded.rootAttempts = solved.rootAttempts;
    if (solved.wire) recorded.wire = solved.wire;
    if (solved.progress) recorded.progress = solved.progress;
    if (solved.replayPath) recorded.replayPath = solved.replayPath;
    if (solved.reportPath) recorded.reportPath = solved.reportPath;
    if (solved.error) recorded.error = solved.error;
    if (platformCompleted) recorded.platformCompleted = true;
    applyContestDiagnostics(recorded);
    results.set(row.boardId, recorded);
    const hasPlatformSignal = platformCompleted || platformProgress || platformCorrect > 0 || platformWrong > 0;
    if (!hasPlatformSignal && (isLlmDeadSolver(solved) || isLlmTransportDeadSolver(solved))) {
      consecutiveLlmDead += 1;
      if (consecutiveLlmDead >= LLM_DEAD_HALT_AFTER && !llmDeadHalt) {
        llmDeadHalt = `halted after ${consecutiveLlmDead} consecutive LLM-dead solvers`;
        pool.halt();
      }
    } else if ((solved.toolCalls ?? 0) > 0 || solved.outcome === "reported" || platformCompleted) {
      consecutiveLlmDead = 0;
    }
    return { ...solved, startFailed: false, targetId: row.boardId, targetUrl };
  });

  const enqueueRow = (row: ContestBoardRow) => {
    if (aborted()) return;
    pending.push(row);
    const queued = pool.enqueue({
      targetId: row.boardId,
      targetUrl: row.containerAddr[0] ? contestTargetUrl(row.containerAddr[0]) : `https://pending.invalid/${row.boardId}`,
    });
    if (queued.accepted && sampleSize) samplePotentialSolvers += 1;
    if (!queued.accepted) {
      results.set(row.boardId, {
        boardId: row.boardId,
        outcome: "failed",
        platformCorrect: 0,
        platformWrong: 0,
        error: queued.reason ?? "enqueue failed",
        awarded: 0,
        cumulativeScore: 0,
      });
    }
    peakActive = Math.max(peakActive, pool.status().active);
  };

  const refill = () => {
    while (
      !aborted() &&
      !llmDeadHalt &&
      nextPending < sampleCandidates.length &&
      (sampleSize ? samplePotentialSolvers < sampleTarget : true)
    ) {
      enqueueRow(sampleCandidates[nextPending]!);
      nextPending += 1;
      if (sampleSize && pool.status().active + pool.status().queued >= input.maxConcurrent) break;
    }
  };

  if (sampleSize) {
    refill();
  } else {
    while (nextPending < sampleCandidates.length) {
      enqueueRow(sampleCandidates[nextPending]!);
      nextPending += 1;
    }
  }

  const deadline = startedAt + input.contestTimeoutMs;
  let timedOut = false;
  while (pool.status().active > 0 || pool.status().queued > 0) {
    if (aborted()) {
      pool.halt();
      break;
    }
    if ((input.now ?? Date.now)() >= deadline) {
      pool.halt();
      timedOut = true;
      break;
    }
    peakActive = Math.max(peakActive, pool.status().active);
    const slot = await waitSlotOrAbort(pool, input.signal);
    if ("aborted" in slot) {
      pool.halt();
      break;
    }
    if (!("idle" in slot)) {
      const solved = slot as ContestSolveResult;
      if (solved.startFailed && sampleSize) samplePotentialSolvers = Math.max(0, samplePotentialSolvers - 1);
      if (sampleSize) refill();
    }
  }
  await closeOpenChallenges();
  input.signal?.removeEventListener("abort", cleanupOnAbort);
  const settledResults = await pool.drain();
  for (const row of settledResults) {
    if (results.has(row.targetId)) continue;
    const solved = row as ContestSolveResult;
    const recorded: ContestChallengeResult = {
      boardId: row.targetId,
      outcome: row.outcome ?? "failed",
      platformCorrect: 0,
      platformWrong: 0,
      awarded: 0,
      cumulativeScore: 0,
      ...(row.wallTimeMs !== undefined ? { wallTimeMs: row.wallTimeMs } : {}),
      ...(row.turns !== undefined ? { turns: row.turns } : {}),
      ...(row.toolCalls !== undefined ? { toolCalls: row.toolCalls } : {}),
      ...(row.noToolTurns !== undefined ? { noToolTurns: row.noToolTurns } : {}),
      ...(row.maxNoToolStreak !== undefined ? { maxNoToolStreak: row.maxNoToolStreak } : {}),
      ...(row.lengthStops !== undefined ? { lengthStops: row.lengthStops } : {}),
      ...(row.assistantTextBytes !== undefined ? { assistantTextBytes: row.assistantTextBytes } : {}),
      ...(row.maxAssistantTextBytes !== undefined ? { maxAssistantTextBytes: row.maxAssistantTextBytes } : {}),
      ...(solved.promptTokens !== undefined ? { promptTokens: solved.promptTokens } : {}),
      ...(solved.completionTokens !== undefined ? { completionTokens: solved.completionTokens } : {}),
      ...(solved.totalTokens !== undefined ? { totalTokens: solved.totalTokens } : {}),
      ...(row.promptSkillGestures?.length ? { promptSkillGestures: row.promptSkillGestures } : {}),
      ...(row.promptSkillGestureCount !== undefined ? { promptSkillGestureCount: row.promptSkillGestureCount } : {}),
      ...(row.skillCalls !== undefined ? { skillCalls: row.skillCalls } : {}),
      ...(row.todoCalls !== undefined ? { todoCalls: row.todoCalls } : {}),
      ...(row.lastTodoTurn !== undefined ? { lastTodoTurn: row.lastTodoTurn } : {}),
      ...(row.turnsSinceTodo !== undefined ? { turnsSinceTodo: row.turnsSinceTodo } : {}),
      ...(row.fingerprintCount !== undefined ? { fingerprintCount: row.fingerprintCount } : {}),
      ...(solved.startFailed ? { startFailed: true } : {}),
      ...(solved.rootAttempts ? { rootAttempts: solved.rootAttempts } : {}),
      ...(solved.progress ? { progress: solved.progress } : {}),
      error: row.error ?? "solver did not produce a contest result",
    };
    applyContestDiagnostics(recorded);
    results.set(row.targetId, recorded);
  }
  peakActive = Math.max(peakActive, pool.status().active);

  let board: ContestBoardRow[] = [];
  let boardError: string | undefined;
  try {
    board = await input.platform.list();
  } catch (err) {
    if (err instanceof ContestEndedError) {
      boardError = err.message;
    } else {
      boardError = `final board refresh failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const challenges = pending.map((row) => results.get(row.boardId)).filter(Boolean) as ContestChallengeResult[];
  for (const row of board) {
    const rec = results.get(row.boardId);
    if (rec && row.isCompleted) rec.platformCompleted = true;
  }

  let accepted = 0;
  let partial = 0;
  let wrong = 0;
  let reported = 0;
  let candidate = 0;
  let failed = 0;
  let stalled = 0;
  let startFailed = 0;
  let wireRequests = 0;
  let wireFailures = 0;
  let maxWireBodyBytes = 0;
  let maxWireMessageCount = 0;
  let maxWireToolCount = 0;
  let maxWireToolBytes = 0;
  let maxWireSystemBytes = 0;
  let messageCountDrops = 0;
  let noToolTurns = 0;
  let maxNoToolStreak = 0;
  let lengthStops = 0;
  let assistantTextBytes = 0;
  let maxAssistantTextBytes = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let staleTodoRuns = 0;
  let thinkingRequests = 0;
  let thinkingDisabledRequests = 0;
  let thinkingUnknownRequests = 0;
  let promptSkillGestureCount = 0;
  const promptSkillGestures: Record<string, number> = {};
  let skillCalls = 0;
  let todoCalls = 0;
  let offTargetProbeCount = 0;
  let hostFileProbeCount = 0;
  let rootSessions = 0;
  let freshRootSessions = 0;
  const stopReasons: Record<string, number> = {};
  const rootStopReasons: Record<string, number> = {};
  let workMemoryNextCheckCount = 0;
  let workMemoryEvidenceCount = 0;
  let workMemoryHypothesisCount = 0;
  const assetCounts: Record<string, number> = {};
  const explorationCounts: Record<string, number> = {};
  const findingStatusCounts: Record<string, number> = {};
  const findingKindCounts: Record<string, number> = {};
  let verifiedButUnsubmitted = 0;
  const progressStates: Record<string, number> = {};
  const workMemoryStates: Record<string, number> = {};
  const diagnostics: Partial<Record<LiveRunDiagnostic, number>> = {};
  let anyTokens = false;
  let anyProgress = false;
  let anyWorkMemory = false;
  let anyToolStateMetric = false;
  let anyWire = false;
  for (const row of challenges) {
    if (row.startFailed) startFailed += 1;
    if (row.platformCompleted) accepted += 1;
    else if (row.outcome === "partial" || row.platformCorrect > 0) partial += 1;
    else if (row.platformWrong > 0) wrong += 1;
    else if (isStalledStop(row.stopReason)) stalled += 1;
    else if (row.outcome === "reported") reported += 1;
    else if (row.outcome === "candidate") candidate += 1;
    else failed += 1;
    if (row.stopReason) stopReasons[row.stopReason] = (stopReasons[row.stopReason] ?? 0) + 1;
    mergeContestDiagnostics(diagnostics, row.diagnostics ?? diagnoseContestChallenge(row));
    mergeSummaryCounts(rootStopReasons, row.rootStopReasons);
    if (row.rootSessions !== undefined) {
      rootSessions += row.rootSessions;
      freshRootSessions += Math.max(0, row.rootSessions - 1);
    } else {
      rootSessions += 1;
    }
    if (row.wire) {
      anyWire = true;
      wireRequests += row.wire.requests;
      wireFailures += row.wire.failedRequests;
      maxWireBodyBytes = Math.max(maxWireBodyBytes, row.wire.maxBodyBytes);
      maxWireMessageCount = Math.max(maxWireMessageCount, row.wire.maxMessageCount);
      maxWireToolCount = Math.max(maxWireToolCount, row.wire.maxToolCount);
      maxWireToolBytes = Math.max(maxWireToolBytes, row.wire.maxToolBytes);
      maxWireSystemBytes = Math.max(maxWireSystemBytes, row.wire.maxSystemBytes);
      messageCountDrops += row.wire.messageCountDrops;
      thinkingRequests += row.wire.thinkingRequests;
      thinkingDisabledRequests += row.wire.thinkingDisabledRequests;
      thinkingUnknownRequests += row.wire.thinkingUnknownRequests;
    }
    noToolTurns += row.noToolTurns ?? 0;
    maxNoToolStreak = Math.max(maxNoToolStreak, row.maxNoToolStreak ?? 0);
    lengthStops += row.lengthStops ?? 0;
    assistantTextBytes += row.assistantTextBytes ?? 0;
    maxAssistantTextBytes = Math.max(maxAssistantTextBytes, row.maxAssistantTextBytes ?? 0);
    if (row.promptTokens !== undefined || row.completionTokens !== undefined || row.totalTokens !== undefined) {
      anyTokens = true;
      promptTokens += row.promptTokens ?? 0;
      completionTokens += row.completionTokens ?? 0;
      totalTokens += row.totalTokens ?? 0;
    }
    if (row.turnsSinceTodo != null && row.turnsSinceTodo >= 8) staleTodoRuns += 1;
    if (row.promptSkillGestureCount !== undefined || row.promptSkillGestures?.length) {
      anyToolStateMetric = true;
      promptSkillGestureCount += row.promptSkillGestureCount ?? row.promptSkillGestures?.length ?? 0;
      for (const name of row.promptSkillGestures ?? []) {
        promptSkillGestures[name] = (promptSkillGestures[name] ?? 0) + 1;
      }
    }
    if (row.progress) {
      anyProgress = true;
      const state = row.progress.state ?? "none";
      progressStates[state] = (progressStates[state] ?? 0) + 1;
      offTargetProbeCount += row.progress.offTargetProbeCount ?? 0;
      hostFileProbeCount += row.progress.hostFileProbeCount ?? 0;
      if (row.progress.workMemoryState) {
        anyWorkMemory = true;
        workMemoryStates[row.progress.workMemoryState] = (workMemoryStates[row.progress.workMemoryState] ?? 0) + 1;
        workMemoryNextCheckCount += row.progress.workMemoryNextCheckCount ?? 0;
        workMemoryEvidenceCount += row.progress.workMemoryEvidenceCount ?? 0;
        workMemoryHypothesisCount += row.progress.workMemoryHypothesisCount ?? 0;
      }
      mergeSummaryCounts(assetCounts, row.progress.assetCounts);
      mergeSummaryCounts(explorationCounts, row.progress.explorationCounts);
      mergeSummaryCounts(findingStatusCounts, row.progress.findingStatusCounts);
      mergeSummaryCounts(findingKindCounts, row.progress.findingKindCounts);
    }
    if (row.skillCalls !== undefined || row.todoCalls !== undefined) {
      anyToolStateMetric = true;
      skillCalls += row.skillCalls ?? 0;
      todoCalls += row.todoCalls ?? 0;
    }
    verifiedButUnsubmitted += row.verifiedButUnsubmitted ?? 0;
  }

  const scheduled = pending.length;
  const settled = pool.status().settledCount;
  const pendingLeft = Math.max(0, scheduled - settled);
  const finalBoardEndedAfterSample = sampleSize !== undefined && pendingLeft === 0 && settled >= scheduled && boardError;
  const missionDone =
    pendingLeft === 0 && !timedOut && !llmDeadHalt && !aborted() && (!boardError || Boolean(finalBoardEndedAfterSample));
  const error =
    boardError && !finalBoardEndedAfterSample
      ? boardError
      : llmDeadHalt ?? (aborted() ? abortErrorMessage(input.signal) : timedOut ? "contest timeout" : undefined);
  return {
    schema: "silver.contest-summary.v1",
    maxConcurrent: input.maxConcurrent,
    solverMaxConcurrent,
    solverMaxRootSessions,
    ...(input.solverBudget
      ? {
          solverTimeoutMs: input.solverBudget.timeoutMs,
          solverMaxTurns: input.solverBudget.maxTurns,
          ...(input.solverBudget.source ? { solverBudgetSource: input.solverBudget.source } : {}),
        }
      : {}),
    ...(sampleSize ? { sampleSize, sampledBoardIds: pending.map((row) => row.boardId) } : {}),
    totalListed: listed.length,
    scheduled,
    settled,
    accepted,
    partial,
    wrong,
    reported,
    candidate,
    failed,
    stalled,
    ...(startFailed > 0 ? { startFailed } : {}),
    skipped: skipped.length,
    pending: pendingLeft,
    awarded: challenges.reduce((sum, row) => sum + row.awarded, 0),
    cumulativeScore: challenges.reduce((sum, row) => sum + row.cumulativeScore, 0),
    verifiedButUnsubmitted,
    maxActive: peakActive,
    rootSessions,
    ...(freshRootSessions > 0 ? { freshRootSessions } : {}),
    ...(Object.keys(stopReasons).length > 0 ? { stopReasons } : {}),
    ...(Object.keys(rootStopReasons).length > 0 ? { rootStopReasons } : {}),
    ...(anyWire
      ? {
          wireRequests,
          wireFailures,
          maxWireBodyBytes,
          maxWireMessageCount,
          maxWireToolCount,
          maxWireToolBytes,
          maxWireSystemBytes,
          messageCountDrops,
          noToolTurns,
          maxNoToolStreak,
          lengthStops,
          assistantTextBytes,
          maxAssistantTextBytes,
          staleTodoRuns,
          thinkingRequests,
          thinkingDisabledRequests,
          thinkingUnknownRequests,
        }
      : {}),
    ...(anyTokens ? { promptTokens, completionTokens, totalTokens } : {}),
    ...(anyToolStateMetric
      ? {
          ...(promptSkillGestureCount > 0 ? { promptSkillGestureCount, promptSkillGestures } : {}),
          skillCalls,
          todoCalls,
        }
      : {}),
    ...(anyProgress ? { progressStates, offTargetProbeCount, hostFileProbeCount } : {}),
    ...(anyWorkMemory
      ? {
          workMemoryStates,
          workMemoryNextCheckCount,
          workMemoryEvidenceCount,
          workMemoryHypothesisCount,
        }
      : {}),
    ...(Object.keys(assetCounts).length > 0 ? { assetCounts } : {}),
    ...(Object.keys(explorationCounts).length > 0 ? { explorationCounts } : {}),
    ...(Object.keys(findingStatusCounts).length > 0 ? { findingStatusCounts } : {}),
    ...(Object.keys(findingKindCounts).length > 0 ? { findingKindCounts } : {}),
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    missionDone,
    wallTimeMs: (input.now ?? Date.now)() - startedAt,
    ...(error ? { error } : {}),
    challenges,
  };
}

type ContestDiagnosticInput = {
  stopReason?: string;
  wire?: LiveRunWireSummary;
  toolCalls?: number;
  maxNoToolStreak?: number;
  lengthStops?: number;
  turnsSinceTodo?: number | null;
  progress?: ContestProgressSummary;
  diagnostics?: LiveRunDiagnostic[];
};

function applyContestDiagnostics(row: ContestDiagnosticInput): void {
  const diagnostics = diagnoseContestChallenge(row);
  if (diagnostics.length > 0) row.diagnostics = diagnostics;
}

function diagnoseContestChallenge(row: ContestDiagnosticInput): LiveRunDiagnostic[] {
  const diagnostics: LiveRunDiagnostic[] = [];
  if (row.stopReason === "llm_transport_failure" || (row.wire?.failedRequests ?? 0) > 0) diagnostics.push("llm_transport");
  if ((row.toolCalls ?? 0) === 0 || (row.maxNoToolStreak ?? 0) >= 3) diagnostics.push("no_tool");
  if ((row.lengthStops ?? 0) > 0) diagnostics.push("length_stop");
  if (row.turnsSinceTodo != null && row.turnsSinceTodo >= 8) diagnostics.push("stale_todo");
  if ((row.progress?.hostFileProbeCount ?? 0) > 0) diagnostics.push("host_file_probe");
  if ((row.wire?.maxMessageCount ?? 0) >= 10 || (row.wire?.maxBodyBytes ?? 0) >= 24_000) diagnostics.push("context_pressure");
  if ((row.wire?.compactionRequests ?? 0) > 0) diagnostics.push("compaction_active");
  return diagnostics;
}

function mergeContestDiagnostics(
  target: Partial<Record<LiveRunDiagnostic, number>>,
  diagnostics: readonly LiveRunDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    target[diagnostic] = (target[diagnostic] ?? 0) + 1;
  }
}

function mergeSummaryCounts(target: Record<string, number>, source: Record<string, number> | undefined): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    target[key] = (target[key] ?? 0) + value;
  }
}

function compactBriefText(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function shouldStartFreshRoot(
  result: ContestSolveResult,
  rootSession: number,
  maxRootSessions: number,
  aborted: boolean,
): boolean {
  if (aborted) return false;
  if (rootSession + 1 >= maxRootSessions) return false;
  // Stagnation/candidate heuristics are observational only — they must not force a fresh root.
  // Fresh roots remain for technical transport recovery after tools were reached.
  const recoverableStop = result.stopReason === "llm_transport_failure" && (result.toolCalls ?? 0) > 0;
  if (!recoverableStop) return false;
  if ((result.leftoverRaw?.length ?? 0) > 0) return false;
  const verdicts = result.platformVerdicts ?? [];
  const platformCount = mergePlatformAcceptanceSnapshots(verdicts);
  return !(platformCount?.completed ?? verdicts.some(platformRoomCompleted));
}

function mergeRootSessionResults(
  targetId: string,
  targetUrl: string,
  attempts: ContestSolveResult[],
): ContestSolveResult {
  const last = attempts.at(-1);
  if (!last) return { targetId, targetUrl, outcome: "failed", error: "solver did not run" };
  if (attempts.length === 1) return last;
  const out: ContestSolveResult = {
    ...last,
    targetId,
    targetUrl,
    platformVerdicts: attempts.flatMap((row) => row.platformVerdicts ?? []),
    leftoverRaw: attempts.flatMap((row) => row.leftoverRaw ?? []),
    rootSessions: attempts.length,
  };
  const wallTimeMs = sumOptional(attempts, "wallTimeMs");
  if (wallTimeMs !== undefined) out.wallTimeMs = wallTimeMs;
  const turns = sumOptional(attempts, "turns");
  if (turns !== undefined) out.turns = turns;
  const toolCalls = sumOptional(attempts, "toolCalls");
  if (toolCalls !== undefined) out.toolCalls = toolCalls;
  const noToolTurns = sumOptional(attempts, "noToolTurns");
  if (noToolTurns !== undefined) out.noToolTurns = noToolTurns;
  const lengthStops = sumOptional(attempts, "lengthStops");
  if (lengthStops !== undefined) out.lengthStops = lengthStops;
  const assistantTextBytes = sumOptional(attempts, "assistantTextBytes");
  if (assistantTextBytes !== undefined) out.assistantTextBytes = assistantTextBytes;
  const promptTokens = sumOptional(attempts, "promptTokens");
  if (promptTokens !== undefined) out.promptTokens = promptTokens;
  const completionTokens = sumOptional(attempts, "completionTokens");
  if (completionTokens !== undefined) out.completionTokens = completionTokens;
  const totalTokens = sumOptional(attempts, "totalTokens");
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  const promptSkillGestureCount = sumOptional(attempts, "promptSkillGestureCount");
  if (promptSkillGestureCount !== undefined) out.promptSkillGestureCount = promptSkillGestureCount;
  const promptSkillGestures = uniqueStrings(attempts.flatMap((row) => row.promptSkillGestures ?? []));
  if (promptSkillGestures.length > 0) out.promptSkillGestures = promptSkillGestures;
  const skillCalls = sumOptional(attempts, "skillCalls");
  if (skillCalls !== undefined) out.skillCalls = skillCalls;
  const todoCalls = sumOptional(attempts, "todoCalls");
  if (todoCalls !== undefined) out.todoCalls = todoCalls;
  const maxNoToolStreak = maxOptional(attempts, "maxNoToolStreak");
  if (maxNoToolStreak !== undefined) out.maxNoToolStreak = maxNoToolStreak;
  const maxAssistantTextBytes = maxOptional(attempts, "maxAssistantTextBytes");
  if (maxAssistantTextBytes !== undefined) out.maxAssistantTextBytes = maxAssistantTextBytes;
  const fingerprintCount = maxOptional(attempts, "fingerprintCount");
  if (fingerprintCount !== undefined) out.fingerprintCount = fingerprintCount;
  const wire = mergeLiveWireSummaries(attempts.map((row) => row.wire));
  if (wire) out.wire = wire;
  const rootStopReasons = countRootStopReasons(attempts);
  if (Object.keys(rootStopReasons).length > 0) out.rootStopReasons = rootStopReasons;
  out.rootAttempts = attempts.map((attempt, rootSession) => summarizeRootAttempt(attempt, rootSession));
  const diagnostics = uniqueDiagnostics(attempts.flatMap((row) => row.diagnostics ?? diagnoseContestChallenge(row)));
  if (diagnostics.length > 0) out.diagnostics = diagnostics;
  const errors = attempts.map((row) => row.error).filter((value): value is string => Boolean(value));
  if (errors.length > 0) out.error = errors.join("; ");
  return out;
}

function summarizeRootAttempt(attempt: ContestSolveResult, rootSession: number): ContestRootAttemptSummary {
  const out: ContestRootAttemptSummary = { rootSession };
  if (attempt.outcome) out.outcome = attempt.outcome;
  if (attempt.stopReason) out.stopReason = attempt.stopReason;
  if (attempt.acpStopReason) out.acpStopReason = attempt.acpStopReason;
  if (attempt.dshSessionId) out.dshSessionId = attempt.dshSessionId;
  if (attempt.turns !== undefined) out.turns = attempt.turns;
  if (attempt.toolCalls !== undefined) out.toolCalls = attempt.toolCalls;
  if (attempt.wire?.failedRequests !== undefined) out.wireFailures = attempt.wire.failedRequests;
  if (attempt.replayPath) out.replayPath = attempt.replayPath;
  if (attempt.reportPath) out.reportPath = attempt.reportPath;
  if (attempt.promptSkillGestures?.length) out.promptSkillGestures = attempt.promptSkillGestures;
  if (attempt.promptSkillGestureCount !== undefined) out.promptSkillGestureCount = attempt.promptSkillGestureCount;
  const diagnostics = attempt.diagnostics ?? diagnoseContestChallenge(attempt);
  if (diagnostics.length > 0) out.diagnostics = diagnostics;
  return out;
}

function uniqueDiagnostics(rows: LiveRunDiagnostic[]): LiveRunDiagnostic[] {
  const seen = new Set<LiveRunDiagnostic>();
  const out: LiveRunDiagnostic[] = [];
  for (const row of rows) {
    if (seen.has(row)) continue;
    seen.add(row);
    out.push(row);
  }
  return out;
}

function uniqueStrings(rows: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (!row || seen.has(row)) continue;
    seen.add(row);
    out.push(row);
  }
  return out;
}

function countRootStopReasons(attempts: ContestSolveResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const attempt of attempts) {
    if (!attempt.stopReason) continue;
    out[attempt.stopReason] = (out[attempt.stopReason] ?? 0) + 1;
  }
  return out;
}

function sumOptional<K extends keyof ContestSolveResult>(rows: ContestSolveResult[], key: K): number | undefined {
  let sum = 0;
  let any = false;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "number") continue;
    sum += value;
    any = true;
  }
  return any ? sum : undefined;
}

function maxOptional<K extends keyof ContestSolveResult>(rows: ContestSolveResult[], key: K): number | undefined {
  let max: number | undefined;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "number") continue;
    max = max === undefined ? value : Math.max(max, value);
  }
  return max;
}

function normalizeSolverMaxConcurrent(value: number | undefined, fallback: number): number {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw) || raw < 1) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(raw));
}

function normalizeSampleSize(value: number | undefined, available: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1) return undefined;
  return Math.min(Math.floor(value), available);
}

export function sampleContestRows<T>(rows: T[], size: number, random: () => number): T[] {
  if (size >= rows.length) return [...rows];
  return shuffleContestRows(rows, random).slice(0, size);
}

export function shuffleContestRows<T>(rows: T[], random: () => number): T[] {
  const shuffled = [...rows];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const raw = random();
    const bounded = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999) : 0;
    const j = Math.floor(bounded * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

function contestOutcomeFromVerdicts(input: {
  fallback?: string;
  platformCompleted: boolean;
  platformProgress: boolean;
  platformCorrect: number;
  platformWrong: number;
  stopReason?: string;
}): string {
  if (input.platformCompleted) return "accepted";
  if (input.platformProgress || input.platformCorrect > 0) return "partial";
  if (input.platformWrong > 0) return "wrong";
  if (isStalledStop(input.stopReason)) return "stalled";
  return input.fallback ?? "failed";
}

function isStalledStop(stopReason: string | undefined): boolean {
  return (
    stopReason === "timeout" ||
    stopReason === "max_turns" ||
    stopReason === "stagnation_checkpoint" ||
    stopReason === "candidate_checkpoint" ||
    stopReason === "llm_transport_failure" ||
    stopReason === "coordination_failure" ||
    stopReason === "interrupted"
  );
}

async function waitSlotOrAbort(
  pool: SlotPool,
  signal: AbortSignal | undefined,
): Promise<SlotResult | { idle: true } | { aborted: true }> {
  if (!signal) return pool.waitSlot();
  if (signal.aborted) return { aborted: true };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<{ aborted: true }>((resolve) => {
    onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pool.waitSlot(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortErrorMessage(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "contest interrupted";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
