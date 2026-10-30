/**
 * C6 Swarm Convergence Episode — Lead synthesizer (not bypass Reviewer).
 * Allows recruit/remove. Host does not judge routes.
 * After apply, executes deferred resource intents and returns spawn/stop/wake intents for CLI.
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
  claimProcessing,
  writeConvergenceStore,
  convergenceGenerationPath,
  type ConvergenceStore,
} from "./convergence-generation.ts";
import {
  applyDecisionEnvelope,
  parseDecisionEnvelope,
  readDecisionJournal,
  type ApplyDecisionEnvelopeResult,
  type DecisionEnvelope,
  type DecisionAction,
} from "./decision-envelope.ts";
import {
  type ConvergenceReviewer,
  type SoloConvergenceEpisodeResult,
} from "./convergence-episode.ts";
import {
  executeDeferredRoomResourceIntents,
  type ExecuteRoomResourceIntentResult,
  type RoomRecruitSpawnRequest,
  type RoomRemoveStopRequest,
} from "./room-resource-exec.ts";
import {
  consumeOfficialTeamRemovePermit,
  grantOfficialTeamPermits,
  officialTeamFollowUp,
} from "./official-team-c3.ts";
import {
  exhaustedDecisionNeedsNoop,
} from "./official-team-recovery.ts";
import type { RoomProjectionChallengeInfo } from "./room-projection.ts";

export const SWARM_LEAD_MEMBER_ID = "lead" as const;

export type SwarmConvergenceEpisodeInput = {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  projection: RoomProjectionChallengeInfo;
  /** Lead synthesizer — usually wakes the Lead DSH session; tests inject scripted. */
  synthesizer: ConvergenceReviewer;
  maxMembers: number;
  leadMemberId?: string;
  claimToken?: string;
  nowMs?: number;
  signal?: AbortSignal;
  /** Experimental path: C3 recruit/remove become D2 permits. No independent-root spawns. */
  officialTeam?: boolean;
};

export type SwarmConvergenceEpisodeResult =
  | {
      ok: true;
      outcome: "applied" | "already_applied" | "idle";
      generationId?: number;
      decisionId?: string;
      spawnMembers: RoomRecruitSpawnRequest[];
      stopMembers: RoomRemoveStopRequest[];
      resourceResults: ExecuteRoomResourceIntentResult[];
      store: ConvergenceStore;
      apply?: ApplyDecisionEnvelopeResult;
      officialFollowUp?: string;
    }
  | {
      ok: false;
      reason: string;
      recoverable: boolean;
      generationId?: number;
      decisionId?: string;
      store?: ConvergenceStore;
    };

export function assertSwarmConvergenceActor(actorMemberId: string, leadMemberId: string): void {
  if (actorMemberId !== leadMemberId) {
    throw new Error(
      `swarm_convergence_actor_must_be_lead: expected=${leadMemberId} got=${actorMemberId}`,
    );
  }
}

export function assertSwarmConvergenceActions(actions: readonly DecisionAction[]): void {
  for (const action of actions) {
    if (action.type === "recruit" && action.role === "lead") {
      throw new Error("swarm_convergence_refuses_recruit_lead");
    }
  }
}

/**
 * Run one swarm Convergence Episode for the active generation plan.
 * recruit/remove are executed after C3 apply (roster bind / refuse); CLI must spawn/stop DSH.
 */
export async function runSwarmConvergenceEpisode(
  input: SwarmConvergenceEpisodeInput,
): Promise<SwarmConvergenceEpisodeResult> {
  const leadMemberId = input.leadMemberId ?? SWARM_LEAD_MEMBER_ID;
  const file = convergenceGenerationPath(input.roomClockDir, input.challengeId);
  if (!fs.existsSync(file)) {
    return { ok: false, reason: "convergence_ledger_missing", recoverable: true };
  }

  let store = requireConvergenceStore(file);
  if (store.terminalHalt) {
    return { ok: false, reason: "room_terminal_halt", recoverable: true, store };
  }
  if (input.signal?.aborted) {
    return { ok: false, reason: "aborted", recoverable: true, store };
  }

  let plan = restoreConvergencePlan(store);
  if (plan.kind === "flush_pending_next") {
    const flushed = await flushRoomPendingNext({
      roomClockDir: input.roomClockDir,
      roomId: input.roomId,
      challengeId: input.challengeId,
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
    if (!flushed.ok) {
      return { ok: false, reason: flushed.reason, recoverable: true, store: flushed.store };
    }
    store = flushed.store;
    if (flushed.outcome === "idle") {
      return {
        ok: true,
        outcome: "idle",
        spawnMembers: [],
        stopMembers: [],
        resourceResults: [],
        store,
      };
    }
    plan = restoreConvergencePlan(store);
  }

  if (platformVerdictAckable(store)) {
    return settlePlatformVerdictAck(input, store);
  }
  if (exhaustedDecisionNeedsNoop(store)) {
    return settleExhaustedDecisionNoop(input, store);
  }

  if (plan.kind === "idle" || plan.kind === "flush_pending_next") {
    if (plan.kind === "flush_pending_next") {
      return { ok: false, reason: "flush_pending_next_unresolved", recoverable: true, store };
    }
    if (platformVerdictAckable(store)) {
      return settlePlatformVerdictAck(input, store);
    }
    return {
      ok: true,
      outcome: "idle",
      spawnMembers: [],
      stopMembers: [],
      resourceResults: [],
      store,
    };
  }

  if (plan.kind === "deliver" && platformVerdictAckable(store, "repeat_rejected")) {
    return settlePlatformVerdictAck(input, store);
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
    const resources = await settleResources(input, apply, journal.envelope);
    return {
      ok: true,
      outcome: apply.outcome,
      generationId: apply.generationId,
      decisionId: apply.decisionId,
      spawnMembers: resources.spawns,
      stopMembers: resources.stops,
      resourceResults: resources.results,
      store: apply.store,
      apply,
      ...(resources.followUp ? { officialFollowUp: resources.followUp } : {}),
    };
  }

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

  const synth = await input.synthesizer.synthesize({
    roomId: input.roomId,
    challengeId: input.challengeId,
    generationId: plan.generationId,
    claimToken: claimed.claimToken,
    triggers: [...active.triggers],
    projection: input.projection,
    systemActorId: leadMemberId,
    ...(input.signal ? { signal: input.signal } : {}),
  });

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
  if (!synth.ok) {
    if (synth.reason === "aborted") {
      return {
        ok: false,
        reason: `synthesizer_failed:${synth.reason}`,
        recoverable: true,
        generationId: plan.generationId,
        store,
      };
    }
    const settled = persistInvalidDecisionDelivery(file, store, {
      claimedOutcome: claimed.outcome,
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
    if (platformVerdictAckable(settled.store, synth.reason)) {
      return settlePlatformVerdictAck(input, settled.store);
    }
    return {
      ok: false,
      reason: `synthesizer_failed:${synth.reason}`,
      recoverable: settled.outcome === "redeliver",
      generationId: plan.generationId,
      store: settled.store,
    };
  }

  let envelope: DecisionEnvelope;
  try {
    envelope = parseDecisionEnvelope(synth.envelope);
    assertSwarmConvergenceActor(envelope.actorMemberId, leadMemberId);
    assertSwarmConvergenceActions(envelope.actions);
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
    if (platformVerdictAckable(settled.store, "invalid_envelope")) {
      return settlePlatformVerdictAck(input, settled.store);
    }
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
    let failed = apply.store ?? requireConvergenceStore(file);
    if (failed.active?.state === "processing" && failed.active.generationId === plan.generationId) {
      failed = persistInvalidDecisionDelivery(file, failed, {
        claimedOutcome: claimed.outcome,
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      }).store;
    }
    return {
      ok: false,
      reason: apply.reason,
      recoverable: true,
      generationId: plan.generationId,
      store: failed,
    };
  }

  const resources = await settleResources(input, apply, envelope);
  return {
    ok: true,
    outcome: apply.outcome,
    generationId: apply.generationId,
    decisionId: apply.decisionId,
    spawnMembers: resources.spawns,
    stopMembers: resources.stops,
    resourceResults: resources.results,
    store: apply.store,
    apply,
    ...(resources.followUp ? { officialFollowUp: resources.followUp } : {}),
  };
}

function platformVerdictTriggers(store: ConvergenceStore): boolean {
  const active = store.active;
  if (!active) return false;
  if (active.state !== "pending" && active.state !== "processing") return false;
  return active.triggers.some((row) => row.kind === "platform_verdict_changed");
}

function platformVerdictAckable(store: ConvergenceStore, reason?: string): boolean {
  if (!platformVerdictTriggers(store)) return false;
  const active = store.active!;
  if (active.decisionRedeliveryExhausted) return true;
  if (reason === "lead_session_still_active") return true;
  if (reason === "repeat_rejected") {
    return store.pendingNextTriggers.some((row) => row.kind === "platform_verdict_changed");
  }
  return false;
}

async function settlePlatformVerdictAck(
  input: SwarmConvergenceEpisodeInput,
  store: ConvergenceStore,
): Promise<SwarmConvergenceEpisodeResult> {
  const apply = await applyPlatformVerdictAck(input, store);
  if (!apply.ok) {
    return {
      ok: false,
      reason: apply.reason,
      recoverable: true,
      ...(store.active ? { generationId: store.active.generationId } : {}),
      ...(apply.store ? { store: apply.store } : { store }),
    };
  }
  return {
    ok: true,
    outcome: apply.outcome,
    generationId: apply.generationId,
    decisionId: apply.decisionId,
    spawnMembers: [],
    stopMembers: [],
    resourceResults: [],
    store: apply.store,
    apply,
  };
}

/** The Lead already failed the one allowed redelivery. Close the generation with empty actions so the room is not parked until the deadline. */
async function settleExhaustedDecisionNoop(
  input: SwarmConvergenceEpisodeInput,
  store: ConvergenceStore,
): Promise<SwarmConvergenceEpisodeResult> {
  const apply = await applyPlatformVerdictAck(input, store, {
    decisionId: `exhausted_noop:g${store.active?.generationId ?? 0}`,
    claimToken: input.claimToken ?? "exhausted-noop",
    rationale: "Lead did not submit after the allowed redelivery; empty actions, room continues",
  });
  if (!apply.ok) {
    return {
      ok: false,
      reason: apply.reason,
      recoverable: false,
      ...(store.active ? { generationId: store.active.generationId } : {}),
      ...(apply.store ? { store: apply.store } : { store }),
    };
  }
  return {
    ok: true,
    outcome: apply.outcome,
    generationId: apply.generationId,
    decisionId: apply.decisionId,
    spawnMembers: [],
    stopMembers: [],
    resourceResults: [],
    store: apply.store,
    apply,
  };
}

async function applyPlatformVerdictAck(
  input: SwarmConvergenceEpisodeInput,
  store: ConvergenceStore,
  override?: { decisionId: string; claimToken: string; rationale: string },
): Promise<ApplyDecisionEnvelopeResult> {
  const active = store.active;
  if (!active) return { ok: false, reason: "generation_missing" };
  const file = convergenceGenerationPath(input.roomClockDir, input.challengeId);
  if (active.state === "pending") {
    const claimed = claimProcessing(
      store,
      { generationId: active.generationId, claimToken: override?.claimToken ?? input.claimToken ?? "platform-verdict-ack" },
      input.nowMs,
    );
    if (!claimed.ok) return { ok: false, reason: claimed.reason, store: claimed.store };
    writeConvergenceStore(file, claimed.store);
  }
  return applyDecisionEnvelope({
    roomClockDir: input.roomClockDir,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    envelope: parseDecisionEnvelope({
      schema: "silver.decision-envelope.v1",
      decisionId: override?.decisionId ?? `platform_verdict_ack:g${active.generationId}`,
      expectedGeneration: active.generationId,
      roomId: input.roomId,
      challengeId: input.challengeId,
      actorMemberId: input.leadMemberId ?? SWARM_LEAD_MEMBER_ID,
      rationale: override?.rationale ?? "acknowledge platform verdict; no roster change",
      evidence: [],
      actions: [],
      createdAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    }),
  });
}

async function settleResources(
  input: SwarmConvergenceEpisodeInput,
  apply: ApplyDecisionEnvelopeResult,
  envelope: DecisionEnvelope,
): Promise<{
  results: ExecuteRoomResourceIntentResult[];
  spawns: RoomRecruitSpawnRequest[];
  stops: RoomRemoveStopRequest[];
  followUp?: string;
}> {
  if (!apply.ok) return { results: [], spawns: [], stops: [] };
  if (input.officialTeam) {
    const granted = await grantOfficialTeamPermits({
      roomClockDir: input.roomClockDir,
      roomId: input.roomId,
      challengeId: input.challengeId,
      maxMembers: input.maxMembers,
      envelope,
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    });
    const spawns = granted.permits
      .filter((row) => row.kind === "recruit" && row.status === "granted")
      .map((row) => ({ spawnName: row.spawnName, permitId: row.permitId }));
    const interrupts: Array<{ spawnName: string }> = [];
    for (const row of granted.permits) {
      if (row.kind !== "remove" || row.status !== "granted") continue;
      const consumed = await consumeOfficialTeamRemovePermit({
        roomClockDir: input.roomClockDir,
        roomId: input.roomId,
        challengeId: input.challengeId,
        permitId: row.permitId,
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      });
      interrupts.push({ spawnName: consumed.interrupt.args.target });
    }
    const followUp = officialTeamFollowUp({ spawns, interrupts });
    return { results: [], spawns: [], stops: [], ...(followUp ? { followUp } : {}) };
  }
  const intentIds = apply.actions
    .filter(
      (row): row is Extract<(typeof apply.actions)[number], { ok: true; type: "recruit" | "remove" }> =>
        row.ok === true && (row.type === "recruit" || row.type === "remove") && typeof row.intentId === "string",
    )
    .map((row) => row.intentId);
  const results = await executeDeferredRoomResourceIntents({
    roomClockDir: input.roomClockDir,
    roomId: input.roomId,
    challengeId: input.challengeId,
    maxMembers: input.maxMembers,
    intentIds,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
  const spawns: RoomRecruitSpawnRequest[] = [];
  const stops: RoomRemoveStopRequest[] = [];
  for (const row of results) {
    if (!row.ok) continue;
    // already_executed still carries spawn binding so a crash between roster append and
    // DSH startAttempt can retry spawn without minting a second memberId.
    if (row.spawn && (row.outcome === "spawn" || row.outcome === "already_executed")) {
      spawns.push(row.spawn);
    }
    if (row.stop && (row.outcome === "stop" || row.outcome === "already_executed")) {
      stops.push(row.stop);
    }
  }
  return { results, spawns, stops };
}

/** Narrow SoloConvergenceEpisodeResult-compatible failure for shared callers. */
export type SwarmOrSoloFailure = Extract<SoloConvergenceEpisodeResult, { ok: false }>;
