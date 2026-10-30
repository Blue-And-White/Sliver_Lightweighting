/**
 * Official Team native-session binding. Probe-only: the default live overlay,
 * C6 Host recruit, and production swarm never call this.
 * memberId is derived from the DSH session id. Team members do not share an attemptId.
 * Admission uses the sealed ToolExecution session, not a model-supplied id.
 */
import fs from "node:fs";
import path from "node:path";
import type { NativeSessionRpcMeta } from "@silver/protocol";
import {
  readRoomMembers,
  roomMembersPath,
  writeRoomMembers,
  type RoomMemberRecord,
  type RoomMemberRunStatus,
  type RoomMembersState,
} from "./room-members.ts";

export const NATIVE_SESSION_BINDING_SCHEMA = "silver.native-session-binding.v1" as const;

export type TeamMemberRole = "lead" | "worker";

export type OfficialTeamRpcGate = {
  roomId: string;
  roomClockDir: string;
  maxMembers: number;
  /** D2 only. Teammates must bind a C3 recruit permit. Default swarm and C6 leave this unset. */
  requireRecruitPermit?: boolean;
  /** Host callback after a recruit permit binds. Not a scheduler. */
  onRecruitBound?: () => void;
};

export type NativeSessionMember = {
  sessionId: string;
  memberId: string;
  parentSessionId?: string;
  role: TeamMemberRole;
  tools: string[];
};

export type NativeSessionBindingState = {
  schema: typeof NATIVE_SESSION_BINDING_SCHEMA;
  challengeId: string;
  roomId: string;
  maxMembers: number;
  leadSessionId?: string;
  members: NativeSessionMember[];
};

const MODEL_IDENTITY_KEYS = [
  "sessionId",
  "parentSessionId",
  "memberId",
  "dshSessionId",
  "nativeSession",
  "attemptId",
  "role",
  "actorMemberId",
] as const;

export function rosterMemberIsLead(
  members: readonly {
    memberId: string;
    role: string;
    dshSessionId?: string;
    nativeSession?: { sessionId: string };
  }[],
  actor: { memberId?: string; sessionId?: string },
): boolean {
  return members.some((row) => {
    if (row.role !== "lead") return false;
    if (actor.memberId && row.memberId === actor.memberId) return true;
    if (
      actor.sessionId &&
      (row.dshSessionId === actor.sessionId || row.nativeSession?.sessionId === actor.sessionId)
    ) {
      return true;
    }
    return false;
  });
}

export function memberIdForNativeSession(sessionId: string): string {
  return `m-${sessionId}`;
}

export function nativeSessionBindingPath(roomClockDir: string): string {
  return path.join(roomClockDir, "native-session-binding.json");
}

/** Drop identity fields a model can put in tool arguments. They are not the RPC attribution. */
export function stripModelIdentity(payload: Record<string, unknown>): Record<string, unknown> {
  const next = { ...payload };
  for (const key of MODEL_IDENTITY_KEYS) delete next[key];
  return next;
}

export function readNativeSessionBinding(roomClockDir: string): NativeSessionBindingState {
  const file = nativeSessionBindingPath(roomClockDir);
  if (!fs.existsSync(file)) throw new Error(`native session binding missing: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as NativeSessionBindingState;
  if (parsed.schema !== NATIVE_SESSION_BINDING_SCHEMA) throw new Error("native session binding schema mismatch");
  return parsed;
}

/**
 * Admit one native session into the Room. Synchronous so a Host lock can keep
 * concurrent RPC calls from dropping members. The file is the cold-recovery source.
 */
export function admitNativeSessionMember(input: {
  gate: OfficialTeamRpcGate;
  challengeId: string;
  meta: NativeSessionRpcMeta;
  tool: string;
}): NativeSessionMember {
  const sessionId = cleanId(input.meta.sessionId);
  if (!sessionId) throw new Error("TEAM_IDENTITY_UNAVAILABLE: native session id missing");
  if (input.meta.parentSessionId != null && typeof input.meta.parentSessionId !== "string") {
    throw new Error("TEAM_IDENTITY_UNAVAILABLE: parentSession is not a string");
  }
  const parentSessionId = cleanId(input.meta.parentSessionId);
  if (parentSessionId === sessionId) {
    throw new Error("TEAM_IDENTITY_UNAVAILABLE: parentSession disagrees with the member session");
  }
  if (!Number.isInteger(input.gate.maxMembers) || input.gate.maxMembers < 1) {
    throw new Error("official team maxMembers is invalid");
  }

  const state = loadOrCreate(input.gate, input.challengeId);
  const memberId = memberIdForNativeSession(sessionId);
  const existing = state.members.find((member) => member.sessionId === sessionId);
  if (existing && existing.memberId !== memberId) {
    throw new Error(`session ${sessionId} already mapped to ${existing.memberId}, not ${memberId}`);
  }
  if (!parentSessionId) {
    if (existing?.role === "worker") throw new Error("teammate cannot become the Lead root");
    if (state.leadSessionId && state.leadSessionId !== sessionId) {
      throw new Error("official team room already has a Lead");
    }
    state.leadSessionId = sessionId;
  } else {
    if (existing?.role === "lead") throw new Error("Lead root cannot gain a parentSession");
    if (existing?.parentSessionId && existing.parentSessionId !== parentSessionId) {
      throw new Error("teammate parentSession is not this Room's Lead");
    }
    if (!state.leadSessionId || state.leadSessionId !== parentSessionId) {
      throw new Error("teammate parentSession is not this Room's Lead");
    }
  }
  if (!existing && state.members.length >= input.gate.maxMembers) {
    throw new Error(`official team maxMembers ${input.gate.maxMembers} reached`);
  }

  const role: TeamMemberRole = parentSessionId ? "worker" : "lead";
  const member: NativeSessionMember = existing ?? {
    sessionId,
    memberId,
    ...(parentSessionId ? { parentSessionId } : {}),
    role,
    tools: [],
  };
  if (parentSessionId && !member.parentSessionId) member.parentSessionId = parentSessionId;
  if (!member.tools.includes(input.tool)) member.tools.push(input.tool);
  if (!existing) state.members.push(member);
  writeBinding(input.gate.roomClockDir, state);
  writeTeamProjection(input.gate, input.challengeId, state, sessionId);
  return member;
}

function loadOrCreate(gate: OfficialTeamRpcGate, challengeId: string): NativeSessionBindingState {
  const file = nativeSessionBindingPath(gate.roomClockDir);
  if (!fs.existsSync(file)) {
    return {
      schema: NATIVE_SESSION_BINDING_SCHEMA,
      challengeId,
      roomId: gate.roomId,
      maxMembers: gate.maxMembers,
      members: [],
    };
  }
  const state = readNativeSessionBinding(gate.roomClockDir);
  if (state.challengeId !== challengeId) {
    throw new Error(`native session binding is bound to ${state.challengeId}, not ${challengeId}`);
  }
  if (state.roomId !== gate.roomId) {
    throw new Error(`native session binding is bound to room ${state.roomId}, not ${gate.roomId}`);
  }
  if (state.maxMembers !== gate.maxMembers) {
    throw new Error(`official team maxMembers ${gate.maxMembers} disagrees with durable cap ${state.maxMembers}`);
  }
  return state;
}

function writeBinding(roomClockDir: string, state: NativeSessionBindingState): void {
  const file = nativeSessionBindingPath(roomClockDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Room projection status. A parked native session must not stay `active`. */
export function officialTeamMemberViewStatus(input: {
  previousStatus?: string;
  previousStopReason?: string;
  admitted: boolean;
  held: boolean;
}): { status: RoomMemberRunStatus; stopReason?: string } {
  if (input.held) {
    return {
      status: (input.previousStatus ?? "stopped") as RoomMemberRunStatus,
      ...(input.previousStopReason ? { stopReason: input.previousStopReason } : {}),
    };
  }
  const parked =
    input.previousStatus === "idle_awaiting_host_wake" ||
    input.previousStopReason === "idle_awaiting_host_wake";
  if (parked && !input.admitted) {
    return { status: "idle_awaiting_host_wake", stopReason: "idle_awaiting_host_wake" };
  }
  if (input.admitted) return { status: "active" };
  return {
    status: (input.previousStatus ?? "active") as RoomMemberRunStatus,
    ...(input.previousStopReason ? { stopReason: input.previousStopReason } : {}),
  };
}

function writeTeamProjection(
  gate: OfficialTeamRpcGate,
  challengeId: string,
  state: NativeSessionBindingState,
  admittedSessionId: string,
): void {
  const now = new Date().toISOString();
  const file = roomMembersPath(gate.roomClockDir, challengeId);
  const previous = readRoomMembers(file);
  const prior = new Map(previous?.members.map((row) => [row.memberId, row]) ?? []);
  const members: RoomMemberRecord[] = state.members.map((member) => {
    const old = prior.get(member.memberId);
    // stopped/terminal stay put. interrupted is the SIGINT snapshot and must
    // become active again when this session is re-admitted on resume.
    const held = old?.status === "stopped" || old?.status === "terminal" ? old : undefined;
    const admitted = member.sessionId === admittedSessionId;
    const viewed = officialTeamMemberViewStatus({
      ...(old?.status ? { previousStatus: old.status } : {}),
      ...(old?.stopReason ? { previousStopReason: old.stopReason } : {}),
      admitted,
      held: Boolean(held),
    });
    const status = viewed.status;
    const stopReason = viewed.stopReason;
    return {
      memberId: member.memberId,
      nativeSession: {
        sessionId: member.sessionId,
        ...(member.parentSessionId ? { parentSessionId: member.parentSessionId } : {}),
      },
      role: member.role,
      duty: old?.duty ?? (member.role === "lead" ? "coordinate" : "explore"),
      dshSessionId: member.sessionId,
      status,
      ...(stopReason ? { stopReason } : {}),
      updatedAt: now,
    };
  });
  const projection: RoomMembersState = {
    schema: "silver.room-members.v1",
    roomId: gate.roomId,
    challengeId,
    updatedAt: now,
    members,
  };
  writeRoomMembers(file, projection);
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
