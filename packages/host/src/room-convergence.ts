/**
 * Host → C2 convergence trigger wiring.
 * Durable mint/merge/claim under the Room ledger lock.
 * Does not run synthesizers or apply decision envelopes.
 */
import fs from "node:fs";
import {
  claimProcessing,
  convergenceGenerationPath,
  emptyConvergenceStore,
  flushPendingNextTriggers,
  noteTrigger,
  requireConvergenceStore,
  writeConvergenceStore,
  type ClaimProcessingResult,
  type ConvergenceStore,
  type ConvergenceTrigger,
  type ConvergenceTriggerKind,
  type FlushPendingNextResult,
  type NoteTriggerResult,
} from "./convergence-generation.ts";
import { withRoomLedgerLock } from "./room-ledger-lock.ts";
import { assertRoomAcceptsActivity } from "./room-platform-stop-state.ts";

export type NoteRoomConvergenceTriggerInput = {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  trigger: {
    eventId: string;
    kind: ConvergenceTriggerKind;
    at?: string;
    subjectRef?: string;
    version?: string;
  };
  nowMs?: number;
};

export type ClaimRoomConvergenceInput = {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  generationId: number;
  claimToken?: string;
  nowMs?: number;
};

export type FlushRoomPendingNextInput = {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  nowMs?: number;
};

/**
 * Record a structural Host event into the Room convergence ledger (mint or merge).
 * Refuses when a platform-stop journal is present or the ledger is terminal-halted.
 */
export async function noteRoomConvergenceTrigger(
  input: NoteRoomConvergenceTriggerInput,
): Promise<NoteTriggerResult> {
  const roomKey = `${input.roomId}:${input.challengeId}`;
  return withRoomLedgerLock(roomKey, () => noteRoomConvergenceTriggerUnlocked(input));
}

/**
 * Claim a pending generation for Host-owned processing (no synthesizer yet).
 * While claimed, further triggers queue for the next generation.
 */
export async function claimRoomConvergence(
  input: ClaimRoomConvergenceInput,
): Promise<ClaimProcessingResult> {
  const roomKey = `${input.roomId}:${input.challengeId}`;
  return withRoomLedgerLock(roomKey, () => claimRoomConvergenceUnlocked(input));
}

/**
 * Mint a new pending generation from durable `pendingNextTriggers` when idle.
 * Used by Convergence Episode when restore plan is `flush_pending_next`.
 */
export async function flushRoomPendingNext(
  input: FlushRoomPendingNextInput,
): Promise<FlushPendingNextResult> {
  const roomKey = `${input.roomId}:${input.challengeId}`;
  return withRoomLedgerLock(roomKey, () => flushRoomPendingNextUnlocked(input));
}

function loadOrInitConvergenceStore(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  nowMs?: number;
}): ConvergenceStore {
  const file = convergenceGenerationPath(input.roomClockDir, input.challengeId);
  if (fs.existsSync(file)) {
    return requireConvergenceStore(file);
  }
  return emptyConvergenceStore({
    roomId: input.roomId,
    challengeId: input.challengeId,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
}

function noteRoomConvergenceTriggerUnlocked(input: NoteRoomConvergenceTriggerInput): NoteTriggerResult {
  assertRoomAcceptsActivity({
    roomClockDir: input.roomClockDir,
    challengeId: input.challengeId,
    activity: "convergence_trigger",
  });
  const file = convergenceGenerationPath(input.roomClockDir, input.challengeId);
  const store = loadOrInitConvergenceStore(input);
  if (store.roomId !== input.roomId || store.challengeId !== input.challengeId) {
    return {
      ok: false,
      reason: `room_identity_mismatch: ledger=${store.roomId}/${store.challengeId} expected=${input.roomId}/${input.challengeId}`,
      store,
    };
  }
  const at = input.trigger.at ?? new Date(input.nowMs ?? Date.now()).toISOString();
  const trigger: ConvergenceTrigger = {
    eventId: input.trigger.eventId,
    kind: input.trigger.kind,
    at,
    ...(input.trigger.subjectRef ? { subjectRef: input.trigger.subjectRef } : {}),
    ...(input.trigger.version ? { version: input.trigger.version } : {}),
  };
  const result = noteTrigger(store, trigger, input.nowMs);
  if (result.ok) writeConvergenceStore(file, result.store);
  return result;
}

function claimRoomConvergenceUnlocked(input: ClaimRoomConvergenceInput): ClaimProcessingResult {
  assertRoomAcceptsActivity({
    roomClockDir: input.roomClockDir,
    challengeId: input.challengeId,
    activity: "convergence_claim",
  });
  const file = convergenceGenerationPath(input.roomClockDir, input.challengeId);
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      reason: "convergence ledger missing",
      store: emptyConvergenceStore({
        roomId: input.roomId,
        challengeId: input.challengeId,
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      }),
    };
  }
  const store = requireConvergenceStore(file);
  if (store.roomId !== input.roomId || store.challengeId !== input.challengeId) {
    return {
      ok: false,
      reason: `room_identity_mismatch: ledger=${store.roomId}/${store.challengeId} expected=${input.roomId}/${input.challengeId}`,
      store,
    };
  }
  const result = claimProcessing(
    store,
    {
      generationId: input.generationId,
      ...(input.claimToken ? { claimToken: input.claimToken } : {}),
    },
    input.nowMs,
  );
  if (result.ok) writeConvergenceStore(file, result.store);
  return result;
}

function flushRoomPendingNextUnlocked(input: FlushRoomPendingNextInput): FlushPendingNextResult {
  assertRoomAcceptsActivity({
    roomClockDir: input.roomClockDir,
    challengeId: input.challengeId,
    activity: "convergence_trigger",
  });
  const file = convergenceGenerationPath(input.roomClockDir, input.challengeId);
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      reason: "convergence ledger missing",
      store: emptyConvergenceStore({
        roomId: input.roomId,
        challengeId: input.challengeId,
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      }),
    };
  }
  const store = requireConvergenceStore(file);
  if (store.roomId !== input.roomId || store.challengeId !== input.challengeId) {
    return {
      ok: false,
      reason: `room_identity_mismatch: ledger=${store.roomId}/${store.challengeId} expected=${input.roomId}/${input.challengeId}`,
      store,
    };
  }
  const result = flushPendingNextTriggers(store, input.nowMs);
  if (result.ok && result.outcome === "minted") writeConvergenceStore(file, result.store);
  return result;
}
