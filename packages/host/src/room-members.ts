/**
 * Formal room members v1 — roster and Host status projection.
 * Temporary DSH assistants are not stored here.
 */
import fs from "node:fs";
import path from "node:path";
import type { LiveSessionStateStatus } from "./live-session-state.ts";
import type { RoomClockState } from "./room-clock.ts";

export const ROOM_MEMBERS_SCHEMA = "silver.room-members.v1" as const;
export const ROOM_STATUS_SCHEMA = "silver.room-status.v1" as const;

export type RoomMemberRole = "lead" | "worker";

/** Reuses session vocabulary where possible; adds pending/blocked for Host projection. */
export type RoomMemberRunStatus =
  | "pending"
  | LiveSessionStateStatus
  | "idle"
  | "idle_awaiting_host_wake"
  | "blocked"
  | "stopped";

/** Official Team session. Mutually exclusive with an independent-root attemptId. */
export type NativeSessionBinding = {
  sessionId: string;
  parentSessionId?: string;
};

type RoomMemberFields = {
  memberId: string;
  role: RoomMemberRole;
  /** Short duty label — not a second state machine. */
  duty: string;
  dshSessionId?: string;
  cwd?: string;
  dshHome?: string;
  status: RoomMemberRunStatus;
  blockReason?: string;
  stopReason?: string;
  startedAt?: string;
  updatedAt: string;
};

/**
 * Exactly one execution binding.
 * Independent roots carry attemptId. Official Team members carry nativeSession.
 */
export type RoomMemberRecord = RoomMemberFields &
  (
    | { attemptId: string; nativeSession?: never }
    | { attemptId?: never; nativeSession: NativeSessionBinding }
  );

export type RoomMembersState = {
  schema: typeof ROOM_MEMBERS_SCHEMA;
  roomId: string;
  challengeId: string;
  members: RoomMemberRecord[];
  updatedAt: string;
};

export type RoomBootstrapProjection = {
  state: "ok" | "in_progress" | "bootstrap_degraded";
  /** Host-owned Room lifecycle while initialWorkers bootstrap. */
  phase?: "bootstrapping" | "active" | "bootstrap_degraded";
  expectedWorkers: number;
  boundWorkers: number;
  missingWorkers: number;
  unacknowledgedWorkers: number;
};

export type RoomStatusProjection = {
  schema: typeof ROOM_STATUS_SCHEMA;
  roomId: string;
  challengeId: string;
  deadline?: {
    startedAt: string;
    deadlineAt: string;
    budgetMs: number;
    remainingMs: number;
    expired: boolean;
    unbounded?: true;
  };
  members: Array<{
    memberId: string;
    role: RoomMemberRole;
    duty: string;
    status: RoomMemberRunStatus;
    dshSessionId?: string;
    cwd?: string;
    recentActivity?: string;
    blockReason?: string;
    stopReason?: string;
  }>;
  /** Partial bootstrap failure. Commander must not treat a degraded Room as a full swarm. */
  bootstrap?: RoomBootstrapProjection;
  updatedAt: string;
};

export type TeamMemberSpec = {
  memberId: string;
  attemptId: string;
  role: RoomMemberRole;
  duty?: string;
};

/** Default Lead-only team (explicit `--team lead` or single-slice plan). */
export function singleLeadTeamSpec(): TeamMemberSpec[] {
  return [{ memberId: "lead", attemptId: "a0", role: "lead", duty: "solve" }];
}

/** Durable Racer identities for one Room. Resume refuses to grow or rebind this file. */
export const RACE_ROSTER_SCHEMA = "silver.race-roster.v1" as const;

export type RaceRosterFile = {
  schema: typeof RACE_ROSTER_SCHEMA;
  challengeId: string;
  racers: TeamMemberSpec[];
};

/** N equal Racers. No Lead. attemptId stays `a0..` so resume binds the same session. */
export function raceRacerSpecs(workers: number): TeamMemberSpec[] {
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) {
    throw new Error(`race.workers must be an integer from 1 to 32, got ${String(workers)}`);
  }
  return Array.from({ length: workers }, (_, index) => ({
    memberId: `racer-${index + 1}`,
    attemptId: `a${index}`,
    role: "worker" as const,
    duty: "race",
  }));
}

export function raceRosterPath(workDir: string, roomId: string): string {
  const safe = roomId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(workDir, `race-roster-${safe}.json`);
}

export function readRaceRoster(file: string): RaceRosterFile | undefined {
  if (!fs.existsSync(file)) return undefined;
  let parsed: RaceRosterFile;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RaceRosterFile;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`corrupt race roster at ${file}: ${detail}; fail closed`);
  }
  if (parsed?.schema !== RACE_ROSTER_SCHEMA || !Array.isArray(parsed.racers) || parsed.racers.length < 1) {
    throw new Error(`corrupt race roster at ${file}; fail closed`);
  }
  return parsed;
}

export function writeRaceRoster(
  file: string,
  input: { challengeId: string; racers: readonly TeamMemberSpec[] },
): void {
  const body: RaceRosterFile = {
    schema: RACE_ROSTER_SCHEMA,
    challengeId: input.challengeId,
    racers: input.racers.map((row) => ({
      memberId: row.memberId,
      attemptId: row.attemptId,
      role: row.role,
      ...(row.duty ? { duty: row.duty } : {}),
    })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Resume must keep each Racer identity. A different count or id fails closed instead of adding Racers. */
export function assertSameRaceRoster(
  persisted: RaceRosterFile,
  opened: readonly TeamMemberSpec[],
  challengeId: string,
): void {
  if (persisted.challengeId !== challengeId) {
    throw new Error(`race roster challenge ${persisted.challengeId} conflicts with ${challengeId}; fail closed`);
  }
  if (persisted.racers.length !== opened.length) {
    throw new Error(
      `race.workers=${opened.length} conflicts with persisted racer count ${persisted.racers.length}; fail closed`,
    );
  }
  for (let index = 0; index < opened.length; index += 1) {
    const left = persisted.racers[index];
    const right = opened[index];
    if (!left || !right || left.memberId !== right.memberId || left.attemptId !== right.attemptId) {
      throw new Error(
        `race roster identity conflicts with persisted ${left?.memberId ?? "?"}/${left?.attemptId ?? "?"}; fail closed`,
      );
    }
  }
}

/**
 * Compat roster for multi-attempt profiles (e.g. cheap-swarm) without `--team`.
 * a0 is Lead; additional slices are attempt-scoped members so ACP ready/finish
 * can update the roster without inventing a formal Worker team.
 */
export function compatTeamSpecsForPlan(planLength: number): TeamMemberSpec[] {
  if (!Number.isInteger(planLength) || planLength <= 0) {
    throw new Error(`compat team requires planLength >= 1, got ${String(planLength)}`);
  }
  const out: TeamMemberSpec[] = [
    { memberId: "lead", attemptId: "a0", role: "lead", duty: "solve" },
  ];
  for (let i = 1; i < planLength; i += 1) {
    out.push({
      memberId: `attempt-a${i}`,
      attemptId: `a${i}`,
      role: "worker",
      duty: "compat-attempt",
    });
  }
  return out;
}

/** Parse `--team lead,worker,worker` into stable member specs. */
export function parseTeamMemberSpecs(raw: string): TeamMemberSpec[] {
  const roles = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (roles.length === 0) throw new Error("--team requires at least one role");
  let leadCount = 0;
  let workerCount = 0;
  const out: TeamMemberSpec[] = [];
  for (const role of roles) {
    if (role !== "lead" && role !== "worker") {
      throw new Error(`--team role must be lead|worker, got ${role}`);
    }
    if (role === "lead") {
      leadCount += 1;
      if (leadCount > 1) throw new Error("--team allows at most one lead");
      out.push({ memberId: "lead", attemptId: `a${out.length}`, role: "lead", duty: "coordinate" });
      continue;
    }
    workerCount += 1;
    out.push({
      memberId: `worker-${workerCount}`,
      attemptId: `a${out.length}`,
      role: "worker",
      duty: "explore",
    });
  }
  if (leadCount !== 1) throw new Error("--team requires exactly one lead");
  return out;
}

export function roomMembersPath(roomClockDir: string, challengeId: string): string {
  return path.join(roomClockDir, `room-members-${challengeId}.json`);
}

export function emptyRoomMembers(input: {
  roomId: string;
  challengeId: string;
  specs: TeamMemberSpec[];
  nowMs?: number;
}): RoomMembersState {
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  return {
    schema: ROOM_MEMBERS_SCHEMA,
    roomId: input.roomId,
    challengeId: input.challengeId,
    members: input.specs.map((spec) => ({
      memberId: spec.memberId,
      attemptId: spec.attemptId,
      role: spec.role,
      duty: spec.duty ?? (spec.role === "lead" ? "coordinate" : "explore"),
      status: "pending",
      updatedAt: now,
    })),
    updatedAt: now,
  };
}

export function readRoomMembers(file: string): RoomMembersState | undefined {
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    throw new Error(
      `room members unreadable: ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseRoomMembersState(parsed, file);
}

export function writeRoomMembers(file: string, state: RoomMembersState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic write: concurrent readers (idle projection, admission, room
  // projection) must never observe a torn half-written roster file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * SIGINT / operator interrupt. Official Team publish is owned by the native
 * session projection, so the Host attempt upsert never reaches this file.
 * Mark still-running rows interrupted without dropping nativeSession.
 * Platform-stopped and terminal rows stay as they are.
 */
export function projectInterruptedRoomMembers(file: string, stopReason = "interrupted", nowMs?: number): void {
  const existing = readRoomMembers(file);
  if (!existing) return;
  let next = existing;
  for (const row of existing.members) {
    if (row.status === "stopped" || row.status === "terminal") continue;
    if (row.status === "interrupted" && row.stopReason === stopReason) continue;
    next = upsertRoomMember(
      next,
      { memberId: row.memberId, status: "interrupted", stopReason },
      nowMs,
    );
  }
  writeRoomMembers(file, next);
}

/** Map a stale Host alias (`lead`) onto the durable native Lead row. */
export function resolveRoomMemberId(
  state: RoomMembersState | undefined,
  hint: { memberId?: string; role?: RoomMemberRole; sessionId?: string },
): string | undefined {
  if (!state) return hint.memberId;
  if (hint.memberId && state.members.some((row) => row.memberId === hint.memberId)) return hint.memberId;
  if (hint.sessionId) {
    const bySession = state.members.find(
      (row) => row.nativeSession?.sessionId === hint.sessionId || row.dshSessionId === hint.sessionId,
    );
    if (bySession) return bySession.memberId;
  }
  if (hint.memberId === "lead" || hint.role === "lead") {
    const lead = state.members.filter((row) => row.role === "lead");
    if (lead.length === 1) return lead[0]!.memberId;
  }
  return undefined;
}

export function upsertRoomMember(
  state: RoomMembersState,
  patch: Partial<RoomMemberFields> & { memberId: string },
  nowMs?: number,
): RoomMembersState {
  const now = new Date(nowMs ?? Date.now()).toISOString();
  const memberId = resolveRoomMemberId(state, { memberId: patch.memberId }) ?? patch.memberId;
  const idx = state.members.findIndex((row) => row.memberId === memberId);
  if (idx < 0) throw new Error(`unknown room member ${patch.memberId}`);
  const prev = state.members[idx]!;
  const fields = overlayMemberFields(prev, patch, now);
  const next: RoomMemberRecord = prev.nativeSession
    ? { ...fields, nativeSession: prev.nativeSession }
    : { ...fields, attemptId: prev.attemptId };
  const members = state.members.slice();
  members[idx] = next;
  return { ...state, members, updatedAt: now };
}

/** C6: append a newly recruited Member (stable memberId). Refuses duplicates. */
export function appendRoomMember(
  state: RoomMembersState,
  spec: TeamMemberSpec & { status?: RoomMemberRecord["status"] },
  nowMs?: number,
): RoomMembersState {
  if (state.members.some((row) => row.memberId === spec.memberId)) {
    throw new Error(`room member already exists: ${spec.memberId}`);
  }
  if (state.members.some((row) => row.attemptId === spec.attemptId)) {
    throw new Error(`room attempt already claimed: ${spec.attemptId}`);
  }
  const now = new Date(nowMs ?? Date.now()).toISOString();
  return {
    ...state,
    members: [
      ...state.members,
      {
        memberId: spec.memberId,
        attemptId: spec.attemptId,
        role: spec.role,
        duty: spec.duty ?? (spec.role === "lead" ? "coordinate" : "explore"),
        status: spec.status ?? "pending",
        updatedAt: now,
      },
    ],
    updatedAt: now,
  };
}

export function resumeOrCreateRoomMembers(input: {
  file: string;
  roomId: string;
  challengeId: string;
  specs: TeamMemberSpec[];
  nowMs?: number;
}): { state: RoomMembersState; resumed: boolean } {
  const existing = readRoomMembers(input.file);
  if (
    existing &&
    existing.roomId === input.roomId &&
    existing.challengeId === input.challengeId &&
    (memberSpecsMatch(existing, input.specs) || existing.members.some((row) => row.nativeSession))
  ) {
    // Official Team projection uses nativeSession member ids, not the CLI lead spec.
    // Realigning that roster onto `--team lead` would drop teammates and mint a second lead.
    return { state: existing, resumed: true };
  }
  if (existing && existing.challengeId === input.challengeId && existing.members.length > 0) {
    const aligned = alignMembersByStableId(existing, input.specs, input.nowMs);
    writeRoomMembers(input.file, aligned);
    return { state: aligned, resumed: true };
  }
  const state = emptyRoomMembers(input);
  writeRoomMembers(input.file, state);
  return { state, resumed: false };
}

/**
 * Resume by stable memberId. Refuse role swaps or attempt-slot steals that would
 * cross-wire sessions (e.g. lead,worker → worker,lead).
 */
export function alignMembersByStableId(
  existing: RoomMembersState,
  specs: TeamMemberSpec[],
  nowMs?: number,
): RoomMembersState {
  const now = new Date(nowMs ?? Date.now()).toISOString();
  const byMemberId = new Map(existing.members.map((row) => [row.memberId, row]));
  const claimedAttempts = new Set<string>();
  const members: RoomMemberRecord[] = [];
  for (const spec of specs) {
    const prev = byMemberId.get(spec.memberId);
    if (prev) {
      if (prev.role !== spec.role) {
        throw new Error(
          `unsupported room member remapping: memberId ${spec.memberId} role ${prev.role} -> ${spec.role}; refuse to cross-wire sessions/cwd`,
        );
      }
      if (prev.nativeSession) {
        throw new Error(
          `unsupported room member remapping: ${spec.memberId} is bound to native session ${prev.nativeSession.sessionId}, not attempt ${spec.attemptId}`,
        );
      }
      if (claimedAttempts.has(spec.attemptId) && prev.attemptId !== spec.attemptId) {
        throw new Error(
          `unsupported room member remapping: attempt ${spec.attemptId} already claimed while aligning ${spec.memberId}`,
        );
      }
      const occupant = existing.members.find(
        (row) => row.attemptId === spec.attemptId && row.memberId !== spec.memberId,
      );
      if (occupant && prev.attemptId !== spec.attemptId) {
        throw new Error(
          `unsupported room member remapping: cannot move ${spec.memberId} onto attempt ${spec.attemptId} owned by ${occupant.memberId}`,
        );
      }
      claimedAttempts.add(spec.attemptId);
      members.push({
        ...prev,
        memberId: prev.memberId,
        attemptId: spec.attemptId,
        role: spec.role,
        duty: spec.duty ?? prev.duty,
        status: prev.status === "active" ? "interrupted" : prev.status,
        updatedAt: now,
      });
      continue;
    }
    const occupant = existing.members.find((row) => row.attemptId === spec.attemptId);
    if (occupant) {
      throw new Error(
        `unsupported room member remapping: attempt ${spec.attemptId} belongs to ${occupant.memberId}, cannot assign new member ${spec.memberId}`,
      );
    }
    claimedAttempts.add(spec.attemptId);
    members.push({
      memberId: spec.memberId,
      attemptId: spec.attemptId,
      role: spec.role,
      duty: spec.duty ?? (spec.role === "lead" ? "coordinate" : "explore"),
      status: "pending",
      updatedAt: now,
    });
  }
  return {
    schema: ROOM_MEMBERS_SCHEMA,
    roomId: existing.roomId,
    challengeId: existing.challengeId,
    members,
    updatedAt: now,
  };
}

export function projectRoomStatus(input: {
  members: RoomMembersState;
  clock?: RoomClockState;
  nowMs?: number;
  recentActivityByMember?: Record<string, string>;
  bootstrap?: RoomBootstrapProjection;
}): RoomStatusProjection {
  const nowMs = input.nowMs ?? Date.now();
  return {
    schema: ROOM_STATUS_SCHEMA,
    roomId: input.members.roomId,
    challengeId: input.members.challengeId,
    ...(input.clock
      ? {
          deadline: {
            startedAt: input.clock.startedAt,
            deadlineAt: input.clock.deadlineAt,
            budgetMs: input.clock.budgetMs,
            remainingMs: Math.max(0, Date.parse(input.clock.deadlineAt) - nowMs),
            expired: Date.parse(input.clock.deadlineAt) <= nowMs,
            ...(input.clock.unbounded ? { unbounded: true as const } : {}),
          },
        }
      : {}),
    members: input.members.members.map((member) => ({
        memberId: member.memberId,
        role: member.role,
        duty: member.duty,
        status: member.status,
        ...(member.dshSessionId ? { dshSessionId: member.dshSessionId } : {}),
        ...(member.cwd ? { cwd: member.cwd } : {}),
        ...(input.recentActivityByMember?.[member.memberId]
          ? { recentActivity: input.recentActivityByMember[member.memberId] }
          : {}),
        ...(member.blockReason ? { blockReason: member.blockReason } : {}),
        ...(member.stopReason ? { stopReason: member.stopReason } : {}),
      })),
    ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function memberSpecsMatch(state: RoomMembersState, specs: TeamMemberSpec[]): boolean {
  if (state.members.length !== specs.length) return false;
  return specs.every((spec, i) => {
    const row = state.members[i];
    return row && row.memberId === spec.memberId && row.attemptId === spec.attemptId && row.role === spec.role;
  });
}

function isRoomMembersState(value: unknown): value is RoomMembersState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.schema === ROOM_MEMBERS_SCHEMA &&
    typeof row.roomId === "string" &&
    typeof row.challengeId === "string" &&
    typeof row.updatedAt === "string" &&
    Array.isArray(row.members)
  );
}

function parseRoomMembersState(value: unknown, file: string): RoomMembersState {
  if (!isRoomMembersState(value)) throw new Error(`room members schema invalid: ${file}`);
  return {
    ...value,
    members: value.members.map((member, index) => parseRoomMember(member, index)),
  };
}

function parseRoomMember(value: unknown, index: number): RoomMemberRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`room member ${index} is not an object`);
  }
  const row = value as Record<string, unknown>;
  const memberId = typeof row.memberId === "string" && row.memberId.trim() ? row.memberId : `#${index}`;
  const hasAttempt = Object.prototype.hasOwnProperty.call(row, "attemptId");
  const hasNative = Object.prototype.hasOwnProperty.call(row, "nativeSession");
  if (hasAttempt && hasNative) {
    throw new Error(`room member ${memberId} has both attemptId and nativeSession`);
  }
  if (!hasAttempt && !hasNative) {
    throw new Error(`room member ${memberId} has no execution binding`);
  }
  if (hasAttempt) {
    if (typeof row.attemptId !== "string" || !row.attemptId.trim()) {
      throw new Error(`room member ${memberId} attemptId is invalid`);
    }
    const { nativeSession: _native, ...rest } = row;
    return rest as RoomMemberRecord;
  }
  if (!isNativeSessionBinding(row.nativeSession)) {
    throw new Error(`room member ${memberId} nativeSession is invalid`);
  }
  const { attemptId: _attempt, ...rest } = row;
  return rest as RoomMemberRecord;
}

function isNativeSessionBinding(value: unknown): value is NativeSessionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.sessionId !== "string" || !row.sessionId.trim()) return false;
  if (row.parentSessionId !== undefined && (typeof row.parentSessionId !== "string" || !row.parentSessionId.trim())) {
    return false;
  }
  return true;
}

function overlayMemberFields(
  prev: RoomMemberRecord,
  patch: Partial<RoomMemberFields> & { memberId: string },
  now: string,
): RoomMemberFields {
  const { attemptId: _attempt, nativeSession: _native, ...base } = prev as RoomMemberFields & {
    attemptId?: string;
    nativeSession?: NativeSessionBinding;
  };
  const next: RoomMemberFields = { ...base, memberId: prev.memberId, updatedAt: now };
  if (patch.role !== undefined) next.role = patch.role;
  if (patch.duty !== undefined) next.duty = patch.duty;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.dshSessionId !== undefined) next.dshSessionId = patch.dshSessionId;
  if (patch.cwd !== undefined) next.cwd = patch.cwd;
  if (patch.dshHome !== undefined) next.dshHome = patch.dshHome;
  if (patch.blockReason !== undefined) next.blockReason = patch.blockReason;
  if (patch.stopReason !== undefined) next.stopReason = patch.stopReason;
  if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
  return next;
}
