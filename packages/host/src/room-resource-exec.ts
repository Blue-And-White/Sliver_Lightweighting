/**
 * C6: execute C3 deferred recruit/remove resource intents against Room roster.
 * Does not spawn DSH — returns spawn/stop requests for the CLI Host loop.
 * Idempotent on requestId / already-bound members. maxMembers is a hard refuse.
 */
import fs from "node:fs";
import path from "node:path";
import {
  findResourceIntentByRequestId,
  roomResourceIntentPath,
  roomResourceIntentsDir,
  type RoomResourceIntent,
} from "./decision-envelope.ts";
import {
  readRoomMembers,
  roomMembersPath,
  appendRoomMember,
  upsertRoomMember,
  writeRoomMembers,
  type RoomMemberRole,
  type RoomMembersState,
  type TeamMemberSpec,
} from "./room-members.ts";
import { withRoomLedgerLock } from "./room-ledger-lock.ts";

export type RoomRecruitSpawnRequest = {
  kind: "spawn";
  intentId: string;
  requestId: string;
  memberId: string;
  attemptId: string;
  role: RoomMemberRole;
  duty?: string;
};

export type RoomRemoveStopRequest = {
  kind: "stop";
  intentId: string;
  requestId: string;
  memberId: string;
  attemptId?: string;
};

export type ExecuteRoomResourceIntentResult =
  | {
      ok: true;
      outcome: "spawn" | "stop" | "already_executed" | "refused";
      intent: RoomResourceIntent;
      spawn?: RoomRecruitSpawnRequest;
      stop?: RoomRemoveStopRequest;
      members: RoomMembersState;
      reason?: string;
    }
  | { ok: false; reason: string; intent?: RoomResourceIntent; members?: RoomMembersState };

export type ExecuteRoomResourceIntentsInput = {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  maxMembers: number;
  /** Specific intent ids from a decision apply; omit = all deferred in dir. */
  intentIds?: string[];
  nowMs?: number;
};

function activeMemberCount(members: RoomMembersState): number {
  return members.members.filter(
    (row) =>
      row.status !== "terminal" &&
      row.status !== "interrupted" &&
      row.status !== "blocked" &&
      row.status !== "stopped",
  ).length;
}

function nextWorkerMemberId(members: RoomMembersState): string {
  let max = 0;
  for (const row of members.members) {
    const m = /^worker-(\d+)$/.exec(row.memberId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `worker-${max + 1}`;
}

function nextAttemptId(members: RoomMembersState): string {
  let max = -1;
  for (const row of members.members) {
    const m = /^a(\d+)$/.exec(row.attemptId ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `a${max + 1}`;
}

function writeIntent(roomClockDir: string, intent: RoomResourceIntent): void {
  const file = roomResourceIntentPath(roomClockDir, intent.intentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(intent, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readIntentFile(file: string): RoomResourceIntent | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RoomResourceIntent;
    if (parsed?.schema !== "silver.room-resource-intent.v1") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function listDeferredResourceIntents(roomClockDir: string): RoomResourceIntent[] {
  const dir = roomResourceIntentsDir(roomClockDir);
  if (!fs.existsSync(dir)) return [];
  const out: RoomResourceIntent[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const intent = readIntentFile(path.join(dir, name));
    if (!intent) continue;
    if (intent.execution === "deferred" && intent.status === "recorded") out.push(intent);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Allocate a stable worker slot under maxMembers. Idempotent if requestId already bound.
 */
export function planRecruitMember(input: {
  members: RoomMembersState;
  maxMembers: number;
  role?: RoomMemberRole;
  duty?: string;
  requestId: string;
}):
  | { ok: true; spec: TeamMemberSpec; alreadyBound: boolean }
  | { ok: false; reason: string } {
  const role = input.role ?? "worker";
  if (role === "lead") {
    return { ok: false, reason: "recruit_lead_refused: swarm Room already has Lead" };
  }
  const existing = input.members.members.find(
    (row) => row.duty === `recruit:${input.requestId}` || row.memberId === `recruit:${input.requestId}`,
  );
  // Prefer explicit binding via intent later; also detect by requestId tag in duty.
  const byDuty = input.members.members.find((row) => row.duty?.includes(`req:${input.requestId}`));
  if (byDuty) {
    if (!byDuty.attemptId) {
      return { ok: false, reason: "recruit_binding_not_independent_root" };
    }
    return {
      ok: true,
      alreadyBound: true,
      spec: {
        memberId: byDuty.memberId,
        attemptId: byDuty.attemptId,
        role: byDuty.role,
        ...(byDuty.duty ? { duty: byDuty.duty } : {}),
      },
    };
  }
  void existing;
  if (activeMemberCount(input.members) >= input.maxMembers) {
    return { ok: false, reason: `maxMembers_reached:${input.maxMembers}` };
  }
  const memberId = nextWorkerMemberId(input.members);
  const attemptId = nextAttemptId(input.members);
  const duty = input.duty?.trim() || `explore;req:${input.requestId}`;
  const taggedDuty = duty.includes(`req:${input.requestId}`) ? duty : `${duty};req:${input.requestId}`;
  return {
    ok: true,
    alreadyBound: false,
    spec: { memberId, attemptId, role: "worker", duty: taggedDuty },
  };
}

export async function executeRoomResourceIntent(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  maxMembers: number;
  intentId: string;
  nowMs?: number;
}): Promise<ExecuteRoomResourceIntentResult> {
  const roomKey = `${input.roomId}:${input.challengeId}`;
  return withRoomLedgerLock(roomKey, () => executeRoomResourceIntentUnlocked(input));
}

export async function executeDeferredRoomResourceIntents(
  input: ExecuteRoomResourceIntentsInput,
): Promise<ExecuteRoomResourceIntentResult[]> {
  const intents =
    input.intentIds && input.intentIds.length > 0
      ? input.intentIds
          .map((id) => readIntentFile(roomResourceIntentPath(input.roomClockDir, id)))
          .filter((row): row is RoomResourceIntent => Boolean(row))
      : listDeferredResourceIntents(input.roomClockDir);
  const results: ExecuteRoomResourceIntentResult[] = [];
  for (const intent of intents) {
    results.push(
      await executeRoomResourceIntent({
        roomClockDir: input.roomClockDir,
        roomId: input.roomId,
        challengeId: input.challengeId,
        maxMembers: input.maxMembers,
        intentId: intent.intentId,
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      }),
    );
  }
  return results;
}

function executeRoomResourceIntentUnlocked(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  maxMembers: number;
  intentId: string;
  nowMs?: number;
}): ExecuteRoomResourceIntentResult {
  const file = roomResourceIntentPath(input.roomClockDir, input.intentId);
  const intent = readIntentFile(file);
  if (!intent) return { ok: false, reason: "intent_missing" };
  if (intent.roomId !== input.roomId || intent.challengeId !== input.challengeId) {
    return { ok: false, reason: "intent_room_identity_mismatch", intent };
  }

  const membersFile = roomMembersPath(input.roomClockDir, input.challengeId);
  let members = readRoomMembers(membersFile);
  if (!members) {
    return { ok: false, reason: "room_members_missing", intent };
  }

  const now = new Date(input.nowMs ?? Date.now()).toISOString();

  if (intent.execution !== "deferred" || intent.status !== "recorded") {
    return {
      ok: true,
      outcome: intent.status === "refused" ? "refused" : "already_executed",
      intent,
      members,
      ...(intent.refuseReason ? { reason: intent.refuseReason } : {}),
      ...(intent.kind === "recruit" && intent.boundMemberId
        ? {
            spawn: {
              kind: "spawn" as const,
              intentId: intent.intentId,
              requestId: intent.requestId,
              memberId: intent.boundMemberId,
              attemptId: intent.boundAttemptId ?? "",
              role: "worker" as const,
              ...(intent.payload.duty ? { duty: intent.payload.duty } : {}),
            },
          }
        : {}),
      ...(intent.kind === "remove" && intent.payload.memberId
        ? {
            stop: {
              kind: "stop" as const,
              intentId: intent.intentId,
              requestId: intent.requestId,
              memberId: intent.payload.memberId,
              ...(intent.boundAttemptId ? { attemptId: intent.boundAttemptId } : {}),
            },
          }
        : {}),
    };
  }

  if (intent.kind === "recruit") {
    const planned = planRecruitMember({
      members,
      maxMembers: input.maxMembers,
      requestId: intent.requestId,
      ...(intent.payload.role ? { role: intent.payload.role } : {}),
      ...(intent.payload.duty ? { duty: intent.payload.duty } : {}),
    });
    if (!planned.ok) {
      const refused: RoomResourceIntent = {
        ...intent,
        status: "refused",
        execution: "refused",
        refuseReason: planned.reason,
        settledAt: now,
      };
      writeIntent(input.roomClockDir, refused);
      return { ok: true, outcome: "refused", intent: refused, members, reason: planned.reason };
    }
    if (!planned.alreadyBound) {
      members = appendRoomMember(members, planned.spec, input.nowMs);
      writeRoomMembers(membersFile, members);
    }
    const executed: RoomResourceIntent = {
      ...intent,
      status: "executed",
      execution: "completed",
      boundMemberId: planned.spec.memberId,
      boundAttemptId: planned.spec.attemptId,
      settledAt: now,
    };
    writeIntent(input.roomClockDir, executed);
    return {
      ok: true,
      outcome: planned.alreadyBound ? "already_executed" : "spawn",
      intent: executed,
      members,
      spawn: {
        kind: "spawn",
        intentId: intent.intentId,
        requestId: intent.requestId,
        memberId: planned.spec.memberId,
        attemptId: planned.spec.attemptId,
        role: planned.spec.role,
        ...(planned.spec.duty ? { duty: planned.spec.duty } : {}),
      },
    };
  }

  // remove
  const memberId = intent.payload.memberId?.trim();
  if (!memberId) {
    return { ok: false, reason: "remove_missing_memberId", intent, members };
  }
  if (memberId === "lead") {
    const refused: RoomResourceIntent = {
      ...intent,
      status: "refused",
      execution: "refused",
      refuseReason: "remove_lead_refused",
      settledAt: now,
    };
    writeIntent(input.roomClockDir, refused);
    return { ok: true, outcome: "refused", intent: refused, members, reason: "remove_lead_refused" };
  }
  const row = members.members.find((m) => m.memberId === memberId);
  if (!row || !row.attemptId) {
    const refused: RoomResourceIntent = {
      ...intent,
      status: "refused",
      execution: "refused",
      refuseReason: "member_not_found",
      settledAt: now,
    };
    writeIntent(input.roomClockDir, refused);
    return { ok: true, outcome: "refused", intent: refused, members, reason: "member_not_found" };
  }
  members = upsertRoomMember(
    members,
    { memberId, status: "interrupted", stopReason: "removed_by_lead" },
    input.nowMs,
  );
  writeRoomMembers(membersFile, members);
  const executed: RoomResourceIntent = {
    ...intent,
    status: "executed",
    execution: "completed",
    boundMemberId: memberId,
    boundAttemptId: row.attemptId,
    settledAt: now,
  };
  writeIntent(input.roomClockDir, executed);
  return {
    ok: true,
    outcome: "stop",
    intent: executed,
    members,
    stop: {
      kind: "stop",
      intentId: intent.intentId,
      requestId: intent.requestId,
      memberId,
      attemptId: row.attemptId,
    },
  };
}

/** Test helper: resolve intent by requestId after exec. */
export function requireResourceIntentByRequestId(
  roomClockDir: string,
  requestId: string,
): RoomResourceIntent {
  const hit = findResourceIntentByRequestId(roomClockDir, requestId);
  if (!hit) throw new Error(`resource intent missing for requestId=${requestId}`);
  return hit;
}
