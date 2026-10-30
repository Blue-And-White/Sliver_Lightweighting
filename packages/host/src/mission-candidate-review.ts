/**
 * Mission-level candidate review generations.
 * Durable latest/acked watermarks + wake queue upgrade for the same target.
 * Ack N covers all generations <= N; if latest > N, a re-wake is required.
 */
/** Failed record_target_result turns for the current unacked generation. Not global. */
export const CANDIDATE_REVIEW_REPROMPTS = 2;

export type TargetReviewGenerationState = {
  latestReviewGeneration: number;
  ackedReviewGeneration: number;
  /** Spent on latestReviewGeneration while it is still unacked. Reset when that generation moves or is acked. */
  unackedReprompts?: 1 | 2;
};

export type UnackedRepromptResult = {
  reviewGenerationId: number;
  reprompts: number;
  reprompt: boolean;
  exhausted: boolean;
};

export type CandidateReportWake = {
  kind: "candidate_report";
  targetId: string;
  status: "reported" | "duplicate";
  reviewGenerationId: number;
};

export type MissionCandidateReviewSnapshot = {
  targets: Record<string, TargetReviewGenerationState>;
};

export type NoteCandidateWakeResult =
  | { outcome: "delivered"; wake: CandidateReportWake }
  | { outcome: "queued"; wake: CandidateReportWake }
  | { outcome: "upgraded"; wake: CandidateReportWake; previousGenerationId: number };

export type AckCandidateReviewResult = {
  targetId: string;
  ackedReviewGeneration: number;
  latestReviewGeneration: number;
  /** Fully caught up: latest <= acked. */
  caughtUp: boolean;
  /** latest > acked after this ack — Commander must be woken again. */
  needsRewake: boolean;
  rewake?: CandidateReportWake;
};

export type MissionCandidateReviewTracker = {
  snapshot: () => MissionCandidateReviewSnapshot;
  pendingTargetIds: () => string[];
  stateFor: (targetId: string) => TargetReviewGenerationState | undefined;
  /**
   * Record a candidate-report wake. Same-target queued wakes are upgraded to the
   * newest generation instead of being dropped.
   */
  noteCandidateWake: (input: {
    targetId: string;
    status: "reported" | "duplicate";
    reviewGenerationId: number;
    /** When true, project is closed — ignore. */
    closed?: boolean;
  }) => NoteCandidateWakeResult | { outcome: "ignored_closed" };
  /** Pop the next queued wake, or undefined if empty. */
  takeNextWake: () => CandidateReportWake | undefined;
  /** Peek queued wakes (test/debug). */
  queuedWakes: () => readonly CandidateReportWake[];
  /**
   * Commander echoed reviewGenerationId from a wake.
   * Ack covers <= N. If latest > N, enqueues/upgrades a re-wake for latest.
   */
  ackReviewGeneration: (input: {
    targetId: string;
    reviewGenerationId: number;
  }) => AckCandidateReviewResult;
  /** Drop all state for a target (completed / closed). */
  clearTarget: (targetId: string) => void;
  /** Restore pending targets that still need Commander attention after checkpoint load. */
  restorePendingWakes: () => CandidateReportWake[];
  /** True when some still-unacked generation has already spent its two re-prompts. */
  reviewRepromptExhausted: () => boolean;
  /**
   * Count one failed acknowledgement for this target's current unacked generation.
   * Two failures exhaust that pair. Another target, or a newer generation, starts at zero.
   */
  noteUnackedReprompt: (targetId: string) => UnackedRepromptResult;
};

export function createMissionCandidateReviewTracker(
  resume?: MissionCandidateReviewSnapshot,
): MissionCandidateReviewTracker {
  const targets = new Map<string, TargetReviewGenerationState>();
  const queue: CandidateReportWake[] = [];

  if (resume?.targets) {
    for (const [targetId, row] of Object.entries(resume.targets)) {
      if (!/^[A-Za-z0-9._-]+$/.test(targetId) || !isTargetState(row)) {
        throw new Error(
          `corrupt mission candidate review snapshot for target ${JSON.stringify(targetId)}`,
        );
      }
      targets.set(targetId, copyState(row));
    }
  }

  const ensure = (targetId: string): TargetReviewGenerationState => {
    const existing = targets.get(targetId);
    if (existing) return existing;
    const created = { latestReviewGeneration: 0, ackedReviewGeneration: 0 };
    targets.set(targetId, created);
    return created;
  };

  const snapshot = (): MissionCandidateReviewSnapshot => {
    const out: Record<string, TargetReviewGenerationState> = {};
    for (const [targetId, row] of targets) {
      if (row.latestReviewGeneration <= 0 && row.ackedReviewGeneration <= 0) continue;
      out[targetId] = copyState(row);
    }
    return { targets: out };
  };

  const pendingTargetIds = (): string[] =>
    [...targets.entries()]
      .filter(([, row]) => row.latestReviewGeneration > row.ackedReviewGeneration)
      .map(([targetId]) => targetId);

  const upgradeOrQueue = (wake: CandidateReportWake): NoteCandidateWakeResult => {
    const idx = queue.findIndex((row) => row.targetId === wake.targetId);
    if (idx >= 0) {
      const previous = queue[idx]!;
      const previousGenerationId = previous.reviewGenerationId;
      const upgraded: CandidateReportWake = {
        kind: "candidate_report",
        targetId: wake.targetId,
        status: wake.status,
        reviewGenerationId: Math.max(previousGenerationId, wake.reviewGenerationId),
      };
      queue[idx] = upgraded;
      return { outcome: "upgraded", wake: upgraded, previousGenerationId };
    }
    queue.push(wake);
    return { outcome: "queued", wake };
  };

  return {
    snapshot,
    pendingTargetIds,
    stateFor: (targetId) => {
      const row = targets.get(targetId);
      return row ? copyState(row) : undefined;
    },
    noteCandidateWake: (input) => {
      if (input.closed) return { outcome: "ignored_closed" };
      const generationId = input.reviewGenerationId;
      if (!Number.isInteger(generationId) || generationId < 1) {
        throw new Error(`reviewGenerationId must be a positive integer, got ${input.reviewGenerationId}`);
      }
      const state = ensure(input.targetId);
      const previousLatest = state.latestReviewGeneration;
      state.latestReviewGeneration = Math.max(previousLatest, generationId);
      if (state.latestReviewGeneration > previousLatest) delete state.unackedReprompts;
      const wake: CandidateReportWake = {
        kind: "candidate_report",
        targetId: input.targetId,
        status: input.status,
        reviewGenerationId: state.latestReviewGeneration,
      };
      // Always carry the latest generation on the wake object.
      return upgradeOrQueue(wake);
    },
    takeNextWake: () => queue.shift(),
    queuedWakes: () => queue,
    ackReviewGeneration: (input) => {
      const acked = input.reviewGenerationId;
      if (!Number.isInteger(acked) || acked < 1) {
        throw new Error(`reviewGenerationId must be a positive integer, got ${input.reviewGenerationId}`);
      }
      const state = ensure(input.targetId);
      if (state.latestReviewGeneration < 1) {
        throw new Error(`no candidate review generation outstanding for ${input.targetId}`);
      }
      if (acked > state.latestReviewGeneration) {
        throw new Error(
          `reviewGenerationId=${acked} is ahead of latest=${state.latestReviewGeneration} for ${input.targetId}`,
        );
      }
      state.ackedReviewGeneration = Math.max(state.ackedReviewGeneration, acked);
      if (state.latestReviewGeneration <= state.ackedReviewGeneration) delete state.unackedReprompts;
      const caughtUp = state.latestReviewGeneration <= state.ackedReviewGeneration;
      if (caughtUp) {
        // Drop any queued wake for this target — nothing left to reconcile.
        for (let i = queue.length - 1; i >= 0; i -= 1) {
          if (queue[i]?.targetId === input.targetId) queue.splice(i, 1);
        }
        return {
          targetId: input.targetId,
          ackedReviewGeneration: state.ackedReviewGeneration,
          latestReviewGeneration: state.latestReviewGeneration,
          caughtUp: true,
          needsRewake: false,
        };
      }
      const rewake: CandidateReportWake = {
        kind: "candidate_report",
        targetId: input.targetId,
        status: "reported",
        reviewGenerationId: state.latestReviewGeneration,
      };
      upgradeOrQueue(rewake);
      return {
        targetId: input.targetId,
        ackedReviewGeneration: state.ackedReviewGeneration,
        latestReviewGeneration: state.latestReviewGeneration,
        caughtUp: false,
        needsRewake: true,
        rewake,
      };
    },
    clearTarget: (targetId) => {
      targets.delete(targetId);
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]?.targetId === targetId) queue.splice(i, 1);
      }
    },
    reviewRepromptExhausted: () =>
      pendingTargetIds().some((targetId) => (targets.get(targetId)?.unackedReprompts ?? 0) >= CANDIDATE_REVIEW_REPROMPTS),
    noteUnackedReprompt: (targetId) => {
      const state = targets.get(targetId);
      if (!state || state.latestReviewGeneration <= state.ackedReviewGeneration) {
        return {
          reviewGenerationId: state?.latestReviewGeneration ?? 0,
          reprompts: 0,
          reprompt: false,
          exhausted: false,
        };
      }
      const spent = state.unackedReprompts ?? 0;
      if (spent >= CANDIDATE_REVIEW_REPROMPTS) {
        return {
          reviewGenerationId: state.latestReviewGeneration,
          reprompts: spent,
          reprompt: false,
          exhausted: true,
        };
      }
      const next = (spent + 1) as 1 | 2;
      state.unackedReprompts = next;
      return {
        reviewGenerationId: state.latestReviewGeneration,
        reprompts: next,
        reprompt: true,
        exhausted: false,
      };
    },
    restorePendingWakes: () => {
      const restored: CandidateReportWake[] = [];
      for (const targetId of pendingTargetIds()) {
        const state = targets.get(targetId)!;
        const wake: CandidateReportWake = {
          kind: "candidate_report",
          targetId,
          status: "reported",
          reviewGenerationId: state.latestReviewGeneration,
        };
        upgradeOrQueue(wake);
        restored.push(wake);
      }
      return restored;
    },
  };
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTargetState(value: unknown): value is TargetReviewGenerationState {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!isNonNegativeInt(row.latestReviewGeneration) || !isNonNegativeInt(row.ackedReviewGeneration)) {
    return false;
  }
  if (row.ackedReviewGeneration > row.latestReviewGeneration) return false;
  if (!("unackedReprompts" in row) || row.unackedReprompts === undefined) return true;
  return row.unackedReprompts === 1 || row.unackedReprompts === 2;
}

function copyState(row: TargetReviewGenerationState): TargetReviewGenerationState {
  return {
    latestReviewGeneration: row.latestReviewGeneration,
    ackedReviewGeneration: row.ackedReviewGeneration,
    ...(row.unackedReprompts ? { unackedReprompts: row.unackedReprompts } : {}),
  };
}

/**
 * Fail-closed: any corrupt target id or row → undefined (do not partially resume).
 */
export function parseMissionCandidateReviewSnapshot(value: unknown): MissionCandidateReviewSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const targetsRaw = row.targets;
  if (!targetsRaw || typeof targetsRaw !== "object" || Array.isArray(targetsRaw)) return undefined;
  const targets: Record<string, TargetReviewGenerationState> = {};
  for (const [targetId, state] of Object.entries(targetsRaw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]+$/.test(targetId) || !isTargetState(state)) return undefined;
    targets[targetId] = copyState(state);
  }
  return { targets };
}
