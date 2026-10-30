/**
 * Goal-bound candidate review hold.
 *
 * Model: fingerprint + review generation + fixed expiresAt.
 * - Same generation never renews the lease.
 * - New fingerprint opens a new generation (new fixed expiresAt).
 * - Same fingerprint after lease/pending only repairs C2 — never re-freezes.
 * - Resume restores the original expiresAt (bounded across restarts).
 * - beginTerminalStop cancels the lease without waking workers for pending.
 * - resolve pending acks a generation; a newer open generation stays held (dirty).
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CANDIDATE_REVIEW_LEASE_MS = 120_000;
export const CANDIDATE_REVIEW_HOLD_SCHEMA = "silver.candidate-review-hold.v1" as const;

export const REVIEW_LEASE_EXPIRED_REASON =
  "review_lease_expired; Commander still owes platform verification" as const;

export type CandidateReviewHoldReview = {
  status: "pending" | "completed";
  reason: string;
  /** Generation the Commander wake was for; stale acks must not clear a newer hold. */
  ackedGenerationId?: number;
};

export type CandidateReviewHoldPlatformView = {
  status: "reviewing" | "pending" | "active";
  reason?: string;
};

export type CandidateReviewHoldSnapshot = {
  schema: typeof CANDIDATE_REVIEW_HOLD_SCHEMA;
  generationId: number;
  fingerprint: string;
  expiresAtMs: number;
  holding: boolean;
  commanderReviewOwed: boolean;
  knownFingerprints: string[];
  lastWokenGenerationId: number;
  lastAckedGenerationId: number;
};

export type NoteCandidateResult = {
  outcome: "opened_generation" | "same_generation" | "c2_repair_only" | "ignored_terminal";
  generationId: number;
  fingerprint: string;
  /** Commander must be woken for this note (new generation only). */
  wakeCommander: boolean;
  /** Active ACP turns should be stopped for a checkpoint. */
  quiesceSessions: boolean;
  expiresAtMs?: number;
};

export type ResolveCommanderResult = {
  review: CandidateReviewHoldReview;
  /** Current generation is newer than the acked wake — Commander must run again. */
  dirty: boolean;
  wakeCommander: boolean;
  generationId: number;
};

export type CandidateReviewHoldOptions = {
  /** Bounded hold; <=0 disables the lease timer. Default 120s. */
  leaseMs?: number;
  nowMs?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Restore a prior generation with its original expiresAt. */
  resume?: CandidateReviewHoldSnapshot;
  /** Fired when the lease expires: hold lifts, Commander still owes review. */
  onLeaseExpired?: (review: CandidateReviewHoldReview) => void;
  /** Optional durable snapshot hook (Host persists across resume). */
  onSnapshot?: (snapshot: CandidateReviewHoldSnapshot | undefined) => void;
};

export type CandidateReviewHold = {
  isHolding: () => boolean;
  isCommanderReviewOwed: () => boolean;
  isTerminalStopping: () => boolean;
  generationId: () => number;
  activeFingerprint: () => string | undefined;
  expiresAtMs: () => number | undefined;
  platformView: () => CandidateReviewHoldPlatformView;
  snapshot: () => CandidateReviewHoldSnapshot | undefined;
  /**
   * Record a candidate report. Same generation does not renew the lease.
   * New fingerprint opens a new generation with a fresh fixed expiresAt.
   */
  noteCandidate: (input: { fingerprint: string; nowMs?: number }) => NoteCandidateResult;
  /**
   * completed received: cancel lease immediately and refuse further holds/wakes
   * until resolveFromCommander after durable stop. Does not signal worker pending.
   */
  beginTerminalStop: () => void;
  /**
   * Pending target with missing/corrupt snapshot: Commander still owes review,
   * but workers must not wait on a hold that no longer exists.
   */
  markCommanderReviewOwed: () => void;
  /**
   * Commander answered pending/completed (or room closed after stop).
   * Pending acks `ackedGenerationId` when provided; a newer generation stays held.
   */
  resolveFromCommander: (review: CandidateReviewHoldReview) => ResolveCommanderResult;
  dispose: () => void;
};

export function candidateReviewHoldPath(roomClockDir: string, challengeId: string): string {
  return path.join(roomClockDir, `candidate-review-hold-${challengeId}.json`);
}

export function readCandidateReviewHoldSnapshot(
  roomClockDir: string,
  challengeId: string,
): CandidateReviewHoldSnapshot | undefined {
  const file = candidateReviewHoldPath(roomClockDir, challengeId);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isCandidateReviewHoldSnapshot(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeCandidateReviewHoldSnapshot(
  roomClockDir: string,
  challengeId: string,
  snapshot: CandidateReviewHoldSnapshot | undefined,
): void {
  const file = candidateReviewHoldPath(roomClockDir, challengeId);
  if (!snapshot) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* missing is fine */
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Sessions should wait on GoalReview only while the restored snapshot is still holding.
 * Lease-expired / owed-only / missing snapshots must continue ACP immediately.
 */
export function shouldResumeSessionsInReviewHold(
  snapshot: CandidateReviewHoldSnapshot | undefined,
): boolean {
  return snapshot?.holding === true;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isCandidateReviewHoldSnapshot(value: unknown): value is CandidateReviewHoldSnapshot {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (
    row.schema !== CANDIDATE_REVIEW_HOLD_SCHEMA ||
    !isPositiveInt(row.generationId) ||
    typeof row.fingerprint !== "string" ||
    row.fingerprint.trim().length === 0 ||
    typeof row.expiresAtMs !== "number" ||
    !Number.isFinite(row.expiresAtMs) ||
    typeof row.holding !== "boolean" ||
    typeof row.commanderReviewOwed !== "boolean" ||
    !Array.isArray(row.knownFingerprints) ||
    !row.knownFingerprints.every((item) => typeof item === "string") ||
    !isNonNegativeInt(row.lastWokenGenerationId) ||
    !isNonNegativeInt(row.lastAckedGenerationId)
  ) {
    return false;
  }
  // lastAcked ≤ lastWoken ≤ generation
  return (
    row.lastAckedGenerationId <= row.lastWokenGenerationId &&
    row.lastWokenGenerationId <= row.generationId
  );
}

export function createCandidateReviewHold(options: CandidateReviewHoldOptions = {}): CandidateReviewHold {
  const leaseMs = options.leaseMs ?? DEFAULT_CANDIDATE_REVIEW_LEASE_MS;
  const nowFn = options.nowMs ?? Date.now;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  let generationId = 0;
  let activeFingerprint: string | undefined;
  let expiresAtMs: number | undefined;
  let holding = false;
  let commanderReviewOwed = false;
  let terminalStopping = false;
  let lastWokenGenerationId = 0;
  let lastAckedGenerationId = 0;
  const knownFingerprints = new Set<string>();
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;

  const emitSnapshot = (): void => {
    options.onSnapshot?.(snapshot());
  };

  const snapshot = (): CandidateReviewHoldSnapshot | undefined => {
    if (!activeFingerprint || expiresAtMs === undefined || generationId < 1) return undefined;
    return {
      schema: CANDIDATE_REVIEW_HOLD_SCHEMA,
      generationId,
      fingerprint: activeFingerprint,
      expiresAtMs,
      holding,
      commanderReviewOwed,
      knownFingerprints: [...knownFingerprints],
      lastWokenGenerationId,
      lastAckedGenerationId,
    };
  };

  const clearLease = (): void => {
    if (leaseTimer !== undefined) {
      clearTimeoutFn(leaseTimer);
      leaseTimer = undefined;
    }
  };

  const fireLeaseExpired = (): void => {
    if (terminalStopping || !holding) return;
    holding = false;
    clearLease();
    emitSnapshot();
    options.onLeaseExpired?.({
      status: "pending",
      reason: REVIEW_LEASE_EXPIRED_REASON,
    });
  };

  const armLeaseToExpiresAt = (): void => {
    clearLease();
    if (!(leaseMs > 0) || expiresAtMs === undefined) return;
    const remaining = Math.max(0, expiresAtMs - nowFn());
    leaseTimer = setTimeoutFn(() => {
      leaseTimer = undefined;
      fireLeaseExpired();
    }, remaining);
  };

  const openGeneration = (fingerprint: string, nowMs: number): NoteCandidateResult => {
    generationId += 1;
    activeFingerprint = fingerprint;
    knownFingerprints.add(fingerprint);
    // Fixed expiresAt for this generation — never renewed by same-generation notes.
    expiresAtMs = nowMs + Math.max(0, leaseMs);
    holding = true;
    commanderReviewOwed = true;
    const wakeCommander = generationId > lastWokenGenerationId;
    if (wakeCommander) lastWokenGenerationId = generationId;
    armLeaseToExpiresAt();
    emitSnapshot();
    return {
      outcome: "opened_generation",
      generationId,
      fingerprint,
      wakeCommander,
      quiesceSessions: true,
      expiresAtMs,
    };
  };

  if (options.resume && isCandidateReviewHoldSnapshot(options.resume)) {
    const resume = options.resume;
    generationId = resume.generationId;
    activeFingerprint = resume.fingerprint;
    expiresAtMs = resume.expiresAtMs;
    holding = resume.holding;
    commanderReviewOwed = resume.commanderReviewOwed;
    lastWokenGenerationId = resume.lastWokenGenerationId;
    lastAckedGenerationId = resume.lastAckedGenerationId;
    for (const fp of resume.knownFingerprints) knownFingerprints.add(fp);
    knownFingerprints.add(resume.fingerprint);
    if (holding) {
      if (expiresAtMs <= nowFn()) fireLeaseExpired();
      else armLeaseToExpiresAt();
    }
  }

  return {
    isHolding: () => holding || terminalStopping,
    isCommanderReviewOwed: () => commanderReviewOwed,
    isTerminalStopping: () => terminalStopping,
    generationId: () => generationId,
    activeFingerprint: () => activeFingerprint,
    expiresAtMs: () => expiresAtMs,
    platformView: () => {
      if (holding || terminalStopping) return { status: "reviewing", reason: "candidate checkpoint" };
      if (commanderReviewOwed) {
        return { status: "pending", reason: "commander owes platform review" };
      }
      return { status: "active" };
    },
    snapshot,
    noteCandidate: (input) => {
      const fingerprint = input.fingerprint.trim();
      if (!fingerprint) {
        return {
          outcome: "c2_repair_only",
          generationId,
          fingerprint: "",
          wakeCommander: false,
          quiesceSessions: false,
        };
      }
      const nowMs = input.nowMs ?? nowFn();

      if (terminalStopping) {
        return {
          outcome: "ignored_terminal",
          generationId,
          fingerprint,
          wakeCommander: false,
          quiesceSessions: false,
          ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
        };
      }

      if (holding && activeFingerprint === fingerprint) {
        return {
          outcome: "same_generation",
          generationId,
          fingerprint,
          wakeCommander: false,
          quiesceSessions: false,
          ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
        };
      }

      if (!knownFingerprints.has(fingerprint)) {
        return openGeneration(fingerprint, nowMs);
      }

      return {
        outcome: "c2_repair_only",
        generationId,
        fingerprint,
        wakeCommander: false,
        quiesceSessions: false,
        ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
      };
    },
    beginTerminalStop: () => {
      terminalStopping = true;
      holding = false;
      clearLease();
      emitSnapshot();
    },
    markCommanderReviewOwed: () => {
      if (terminalStopping) return;
      holding = false;
      commanderReviewOwed = true;
      // Missing/corrupt snapshot must still be clearable by a generation ack.
      if (generationId < 1) {
        generationId = 1;
        activeFingerprint = activeFingerprint ?? "__resume_owed__";
        lastWokenGenerationId = Math.max(lastWokenGenerationId, 1);
      }
      // Owed-only must still snapshot: use a fixed already-expired expiresAt so
      // writeCandidateReviewHoldSnapshot persists instead of deleting the file.
      if (expiresAtMs === undefined) {
        expiresAtMs = nowFn();
      }
      clearLease();
      emitSnapshot();
    },
    resolveFromCommander: (review) => {
      if (review.status === "completed") {
        holding = false;
        commanderReviewOwed = false;
        terminalStopping = false;
        clearLease();
        generationId = 0;
        activeFingerprint = undefined;
        expiresAtMs = undefined;
        knownFingerprints.clear();
        lastWokenGenerationId = 0;
        lastAckedGenerationId = 0;
        options.onSnapshot?.(undefined);
        return { review, dirty: false, wakeCommander: false, generationId: 0 };
      }

      const acked = review.ackedGenerationId;
      if (acked === undefined) {
        // Missing ack id must not confirm the latest generation.
        emitSnapshot();
        return {
          review,
          dirty: generationId > lastAckedGenerationId,
          wakeCommander: false,
          generationId,
        };
      }
      if (!Number.isInteger(acked) || acked < 1) {
        throw new Error(`ackedGenerationId must be a positive integer, got ${acked}`);
      }
      if (acked > generationId) {
        throw new Error(
          `ackedGenerationId=${acked} is ahead of generation=${generationId}`,
        );
      }
      lastAckedGenerationId = Math.max(lastAckedGenerationId, acked);
      const dirty = generationId > lastAckedGenerationId;

      if (dirty) {
        // Newer generation than this ack — keep freeze if active; ask for another wake.
        commanderReviewOwed = true;
        emitSnapshot();
        const wakeCommander = generationId > lastWokenGenerationId;
        if (wakeCommander) lastWokenGenerationId = generationId;
        return { review, dirty: true, wakeCommander, generationId };
      }

      holding = false;
      commanderReviewOwed = false;
      terminalStopping = false;
      clearLease();
      emitSnapshot();
      return { review, dirty: false, wakeCommander: false, generationId };
    },
    dispose: () => {
      clearLease();
    },
  };
}

/** Resolve lease ms from env; invalid/empty → default. */
export function candidateReviewLeaseMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_CANDIDATE_REVIEW_LEASE_MS,
): number {
  const raw = env.SILVER_CANDIDATE_REVIEW_LEASE_MS?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}
