/**
 * C5a Solo Convergence Episode — Host orchestration only.
 * claim → Reviewer synthesize → C3 apply.
 * Does not judge technical routes; does not run recruit/remove; does not spawn DSH itself.
 *
 * Identity: solo Reviewer is NOT a Room Member. Envelopes must use the Host system
 * principal `system:convergence-reviewer` as actorMemberId.
 */
import fs from "node:fs";
import {
  claimRoomConvergence,
  flushRoomPendingNext,
  type ClaimRoomConvergenceInput,
} from "./room-convergence.ts";
import {
  requireConvergenceStore,
  restoreConvergencePlan,
  persistStuckDecisionRedelivery,
  persistInvalidDecisionDelivery,
  convergenceGenerationPath,
  type ConvergenceStore,
  type ConvergenceTrigger,
} from "./convergence-generation.ts";
import {
  applyDecisionEnvelope,
  parseDecisionEnvelope,
  readDecisionJournal,
  type ApplyDecisionEnvelopeResult,
  type DecisionEnvelope,
  type DecisionAction,
} from "./decision-envelope.ts";
import type { RoomProjectionChallengeInfo } from "./room-projection.ts";

/**
 * Host system principal for solo Convergence Episode decisions.
 * Not a roster Member; it identifies Host-system convergence actions.
 */
export const CONVERGENCE_SYSTEM_ACTOR_ID = "system:convergence-reviewer" as const;
/** @deprecated Use CONVERGENCE_SYSTEM_ACTOR_ID — fake Member id removed. */
export const SOLO_REVIEWER_ACTOR_MEMBER_ID = CONVERGENCE_SYSTEM_ACTOR_ID;
export const SOLO_MEMBER_ID = "lead" as const;

export type ConvergenceReviewerInput = {
  roomId: string;
  challengeId: string;
  generationId: number;
  claimToken: string;
  triggers: ConvergenceTrigger[];
  projection: RoomProjectionChallengeInfo;
  /** Required envelope actor — system Reviewer (solo) or Lead memberId (swarm). */
  systemActorId: string;
  /** Cancel in-flight Reviewer (platform stop / deadline / SIGINT). */
  signal?: AbortSignal;
};

export type ConvergenceReviewerResult =
  | { ok: true; envelope: DecisionEnvelope | unknown }
  | { ok: false; reason: string };

export type ConvergenceReviewer = {
  synthesize: (input: ConvergenceReviewerInput) => Promise<ConvergenceReviewerResult>;
};

export type SoloConvergenceEpisodeInput = {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  /** Thin projection slice — Host supplies; Reviewer must not invent facts. */
  projection: RoomProjectionChallengeInfo;
  reviewer: ConvergenceReviewer;
  claimToken?: string;
  nowMs?: number;
  signal?: AbortSignal;
};

export type SoloConvergenceEpisodeResult =
  | {
      ok: true;
      outcome: "applied" | "already_applied" | "idle";
      generationId?: number;
      decisionId?: string;
      store: ConvergenceStore;
      apply?: ApplyDecisionEnvelopeResult;
    }
  | {
      ok: false;
      reason: string;
      /** Generation remains recoverable via restoreConvergencePlan. */
      recoverable: boolean;
      generationId?: number;
      decisionId?: string;
      store?: ConvergenceStore;
    };

/** Solo C5a refuses recruit/remove — Host policy, not technical judgment. */
export function assertSoloConvergenceActions(actions: readonly DecisionAction[]): void {
  for (const action of actions) {
    if (action.type === "recruit" || action.type === "remove") {
      throw new Error(`solo_convergence_refuses_${action.type}`);
    }
  }
}

export function assertSoloConvergenceActor(actorMemberId: string): void {
  if (actorMemberId !== CONVERGENCE_SYSTEM_ACTOR_ID) {
    throw new Error(
      `solo_convergence_actor_must_be_system_principal: expected=${CONVERGENCE_SYSTEM_ACTOR_ID} got=${actorMemberId}`,
    );
  }
}

/**
 * Run one solo Convergence Episode to quiescence for the active generation plan.
 * Idempotent across crash/retry when C2/C3 journals are intact.
 */
export async function runSoloConvergenceEpisode(
  input: SoloConvergenceEpisodeInput,
): Promise<SoloConvergenceEpisodeResult> {
  const file = convergenceGenerationPath(input.roomClockDir, input.challengeId);
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      reason: "convergence_ledger_missing",
      recoverable: true,
    };
  }

  let store = requireConvergenceStore(file);
  if (store.terminalHalt) {
    return {
      ok: false,
      reason: "room_terminal_halt",
      recoverable: true,
      store,
    };
  }
  if (input.signal?.aborted) {
    return { ok: false, reason: "aborted", recoverable: true, store };
  }

  let plan = restoreConvergencePlan(store);

  // Durable queued triggers must mint a generation before any idle return.
  if (plan.kind === "flush_pending_next") {
    const flushed = await flushRoomPendingNext({
      roomClockDir: input.roomClockDir,
      roomId: input.roomId,
      challengeId: input.challengeId,
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
    if (!flushed.ok) {
      return {
        ok: false,
        reason: flushed.reason,
        recoverable: true,
        store: flushed.store,
      };
    }
    store = flushed.store;
    if (flushed.outcome === "idle") {
      return { ok: true, outcome: "idle", store };
    }
    plan = restoreConvergencePlan(store);
  }

  if (plan.kind === "idle" || plan.kind === "flush_pending_next") {
    // Second flush_pending_next would mean mint left queue without active — fail closed.
    if (plan.kind === "flush_pending_next") {
      return {
        ok: false,
        reason: "flush_pending_next_unresolved",
        recoverable: true,
        store,
      };
    }
    return { ok: true, outcome: "idle", store };
  }

  if (plan.kind === "reapply") {
    const journal = readDecisionJournal(input.roomClockDir, plan.decisionId);
    if (!journal) {
      return {
        ok: false,
        reason: "decision_journal_missing",
        recoverable: true,
        generationId: plan.generationId,
        decisionId: plan.decisionId,
        store,
      };
    }
    const apply = await applyDecisionEnvelope({
      roomClockDir: input.roomClockDir,
      envelope: journal.envelope,
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
    if (!apply.ok) {
      return {
        ok: false,
        reason: apply.reason,
        recoverable: true,
        generationId: plan.generationId,
        decisionId: plan.decisionId,
        ...(apply.store ? { store: apply.store } : { store }),
      };
    }
    return {
      ok: true,
      outcome: apply.outcome,
      generationId: apply.generationId,
      decisionId: apply.decisionId,
      store: apply.store,
      apply,
    };
  }

  // deliver: pending | processing
  const claimInput: ClaimRoomConvergenceInput = {
    roomClockDir: input.roomClockDir,
    roomId: input.roomId,
    challengeId: input.challengeId,
    generationId: plan.generationId,
    ...(input.claimToken ? { claimToken: input.claimToken } : {}),
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  };
  const claimed = await claimRoomConvergence(claimInput);
  if (!claimed.ok) {
    return {
      ok: false,
      reason: claimed.reason,
      recoverable: true,
      generationId: plan.generationId,
      store: claimed.store,
    };
  }
  store = claimed.store;
  store = persistStuckDecisionRedelivery(file, store, claimed.outcome, input.nowMs);
  const active = store.active;
  if (!active || active.generationId !== plan.generationId) {
    return {
      ok: false,
      reason: "generation_missing_after_claim",
      recoverable: true,
      generationId: plan.generationId,
      store,
    };
  }

  if (input.signal?.aborted || store.terminalHalt) {
    return {
      ok: false,
      reason: store.terminalHalt ? "room_terminal_halt" : "aborted",
      recoverable: true,
      generationId: plan.generationId,
      store,
    };
  }

  const reviewerResult = await input.reviewer.synthesize({
    roomId: input.roomId,
    challengeId: input.challengeId,
    generationId: plan.generationId,
    claimToken: claimed.claimToken,
    triggers: [...active.triggers],
    projection: input.projection,
    systemActorId: CONVERGENCE_SYSTEM_ACTOR_ID,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  // Re-read terminal halt — platform stop may have raced the Reviewer.
  store = requireConvergenceStore(file);
  if (store.terminalHalt) {
    return {
      ok: false,
      reason: "room_terminal_halt",
      recoverable: true,
      generationId: plan.generationId,
      store,
    };
  }
  if (input.signal?.aborted) {
    return {
      ok: false,
      reason: "aborted",
      recoverable: true,
      generationId: plan.generationId,
      store,
    };
  }

  if (!reviewerResult.ok) {
    if (reviewerResult.reason === "aborted" || reviewerResult.reason === "lead_session_still_active") {
      return {
        ok: false,
        reason: `reviewer_failed:${reviewerResult.reason}`,
        recoverable: true,
        generationId: plan.generationId,
        store,
      };
    }
    const settled = persistInvalidDecisionDelivery(file, store, {
      claimedOutcome: claimed.outcome,
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
    return {
      ok: false,
      reason: `reviewer_failed:${reviewerResult.reason}`,
      recoverable: settled.outcome === "redeliver",
      generationId: plan.generationId,
      store: settled.store,
    };
  }

  let envelope: DecisionEnvelope;
  try {
    envelope = parseDecisionEnvelope(reviewerResult.envelope);
    assertSoloConvergenceActor(envelope.actorMemberId);
    assertSoloConvergenceActions(envelope.actions);
    if (envelope.expectedGeneration !== plan.generationId) {
      throw new Error(
        `expectedGeneration_mismatch: envelope=${envelope.expectedGeneration} active=${plan.generationId}`,
      );
    }
    if (envelope.roomId !== input.roomId || envelope.challengeId !== input.challengeId) {
      throw new Error("envelope_room_identity_mismatch");
    }
  } catch (err) {
    const settled = persistInvalidDecisionDelivery(file, store, {
      claimedOutcome: claimed.outcome,
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      recoverable: settled.outcome === "redeliver",
      generationId: plan.generationId,
      store: settled.store,
    };
  }

  const apply = await applyDecisionEnvelope({
    roomClockDir: input.roomClockDir,
    envelope,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
  if (!apply.ok) {
    return {
      ok: false,
      reason: apply.reason,
      recoverable: true,
      generationId: plan.generationId,
      ...(apply.store ? { store: apply.store } : { store }),
    };
  }

  return {
    ok: true,
    outcome: apply.outcome,
    generationId: apply.generationId,
    decisionId: apply.decisionId,
    store: apply.store,
    apply,
  };
}
