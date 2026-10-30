/**
 * Convergence generation ledger (Slice C2).
 * Host-owned durable state machine: pending → processing → decided → applied.
 * Merges structural triggers, claim/confirm/apply with idempotency, crash replay.
 * Not a judgment model, Reviewer, recruiter, scheduler, or decision-envelope router (C3).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CONVERGENCE_GENERATION_SCHEMA = "silver.convergence-generation.v1" as const;

export type ConvergenceState = "pending" | "processing" | "decided" | "applied";

export type ConvergenceTriggerKind =
  | "member_turn_ended"
  | "member_help_requested"
  | "intel_changed"
  | "candidate_changed"
  | "platform_verdict_changed"
  | "deadline_boundary"
  | "stall_boundary"
  | "bootstrap_ready"
  | "review_changed"
  | "evidence_source_exhausted";

export type ConvergenceTrigger = {
  eventId: string;
  kind: ConvergenceTriggerKind;
  at: string;
  subjectRef?: string;
  version?: string;
};

export type ConvergenceAbortReason = "platform_accepted" | "room_closed";

export type ConvergenceGenerationRecord = {
  generationId: number;
  state: ConvergenceState;
  triggers: ConvergenceTrigger[];
  createdAt: string;
  updatedAt: string;
  claimToken?: string;
  claimedAt?: string;
  decisionId?: string;
  decidedAt?: string;
  appliedAt?: string;
  abortReason?: ConvergenceAbortReason;
  /** How many failed decision deliveries have already been granted a retry. 0 or omitted means none; 1 is the only retry. */
  decisionRedeliveries?: 0 | 1;
  /** Set after the one retry is spent. Restore must not synthesize this generation again. */
  decisionRedeliveryExhausted?: true;
};

export type ConvergenceAppliedRecord = {
  generationId: number;
  decisionId: string;
  appliedAt: string;
};

export type ConvergenceStore = {
  schema: typeof CONVERGENCE_GENERATION_SCHEMA;
  roomId: string;
  challengeId: string;
  nextGenerationId: number;
  active?: ConvergenceGenerationRecord;
  pendingNextTriggers: ConvergenceTrigger[];
  /** Durable event identities already absorbed into an applied generation. */
  consumedEventIds: string[];
  /** Applied generation+decision pairs for cross-generation apply idempotency. */
  applied: ConvergenceAppliedRecord[];
  lastAppliedGenerationId?: number;
  recentDecisionIds: string[];
  /** Set by platform-accepted / room-closed abort — refuses further mint/claim/decide. */
  terminalHalt?: {
    reason: ConvergenceAbortReason;
    at: string;
  };
  updatedAt: string;
};

export type ConvergenceRestorePlan =
  | { kind: "idle" }
  | { kind: "deliver"; generationId: number; state: "pending" | "processing"; triggers: ConvergenceTrigger[] }
  | { kind: "reapply"; generationId: number; decisionId: string }
  | { kind: "flush_pending_next"; triggers: ConvergenceTrigger[] };

/** Bounded idempotency window — C3 must not replay unbounded history without a cursor. */
export const CONVERGENCE_RECENT_DECISION_CAP = 8;
export const CONVERGENCE_APPLIED_CAP = 32;
export const CONVERGENCE_CONSUMED_EVENT_CAP = 512;

const RECENT_DECISION_CAP = CONVERGENCE_RECENT_DECISION_CAP;
const APPLIED_CAP = CONVERGENCE_APPLIED_CAP;
const CONSUMED_EVENT_CAP = CONVERGENCE_CONSUMED_EVENT_CAP;
const TRIGGER_KINDS = new Set<ConvergenceTriggerKind>([
  "member_turn_ended",
  "member_help_requested",
  "intel_changed",
  "candidate_changed",
  "platform_verdict_changed",
  "deadline_boundary",
  "stall_boundary",
  "bootstrap_ready",
  "review_changed",
  "evidence_source_exhausted",
]);

export function convergenceGenerationPath(roomClockDir: string, challengeId: string): string {
  const safe = challengeId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(roomClockDir, `convergence-generation-${safe}.json`);
}

export function emptyConvergenceStore(input: {
  roomId: string;
  challengeId: string;
  nowMs?: number;
}): ConvergenceStore {
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  return {
    schema: CONVERGENCE_GENERATION_SCHEMA,
    roomId: input.roomId,
    challengeId: input.challengeId,
    nextGenerationId: 1,
    pendingNextTriggers: [],
    consumedEventIds: [],
    applied: [],
    recentDecisionIds: [],
    updatedAt: now,
  };
}

export function readConvergenceStore(file: string): ConvergenceStore | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isConvergenceStore(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Fail closed: missing or corrupt ledger refuses to continue.
 * Callers must not invent an empty store over a damaged file.
 */
export function requireConvergenceStore(file: string): ConvergenceStore {
  if (!fs.existsSync(file)) {
    throw new Error(`convergence ledger missing: ${file}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`convergence ledger unreadable: ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`convergence ledger corrupt (invalid json): ${file}`);
  }
  if (!isConvergenceStore(parsed)) {
    throw new Error(`convergence ledger corrupt (schema): ${file}`);
  }
  return parsed;
}

export function writeConvergenceStore(file: string, store: ConvergenceStore): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function restoreConvergencePlan(store: ConvergenceStore): ConvergenceRestorePlan {
  const active = store.active;
  if (!active) {
    if (store.pendingNextTriggers.length > 0) {
      return { kind: "flush_pending_next", triggers: [...store.pendingNextTriggers] };
    }
    return { kind: "idle" };
  }
  if (active.decisionRedeliveryExhausted) {
    return { kind: "idle" };
  }
  if (active.state === "pending" || active.state === "processing") {
    return {
      kind: "deliver",
      generationId: active.generationId,
      state: active.state,
      triggers: [...active.triggers],
    };
  }
  if (active.state === "decided" && active.decisionId) {
    return { kind: "reapply", generationId: active.generationId, decisionId: active.decisionId };
  }
  if (active.state === "applied") {
    if (store.pendingNextTriggers.length > 0) {
      return { kind: "flush_pending_next", triggers: [...store.pendingNextTriggers] };
    }
    return { kind: "idle" };
  }
  return { kind: "idle" };
}

export type InvalidDecisionDeliveryOutcome = "redeliver" | "exhausted";

/**
 * A generation left in processing is the one allowed redelivery.
 * Persist the counter before the Lead is asked again so a crash cannot loop.
 */
export function armStuckDecisionRedelivery(
  store: ConvergenceStore,
  claimedOutcome: "claimed" | "already_processing",
  nowMs?: number,
): ConvergenceStore {
  const active = store.active;
  if (!active || active.state !== "processing") return store;
  if (claimedOutcome !== "already_processing") return store;
  if (active.decisionRedeliveryExhausted) return store;
  if ((active.decisionRedeliveries ?? 0) !== 0) return store;
  const now = new Date(nowMs ?? Date.now()).toISOString();
  return {
    ...store,
    updatedAt: now,
    active: { ...active, decisionRedeliveries: 1, updatedAt: now },
  };
}

export function persistStuckDecisionRedelivery(
  file: string,
  store: ConvergenceStore,
  claimedOutcome: "claimed" | "already_processing",
  nowMs?: number,
): ConvergenceStore {
  const armed = armStuckDecisionRedelivery(store, claimedOutcome, nowMs);
  if (armed !== store) writeConvergenceStore(file, armed);
  return armed;
}

/**
 * Invalid envelope or synthesizer failure must not leave the generation in processing.
 * A fresh claim gets one pending retry. A generation that already used that retry, including
 * a stuck processing ledger whose current attempt is the retry, is marked exhausted.
 */
export function settleInvalidDecisionDelivery(
  store: ConvergenceStore,
  input: { claimedOutcome: "claimed" | "already_processing"; nowMs?: number },
): { outcome: InvalidDecisionDeliveryOutcome; store: ConvergenceStore } {
  const active = store.active;
  if (!active || active.state !== "processing") {
    throw new Error("invalid decision delivery requires a processing generation");
  }
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  const used = (active.decisionRedeliveries ?? 0) >= 1 || input.claimedOutcome === "already_processing";
  return {
    outcome: used ? "exhausted" : "redeliver",
    store: {
      ...store,
      updatedAt: now,
      active: pendingAfterInvalidDelivery(active, now, used),
    },
  };
}

function pendingAfterInvalidDelivery(
  active: ConvergenceGenerationRecord,
  now: string,
  exhausted: boolean,
): ConvergenceGenerationRecord {
  return {
    generationId: active.generationId,
    state: "pending",
    triggers: active.triggers,
    createdAt: active.createdAt,
    updatedAt: now,
    decisionRedeliveries: 1,
    ...(exhausted ? { decisionRedeliveryExhausted: true as const } : {}),
    ...(active.decisionId !== undefined ? { decisionId: active.decisionId } : {}),
    ...(active.decidedAt !== undefined ? { decidedAt: active.decidedAt } : {}),
    ...(active.appliedAt !== undefined ? { appliedAt: active.appliedAt } : {}),
    ...(active.abortReason !== undefined ? { abortReason: active.abortReason } : {}),
  };
}

export function persistInvalidDecisionDelivery(
  file: string,
  store: ConvergenceStore,
  input: { claimedOutcome: "claimed" | "already_processing"; nowMs?: number },
): { outcome: InvalidDecisionDeliveryOutcome; store: ConvergenceStore } {
  const settled = settleInvalidDecisionDelivery(store, input);
  writeConvergenceStore(file, settled.store);
  return settled;
}

export type NoteTriggerResult =
  | { ok: true; outcome: "merged" | "minted" | "ignored_duplicate" | "queued_for_next"; store: ConvergenceStore }
  | { ok: false; reason: string; store: ConvergenceStore };

export function noteTrigger(
  store: ConvergenceStore,
  trigger: ConvergenceTrigger,
  nowMs?: number,
): NoteTriggerResult {
  if (store.terminalHalt) {
    return { ok: false, reason: "room_terminal_halt", store };
  }
  if (!trigger.eventId.trim()) {
    return { ok: false, reason: "eventId_required", store };
  }
  if (!TRIGGER_KINDS.has(trigger.kind)) {
    return { ok: false, reason: "unknown_trigger_kind", store };
  }
  const now = new Date(nowMs ?? Date.now()).toISOString();
  const normalized = normalizeTrigger(trigger);

  if (isConsumed(store, normalized.eventId)) {
    return { ok: true, outcome: "ignored_duplicate", store };
  }

  const active = store.active;
  if (active && (active.state === "pending" || active.state === "processing" || active.state === "decided")) {
    if (active.state === "pending") {
      if (active.triggers.some((row) => row.eventId === normalized.eventId)) {
        return { ok: true, outcome: "ignored_duplicate", store };
      }
      const alreadyKicked =
        (active.decisionRedeliveries ?? 0) > 0 ||
        active.decisionRedeliveryExhausted === true ||
        Boolean(active.claimToken);
      if (
        alreadyKicked &&
        normalized.kind === "platform_verdict_changed" &&
        normalized.version === "rejected" &&
        active.triggers.some((row) => row.kind === "platform_verdict_changed")
      ) {
        if (store.pendingNextTriggers.some((row) => row.eventId === normalized.eventId)) {
          return { ok: true, outcome: "ignored_duplicate", store };
        }
        return {
          ok: true,
          outcome: "queued_for_next",
          store: {
            ...store,
            pendingNextTriggers: [...store.pendingNextTriggers, normalized],
            updatedAt: now,
          },
        };
      }
      const nextActive: ConvergenceGenerationRecord = {
        ...active,
        triggers: [...active.triggers, normalized],
        updatedAt: now,
      };
      return {
        ok: true,
        outcome: "merged",
        store: { ...store, active: nextActive, updatedAt: now },
      };
    }
    // processing / decided — do not mutate in-flight generation
    if (
      store.pendingNextTriggers.some((row) => row.eventId === normalized.eventId) ||
      active.triggers.some((row) => row.eventId === normalized.eventId)
    ) {
      return { ok: true, outcome: "ignored_duplicate", store };
    }
    return {
      ok: true,
      outcome: "queued_for_next",
      store: {
        ...store,
        pendingNextTriggers: [...store.pendingNextTriggers, normalized],
        updatedAt: now,
      },
    };
  }

  // idle — mint new pending (flush any queued first; drop already-consumed ids)
  const seeded = uniqueTriggers([...store.pendingNextTriggers, normalized]).filter(
    (row) => !isConsumed(store, row.eventId),
  );
  if (seeded.length === 0) {
    return {
      ok: true,
      outcome: "ignored_duplicate",
      store: { ...store, pendingNextTriggers: [], updatedAt: now },
    };
  }
  const generationId = store.nextGenerationId;
  const record: ConvergenceGenerationRecord = {
    generationId,
    state: "pending",
    triggers: seeded,
    createdAt: now,
    updatedAt: now,
  };
  return {
    ok: true,
    outcome: "minted",
    store: withoutActive(store, {
      nextGenerationId: generationId + 1,
      active: record,
      pendingNextTriggers: [],
      updatedAt: now,
    }),
  };
}

export type ClaimProcessingResult =
  | { ok: true; outcome: "claimed" | "already_processing"; store: ConvergenceStore; claimToken: string }
  | { ok: false; reason: string; store: ConvergenceStore };

export function claimProcessing(
  store: ConvergenceStore,
  input: { generationId: number; claimToken?: string },
  nowMs?: number,
): ClaimProcessingResult {
  if (store.terminalHalt) {
    return { ok: false, reason: "room_terminal_halt", store };
  }
  const active = store.active;
  if (!active || active.generationId !== input.generationId) {
    return { ok: false, reason: "generation_mismatch", store };
  }
  const now = new Date(nowMs ?? Date.now()).toISOString();
  if (active.state === "processing") {
    const claimToken = active.claimToken ?? input.claimToken ?? randomUUID();
    return {
      ok: true,
      outcome: "already_processing",
      claimToken,
      store: active.claimToken
        ? store
        : {
            ...store,
            active: { ...active, claimToken, claimedAt: active.claimedAt ?? now, updatedAt: now },
            updatedAt: now,
          },
    };
  }
  if (active.state !== "pending") {
    return { ok: false, reason: `invalid_state_${active.state}`, store };
  }
  const claimToken = input.claimToken?.trim() || randomUUID();
  const next: ConvergenceGenerationRecord = {
    ...active,
    state: "processing",
    claimToken,
    claimedAt: now,
    updatedAt: now,
  };
  return {
    ok: true,
    outcome: "claimed",
    claimToken,
    store: { ...store, active: next, updatedAt: now },
  };
}

export type ConfirmDecidedResult =
  | { ok: true; outcome: "decided" | "already_decided"; store: ConvergenceStore }
  | { ok: false; reason: string; store: ConvergenceStore };

export function confirmDecided(
  store: ConvergenceStore,
  input: { expectedGeneration: number; decisionId: string },
  nowMs?: number,
): ConfirmDecidedResult {
  if (store.terminalHalt) {
    return { ok: false, reason: "room_terminal_halt", store };
  }
  const decisionId = input.decisionId.trim();
  if (!decisionId) return { ok: false, reason: "decisionId_required", store };
  const active = store.active;
  if (!active || active.generationId !== input.expectedGeneration) {
    return { ok: false, reason: "generation_mismatch", store };
  }
  const now = new Date(nowMs ?? Date.now()).toISOString();
  if (active.state === "decided") {
    if (active.decisionId === decisionId) {
      return { ok: true, outcome: "already_decided", store };
    }
    return { ok: false, reason: "decision_conflict", store };
  }
  if (active.state !== "processing") {
    return { ok: false, reason: `invalid_state_${active.state}`, store };
  }
  const next: ConvergenceGenerationRecord = {
    ...active,
    state: "decided",
    decisionId,
    decidedAt: now,
    updatedAt: now,
  };
  return {
    ok: true,
    outcome: "decided",
    store: {
      ...store,
      active: next,
      recentDecisionIds: pushRecent(store.recentDecisionIds, decisionId, RECENT_DECISION_CAP),
      updatedAt: now,
    },
  };
}

export type MarkAppliedResult =
  | { ok: true; outcome: "applied" | "already_applied"; store: ConvergenceStore }
  | { ok: false; reason: string; store: ConvergenceStore };

export function markApplied(
  store: ConvergenceStore,
  input: { generationId: number; decisionId: string },
  nowMs?: number,
): MarkAppliedResult {
  const decisionId = input.decisionId.trim();
  if (!decisionId) return { ok: false, reason: "decisionId_required", store };
  const active = store.active;
  const now = new Date(nowMs ?? Date.now()).toISOString();

  // Cross-generation idempotency: prior apply records win even if a newer gen is active.
  const prior = store.applied.find((row) => row.generationId === input.generationId);
  if (prior) {
    if (prior.decisionId === decisionId) {
      return { ok: true, outcome: "already_applied", store };
    }
    return { ok: false, reason: "decision_conflict", store };
  }

  if (!active || active.generationId !== input.generationId) {
    return { ok: false, reason: "generation_mismatch", store };
  }
  if (active.state === "applied") {
    if (active.decisionId === decisionId) {
      return { ok: true, outcome: "already_applied", store };
    }
    return { ok: false, reason: "decision_conflict", store };
  }
  if (active.state !== "decided") {
    return { ok: false, reason: `invalid_state_${active.state}`, store };
  }
  if (active.decisionId !== decisionId) {
    return { ok: false, reason: "decision_mismatch", store };
  }

  const consumedEventIds = pushRecent(
    store.consumedEventIds,
    active.triggers.map((row) => row.eventId),
    CONSUMED_EVENT_CAP,
  );
  const applied = pushApplied(store.applied, {
    generationId: input.generationId,
    decisionId,
    appliedAt: now,
  });

  let nextStore = withoutActive(store, {
    pendingNextTriggers: [],
    consumedEventIds,
    applied,
    lastAppliedGenerationId: input.generationId,
    recentDecisionIds: pushRecent(store.recentDecisionIds, decisionId, RECENT_DECISION_CAP),
    updatedAt: now,
  });

  const queued = [...store.pendingNextTriggers];
  if (queued.length > 0) {
    const first = noteTrigger(nextStore, queued[0]!, nowMs);
    if (first.ok) {
      nextStore = first.store;
      for (const extra of queued.slice(1)) {
        const merged = noteTrigger(nextStore, extra, nowMs);
        if (merged.ok) nextStore = merged.store;
      }
    }
  }

  return { ok: true, outcome: "applied", store: nextStore };
}

export type AbortConvergenceResult = {
  ok: true;
  outcome: "aborted" | "already_idle";
  store: ConvergenceStore;
};

export type FlushPendingNextResult =
  | { ok: true; outcome: "minted" | "idle"; store: ConvergenceStore; generationId?: number }
  | { ok: false; reason: string; store: ConvergenceStore };

/**
 * When restore plan is `flush_pending_next`, mint a new pending generation from
 * the durable queue. Clears a residual `active.state="applied"` record (legacy /
 * crash residue) before minting. Any other active state is refused.
 */
export function flushPendingNextTriggers(
  store: ConvergenceStore,
  nowMs?: number,
): FlushPendingNextResult {
  if (store.terminalHalt) {
    return { ok: false, reason: "room_terminal_halt", store };
  }
  let base = store;
  if (store.active) {
    if (store.active.state !== "applied") {
      return { ok: false, reason: "active_generation_present", store };
    }
    // applied + pendingNextTriggers is a legal restore branch: drop residue, then mint.
    base = withoutActive(store, { updatedAt: new Date(nowMs ?? Date.now()).toISOString() });
  }
  const queued = [...base.pendingNextTriggers];
  if (queued.length === 0) {
    return { ok: true, outcome: "idle", store: base };
  }
  const first = queued[0]!;
  const rest = queued.slice(1);
  // Idle mint path seeds from pendingNextTriggers + the noted trigger — start empty.
  let nextStore: ConvergenceStore = { ...base, pendingNextTriggers: [] };
  const firstResult = noteTrigger(nextStore, first, nowMs);
  if (!firstResult.ok) {
    return { ok: false, reason: firstResult.reason, store: firstResult.store };
  }
  nextStore = firstResult.store;
  for (const extra of rest) {
    const merged = noteTrigger(nextStore, extra, nowMs);
    if (!merged.ok) {
      return { ok: false, reason: merged.reason, store: merged.store };
    }
    nextStore = merged.store;
  }
  const generationId = nextStore.active?.generationId;
  if (generationId === undefined) {
    return { ok: false, reason: "flush_did_not_mint", store: nextStore };
  }
  return { ok: true, outcome: "minted", store: nextStore, generationId };
}

/** Platform accepted / room closed — cancel active generation; do not wait for synthesizer. */
export function abortForPlatformAccepted(
  store: ConvergenceStore,
  input?: { reason?: ConvergenceAbortReason; nowMs?: number },
): AbortConvergenceResult {
  const now = new Date(input?.nowMs ?? Date.now()).toISOString();
  const reason = input?.reason ?? "platform_accepted";
  const terminalHalt = store.terminalHalt ?? { reason, at: now };
  if (!store.active && store.pendingNextTriggers.length === 0 && store.terminalHalt) {
    return { ok: true, outcome: "already_idle", store };
  }
  if (!store.active && store.pendingNextTriggers.length === 0) {
    return {
      ok: true,
      outcome: "already_idle",
      store: { ...store, terminalHalt, updatedAt: now },
    };
  }
  return {
    ok: true,
    outcome: "aborted",
    store: withoutActive(store, {
      pendingNextTriggers: [],
      terminalHalt,
      updatedAt: now,
    }),
  };
}

/** Omit optional `active` rather than assigning undefined (exactOptionalPropertyTypes). */
function withoutActive(
  store: ConvergenceStore,
  patch: Omit<Partial<ConvergenceStore>, "active" | "schema" | "roomId" | "challengeId"> & {
    active?: ConvergenceGenerationRecord;
  },
): ConvergenceStore {
  const { active: _drop, ...rest } = store;
  const { active: nextActive, ...restPatch } = patch;
  const next: ConvergenceStore = {
    ...rest,
    ...restPatch,
    schema: store.schema,
    roomId: store.roomId,
    challengeId: store.challengeId,
  };
  if (nextActive) next.active = nextActive;
  return next;
}

function normalizeTrigger(trigger: ConvergenceTrigger): ConvergenceTrigger {
  return {
    eventId: trigger.eventId.trim(),
    kind: trigger.kind,
    at: trigger.at,
    ...(trigger.subjectRef ? { subjectRef: trigger.subjectRef } : {}),
    ...(trigger.version ? { version: trigger.version } : {}),
  };
}

function uniqueTriggers(rows: ConvergenceTrigger[]): ConvergenceTrigger[] {
  const seen = new Set<string>();
  const out: ConvergenceTrigger[] = [];
  for (const row of rows) {
    if (seen.has(row.eventId)) continue;
    seen.add(row.eventId);
    out.push(row);
  }
  return out;
}

function isConsumed(store: ConvergenceStore, eventId: string): boolean {
  return store.consumedEventIds.includes(eventId);
}

function pushRecent(ids: string[], next: string | string[], cap: number): string[] {
  const additions = Array.isArray(next) ? next : [next];
  let out = ids.slice();
  for (const id of additions) {
    out = out.filter((row) => row !== id);
    out.push(id);
  }
  return out.slice(-cap);
}

function pushApplied(
  rows: ConvergenceAppliedRecord[],
  row: ConvergenceAppliedRecord,
): ConvergenceAppliedRecord[] {
  const next = rows.filter((item) => item.generationId !== row.generationId);
  next.push(row);
  return next.slice(-APPLIED_CAP);
}

function isConvergenceStore(value: unknown): value is ConvergenceStore {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.schema !== CONVERGENCE_GENERATION_SCHEMA) return false;
  if (typeof row.roomId !== "string" || typeof row.challengeId !== "string") return false;
  if (!Number.isInteger(row.nextGenerationId) || (row.nextGenerationId as number) < 1) return false;
  if (!Array.isArray(row.pendingNextTriggers)) return false;
  if (!Array.isArray(row.consumedEventIds)) return false;
  if (!Array.isArray(row.applied)) return false;
  if (!Array.isArray(row.recentDecisionIds)) return false;
  if (typeof row.updatedAt !== "string") return false;
  if (row.active !== undefined && !isGenerationRecord(row.active)) return false;
  return true;
}

function isGenerationRecord(value: unknown): value is ConvergenceGenerationRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!Number.isInteger(row.generationId) || (row.generationId as number) < 1) return false;
  if (
    row.state !== "pending" &&
    row.state !== "processing" &&
    row.state !== "decided" &&
    row.state !== "applied"
  ) {
    return false;
  }
  if (!Array.isArray(row.triggers)) return false;
  if (typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") return false;
  if (
    row.decisionRedeliveries !== undefined &&
    row.decisionRedeliveries !== 0 &&
    row.decisionRedeliveries !== 1
  ) {
    return false;
  }
  if (row.decisionRedeliveryExhausted !== undefined && row.decisionRedeliveryExhausted !== true) return false;
  return true;
}
