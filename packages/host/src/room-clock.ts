/**
 * Shared room wall-clock for production contest/live solves.
 * One startedAt/deadlineAt per challenge room — members/roots share the same deadline.
 * Host downtime does not reset the budget; wall time is absolute.
 *
 * Task/room identity (minimal):
 * - Explicit `roomWorkDir` (contest slot) + challengeId → one room across roots.
 * - Else canonical replay path + challengeId → distinct standalone tasks even in the
 *   same parent directory (`task-a.json` vs `task-b.json`).
 * - `.../root-N/live-run-ledger.json` normalizes to the slot's ledger path so retries
 *   share the room without inventing a new identity.
 * Root session and model route are intentionally excluded from the clock identity.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isRoomDomain, type RoomDomain } from "@silver/ctf-spine";

export const ROOM_CLOCK_SCHEMA = "silver.room-clock.v1" as const;
/** Production default room budget. Explicit CLI/mission overrides still win. */
export const ROOM_DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;
const UNBOUNDED_ROOM_DEADLINE = "9999-12-31T23:59:59.999Z";

export type RoomClockStopReason =
  | "room_deadline"
  | "room_deadline_shortened"
  | "platform_complete"
  | "cancelled"
  | "technical";

export interface RoomClockState {
  schema: typeof ROOM_CLOCK_SCHEMA;
  roomId: string;
  challengeId: string;
  /** Upstream room assembly identity. Legacy and low-level clocks may omit both fields. */
  domain?: RoomDomain;
  formalTeam?: boolean;
  /** ISO wall time when the room entered running (first formal member start). */
  startedAt: string;
  /** ISO absolute deadline. Shared by every member/root in the room. */
  deadlineAt: string;
  /** Configured budget at start (or last explicit reset). Observational. */
  budgetMs: number;
  /** No local deadline. Platform/match completion or operator stop still closes the Room. */
  unbounded?: true;
  /** How the deadline was last changed. */
  updatedAt: string;
  /** Optional note when migration cannot invent a fresh 90m gift. */
  migrationNote?: string;
}

export interface LiveTaskIdentity {
  /** Stable key shared across roots/model changes for one task/room. */
  key: string;
  /** Directory that stores `.silver-room/` for this identity. */
  storageBase: string;
  /** Short filesystem-safe id derived from key. */
  shortId: string;
}

/**
 * Canonical standalone replay path. Climb out of contest `root-N` so retries share
 * the slot ledger identity; keep distinct filenames in the same parent separate.
 */
export function canonicalReplayTaskPath(replayPath: string): string {
  let resolved = path.resolve(replayPath);
  try {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      resolved = path.join(resolved, "live-run-ledger.json");
    } else if (replayPath.endsWith(path.sep)) {
      resolved = path.join(resolved, "live-run-ledger.json");
    }
  } catch {
    if (replayPath.endsWith(path.sep)) resolved = path.join(resolved, "live-run-ledger.json");
  }
  const parent = path.dirname(resolved);
  if (/^root-\d+$/.test(path.basename(parent))) {
    return path.join(path.dirname(parent), path.basename(resolved));
  }
  return resolved;
}

export function liveTaskIdentity(input: {
  challengeId: string;
  roomWorkDir?: string;
  replayPath?: string;
}): LiveTaskIdentity {
  if (input.roomWorkDir) {
    const slot = path.resolve(input.roomWorkDir);
    const key = `slot:${slot}:${input.challengeId}`;
    return { key, storageBase: slot, shortId: shortIdentity(key) };
  }
  if (input.replayPath) {
    const canonical = canonicalReplayTaskPath(input.replayPath);
    const key = `replay:${canonical}:${input.challengeId}`;
    return { key, storageBase: path.dirname(canonical), shortId: shortIdentity(key) };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "silver-room-ephemeral-"));
  const key = `ephemeral:${tmp}:${input.challengeId}`;
  return { key, storageBase: tmp, shortId: shortIdentity(key) };
}

export function roomClockPath(workDir: string, roomId: string): string {
  const safe = roomId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(workDir, `room-clock-${safe}.json`);
}

/**
 * Stable room-clock directory for one task/room. Does not include rootSession or model.
 */
export function liveRoomClockDir(input: {
  challengeId: string;
  roomWorkDir?: string;
  replayPath?: string;
}): string {
  const identity = liveTaskIdentity(input);
  const dir = path.join(identity.storageBase, ".silver-room", identity.shortId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Legacy pre-identity path: `.silver-room/<challengeId>/`. */
export function legacyLiveRoomClockDir(storageBase: string, challengeId: string): string {
  const safe = challengeId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(storageBase, ".silver-room", safe);
}

export type RoomClockFileInspection =
  | { status: "missing" }
  | { status: "valid"; state: RoomClockState }
  | { status: "corrupt"; detail: string };

export function inspectRoomClockFile(file: string): RoomClockFileInspection {
  if (!fs.existsSync(file)) return { status: "missing" };
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRoomClockState(parsed)) {
      return { status: "corrupt", detail: "room clock JSON failed schema validation" };
    }
    return { status: "valid", state: parsed };
  } catch (err) {
    return {
      status: "corrupt",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function readRoomClock(file: string): RoomClockState | undefined {
  const inspected = inspectRoomClockFile(file);
  return inspected.status === "valid" ? inspected.state : undefined;
}

export function startRoomClock(input: {
  roomId: string;
  challengeId: string;
  domain?: RoomDomain;
  formalTeam?: boolean;
  budgetMs?: number;
  nowMs?: number;
  /** External platform deadline; room uses the earlier bound. */
  externalDeadlineAtMs?: number;
}): RoomClockState {
  const assemblyIdentity = normalizeRoomAssemblyIdentity(input);
  const now = input.nowMs ?? Date.now();
  const requestedBudgetMs = input.budgetMs ?? ROOM_DEFAULT_TIMEOUT_MS;
  const unbounded = requestedBudgetMs === 0 && input.externalDeadlineAtMs === undefined;
  const budgetMs = unbounded
    ? 0
    : positiveBudget(requestedBudgetMs === 0 ? Math.max(1, input.externalDeadlineAtMs! - now) : requestedBudgetMs);
  let deadlineMs = unbounded ? Date.parse(UNBOUNDED_ROOM_DEADLINE) : now + budgetMs;
  let migrationNote: string | undefined;
  if (input.externalDeadlineAtMs !== undefined && Number.isFinite(input.externalDeadlineAtMs)) {
    if (input.externalDeadlineAtMs < deadlineMs) {
      deadlineMs = input.externalDeadlineAtMs;
      migrationNote = "external platform deadline is earlier than the room budget";
    }
  }
  const state: RoomClockState = {
    schema: ROOM_CLOCK_SCHEMA,
    roomId: input.roomId,
    challengeId: input.challengeId,
    ...(assemblyIdentity ?? {}),
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(deadlineMs).toISOString(),
    budgetMs,
    ...(unbounded ? { unbounded: true as const } : {}),
    updatedAt: new Date(now).toISOString(),
    ...(migrationNote ? { migrationNote } : {}),
  };
  return state;
}

/**
 * Prefer an existing room clock on resume. Never silently gift a fresh default budget
 * when a prior start time exists without a deadline — mark migration needed instead.
 * Corrupt clocks require an explicit recovery decision and must not be overwritten first.
 */
export function resumeOrStartRoomClock(input: {
  file: string;
  roomId: string;
  challengeId: string;
  domain?: RoomDomain;
  formalTeam?: boolean;
  budgetMs?: number;
  nowMs?: number;
  priorStartedAt?: string;
  priorBudgetMs?: number;
  priorDeadlineAt?: string;
  externalDeadlineAtMs?: number;
  /** When true, refuse to invent a fresh clock (upgrade/resume with evidence). */
  requireExistingEvidence?: boolean;
}): { state: RoomClockState; resumed: boolean; needsRecoveryDecision: boolean } {
  const expectedAssembly = normalizeRoomAssemblyIdentity(input);
  const inspected = inspectRoomClockFile(input.file);
  if (inspected.status === "valid" && inspected.state.roomId === input.roomId && inspected.state.challengeId === input.challengeId) {
    const mismatch = roomAssemblyIdentityMismatch(inspected.state, expectedAssembly);
    if (mismatch) {
      return {
        state: { ...inspected.state, migrationNote: mismatch },
        resumed: false,
        needsRecoveryDecision: true,
      };
    }
    return { state: inspected.state, resumed: true, needsRecoveryDecision: false };
  }
  if (inspected.status === "corrupt") {
    const placeholder = startRoomClock(input);
    return {
      state: {
        ...placeholder,
        migrationNote: `corrupt room clock at ${input.file}: ${inspected.detail}; do not overwrite until recovery is decided`,
      },
      resumed: false,
      needsRecoveryDecision: true,
    };
  }
  if (input.priorStartedAt) {
    const startedMs = Date.parse(input.priorStartedAt);
    if (!Number.isFinite(startedMs)) {
      return {
        state: {
          ...startRoomClock(input),
          migrationNote: "priorStartedAt was not a valid timestamp; recovery decision required",
        },
        resumed: false,
        needsRecoveryDecision: true,
      };
    }
    let deadlineMs: number;
    if (input.priorDeadlineAt) {
      const parsedDeadline = Date.parse(input.priorDeadlineAt);
      if (!Number.isFinite(parsedDeadline)) {
        return {
          state: {
            ...startRoomClock({ ...input, nowMs: startedMs }),
            startedAt: new Date(startedMs).toISOString(),
            migrationNote: "priorDeadlineAt was invalid; recovery decision required",
          },
          resumed: false,
          needsRecoveryDecision: true,
        };
      }
      deadlineMs = parsedDeadline;
    } else {
      const budgetMs = positiveBudget(input.priorBudgetMs ?? input.budgetMs ?? ROOM_DEFAULT_TIMEOUT_MS);
      deadlineMs = startedMs + budgetMs;
    }
    const budgetMs = positiveBudget(input.priorBudgetMs ?? input.budgetMs ?? Math.max(1, deadlineMs - startedMs));
    const state: RoomClockState = {
      schema: ROOM_CLOCK_SCHEMA,
      roomId: input.roomId,
      challengeId: input.challengeId,
      ...(expectedAssembly ?? {}),
      startedAt: new Date(startedMs).toISOString(),
      deadlineAt: new Date(deadlineMs).toISOString(),
      budgetMs,
      updatedAt: new Date(input.nowMs ?? Date.now()).toISOString(),
      migrationNote: input.priorDeadlineAt
        ? "reconstructed from prior startedAt/deadlineAt"
        : "reconstructed from prior startedAt; confirm recovery if the original deadline was different",
    };
    return { state, resumed: true, needsRecoveryDecision: !input.priorDeadlineAt };
  }
  if (input.requireExistingEvidence) {
    return {
      state: {
        ...startRoomClock(input),
        migrationNote: "existing session/runtime without a room clock; recovery decision required before granting a new budget",
      },
      resumed: false,
      needsRecoveryDecision: true,
    };
  }
  return { state: startRoomClock(input), resumed: false, needsRecoveryDecision: false };
}

/** Extend or shorten the absolute deadline. Shortening to now-or-past marks immediate expiry. */
export function updateRoomDeadline(
  state: RoomClockState,
  input: { deadlineAtMs: number; nowMs?: number },
): RoomClockState {
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(input.deadlineAtMs)) {
    throw new Error("room deadlineAtMs must be a finite number");
  }
  const startedAtMs = Date.parse(state.startedAt);
  const next = {
    ...state,
    deadlineAt: new Date(input.deadlineAtMs).toISOString(),
    budgetMs: state.unbounded ? Math.max(1, Math.floor(input.deadlineAtMs - startedAtMs)) : state.budgetMs,
    updatedAt: new Date(now).toISOString(),
  };
  delete next.unbounded;
  return next;
}

export function extendRoomDeadlineBy(
  state: RoomClockState,
  deltaMs: number,
  nowMs?: number,
): RoomClockState {
  if (!Number.isFinite(deltaMs)) throw new Error("room deadline delta must be finite");
  if (state.unbounded) throw new Error("an unbounded room has no deadline to extend; set an absolute deadline instead");
  const current = Date.parse(state.deadlineAt);
  return updateRoomDeadline(state, { deadlineAtMs: current + deltaMs, ...(nowMs !== undefined ? { nowMs } : {}) });
}

export function roomRemainingMs(state: RoomClockState, nowMs = Date.now()): number {
  if (state.unbounded) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.parse(state.deadlineAt) - nowMs);
}

export function roomExpired(state: RoomClockState, nowMs = Date.now()): boolean {
  return roomRemainingMs(state, nowMs) <= 0;
}

/**
 * A finished attempt's clock does not fund the next one.
 * A clock that is still running is left unchanged so crash resume cannot gift a new budget.
 */
export function beginFreshAttemptClock(input: {
  previous: RoomClockState | undefined;
  roomId: string;
  challengeId: string;
  domain?: RoomDomain;
  formalTeam?: boolean;
  budgetMs?: number;
  nowMs?: number;
  externalDeadlineAtMs?: number;
}): { state: RoomClockState; replaced: boolean } {
  if (input.previous && !roomExpired(input.previous, input.nowMs)) {
    return { state: input.previous, replaced: false };
  }
  return {
    state: startRoomClock({
      roomId: input.roomId,
      challengeId: input.challengeId,
      ...(input.domain !== undefined ? { domain: input.domain } : {}),
      ...(input.formalTeam !== undefined ? { formalTeam: input.formalTeam } : {}),
      ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
      ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      ...(input.externalDeadlineAtMs !== undefined ? { externalDeadlineAtMs: input.externalDeadlineAtMs } : {}),
    }),
    replaced: true,
  };
}

export function writeRoomClock(file: string, state: RoomClockState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Snapshot same-task / prior-room evidence BEFORE this invocation creates runtime.db
 * or other artifacts. Callers must pass excludeRuntimeRoot for the hash about to be used
 * so a freshly mkdir'd path is never mistaken for an old run.
 *
 * - Contest slot: prior slot clock, legacy clock, or other runtime roots under the slot.
 * - Standalone: replay ledger whose caseId matches this challenge; then prior runtime
 *   roots under storageBase that carry this challenge's clock/session/workspace.
 * Shared `.silver-room/<challengeId>/` alone is not same-task evidence.
 */
export type PriorRoomEvidence = {
  sameTask: boolean;
  kind: "slot" | "replay-ledger" | "runtime-db" | "session" | "none";
  detail?: string;
  /** Prior `.silver-runtime/<hash>` directories belonging to this task (excludes current). */
  priorRuntimeRoots: string[];
};

export function snapshotPriorRoomEvidence(input: {
  challengeId: string;
  storageBase: string;
  roomWorkDir?: string;
  replayPath?: string;
  excludeRuntimeRoot?: string;
}): PriorRoomEvidence {
  const exclude = input.excludeRuntimeRoot ? path.resolve(input.excludeRuntimeRoot) : undefined;
  if (input.roomWorkDir) {
    const slot = path.resolve(input.roomWorkDir);
    const slotClock = roomClockPath(slot, input.challengeId);
    if (fs.existsSync(slotClock)) {
      return {
        sameTask: true,
        kind: "slot",
        detail: slotClock,
        priorRuntimeRoots: listPriorRuntimeRoots(slot, input.challengeId, exclude),
      };
    }
    const legacyClock = roomClockPath(legacyLiveRoomClockDir(slot, input.challengeId), input.challengeId);
    if (fs.existsSync(legacyClock)) {
      return {
        sameTask: true,
        kind: "slot",
        detail: legacyClock,
        priorRuntimeRoots: listPriorRuntimeRoots(slot, input.challengeId, exclude),
      };
    }
    const priorRoots = listPriorRuntimeRoots(slot, input.challengeId, exclude);
    const priorDetail = priorRoots[0];
    if (priorDetail) {
      return {
        sameTask: true,
        kind: "runtime-db",
        detail: priorDetail,
        priorRuntimeRoots: priorRoots,
      };
    }
    return { sameTask: false, kind: "none", priorRuntimeRoots: [] };
  }
  if (input.replayPath) {
    const canonical = canonicalReplayTaskPath(input.replayPath);
    const ledgerMatch = inspectReplayLedgerIdentity(canonical, input.challengeId);
    const priorRoots = listPriorRuntimeRoots(input.storageBase, input.challengeId, exclude);
    if (ledgerMatch.matched) {
      return {
        sameTask: true,
        kind: "replay-ledger",
        detail: canonical,
        priorRuntimeRoots: priorRoots,
      };
    }
    // Ambiguous leftover runtimes under a shared parent are not enough without ledger identity.
    if (priorRoots.length > 0) {
      return {
        sameTask: false,
        kind: "none",
        detail: `prior runtime roots exist under ${input.storageBase} but replay ledger does not identify this task`,
        priorRuntimeRoots: priorRoots,
      };
    }
  }
  return { sameTask: false, kind: "none", priorRuntimeRoots: [] };
}

/** @deprecated Prefer snapshotPriorRoomEvidence taken before creating runtime.db. */
export function detectSameTaskRoomEvidence(input: {
  challengeId: string;
  storageBase: string;
  roomWorkDir?: string;
  replayPath?: string;
  excludeRuntimeRoot?: string;
}): { sameTask: boolean; kind: PriorRoomEvidence["kind"]; detail?: string } {
  const snap = snapshotPriorRoomEvidence(input);
  return {
    sameTask: snap.sameTask,
    kind: snap.kind,
    ...(snap.detail ? { detail: snap.detail } : {}),
  };
}

export type LegacyRoomClockOwnership = "slot" | "runtime-root" | "challenge-shared";

export type LegacyRoomClockCandidate = {
  file: string;
  ownership: LegacyRoomClockOwnership;
};

/** Ordered legacy clock locations for one task/room upgrade. */
export function collectLegacyRoomClockCandidates(input: {
  challengeId: string;
  storageBase: string;
  runtimeRoot: string;
  roomWorkDir?: string;
  priorRuntimeRoots?: string[];
}): LegacyRoomClockCandidate[] {
  const out: LegacyRoomClockCandidate[] = [];
  const seen = new Set<string>();
  const push = (file: string, ownership: LegacyRoomClockOwnership): void => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push({ file: resolved, ownership });
  };
  push(roomClockPath(input.runtimeRoot, input.challengeId), "runtime-root");
  for (const prior of input.priorRuntimeRoots ?? []) {
    push(roomClockPath(prior, input.challengeId), "runtime-root");
  }
  if (input.roomWorkDir) {
    const slot = path.resolve(input.roomWorkDir);
    // 795f936 contest wrote the clock directly under the slot directory.
    push(roomClockPath(slot, input.challengeId), "slot");
    push(roomClockPath(legacyLiveRoomClockDir(slot, input.challengeId), input.challengeId), "challenge-shared");
  }
  push(
    roomClockPath(legacyLiveRoomClockDir(input.storageBase, input.challengeId), input.challengeId),
    "challenge-shared",
  );
  return out;
}

export type LegacyRoomClockMigrationResult =
  | { status: "already-present" }
  | { status: "migrated"; from: string; state: RoomClockState }
  | { status: "none" }
  | { status: "corrupt-same-task"; from: string; detail: string }
  | { status: "skipped-shared-without-evidence"; from: string };

/**
 * Copy a legacy clock into the new identity path only when ownership matches this task.
 * Never overwrites dest. Shared challenge-scoped clocks require same-task evidence.
 * Corrupt clocks that belong to this task surface recovery instead of a silent fresh budget.
 */
export function migrateLegacyRoomClock(input: {
  destFile: string;
  candidates: LegacyRoomClockCandidate[];
  roomId: string;
  challengeId: string;
  sameTaskEvidence: boolean;
}): LegacyRoomClockMigrationResult {
  if (fs.existsSync(input.destFile)) return { status: "already-present" };
  let skippedShared: string | undefined;
  for (const candidate of input.candidates) {
    const inspected = inspectRoomClockFile(candidate.file);
    if (inspected.status === "missing") continue;
    if (inspected.status === "corrupt") {
      const belongs =
        candidate.ownership === "slot" ||
        candidate.ownership === "runtime-root" ||
        input.sameTaskEvidence;
      if (belongs) {
        return { status: "corrupt-same-task", from: candidate.file, detail: inspected.detail };
      }
      continue;
    }
    const existing = inspected.state;
    if (existing.roomId !== input.roomId || existing.challengeId !== input.challengeId) continue;
    if (candidate.ownership === "challenge-shared" && !input.sameTaskEvidence) {
      skippedShared = candidate.file;
      continue;
    }
    writeRoomClock(input.destFile, existing);
    return { status: "migrated", from: candidate.file, state: existing };
  }
  if (skippedShared) {
    return { status: "skipped-shared-without-evidence", from: skippedShared };
  }
  return { status: "none" };
}

function inspectReplayLedgerIdentity(
  file: string,
  challengeId: string,
): { matched: boolean; detail?: string } {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { matched: false };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { matched: false, detail: "replay is not a JSON object" };
    }
    const row = parsed as Record<string, unknown>;
    if (row.schema !== "silver.live-run-ledger.v1") {
      return { matched: false, detail: `unexpected ledger schema ${String(row.schema)}` };
    }
    if (typeof row.caseId !== "string" || row.caseId !== challengeId) {
      return { matched: false, detail: `ledger caseId ${String(row.caseId)} != ${challengeId}` };
    }
    return { matched: true };
  } catch (err) {
    return { matched: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function listPriorRuntimeRoots(
  storageBase: string,
  challengeId: string,
  excludeRuntimeRoot?: string,
): string[] {
  const runtimeRoot = path.join(storageBase, ".silver-runtime");
  const out: string[] = [];
  try {
    if (!fs.existsSync(runtimeRoot) || !fs.statSync(runtimeRoot).isDirectory()) return out;
    for (const name of fs.readdirSync(runtimeRoot)) {
      const root = path.resolve(path.join(runtimeRoot, name));
      if (excludeRuntimeRoot && root === path.resolve(excludeRuntimeRoot)) continue;
      if (!runtimeRootBelongsToChallenge(root, challengeId)) continue;
      out.push(root);
    }
  } catch {
    return out;
  }
  return out;
}

function runtimeRootBelongsToChallenge(root: string, challengeId: string): boolean {
  if (fs.existsSync(roomClockPath(root, challengeId))) return true;
  if (fs.existsSync(path.join(root, "challenges", challengeId))) return true;
  return false;
}

export function isRoomClockState(value: unknown): value is RoomClockState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.schema === ROOM_CLOCK_SCHEMA &&
    typeof row.roomId === "string" &&
    typeof row.challengeId === "string" &&
    ((row.domain === undefined && row.formalTeam === undefined) ||
      (isRoomDomain(row.domain) && typeof row.formalTeam === "boolean")) &&
    typeof row.startedAt === "string" &&
    typeof row.deadlineAt === "string" &&
    typeof row.budgetMs === "number" &&
    (row.unbounded === undefined || row.unbounded === true) &&
    typeof row.updatedAt === "string" &&
    Number.isFinite(Date.parse(row.startedAt)) &&
    Number.isFinite(Date.parse(row.deadlineAt)) &&
    Number.isFinite(row.budgetMs) &&
    (row.unbounded === true ? row.budgetMs === 0 : row.budgetMs > 0)
  );
}

function normalizeRoomAssemblyIdentity(input: {
  domain?: RoomDomain;
  formalTeam?: boolean;
}): { domain: RoomDomain; formalTeam: boolean } | undefined {
  const hasDomain = input.domain !== undefined;
  const hasFormalTeam = input.formalTeam !== undefined;
  if (hasDomain !== hasFormalTeam) {
    throw new Error("room clock domain and formalTeam must be supplied together");
  }
  if (!hasDomain) return undefined;
  if (!isRoomDomain(input.domain)) {
    throw new Error("room clock domain is invalid");
  }
  return { domain: input.domain, formalTeam: input.formalTeam! };
}

function roomAssemblyIdentityMismatch(
  state: RoomClockState,
  expected: { domain: RoomDomain; formalTeam: boolean } | undefined,
): string | undefined {
  if (!expected) return undefined;
  if (state.domain === undefined || state.formalTeam === undefined) {
    return "existing room clock has no room assembly identity; recovery decision required before resume";
  }
  if (state.domain !== expected.domain || state.formalTeam !== expected.formalTeam) {
    return `room assembly identity mismatch: stored=${state.domain}/${String(state.formalTeam)} requested=${expected.domain}/${String(expected.formalTeam)}`;
  }
  return undefined;
}

function shortIdentity(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function positiveBudget(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`room budgetMs must be a positive number, got ${String(ms)}`);
  }
  return Math.floor(ms);
}
