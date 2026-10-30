/**
 * Decision envelope apply path (Slice C3).
 * Routes recruit/remove actions onto durable resource-intent records.
 *
 * Per-room ledger updates are serialized. Corrupt ledgers/intents fail closed.
 * Side effects are journaled per stable actionId so crash/retry cannot double-apply.
 * Consumed/applied windows are bounded — callers must pass a verified cursor.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDecisionEnvelope as parseSharedDecisionEnvelope } from "@silver/protocol";
import {
  CONVERGENCE_APPLIED_CAP,
  CONVERGENCE_CONSUMED_EVENT_CAP,
  confirmDecided,
  convergenceGenerationPath,
  markApplied,
  requireConvergenceStore,
  writeConvergenceStore,
  type ConvergenceStore,
} from "./convergence-generation.ts";
import type { RoomMemberRole } from "./room-members.ts";
import { assertRoomAcceptsActivity } from "./room-platform-stop-state.ts";
import { withRoomLedgerLock } from "./room-ledger-lock.ts";

export const DECISION_ENVELOPE_SCHEMA = "silver.decision-envelope.v1" as const;
export const DECISION_JOURNAL_SCHEMA = "silver.decision-journal.v1" as const;
export const ROOM_RESOURCE_INTENT_SCHEMA = "silver.room-resource-intent.v1" as const;

/** Re-export window caps so C3 callers cannot invent unbounded replay. */
export {
  CONVERGENCE_APPLIED_CAP,
  CONVERGENCE_CONSUMED_EVENT_CAP,
};

export type DecisionEvidenceRef = {
  kind: "intel" | "artifact" | "candidate" | "platform";
  ref: string;
  version?: string;
};

/** Recorded only — C3 does not create Members / spawn roots. */
export type DecisionRecruitAction = {
  type: "recruit";
  role: RoomMemberRole;
  duty?: string;
  requestId: string;
};

/** Recorded only — C3 does not tear down Members. */
export type DecisionRemoveAction = {
  type: "remove";
  memberId: string;
  requestId: string;
};

export type DecisionAction =
  | DecisionRecruitAction
  | DecisionRemoveAction;

export type DecisionEnvelope = {
  schema: typeof DECISION_ENVELOPE_SCHEMA;
  decisionId: string;
  expectedGeneration: number;
  roomId: string;
  challengeId: string;
  actorMemberId: string;
  rationale?: string;
  evidence: DecisionEvidenceRef[];
  actions: DecisionAction[];
  createdAt: string;
};

export type RoomResourceIntent = {
  schema: typeof ROOM_RESOURCE_INTENT_SCHEMA;
  intentId: string;
  roomId: string;
  challengeId: string;
  kind: "recruit" | "remove";
  requestId: string;
  /** recorded = durable request; executed|refused|failed = Host settled the request. */
  status: "recorded" | "executed" | "refused" | "failed";
  /**
   * deferred = C3 only recorded (pre-C6 / awaiting Host exec).
   * completed|refused = Host settled without inventing a second intent id.
   */
  execution: "deferred" | "completed" | "refused";
  payload: {
    role?: RoomMemberRole;
    duty?: string;
    memberId?: string;
  };
  decisionId: string;
  generationId: number;
  createdAt: string;
  /** Set when recruit completes — stable product identity. */
  boundMemberId?: string;
  boundAttemptId?: string;
  settledAt?: string;
  refuseReason?: string;
  failReason?: string;
};

export type DecisionActionResult =
  | {
      actionId: string;
      type: "recruit" | "remove";
      ok: true;
      intentId: string;
      status: "recorded";
      execution: "deferred";
    }
  | { actionId: string; type: DecisionAction["type"]; ok: false; reason: string };

export type DecisionActionReceipt = {
  actionId: string;
  type: DecisionAction["type"];
  ok: true;
  intentId?: string;
  status?: string;
  execution?: "deferred";
  completedAt: string;
};

export type DecisionJournal = {
  schema: typeof DECISION_JOURNAL_SCHEMA;
  decisionId: string;
  expectedGeneration: number;
  roomId: string;
  challengeId: string;
  envelope: DecisionEnvelope;
  steps: Array<{ actionId: string; action: DecisionAction }>;
  receipts: DecisionActionReceipt[];
  status: "open" | "applied";
  createdAt: string;
  updatedAt: string;
};

export type ApplyDecisionEnvelopeResult =
  | {
      ok: true;
      outcome: "applied" | "already_applied";
      generationId: number;
      decisionId: string;
      actions: DecisionActionResult[];
      store: ConvergenceStore;
    }
  | {
      ok: false;
      reason: string;
      store?: ConvergenceStore;
      actions?: DecisionActionResult[];
    };

/**
 * Cursor for bounded replay. afterEventId must already sit inside consumedEventIds.
 * afterAppliedGenerationId must be ≤ lastApplied and within the retained applied window.
 */
export type ConvergenceReplayCursor = {
  afterEventId?: string;
  afterAppliedGenerationId?: number;
};

export function roomResourceIntentsDir(roomClockDir: string): string {
  return path.join(roomClockDir, "resource-intents");
}

export function roomResourceIntentPath(roomClockDir: string, intentId: string): string {
  return path.join(roomResourceIntentsDir(roomClockDir), `${intentId}.json`);
}

export function decisionJournalsDir(roomClockDir: string): string {
  return path.join(roomClockDir, "decision-journals");
}

export function decisionJournalPath(roomClockDir: string, decisionId: string): string {
  const safe = decisionId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(decisionJournalsDir(roomClockDir), `decision-${safe}.json`);
}

/** Re-export Room ledger lock for callers that already import decision-envelope. */
export { withRoomLedgerLock } from "./room-ledger-lock.ts";

/**
 * Validate a structural event replay batch against the durable bounded windows.
 * `eventIds` is required (may be empty). A non-empty afterEventId must appear in
 * consumedEventIds — arbitrary strings cannot bypass the window.
 */
export function assertReplayWithinBoundedWindow(input: {
  store: ConvergenceStore;
  eventIds: string[];
  cursor?: ConvergenceReplayCursor;
}): void {
  const { store, eventIds, cursor } = input;

  if (cursor?.afterAppliedGenerationId !== undefined) {
    const last = store.lastAppliedGenerationId ?? 0;
    const oldestRetained = Math.max(0, last - CONVERGENCE_APPLIED_CAP);
    if (cursor.afterAppliedGenerationId > last) {
      throw new Error(
        `convergence replay refused: afterAppliedGenerationId=${cursor.afterAppliedGenerationId} is in the future (lastApplied=${last})`,
      );
    }
    if (cursor.afterAppliedGenerationId < oldestRetained) {
      throw new Error(
        `convergence replay refused: afterAppliedGenerationId=${cursor.afterAppliedGenerationId} is older than applied window (oldestRetained=${oldestRetained})`,
      );
    }
  }

  if (cursor?.afterEventId) {
    const cursorIdx = store.consumedEventIds.indexOf(cursor.afterEventId);
    if (cursorIdx < 0) {
      throw new Error(
        `convergence replay refused: afterEventId=${cursor.afterEventId} is not inside consumedEventIds window`,
      );
    }
  }

  if (eventIds.length === 0) return;

  if (!cursor?.afterEventId) {
    if (eventIds.length > CONVERGENCE_CONSUMED_EVENT_CAP) {
      throw new Error(
        `convergence replay refused: ${eventIds.length} events exceed consumedEventIds window (${CONVERGENCE_CONSUMED_EVENT_CAP}); pass a verified afterEventId cursor`,
      );
    }
    if (store.consumedEventIds.length >= CONVERGENCE_CONSUMED_EVENT_CAP) {
      const unknown = eventIds.filter((id) => !store.consumedEventIds.includes(id));
      if (unknown.length > 0) {
        throw new Error(
          `convergence replay refused: consumedEventIds window is full; pass a verified afterEventId cursor before replaying ${unknown.length} unseen event(s)`,
        );
      }
    }
    return;
  }

  // With a verified cursor: refuse events that were already consumed at/before the cursor.
  const cursorIdx = store.consumedEventIds.indexOf(cursor.afterEventId);
  const retainedBeforeOrAt = new Set(store.consumedEventIds.slice(0, cursorIdx + 1));
  const stale = eventIds.filter((id) => retainedBeforeOrAt.has(id));
  if (stale.length > 0) {
    throw new Error(
      `convergence replay refused: ${stale.length} event(s) are at or before afterEventId=${cursor.afterEventId}`,
    );
  }
}

export function parseDecisionEnvelope(raw: unknown): DecisionEnvelope {
  return parseSharedDecisionEnvelope(raw);
}

/** Stable action identity derived from decisionId + index + normalized action body. */
export function deriveActionId(decisionId: string, index: number, action: DecisionAction): string {
  const digest = createHash("sha256").update(stableStringify(action)).digest("hex").slice(0, 12);
  return `${decisionId}:a${index}:${action.type}:${digest}`;
}

/**
 * Apply a decision envelope under the Room ledger lock.
 * Persists decided + per-action receipts before acknowledging applied.
 */
export async function applyDecisionEnvelope(input: {
  roomClockDir: string;
  envelope: DecisionEnvelope | unknown;
  cursor?: ConvergenceReplayCursor;
  nowMs?: number;
}): Promise<ApplyDecisionEnvelopeResult> {
  const envelope = parseDecisionEnvelope(input.envelope);
  const roomKey = `${envelope.roomId}:${envelope.challengeId}`;
  return withRoomLedgerLock(roomKey, () =>
    applyDecisionEnvelopeUnlocked({
      roomClockDir: input.roomClockDir,
      envelope,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    }),
  );
}

function applyDecisionEnvelopeUnlocked(input: {
  roomClockDir: string;
  envelope: DecisionEnvelope;
  cursor?: ConvergenceReplayCursor;
  nowMs?: number;
}): ApplyDecisionEnvelopeResult {
  const { roomClockDir, envelope } = input;
  const file = convergenceGenerationPath(roomClockDir, envelope.challengeId);
  let store: ConvergenceStore;
  try {
    store = requireConvergenceStore(file);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    assertRoomAcceptsActivity({
      roomClockDir,
      challengeId: envelope.challengeId,
      activity: "decision_envelope",
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), store };
  }

  if (store.terminalHalt) {
    return { ok: false, reason: "room_terminal_halt", store };
  }

  if (store.roomId !== envelope.roomId || store.challengeId !== envelope.challengeId) {
    return {
      ok: false,
      reason: `room_identity_mismatch: ledger=${store.roomId}/${store.challengeId} envelope=${envelope.roomId}/${envelope.challengeId}`,
      store,
    };
  }

  try {
    assertReplayWithinBoundedWindow({
      store,
      eventIds: store.active?.triggers.map((row) => row.eventId) ?? [],
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), store };
  }

  const prior = store.applied.find((row) => row.generationId === envelope.expectedGeneration);
  if (prior) {
    if (prior.decisionId === envelope.decisionId) {
      return healAlreadyAppliedJournal({
        roomClockDir,
        envelope,
        store,
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      });
    }
    return { ok: false, reason: "decision_conflict", store };
  }

  let journal = readDecisionJournal(roomClockDir, envelope.decisionId);
  if (journal) {
    try {
      assertJournalMatchesEnvelope(journal, envelope);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err), store };
    }
  } else {
    journal = createDecisionJournal(envelope, input.nowMs);
    writeDecisionJournal(roomClockDir, journal);
  }

  // Resume side effects from the durable journal envelope — never the retry payload.
  const durableEnvelope = journal.envelope;

  const confirmed = confirmDecided(
    store,
    { expectedGeneration: durableEnvelope.expectedGeneration, decisionId: durableEnvelope.decisionId },
    input.nowMs,
  );
  if (!confirmed.ok) {
    return { ok: false, reason: confirmed.reason, store: confirmed.store };
  }
  store = confirmed.store;
  // Persist decided before any side effects so crash mid-actions resumes from decided.
  writeConvergenceStore(file, store);

  const actionResults: DecisionActionResult[] = [];
  for (const step of journal.steps) {
    const existing = journal.receipts.find((row) => row.actionId === step.actionId);
    if (existing) {
      actionResults.push(receiptToResult(existing));
      continue;
    }
    try {
      const result = applyOneAction({
        roomClockDir,
        envelope: durableEnvelope,
        action: step.action,
        actionId: step.actionId,
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      });
      actionResults.push(result);
      if (!result.ok) {
        return {
          ok: false,
          reason: `action_${step.action.type}_failed`,
          store,
          actions: actionResults,
        };
      }
      journal = appendReceipt(journal, resultToReceipt(result, input.nowMs));
      writeDecisionJournal(roomClockDir, journal);
    } catch (err) {
      actionResults.push({
        actionId: step.actionId,
        type: step.action.type,
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        reason: `action_${step.action.type}_failed`,
        store,
        actions: actionResults,
      };
    }
  }

  const applied = markApplied(
    store,
    { generationId: durableEnvelope.expectedGeneration, decisionId: durableEnvelope.decisionId },
    input.nowMs,
  );
  if (!applied.ok) {
    return { ok: false, reason: applied.reason, store: applied.store, actions: actionResults };
  }
  writeConvergenceStore(file, applied.store);
  journal = {
    ...journal,
    status: "applied",
    updatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
  };
  writeDecisionJournal(roomClockDir, journal);
  return {
    ok: true,
    outcome: applied.outcome,
    generationId: durableEnvelope.expectedGeneration,
    decisionId: durableEnvelope.decisionId,
    actions: actionResults,
    store: applied.store,
  };
}

function applyOneAction(input: {
  roomClockDir: string;
  envelope: DecisionEnvelope;
  action: DecisionAction;
  actionId: string;
  nowMs?: number;
}): DecisionActionResult {
  const { roomClockDir, envelope, action, actionId, nowMs } = input;
  switch (action.type) {
    case "recruit": {
      const intent = writeResourceIntent(roomClockDir, {
        kind: "recruit",
        requestId: action.requestId,
        roomId: envelope.roomId,
        challengeId: envelope.challengeId,
        decisionId: envelope.decisionId,
        generationId: envelope.expectedGeneration,
        payload: {
          role: action.role,
          ...(action.duty ? { duty: action.duty } : {}),
        },
        ...(nowMs !== undefined ? { nowMs } : {}),
      });
      return {
        actionId,
        type: "recruit",
        ok: true,
        intentId: intent.intentId,
        status: "recorded",
        execution: "deferred",
      };
    }
    case "remove": {
      const intent = writeResourceIntent(roomClockDir, {
        kind: "remove",
        requestId: action.requestId,
        roomId: envelope.roomId,
        challengeId: envelope.challengeId,
        decisionId: envelope.decisionId,
        generationId: envelope.expectedGeneration,
        payload: { memberId: action.memberId },
        ...(nowMs !== undefined ? { nowMs } : {}),
      });
      return {
        actionId,
        type: "remove",
        ok: true,
        intentId: intent.intentId,
        status: "recorded",
        execution: "deferred",
      };
    }
    default: {
      const _never: never = action;
      void _never;
      throw new Error("unknown decision action");
    }
  }
}

function writeResourceIntent(
  roomClockDir: string,
  input: {
    kind: "recruit" | "remove";
    requestId: string;
    roomId: string;
    challengeId: string;
    decisionId: string;
    generationId: number;
    payload: RoomResourceIntent["payload"];
    nowMs?: number;
  },
): RoomResourceIntent {
  const requestId = input.requestId.trim();
  if (!requestId) throw new Error("resource intent requestId required");
  const existing = findResourceIntentByRequestId(roomClockDir, requestId);
  if (existing) {
    if (!resourceIntentMatches(existing, input)) {
      throw new Error(`resource intent idempotency conflict for requestId=${requestId}`);
    }
    return existing;
  }
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  const intent: RoomResourceIntent = {
    schema: ROOM_RESOURCE_INTENT_SCHEMA,
    intentId: randomUUID(),
    roomId: input.roomId,
    challengeId: input.challengeId,
    kind: input.kind,
    requestId,
    status: "recorded",
    execution: "deferred",
    payload: normalizeIntentPayload(input.payload),
    decisionId: input.decisionId,
    generationId: input.generationId,
    createdAt: now,
  };
  const file = roomResourceIntentPath(roomClockDir, intent.intentId);
  atomicWriteJson(file, intent);
  return intent;
}

function resourceIntentMatches(
  existing: RoomResourceIntent,
  input: {
    kind: "recruit" | "remove";
    roomId: string;
    challengeId: string;
    decisionId: string;
    generationId: number;
    payload: RoomResourceIntent["payload"];
  },
): boolean {
  return (
    existing.kind === input.kind &&
    existing.roomId === input.roomId &&
    existing.challengeId === input.challengeId &&
    existing.decisionId === input.decisionId &&
    existing.generationId === input.generationId &&
    stableStringify(normalizeIntentPayload(existing.payload)) ===
      stableStringify(normalizeIntentPayload(input.payload))
  );
}

function normalizeIntentPayload(payload: RoomResourceIntent["payload"]): RoomResourceIntent["payload"] {
  return {
    ...(payload.role ? { role: payload.role } : {}),
    ...(payload.duty ? { duty: payload.duty } : {}),
    ...(payload.memberId ? { memberId: payload.memberId } : {}),
  };
}

/**
 * Look up a resource intent by requestId.
 * Corrupt / unreadable intent files fail closed (throw) — never treated as missing.
 */
export function findResourceIntentByRequestId(
  roomClockDir: string,
  requestId: string,
): RoomResourceIntent | undefined {
  const dir = roomResourceIntentsDir(roomClockDir);
  if (!fs.existsSync(dir)) return undefined;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(
        `resource intent unreadable: ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`resource intent corrupt (invalid json): ${name}`);
    }
    if (!isResourceIntent(parsed)) {
      throw new Error(`resource intent corrupt (schema): ${name}`);
    }
    if (parsed.requestId === requestId) return parsed;
  }
  return undefined;
}

function createDecisionJournal(envelope: DecisionEnvelope, nowMs?: number): DecisionJournal {
  const now = new Date(nowMs ?? Date.now()).toISOString();
  const durable = normalizeDecisionEnvelope(envelope);
  return {
    schema: DECISION_JOURNAL_SCHEMA,
    decisionId: durable.decisionId,
    expectedGeneration: durable.expectedGeneration,
    roomId: durable.roomId,
    challengeId: durable.challengeId,
    envelope: durable,
    steps: durable.actions.map((action, index) => ({
      actionId: deriveActionId(durable.decisionId, index, action),
      action,
    })),
    receipts: [],
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
}

/** Canonical envelope shape for journal binding (includes actor/evidence/rationale). */
function normalizeDecisionEnvelope(envelope: DecisionEnvelope): DecisionEnvelope {
  return {
    schema: DECISION_ENVELOPE_SCHEMA,
    decisionId: envelope.decisionId,
    expectedGeneration: envelope.expectedGeneration,
    roomId: envelope.roomId,
    challengeId: envelope.challengeId,
    actorMemberId: envelope.actorMemberId,
    ...(envelope.rationale !== undefined ? { rationale: envelope.rationale } : {}),
    evidence: envelope.evidence.map((row) => ({
      kind: row.kind,
      ref: row.ref,
      ...(row.version !== undefined ? { version: row.version } : {}),
    })),
    actions: parseDecisionEnvelope(envelope).actions,
    createdAt: envelope.createdAt,
  };
}

function assertJournalMatchesEnvelope(journal: DecisionJournal, envelope: DecisionEnvelope): void {
  if (stableStringify(normalizeDecisionEnvelope(journal.envelope)) !== stableStringify(normalizeDecisionEnvelope(envelope))) {
    throw new Error(`decision journal envelope mismatch for ${envelope.decisionId}`);
  }
}

/**
 * Convergence already lists this decision as applied. Require a complete journal,
 * reject mismatched retries, and heal status=open → applied after a crash mid-finalize.
 */
function healAlreadyAppliedJournal(input: {
  roomClockDir: string;
  envelope: DecisionEnvelope;
  store: ConvergenceStore;
  nowMs?: number;
}): ApplyDecisionEnvelopeResult {
  const { roomClockDir, envelope, store } = input;
  let journal: DecisionJournal;
  try {
    const existing = readDecisionJournal(roomClockDir, envelope.decisionId);
    if (!existing) {
      return {
        ok: false,
        reason: `decision journal missing for already-applied decisionId=${envelope.decisionId}`,
        store,
      };
    }
    assertJournalMatchesEnvelope(existing, envelope);
    journal = existing;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), store };
  }

  const incomplete = journal.steps.filter(
    (step) => !journal.receipts.some((row) => row.actionId === step.actionId && row.ok),
  );
  if (incomplete.length > 0) {
    return {
      ok: false,
      reason: `decision journal incomplete for already-applied decisionId=${envelope.decisionId}: ${incomplete.length} receipt(s) missing`,
      store,
    };
  }

  if (journal.status !== "applied") {
    journal = {
      ...journal,
      status: "applied",
      updatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
    };
    writeDecisionJournal(roomClockDir, journal);
  }

  return {
    ok: true,
    outcome: "already_applied",
    generationId: envelope.expectedGeneration,
    decisionId: envelope.decisionId,
    actions: receiptsToResults(journal),
    store,
  };
}

export function readDecisionJournal(roomClockDir: string, decisionId: string): DecisionJournal | undefined {
  const file = decisionJournalPath(roomClockDir, decisionId);
  if (!fs.existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `decision journal unreadable: ${decisionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`decision journal corrupt (invalid json): ${decisionId}`);
  }
  if (!isDecisionJournal(parsed)) {
    throw new Error(`decision journal corrupt (schema): ${decisionId}`);
  }
  return parsed;
}

function writeDecisionJournal(roomClockDir: string, journal: DecisionJournal): void {
  atomicWriteJson(decisionJournalPath(roomClockDir, journal.decisionId), journal);
}

function appendReceipt(journal: DecisionJournal, receipt: DecisionActionReceipt): DecisionJournal {
  return {
    ...journal,
    receipts: [...journal.receipts.filter((row) => row.actionId !== receipt.actionId), receipt],
    updatedAt: receipt.completedAt,
  };
}

function resultToReceipt(result: DecisionActionResult, nowMs?: number): DecisionActionReceipt {
  if (!result.ok) throw new Error("cannot receipt a failed action");
  const completedAt = new Date(nowMs ?? Date.now()).toISOString();
  switch (result.type) {
    case "recruit":
    case "remove":
      return {
        actionId: result.actionId,
        type: result.type,
        ok: true,
        intentId: result.intentId,
        status: result.status,
        execution: result.execution,
        completedAt,
      };
  }
}

function receiptToResult(receipt: DecisionActionReceipt): DecisionActionResult {
  return {
    actionId: receipt.actionId,
    type: receipt.type,
    ok: true,
    intentId: receipt.intentId ?? "",
    status: "recorded",
    execution: "deferred",
  };
}

function receiptsToResults(journal: DecisionJournal): DecisionActionResult[] {
  return journal.steps.map((step) => {
    const receipt = journal.receipts.find((row) => row.actionId === step.actionId);
    if (!receipt) {
      return { actionId: step.actionId, type: step.action.type, ok: false, reason: "receipt_missing" };
    }
    return receiptToResult(receipt);
  });
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function isResourceIntent(value: unknown): value is RoomResourceIntent {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const statusOk =
    row.status === "recorded" ||
    row.status === "executed" ||
    row.status === "refused" ||
    row.status === "failed";
  const executionOk =
    row.execution === "deferred" || row.execution === "completed" || row.execution === "refused";
  return (
    row.schema === ROOM_RESOURCE_INTENT_SCHEMA &&
    typeof row.intentId === "string" &&
    typeof row.requestId === "string" &&
    (row.kind === "recruit" || row.kind === "remove") &&
    statusOk &&
    executionOk
  );
}

function isDecisionJournal(value: unknown): value is DecisionJournal {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    row.schema === DECISION_JOURNAL_SCHEMA &&
    typeof row.decisionId === "string" &&
    Number.isInteger(row.expectedGeneration) &&
    typeof row.roomId === "string" &&
    typeof row.challengeId === "string" &&
    Array.isArray(row.steps) &&
    Array.isArray(row.receipts) &&
    (row.status === "open" || row.status === "applied")
  );
}
