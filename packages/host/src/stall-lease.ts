/**
 * Official Team stall lease — durable quiet-room clock.
 *
 * Same family as the Room deadline timer and candidate-review-hold:
 * persist nextReviewAt, arm one setTimeout, mint one stall_boundary per
 * quiet generation, then re-arm the next backoff until cancel. Not a
 * Supervisor, Reviewer, scheduler, or agent loop.
 *
 * Resume must keep the original nextReviewAt. Never recompute
 * nextReviewAt = now + fullWindow on startup (that "续命" bug turns a
 * 10-minute stall into infinite delay). A snapshot left by the old
 * one-shot lease (status emitted, lastEmittedGeneration === generation)
 * promotes the next generation and keeps that nextReviewAt.
 */
import fs from "node:fs";
import path from "node:path";
import {
  armQuietRoomWakeHandoff,
  dropUndeliveredQuietWake,
  markQuietRoomWakeDelivered,
  quietRoomWakePath,
  readQuietRoomWakeEventId,
  restorePersistedStallWake,
  writeQuietRoomWakeFile,
  QUIET_ROOM_WAKE_FILE,
} from "../../ctf-spine/src/quiet-room-wake.ts";
import type { ConvergenceTrigger } from "./convergence-generation.ts";

export {
  armQuietRoomWakeHandoff,
  dropUndeliveredQuietWake,
  markQuietRoomWakeDelivered,
  quietRoomWakePath,
  readQuietRoomWakeEventId,
  restorePersistedStallWake,
  QUIET_ROOM_WAKE_FILE,
};

export const STALL_LEASE_SCHEMA = "silver.stall-lease.v1" as const;
export const STALL_LEASE_INITIAL_MS = 10 * 60 * 1000;
export const STALL_LEASE_BACKOFF_CAP = 4;
/** In-process retry after onNote throws. Same generation and event id. Not a tight loop. */
export const STALL_LEASE_NOTE_RETRY_CAP_MS = 30_000;

export const STALL_PROGRESS_KINDS = ["candidate", "intel", "worker_result"] as const;
export type StallProgressKind = (typeof STALL_PROGRESS_KINDS)[number];

export type StallLeaseStatus = "armed" | "emitted" | "cancelled";

export type StallLeaseSnapshot = {
  schema: typeof STALL_LEASE_SCHEMA;
  lastProgressAt: number;
  nextReviewAt: number;
  lastEmittedGeneration: number;
  backoffLevel: number;
  generation: number;
  status: StallLeaseStatus;
  /** Stall wakes since the last candidate. Absent on older files means zero. */
  stallsSinceCandidate?: number;
};

export type StallLeaseFireResult = {
  trigger: ConvergenceTrigger;
  wakeLead: true;
  /** 1 on the first stall since a candidate. 2+ is the named reconciliation. */
  stallsSinceCandidate: number;
};

export type StallLeaseOptions = {
  challengeId: string;
  roomClockDir: string;
  /** Default 10 minutes. Tests inject a short window. */
  initialWindowMs?: number;
  nowMs?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /**
   * Awaited before the emission receipt is persisted. CLI notes C2 and
   * rejects when the note throws or returns not-ok. A resolved
   * ignored_duplicate is success. Wake Lead only after this succeeds.
   */
  onNote?: (result: StallLeaseFireResult) => Promise<void>;
};

export type StallLease = {
  snapshot: () => StallLeaseSnapshot;
  noteProgress: (kind: string, progressAt?: number) => StallLeaseSnapshot;
  cancel: () => StallLeaseSnapshot;
  dispose: () => void;
};

const STATUSES = new Set<StallLeaseStatus>(["armed", "emitted", "cancelled"]);

export function isStallProgress(kind: string): kind is StallProgressKind {
  return (STALL_PROGRESS_KINDS as readonly string[]).includes(kind);
}

export function stallBoundaryEventId(challengeId: string, generation: number): string {
  return `stall_boundary:${challengeId}:g${generation}`;
}

export function stallBackoffWindowMs(initialWindowMs: number, backoffLevel: number): number {
  const level = Math.min(Math.max(0, backoffLevel), STALL_LEASE_BACKOFF_CAP);
  return initialWindowMs * 2 ** level;
}

/** Positive delay, capped so a failing note cannot spin. Does not change the quiet window. */
export function stallNoteRetryDelayMs(initialWindowMs: number): number {
  const windowMs = Number.isFinite(initialWindowMs) && initialWindowMs > 0 ? initialWindowMs : STALL_LEASE_NOTE_RETRY_CAP_MS;
  return Math.min(windowMs, STALL_LEASE_NOTE_RETRY_CAP_MS);
}

export function stallLeasePath(roomClockDir: string, challengeId: string): string {
  const safe = challengeId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(roomClockDir, `stall-lease-${safe}.json`);
}

/** Busy Lead: leave the wake file for later delivery. Terminal room: do not deliver. */
export function quietLeadDeliveryPlan(input: {
  prompting: boolean;
  terminal: boolean;
  wakePresent: boolean;
}): "defer" | "drop" | "deliver" {
  if (input.terminal) return "drop";
  if (input.prompting) return "defer";
  if (!input.wakePresent) return "drop";
  return "deliver";
}

export function clearQuietRoomWake(roomClockDir: string): void {
  try {
    fs.rmSync(quietRoomWakePath(roomClockDir), { force: true });
  } catch {
    /* already gone */
  }
}

/** A later stall overwrites the pending wake. Delivery of an emitted generation is replayed from the lease, not by minting another one. */
export function writeQuietRoomWake(
  roomClockDir: string,
  eventId: string,
  stallsSinceCandidate?: number,
): void {
  writeQuietRoomWakeFile(roomClockDir, eventId, stallsSinceCandidate);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStallLeaseSnapshot(value: unknown): value is StallLeaseSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.schema !== STALL_LEASE_SCHEMA) return false;
  if (!isNonNegativeInt(row.lastProgressAt) || !isNonNegativeInt(row.nextReviewAt)) return false;
  if (!isNonNegativeInt(row.lastEmittedGeneration) || !isNonNegativeInt(row.backoffLevel)) return false;
  if (!isNonNegativeInt(row.generation)) return false;
  if (typeof row.status !== "string" || !STATUSES.has(row.status as StallLeaseStatus)) return false;
  if (row.lastEmittedGeneration > row.generation) return false;
  if (row.stallsSinceCandidate !== undefined && !isNonNegativeInt(row.stallsSinceCandidate)) return false;
  return true;
}

function failClosed(file: string, detail: string): never {
  throw new Error(`stall lease ${detail}: ${file}; fail closed`);
}

/**
 * Missing file: first start (caller initializes).
 * File exists but JSON/schema/timestamps/generation/backoff are illegal: THROW.
 * Never silently reset to now+window.
 */
export function readStallLeaseSnapshot(roomClockDir: string, challengeId: string): StallLeaseSnapshot | undefined {
  const file = stallLeasePath(roomClockDir, challengeId);
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    failClosed(file, `unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isStallLeaseSnapshot(parsed)) {
    failClosed(file, "schema mismatch");
  }
  return parsed;
}

export function writeStallLeaseSnapshot(
  roomClockDir: string,
  challengeId: string,
  snapshot: StallLeaseSnapshot,
): void {
  const file = stallLeasePath(roomClockDir, challengeId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function noteStallProgress(
  lease: StallLease | undefined,
  kind: string,
  progressAt?: number,
): StallLeaseSnapshot | undefined {
  if (!lease || !isStallProgress(kind)) return lease?.snapshot();
  return lease.noteProgress(kind, progressAt);
}

export function cancelStallLease(lease: StallLease | undefined): void {
  lease?.cancel();
}

export function stallLeaseInitialMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallback = STALL_LEASE_INITIAL_MS,
): number {
  const raw = env.SILVER_STALL_LEASE_MS?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function createStallLease(options: StallLeaseOptions): StallLease {
  const initialWindowMs = options.initialWindowMs ?? STALL_LEASE_INITIAL_MS;
  const nowFn = options.nowMs ?? Date.now;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const { challengeId, roomClockDir } = options;

  let lastProgressAt: number;
  let nextReviewAt: number;
  let lastEmittedGeneration: number;
  let backoffLevel: number;
  let generation: number;
  let status: StallLeaseStatus;
  let stallsSinceCandidate: number;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;

  const snapshot = (): StallLeaseSnapshot => ({
    schema: STALL_LEASE_SCHEMA,
    lastProgressAt,
    nextReviewAt,
    lastEmittedGeneration,
    backoffLevel,
    generation,
    status,
    stallsSinceCandidate,
  });

  const persist = (): void => {
    writeStallLeaseSnapshot(roomClockDir, challengeId, snapshot());
  };

  const clearTimer = (): void => {
    if (leaseTimer !== undefined) {
      clearTimeoutFn(leaseTimer);
      leaseTimer = undefined;
    }
  };

  const armDelay = (delayMs: number): void => {
    clearTimer();
    if (status === "cancelled") return;
    leaseTimer = setTimeoutFn(() => {
      leaseTimer = undefined;
      fire();
    }, delayMs);
    const handle = leaseTimer as { unref?: () => unknown };
    if (typeof handle.unref === "function") handle.unref();
  };

  const persistEmittedReceipt = (firedAt: number, firedGeneration: number): void => {
    // Terminal cancel wins over a late successful note. Do not overwrite
    // a cancelled snapshot back to emitted.
    if (status === "cancelled") return;
    if (generation !== firedGeneration) return;
    if (lastEmittedGeneration >= firedGeneration) return;
    lastEmittedGeneration = firedGeneration;
    stallsSinceCandidate += 1;
    backoffLevel += 1;
    generation = firedGeneration + 1;
    nextReviewAt = firedAt + stallBackoffWindowMs(initialWindowMs, backoffLevel);
    status = "armed";
    persist();
    armToPersistedNextReviewAt();
  };

  const emitOnce = (firedAt: number): void => {
    if (status === "cancelled") return;
    if (lastEmittedGeneration >= generation) return;
    const firedGeneration = generation;
    const result: StallLeaseFireResult = {
      trigger: {
        eventId: stallBoundaryEventId(challengeId, firedGeneration),
        kind: "stall_boundary",
        at: new Date(firedAt).toISOString(),
        subjectRef: challengeId,
        version: `g${firedGeneration}`,
      },
      wakeLead: true,
      stallsSinceCandidate: stallsSinceCandidate + 1,
    };
    // Do not mutate lastEmittedGeneration / status / backoff before the note
    // settles. A concurrent cancel or resume in this process must not observe
    // a receipt that C2 never accepted. Persist only after onNote resolves.
    void (async () => {
      try {
        await options.onNote?.(result);
      } catch {
        // Failed note: same generation and eventId. Do not advance backoff.
        // The fire already cleared the timer; re-arm a bounded retry in-process.
        // A moved generation (progress) or cancel owns the timer instead.
        if (snapshot().status === "cancelled") return;
        if (generation !== firedGeneration) return;
        if (lastEmittedGeneration >= firedGeneration) return;
        armDelay(stallNoteRetryDelayMs(initialWindowMs));
        return;
      }
      persistEmittedReceipt(firedAt, firedGeneration);
    })();
  };

  const fire = (): void => {
    leaseTimer = undefined;
    if (status === "cancelled") return;
    if (lastEmittedGeneration >= generation) return;
    emitOnce(nowFn());
  };

  const armToPersistedNextReviewAt = (): void => {
    clearTimer();
    if (status === "cancelled") return;
    const remaining = nextReviewAt - nowFn();
    if (remaining > 0) {
      armDelay(remaining);
      return;
    }
    // Overdue: emit once if this generation has not been emitted. Do not grant a
    // fresh full window first. Already-emitted generations stay quiet.
    if (lastEmittedGeneration < generation) {
      emitOnce(nowFn());
    }
  };

  const existing = readStallLeaseSnapshot(roomClockDir, challengeId);
  if (!existing) {
    const now = nowFn();
    lastProgressAt = now;
    nextReviewAt = now + initialWindowMs;
    lastEmittedGeneration = 0;
    backoffLevel = 0;
    generation = 1;
    stallsSinceCandidate = 0;
    status = "armed";
    persist();
  } else {
    lastProgressAt = existing.lastProgressAt;
    nextReviewAt = existing.nextReviewAt;
    lastEmittedGeneration = existing.lastEmittedGeneration;
    backoffLevel = existing.backoffLevel;
    generation = existing.generation;
    stallsSinceCandidate = existing.stallsSinceCandidate ?? 0;
    status = existing.status;
    if (status === "emitted") {
      if (lastEmittedGeneration >= generation) generation = lastEmittedGeneration + 1;
      status = "armed";
      persist();
    }
  }

  if (status !== "cancelled") {
    armToPersistedNextReviewAt();
  }

  return {
    snapshot,
    noteProgress: (kind, progressAt) => {
      if (!isStallProgress(kind) || status === "cancelled") return snapshot();
      const at = progressAt ?? nowFn();
      generation += 1;
      if (kind === "candidate") {
        stallsSinceCandidate = 0;
      }
      backoffLevel = 0;
      lastProgressAt = at;
      nextReviewAt = at + initialWindowMs;
      status = "armed";
      persist();
      dropUndeliveredQuietWake(roomClockDir);
      armToPersistedNextReviewAt();
      return snapshot();
    },
    cancel: () => {
      status = "cancelled";
      clearTimer();
      persist();
      return snapshot();
    },
    dispose: () => {
      clearTimer();
    },
  };
}
