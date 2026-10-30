/**
 * Experimental D2: C3 recruit/remove permits for one official Team.
 * Silver grants Host capability permits and binds the native DSH roster.
 * DSH owns teammate transport, lifecycle, mailbox, and Team tasks. This path
 * never starts a C6 independent root.
 * Not the default swarm.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { convergenceGenerationPath } from "./convergence-generation.ts";
import {
  applyDecisionEnvelope,
  roomResourceIntentPath,
  type DecisionActionResult,
  type DecisionEnvelope,
  type RoomResourceIntent,
} from "./decision-envelope.ts";
import { memberIdForNativeSession, nativeSessionBindingPath, readNativeSessionBinding } from "./team-member-identity.ts";
import { readRoomClock, roomClockPath, roomExpired } from "./room-clock.ts";
import {
  readRoomMembers,
  roomMembersPath,
  upsertRoomMember,
  writeRoomMembers,
} from "./room-members.ts";
import type { RoomDomain } from "../../ctf-spine/src/persona.ts";
import {
  loadLeadRolePrompt,
  loadWorkerRolePrompt,
} from "../../ctf-spine/src/role-prompts.ts";
import { assertRoomAcceptsActivity } from "./room-platform-stop-state.ts";
import { withRoomLedgerLock } from "./room-ledger-lock.ts";

export const OFFICIAL_TEAM_PERMITS_SCHEMA = "silver.official-team-permits.v1" as const;

export type OfficialTeamPermitStatus =
  | "granted"
  | "bound"
  | "refused"
  /** Host capability revoked. The immutable DSH member may still exist. */
  | "removed";

export type OfficialTeamPermitOrigin = "decision" | "bootstrap" | "reserve";

export type OfficialTeamPermit = {
  schema: "silver.official-team-permit.v1";
  permitId: string;
  intentId: string;
  actionId: string;
  requestId: string;
  roomId: string;
  challengeId: string;
  kind: "recruit" | "remove";
  /** Recruit: granted → bound. Remove: granted → removed (Host policy park). */
  status: OfficialTeamPermitStatus;
  /** spawn_teammate / interrupt_agent name. Not a memberId. */
  spawnName: string;
  /** Decision-granted, opening bootstrap, or pre-authorized reserve. Omitted on legacy rows = decision. */
  origin?: OfficialTeamPermitOrigin;
  duty?: string;
  memberId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  refuseReason?: string;
};

/** Host-owned Room lifecycle while initialWorkers bootstrap. Derived from the permit ledger. */
export type OfficialTeamRoomPhase = "bootstrapping" | "active" | "bootstrap_degraded";

export type OfficialTeamBootstrapProjection = {
  state: "ok" | "in_progress";
  /** Rooms with a designated opening Anchor become active once Lead and Anchor bind. */
  phase: OfficialTeamRoomPhase;
  expectedWorkers: number;
  boundWorkers: number;
  missingWorkers: number;
};

type PermitFile = {
  schema: typeof OFFICIAL_TEAM_PERMITS_SCHEMA;
  /** Cap recorded with the first grant. Later callers must match it. */
  maxMembers?: number;
  /** Bootstrap expected Workers (excludes Lead). First writer wins. */
  expectedWorkers?: number;
  permits: OfficialTeamPermit[];
};

type InterruptArgs = { name: "interrupt_agent"; args: { target: string } };

export function officialTeamPermitsPath(roomClockDir: string): string {
  return path.join(roomClockDir, "official-team-permits.json");
}

export function readOfficialTeamPermits(roomClockDir: string): OfficialTeamPermit[] {
  return readPermitFile(roomClockDir)?.permits ?? [];
}

/**
 * Apply one C3 envelope, then grant official-Team permits. Does not spawn.
 * A recruit permit is the Lead's permission to call spawn_teammate.
 */
export async function grantOfficialTeamPermits(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  maxMembers: number;
  envelope: DecisionEnvelope | unknown;
  nowMs?: number;
}): Promise<
  | { ok: true; permits: OfficialTeamPermit[] }
  | { ok: false; reason: string; permits: OfficialTeamPermit[] }
> {
  assertOfficialTeamResourceOpen(input);
  refuseIndependentRoots(input.roomClockDir, input.challengeId);
  resolveDurableMaxMembers(input.roomClockDir, input.maxMembers);
  const apply = await applyDecisionEnvelope({
    roomClockDir: input.roomClockDir,
    envelope: input.envelope,
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  });
  if (!apply.ok) return { ok: false, reason: apply.reason, permits: [] };
  const roomKey = `${input.roomId}:${input.challengeId}`;
  return withRoomLedgerLock(roomKey, () => {
    // Deadline or platform stop can land between apply and this lock.
    assertOfficialTeamResourceOpen(input);
    refuseIndependentRoots(input.roomClockDir, input.challengeId);
    const maxMembers = resolveDurableMaxMembers(input.roomClockDir, input.maxMembers);
    return grantFromApplied({ ...input, maxMembers }, apply.actions);
  });
}

/** Already-bound session, or the exact granted permitId named by the first RPC. */
export function officialTeamRecruitAllowsSession(
  roomClockDir: string,
  sessionId: string,
  permitId?: string,
): boolean {
  return officialTeamRecruitBlockReason(roomClockDir, sessionId, permitId) === "ok";
}

export function officialTeamRecruitBlockReason(
  roomClockDir: string,
  sessionId: string,
  permitId?: string,
): "ok" | "removed" | "required" {
  const permits = readOfficialTeamPermits(roomClockDir);
  const bound = permits.find((row) => row.kind === "recruit" && row.sessionId === sessionId);
  if (bound) {
    if (bound.status === "removed" || sessionHeld(roomClockDir, bound)) return "removed";
    if (
      permits.some((row) => row.kind === "remove" && row.memberId === bound.memberId && row.status === "removed")
    ) {
      return "removed";
    }
    return bound.status === "bound" ? "ok" : "required";
  }
  if (!permitId) return "required";
  const permit = permits.find((row) => row.permitId === permitId && row.kind === "recruit");
  if (!permit || !recruitBindable(permit.status)) return "required";
  if (permit.sessionId && permit.sessionId !== sessionId) return "required";
  return "ok";
}

/** Bind the permit named by this session. Arrival order is not a mapping. */
export async function bindOfficialTeamRecruitPermit(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  permitId: string;
  sessionId: string;
  parentSessionId: string;
  nowMs?: number;
}): Promise<OfficialTeamPermit> {
  return withRoomLedgerLock(`${input.roomId}:${input.challengeId}`, () => bindUnlocked(input));
}

/** Revoke Host capability immediately; interrupt is only a best-effort turn cancellation. */
export async function consumeOfficialTeamRemovePermit(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  permitId: string;
  nowMs?: number;
}): Promise<{ permit: OfficialTeamPermit; interrupt: InterruptArgs }> {
  return withRoomLedgerLock(`${input.roomId}:${input.challengeId}`, () => removeUnlocked(input));
}

function grantFromApplied(
  input: {
    roomClockDir: string;
    challengeId: string;
    maxMembers: number;
    nowMs?: number;
  },
  actions: DecisionActionResult[],
): { ok: true; permits: OfficialTeamPermit[] } | { ok: false; reason: string; permits: OfficialTeamPermit[] } {
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  const permits = readOfficialTeamPermits(input.roomClockDir);
  const granted: OfficialTeamPermit[] = [];
  for (const action of actions) {
    if (!action.ok || (action.type !== "recruit" && action.type !== "remove")) continue;
    if (!("intentId" in action) || typeof action.intentId !== "string" || !action.intentId) continue;
    const intent = readIntent(input.roomClockDir, action.intentId);
    if (!intent) continue;
    const existing = permits.find((row) => row.intentId === intent.intentId || row.actionId === action.actionId);
    if (existing) {
      granted.push(existing);
      continue;
    }
    if (intent.execution === "completed") continue;
    if (intent.status === "refused" || intent.execution === "refused") {
      const permit = permitFromIntent(intent, "refused", now, action.actionId, intent.refuseReason);
      permits.push(permit);
      granted.push(permit);
      continue;
    }
    if (intent.execution !== "deferred") continue;
    const permit =
      intent.kind === "recruit"
        ? grantRecruit(input, intent, permits, now, action.actionId)
        : grantRemove(input.roomClockDir, input.challengeId, intent, permits, now, action.actionId);
    permits.push(permit);
    granted.push(permit);
  }
  writePermits(input.roomClockDir, permits, input.maxMembers);
  const refused = granted.find((row) => row.status === "refused");
  if (refused) return { ok: false, reason: refused.refuseReason ?? "permit_refused", permits: granted };
  return { ok: true, permits: granted };
}

function grantRecruit(
  input: { roomClockDir: string; maxMembers: number },
  intent: RoomResourceIntent,
  permits: OfficialTeamPermit[],
  now: string,
  actionId: string,
): OfficialTeamPermit {
  const used = occupiedSlots(input.roomClockDir, intent.challengeId, permits);
  if (!Number.isInteger(input.maxMembers) || input.maxMembers < 1 || used >= input.maxMembers) {
    const reason = `maxMembers_reached:${input.maxMembers}`;
    settleIntent(input.roomClockDir, intent, {
      status: "refused",
      execution: "refused",
      refuseReason: reason,
      settledAt: now,
    });
    return permitFromIntent(intent, "refused", now, actionId, reason);
  }
  return permitFromIntent(intent, "granted", now, actionId);
}

function grantRemove(
  roomClockDir: string,
  challengeId: string,
  intent: RoomResourceIntent,
  permits: OfficialTeamPermit[],
  now: string,
  actionId: string,
): OfficialTeamPermit {
  const memberId = intent.payload.memberId?.trim();
  const members = readRoomMembers(roomMembersPath(roomClockDir, challengeId));
  const row = members?.members.find((member) => member.memberId === memberId);
  if (!row?.nativeSession || row.attemptId) {
    const reason = row?.attemptId ? "official_team_refuses_independent_root" : "member_not_found";
    settleIntent(roomClockDir, intent, {
      status: "refused",
      execution: "refused",
      refuseReason: reason,
      settledAt: now,
    });
    return permitFromIntent(intent, "refused", now, actionId, reason);
  }
  const recruit = permits.find((permit) => permit.kind === "recruit" && permit.memberId === memberId);
  const permit = permitFromIntent(intent, "granted", now, actionId);
  if (recruit) permit.spawnName = recruit.spawnName;
  permit.memberId = row.memberId;
  return permit;
}

function bindUnlocked(input: {
  roomClockDir: string;
  challengeId: string;
  permitId: string;
  sessionId: string;
  parentSessionId: string;
  nowMs?: number;
}): OfficialTeamPermit {
  refuseIndependentRoots(input.roomClockDir, input.challengeId);
  const permits = readOfficialTeamPermits(input.roomClockDir);
  const permit = permits.find((row) => row.permitId === input.permitId);
  if (!permit || permit.kind !== "recruit") {
    throw new Error("official team recruit permit required before spawn_teammate");
  }
  if (permit.status === "bound" && permit.sessionId === input.sessionId) return permit;
  if (permit.sessionId && permit.sessionId !== input.sessionId) {
    throw new Error("official team recruit permit is already bound");
  }
  if (!recruitBindable(permit.status)) {
    throw new Error("official team recruit permit required before spawn_teammate");
  }
  const taken = permits.find(
    (row) => row.kind === "recruit" && row.sessionId === input.sessionId && row.permitId !== permit.permitId,
  );
  if (taken) throw new Error("official team session is already bound to another permit");
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  const memberId = memberIdForNativeSession(input.sessionId);
  permit.status = "bound";
  permit.sessionId = input.sessionId;
  permit.memberId = memberId;
  permit.updatedAt = now;
  const members = readRoomMembers(roomMembersPath(input.roomClockDir, input.challengeId));
  if (!members) throw new Error("official team roster missing for permit bind");
  const duty = permit.duty ? `${permit.duty};req:${permit.requestId}` : `req:${permit.requestId}`;
  const nextMembers = members.members.some((row) => row.memberId === memberId)
    ? upsertRoomMember(members, { memberId, duty }, input.nowMs)
    : {
        ...members,
        members: [
          ...members.members,
          {
            memberId,
            nativeSession: { sessionId: input.sessionId, parentSessionId: input.parentSessionId },
            role: "worker" as const,
            duty,
            dshSessionId: input.sessionId,
            status: "active" as const,
            updatedAt: now,
          },
        ],
        updatedAt: now,
      };
  writeRoomMembers(roomMembersPath(input.roomClockDir, input.challengeId), nextMembers);
  const intent = readIntent(input.roomClockDir, permit.intentId);
  if (intent && intent.execution !== "completed") {
    settleIntent(input.roomClockDir, intent, {
      status: "executed",
      execution: "completed",
      boundMemberId: memberId,
      settledAt: now,
    });
  }
  writePermits(input.roomClockDir, permits);
  return permit;
}

function removeUnlocked(input: {
  roomClockDir: string;
  challengeId: string;
  permitId: string;
  nowMs?: number;
}): { permit: OfficialTeamPermit; interrupt: InterruptArgs } {
  const permits = readOfficialTeamPermits(input.roomClockDir);
  const permit = permits.find((row) => row.permitId === input.permitId);
  if (!permit || permit.kind !== "remove" || !permit.memberId) {
    throw new Error("official team remove permit is not granted");
  }
  if (permit.status === "removed") return { permit, interrupt: interruptArgs(permit) };
  if (permit.status !== "granted") throw new Error("official team remove permit is not granted");
  const members = readRoomMembers(roomMembersPath(input.roomClockDir, input.challengeId));
  const row = members?.members.find((member) => member.memberId === permit.memberId);
  if (!members || !row?.nativeSession || row.attemptId) throw new Error("official_team_refuses_independent_root");
  const now = new Date(input.nowMs ?? Date.now()).toISOString();
  if (row.status !== "stopped") {
    writeRoomMembers(
      roomMembersPath(input.roomClockDir, input.challengeId),
      upsertRoomMember(
        members,
        { memberId: permit.memberId, status: "stopped", stopReason: "removed_by_lead" },
        input.nowMs,
      ),
    );
  }
  for (const recruit of permits) {
    if (recruit.kind === "recruit" && recruit.memberId === permit.memberId && recruit.status !== "removed") {
      recruit.status = "removed";
      recruit.updatedAt = now;
    }
  }
  permit.status = "removed";
  permit.updatedAt = now;
  writePermits(input.roomClockDir, permits);
  const intent = readIntent(input.roomClockDir, permit.intentId);
  if (intent && intent.execution !== "completed") {
    settleIntent(input.roomClockDir, intent, {
      status: "executed",
      execution: "completed",
      boundMemberId: permit.memberId,
      settledAt: now,
    });
  }
  return { permit, interrupt: interruptArgs(permit) };
}

/**
 * Pre-mint bootstrap recruit permits. Reuses the same ledger, stable IDs, and
 * recovery rules. Does not fabricate a convergence generation or Lead decision,
 * and does not spawn teammates.
 */
export async function ensureOfficialTeamBootstrapPermits(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  initialWorkers: number;
  maxWorkers: number;
  workerRoles?: readonly string[];
  nowMs?: number;
}): Promise<OfficialTeamPermit[]> {
  if (!Number.isInteger(input.initialWorkers) || input.initialWorkers < 0) {
    throw new Error("official team initialWorkers is invalid");
  }
  if (!Number.isInteger(input.maxWorkers) || input.maxWorkers < 0) {
    throw new Error("official team maxWorkers is invalid");
  }
  if (input.initialWorkers > input.maxWorkers) {
    throw new Error("official team initialWorkers must be <= maxWorkers");
  }
  refuseIndependentRoots(input.roomClockDir, input.challengeId);
  return withRoomLedgerLock(`${input.roomId}:${input.challengeId}`, () => {
    refuseIndependentRoots(input.roomClockDir, input.challengeId);
    const now = new Date(input.nowMs ?? Date.now()).toISOString();
    const file = readPermitFile(input.roomClockDir);
    const permits = file?.permits ?? [];
    const expectedWorkers = resolveDurableExpectedWorkers(input.roomClockDir, input.initialWorkers);
    const maxMembers = resolveDurableMaxMembers(input.roomClockDir, input.maxWorkers + 1);
    const initial: OfficialTeamPermit[] = [];
    for (let workerIndex = 0; workerIndex < input.maxWorkers; workerIndex += 1) {
      const permitId = officialTeamBootstrapPermitId(input.roomId, workerIndex);
      const existing = permits.find((row) => row.permitId === permitId && row.kind === "recruit");
      if (existing) {
        if (workerIndex < expectedWorkers) initial.push(normalizePermit(existing));
        continue;
      }
      const permit = mintBootstrapPermit(input, workerIndex, workerIndex < expectedWorkers, now);
      permits.push(permit);
      if (workerIndex < expectedWorkers) initial.push(permit);
    }
    writePermits(input.roomClockDir, permits, maxMembers, expectedWorkers);
    return initial;
  });
}

/** Build the Lead bootstrap instruction from unbound Host permits. */
export function planOfficialTeamBootstrapFollowUp(input: {
  roomClockDir: string;
  freshRetry?: boolean;
}): {
  followUp?: string;
  permitIds: string[];
  openingAnchor: boolean;
  anchorSequence: boolean;
  projection: OfficialTeamBootstrapProjection;
} {
  const permits = readOfficialTeamPermits(input.roomClockDir);
  return {
    ...planFromPermits(permits, input.freshRetry === true),
    projection: officialTeamBootstrapProjection(input.roomClockDir),
  };
}

function planFromPermits(permits: readonly OfficialTeamPermit[], freshRetry: boolean): {
  followUp?: string;
  permitIds: string[];
  openingAnchor: boolean;
  anchorSequence: boolean;
} {
  const bootstrapPermits = permits.filter(
    (row) => isBootstrapPermit(row) && row.kind === "recruit",
  );
  const reservePermits = permits.filter(
    (row) => isReservePermit(row) && row.kind === "recruit",
  );
  const anchorPermit = freshRetry
    ? undefined
    : bootstrapPermits.find(
        (row) =>
          (row.status === "granted" || row.status === "bound") &&
          row.requestId === "bootstrap:0" &&
          row.duty === "bootstrap:0",
      );
  const spawnNames: Array<{ spawnName: string; permitId: string; duty?: string; openingAnchor?: boolean }> = [];
  const deferredSpawns: Array<{ spawnName: string; permitId: string; duty?: string }> = [];
  const reserveSpawns: Array<{ spawnName: string; permitId: string }> = [];
  const permitIds: string[] = [];
  for (const row of bootstrapPermits) {
    if (row.status !== "granted") continue;
    permitIds.push(row.permitId);
    const spawn = {
      spawnName: row.spawnName,
      permitId: row.permitId,
      ...(row.duty ? { duty: row.duty } : {}),
    };
    if (anchorPermit && row.permitId !== anchorPermit.permitId) {
      deferredSpawns.push(spawn);
    } else {
      spawnNames.push({
        ...spawn,
        ...(anchorPermit?.permitId === row.permitId ? { openingAnchor: true } : {}),
      });
    }
  }
  for (const row of reservePermits) {
    if (row.status !== "granted") continue;
    reserveSpawns.push({ spawnName: row.spawnName, permitId: row.permitId });
  }
  const followUp = officialTeamFollowUp({
    spawns: spawnNames,
    deferredSpawns,
    reserveSpawns,
    ...(anchorPermit ? { anchorSpawnName: anchorPermit.spawnName } : {}),
    interrupts: [],
    freshRetry,
  });
  return {
    ...(followUp ? { followUp } : {}),
    permitIds,
    openingAnchor: anchorPermit?.status === "granted",
    anchorSequence: Boolean(anchorPermit),
  };
}

export function officialTeamBootstrapProjection(roomClockDir: string): OfficialTeamBootstrapProjection {
  const file = readPermitFile(roomClockDir);
  if (!file) {
    return {
      state: "in_progress",
      phase: "bootstrapping",
      expectedWorkers: 0,
      boundWorkers: 0,
      missingWorkers: 0,
    };
  }
  const expectedWorkers = file.expectedWorkers ?? file.permits.filter((row) => isBootstrapPermit(row)).length;
  const bootstrap = (file?.permits ?? []).filter((row) => isBootstrapPermit(row) && row.kind === "recruit");
  const boundWorkers = bootstrap.filter((row) => row.status === "bound").length;
  const missingWorkers = Math.max(0, expectedWorkers - boundWorkers);
  const state = missingWorkers === 0 ? "ok" : "in_progress";
  const openingAnchor = bootstrap.find(
    (row) => row.requestId === "bootstrap:0" && row.duty === "bootstrap:0",
  );
  const leadReady = (() => {
    const bindingFile = nativeSessionBindingPath(roomClockDir);
    if (!fs.existsSync(bindingFile)) return false;
    return Boolean(readNativeSessionBinding(roomClockDir).leadSessionId?.trim());
  })();
  // Binding is the durable activation boundary. A later remove must not regress
  // an already-active Room back into bootstrap.
  const stagedOpeningReady = leadReady && Boolean(openingAnchor?.memberId && openingAnchor.sessionId);
  const phase: OfficialTeamRoomPhase =
    expectedWorkers <= 0
      ? "active"
      : state === "ok" || stagedOpeningReady
        ? "active"
        : "bootstrapping";
  return { state, phase, expectedWorkers, boundWorkers, missingWorkers };
}

/** Host-side Room phase from the permit ledger. Not model-applied. */
export function officialTeamRoomPhase(roomClockDir: string): OfficialTeamRoomPhase {
  return officialTeamBootstrapProjection(roomClockDir).phase;
}

export function officialTeamRoomIsBootstrapping(roomClockDir: string): boolean {
  return officialTeamRoomPhase(roomClockDir) === "bootstrapping";
}

/**
 * Lead's first prompt while the Room is bootstrapping.
 * Reuses officialTeamFollowUp / recovery text. Must not include solve instructions.
 */
export function officialTeamBootstrapLeadPrompt(input: {
  challengeId: string;
  memberId: string;
  duty: string;
  followUp: string;
  freshRetry?: boolean;
  openingAnchor?: boolean;
  anchorSequence?: boolean;
}): string {
  const openingAnchor = input.freshRetry !== true && input.openingAnchor === true;
  const anchorSequence = input.freshRetry !== true && input.anchorSequence === true;
  return [
    `Formal room member identity: roomId=${input.challengeId} memberId=${input.memberId} role=lead duty=${input.duty}.`,
    "Process/session/member ids are distinct; keep using this memberId across resumes.",
    openingAnchor
      ? "The shared task and authoritative acceptance contract apply to every member. Start one Worker on the full goal first and keep the remaining Worker permits reserved. After the first Worker is admitted, the Lead role contract governs whether and when more Workers are needed."
      : anchorSequence
        ? "The shared task and authoritative acceptance contract apply to every member. The first full-goal Worker is already admitted. Keep the remaining permits reserved; the Lead role contract governs whether and when more Workers are needed."
        : "The shared task and authoritative acceptance contract apply to every member. Start the configured opening teammates with their provided responsibilities and permits.",
    input.freshRetry
      ? "This is a fresh retry. Read prior room state and publish one concise prior-state summary before listing or spawning Workers."
      : openingAnchor
        ? "Read the task and current room state, then complete the room_info admission and list_agents roster check below before spawning the first Worker."
        : anchorSequence
          ? "Read the task, current room state, and current DSH roster."
          : "Before spawning, read the task and current room state.",
    openingAnchor
      ? "Your bootstrap job is to start only the first Worker on the whole Room goal. Keep the other permits reserved. After that Worker is admitted, use them only when the Lead role contract calls for another concurrent owner."
      : anchorSequence
        ? "Bootstrap is complete. Keep the remaining permits reserved and use them only when the Lead role contract calls for another concurrent owner."
        : "Your bootstrap job is to call official spawn_teammate for each configured opening teammate with its provided responsibility and permitId.",
    "Each teammate must bind via its permitId by calling room_info first.",
    "Bootstrap controls identity, admission, and spawn order only. The Lead and Worker role contracts govern coordination and technical work. Authoritative completion results remain governed by room_info.acceptanceContract and current Host state.",
    "",
    input.followUp,
  ].join("\n");
}

export function officialTeamExpectedWorkers(roomClockDir: string): number {
  return officialTeamBootstrapProjection(roomClockDir).expectedWorkers;
}

/** True when this Room has Host-pre-minted bootstrap recruit permits. */
export function hasOfficialTeamBootstrapPermits(roomClockDir: string): boolean {
  return readOfficialTeamPermits(roomClockDir).some((row) => isBootstrapPermit(row) && row.kind === "recruit");
}

export function officialTeamBootstrapFollowUp(roomClockDir: string): string | undefined {
  return planOfficialTeamBootstrapFollowUp({ roomClockDir }).followUp;
}

export function officialTeamBootstrapPermitId(roomId: string, workerIndex: number): string {
  return createHash("sha256")
    .update(`silver.official-team-bootstrap.v1:${roomId}:bootstrap:${workerIndex}`)
    .digest("hex")
    .slice(0, 32);
}

export function officialTeamBootstrapSpawnName(roomId: string, workerIndex: number): string {
  const stamp = createHash("sha256")
    .update(`silver.official-team-bootstrap.v1:${roomId}:name:${workerIndex}`)
    .digest("hex")
    .slice(0, 8);
  return `boot-w${workerIndex}-${stamp}`;
}

function interruptArgs(permit: OfficialTeamPermit): InterruptArgs {
  return { name: "interrupt_agent", args: { target: permit.spawnName } };
}

function assertOfficialTeamResourceOpen(input: { roomClockDir: string; roomId: string; challengeId: string }): void {
  assertRoomAcceptsActivity({
    roomClockDir: input.roomClockDir,
    challengeId: input.challengeId,
    activity: "decision_envelope",
  });
  const clock = readRoomClock(roomClockPath(input.roomClockDir, input.roomId));
  if (clock && roomExpired(clock)) throw new Error("room_deadline_expired");
}

function refuseIndependentRoots(roomClockDir: string, challengeId: string): void {
  const members = readRoomMembers(roomMembersPath(roomClockDir, challengeId));
  // The experimental Room still starts one Host Lead root. That row keeps attemptId.
  // Any other attemptId is a C6 independent root and must not run beside a teammate.
  if (members?.members.some((row) => row.attemptId && row.role !== "lead")) {
    throw new Error("official team refuses to run beside independent roots");
  }
}

/** Legacy/test compatibility wrapper around the static role prompt files. */
export function officialTeamSolveInstructions(role: "lead" | "worker", domain: RoomDomain = "ctf"): string[] {
  if (domain === "report") return [];
  return [role === "lead" ? loadLeadRolePrompt(domain) : loadWorkerRolePrompt(domain)];
}

/** Decision-turn rules. Bound memberIds come from the permit file, not the model. */
export function officialTeamDecisionAddendum(permits: readonly OfficialTeamPermit[]): string {
  const bound = permits.filter((row) => row.kind === "recruit" && row.status === "bound" && row.memberId);
  const lines = [
    "This Room is the Official Team experiment, not C6 Host recruit.",
    "Recruit is optional. You may keep the current roster, or submit empty actions to confirm this turn makes no roster change.",
    "Allowed actions: recruit or remove a bound memberId. Empty actions is a legal no-op.",
    "DSH Team tasks are the Lead-managed work map. The Lead may assign or reassign outcome-level objectives; tasks are not findings, proof, Status, or route verdicts.",
    "Do not call spawn_teammate in this decision turn.",
  ];
  if (bound.length === 0) {
    lines.push("No teammate is bound yet. Recruit only if this turn needs one.");
  } else {
    lines.push("Bound teammates:");
    for (const row of bound) {
      lines.push(`memberId=${row.memberId} spawnName=${row.spawnName} permitId=${row.permitId} status=${row.status}`);
    }
  }
  return lines.join("\n");
}

export function officialTeamFollowUp(parts: {
  spawns: Array<{ spawnName: string; permitId: string; duty?: string; openingAnchor?: boolean }>;
  deferredSpawns?: Array<{ spawnName: string; permitId: string; duty?: string }>;
  reserveSpawns?: Array<{ spawnName: string; permitId: string }>;
  anchorSpawnName?: string;
  interrupts: Array<{ spawnName: string }>;
  freshRetry?: boolean;
}): string | undefined {
  const deferredSpawns = parts.deferredSpawns ?? [];
  const reserveSpawns = parts.reserveSpawns ?? [];
  if (parts.spawns.length + deferredSpawns.length + reserveSpawns.length + parts.interrupts.length === 0) return undefined;
  const lines = [
    "Official Team follow-up.",
    "Call room_info once before any spawn_teammate so this Lead session is admitted.",
  ];
  if (parts.freshRetry) {
    lines.push(
      "This is a fresh retry with a new DSH Team root. The prior roster, private messages, Status, and Team tasks are not mounted here. Before list_agents, send_message, or spawn_teammate, read durable Feed, Intel, platform facts, and acceptance progress; if this attempt has no prior-state summary in Feed, post exactly one concise public prior-state summary, otherwise do not repeat it. Rebuild this attempt's Team tasks and owners from that public handoff.",
    );
  }
  lines.push(
    "After room_info admits this Lead and any required fresh-retry summary is posted, Call list_agents first before deciding whether each expected teammate needs send_message or spawn_teammate. Treat that DSH roster as authoritative.",
  );
  for (const row of parts.spawns) {
    const attemptInstruction = parts.freshRetry
      ? "This Worker joins the fresh retry."
      : row.openingAnchor
        ? "This is the first Worker for the whole Room goal."
        : "This Worker is a configured opening teammate.";
    const bootstrapPrompt = [
      attemptInstruction,
      `Call room_info first with permitId=${row.permitId}.`,
      "After admission, room_info supplies the canonical task and room state.",
      ...(row.duty && !row.duty.startsWith("bootstrap:")
        ? [`Your opening responsibility is: ${row.duty} This responsibility may change through normal Team coordination as evidence and match state change.`]
        : []),
      "Claim the Team task ID supplied with this handoff before starting the current responsibility. The Lead may change that responsibility later.",
    ].join(" ");
    const objectiveInstruction = row.openingAnchor
      ? "Spawn this opening Worker before remaining teammates. First create or reuse one Team task for the whole Room goal without narrowing it. If the Worker is missing, keep the task unowned and include its task ID plus an instruction to claim it in the spawn task. If the Worker already exists, assign that task before send_message."
      : "Create or reuse the matching Team task for this configured responsibility. If the teammate is missing, keep the task unowned and include its task ID plus an instruction to claim it before technical work in the spawn task. Do not race that claim after spawn; if a later reconciliation still finds it unowned, reassign it to the teammate. If it already exists, assign it before send_message.";
    const handoffInstruction = "the admission handoff, current responsibility, and matching Team task ID";
    lines.push(
      `Use this teammate contract for ${row.spawnName}: ${JSON.stringify(bootstrapPrompt)}`,
      objectiveInstruction,
      `If list_agents lists ${row.spawnName} as running or inactive, call send_message with target ${row.spawnName} and ${handoffInstruction}. Do not call spawn_teammate for that name. If it is provisioning, wait_agent once and re-list; do not send_message while it is provisioning, and if it is still provisioning continue with the remaining work instead of waiting again this turn. If it failed, report a bootstrap blocker and do not retry that name in this turn; once the Room is active, normal later recruitment may cover an outcome that remains unowned.`,
      `If that name is missing, Call spawn_teammate with name exactly ${row.spawnName} and ${handoffInstruction}.`,
      `If spawn_teammate reports that ${row.spawnName} already exists or was already used, call list_agents again and apply the same status handling. Never invent another name.`,
      `permitId=${row.permitId}`,
    );
  }
  if (deferredSpawns.length > 0) {
    const anchorToSpawn = parts.spawns.some((row) => row.openingAnchor === true);
    lines.push(
      "Reserved opening capacity follows. Do not message or spawn any reserved teammate yet.",
      anchorToSpawn
        ? "First start the first Worker."
        : `The first Worker is already admitted${parts.anchorSpawnName ? ` as ${parts.anchorSpawnName}` : ""}. Do not spawn another.`,
      "Admission of the first Worker completes bootstrap. From then on, the Lead role contract decides whether and when another concurrent owner is needed. Keep every unused permit reserved.",
    );
    for (const row of deferredSpawns) {
      const bootstrapPrompt = [
        "This Worker is reserved capacity released by the Lead for a current responsibility.",
        `Call room_info first with permitId=${row.permitId}.`,
        "After admission, room_info supplies the canonical task and room state.",
        "Claim the Team task ID supplied with this handoff before starting the current responsibility. The Lead may change that responsibility later.",
      ].join(" ");
      lines.push(
        `Reserved teammate contract for ${row.spawnName}: ${JSON.stringify(bootstrapPrompt)}`,
        "Create or reuse the matching Team task from the Lead-maintained work map. If the teammate is missing, keep the task unowned and include its task ID plus an instruction to claim it before technical work in the spawn task. Do not race that claim after spawn; if a later reconciliation still finds it unowned, reassign it to the teammate. If it already exists, assign it before send_message.",
        `Only after the first Worker is admitted and the Lead role contract calls for this teammate: If list_agents lists ${row.spawnName} as running or inactive, call send_message with target ${row.spawnName} and the admission handoff, current responsibility, and matching Team task ID. Do not call spawn_teammate for that name. If it is provisioning, wait_agent once and re-list; do not send_message while it is provisioning, and if it is still provisioning continue with the remaining work instead of waiting again this turn. If it failed, report a bootstrap blocker and do not retry that name in this turn; normal later recruitment may cover an outcome that remains unowned.`,
        `Only after the first Worker is admitted and the Lead role contract calls for this teammate: If that name is missing, Call spawn_teammate with name exactly ${row.spawnName} and the admission handoff, current responsibility, and matching Team task ID.`,
        `If spawn_teammate reports that ${row.spawnName} already exists or was already used, call list_agents again and apply the same status handling. Never invent another name.`,
        `permitId=${row.permitId}`,
      );
    }
  }
  if (reserveSpawns.length > 0) {
    lines.push(
      "Additional Worker capacity is pre-authorized below. It is not part of initial bootstrap and must not be filled merely because capacity exists.",
      "The Lead role contract governs whether and when this capacity is used. Reuse an inactive teammate first. Host checks only identity and Room capacity.",
    );
    for (const row of reserveSpawns) {
      const recruitPrompt = [
        "This Worker joins the active Room for a current responsibility.",
        `Call room_info first with permitId=${row.permitId}.`,
        "After admission, room_info supplies the canonical task and room state.",
        "Claim the Team task ID supplied with this handoff before starting the current responsibility. The Lead may change that responsibility later.",
      ].join(" ");
      lines.push(
        `Reserved recruit contract for ${row.spawnName}: ${JSON.stringify(recruitPrompt)}`,
        "Before recruiting this teammate, create or reuse one Team task for a distinct outcome that needs concurrent ownership. Keep it unowned and include its task ID plus an instruction to claim it before technical work. If it remains unowned after spawn, reassign it to the teammate.",
        `If list_agents lists ${row.spawnName} as running or inactive, assign the task and call send_message with target ${row.spawnName} and the admission handoff, current responsibility, and Team task ID. Do not call spawn_teammate for that name.`,
        `If that name is missing, call spawn_teammate with name exactly ${row.spawnName} and the admission handoff, current responsibility, and Team task ID.`,
        `If spawn_teammate reports that ${row.spawnName} already exists or was already used, call list_agents again and reconcile that exact name. Never invent another name or recruit without a permitId.`,
        `permitId=${row.permitId}`,
      );
    }
  }
  for (const row of parts.interrupts) {
    lines.push(`Call interrupt_agent with target ${row.spawnName}.`);
  }
  return lines.join("\n");
}

/**
 * Fresh-attempt retry only. Drop the finished attempt's Official Team channel so the
 * next Lead can bind. Leaves Intel, Feed, and platform verdicts in the workspace.
 * Crash resume of a live clock must not call this.
 */
export function retireExpiredOfficialTeamChannel(input: { roomClockDir: string; challengeId: string }): void {
  const { roomClockDir, challengeId } = input;
  const safe = challengeId.replace(/[^A-Za-z0-9._-]+/g, "_");
  for (const file of [
    nativeSessionBindingPath(roomClockDir),
    officialTeamPermitsPath(roomClockDir),
    path.join(roomClockDir, "official-team-opening-marks.json"),
    path.join(roomClockDir, "quiet-room-wake.json"),
    path.join(roomClockDir, "room-defer-unavailable.json"),
    path.join(roomClockDir, "room-task-complete.json"),
    // Migration cleanup for attempts created before periodic meetings were removed.
    path.join(roomClockDir, "room-meeting.json"),
    path.join(roomClockDir, `stall-lease-${safe}.json`),
    path.join(roomClockDir, ".silver-swarm-lead-submit.json"),
    roomMembersPath(roomClockDir, challengeId),
    convergenceGenerationPath(roomClockDir, challengeId),
  ]) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}

function occupiedSlots(roomClockDir: string, challengeId: string, permits: OfficialTeamPermit[]): number {
  const members = readRoomMembers(roomMembersPath(roomClockDir, challengeId));
  const active =
    members?.members.filter(
      (row) => row.status !== "stopped" && row.status !== "terminal",
    ).length ?? 0;
  const leadPresent = members?.members.some((row) => row.role === "lead" && row.status !== "stopped") ?? false;
  const open = permits.filter((row) => row.kind === "recruit" && recruitSlotReserved(row.status)).length;
  return (leadPresent ? active : Math.max(active, 1)) + open;
}

function recruitBindable(status: OfficialTeamPermit["status"]): boolean {
  return status === "granted";
}

function recruitSlotReserved(status: OfficialTeamPermit["status"]): boolean {
  return status === "granted";
}

function isBootstrapPermit(permit: OfficialTeamPermit): boolean {
  return permit.origin === "bootstrap" || permit.requestId.startsWith("bootstrap:");
}

function isReservePermit(permit: OfficialTeamPermit): boolean {
  return permit.origin === "reserve" || permit.requestId.startsWith("reserve:");
}

function mintBootstrapPermit(
  input: { roomId: string; challengeId: string; workerRoles?: readonly string[] },
  workerIndex: number,
  initial: boolean,
  now: string,
): OfficialTeamPermit {
  const prefix = initial ? "bootstrap" : "reserve";
  const requestId = `${prefix}:${workerIndex}`;
  const intentId = `${prefix}:${input.roomId}:${workerIndex}`;
  return {
    schema: "silver.official-team-permit.v1",
    permitId: officialTeamBootstrapPermitId(input.roomId, workerIndex),
    intentId,
    actionId: intentId,
    requestId,
    roomId: input.roomId,
    challengeId: input.challengeId,
    kind: "recruit",
    status: "granted",
    origin: initial ? "bootstrap" : "reserve",
    spawnName: officialTeamBootstrapSpawnName(input.roomId, workerIndex),
    ...(initial
      ? { duty: input.workerRoles?.[workerIndex]?.trim() || `bootstrap:${workerIndex}` }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function resolveDurableExpectedWorkers(roomClockDir: string, caller: number): number {
  if (!Number.isInteger(caller) || caller < 0) throw new Error("official team initialWorkers is invalid");
  const durable = readPermitFile(roomClockDir)?.expectedWorkers;
  if (durable !== undefined && durable !== caller) return durable;
  return caller;
}

/** Read old ledgers without reviving their transport/lifecycle mirrors. */
function normalizePermit(permit: OfficialTeamPermit): OfficialTeamPermit {
  const legacy = permit as OfficialTeamPermit & Record<string, unknown>;
  const cleaned: Record<string, unknown> = { ...legacy };
  const status = String(legacy.status);
  cleaned.status =
    status === "spawn_requested" || status === "spawn_unacknowledged"
      ? "granted"
      : status === "interrupt_pending"
        ? "removed"
        : status;
  for (const key of [
    "transport",
    "delivery",
    "assignmentId",
    "interruptReceipt",
    "spawnAttempts",
    "lastSpawnAttemptAt",
    "spawnReceiptAt",
    "automaticRetryExhaustedAt",
    "operatorRetryCount",
    "followUpId",
    "followUpPhase",
    "reservedHostId",
    "spawnToolCallId",
  ]) {
    delete cleaned[key];
  }
  return cleaned as unknown as OfficialTeamPermit;
}

function permitFromIntent(
  intent: RoomResourceIntent,
  status: OfficialTeamPermit["status"],
  now: string,
  actionId: string,
  refuseReason?: string,
): OfficialTeamPermit {
  return {
    schema: "silver.official-team-permit.v1",
    permitId: stablePermitId(intent.intentId),
    intentId: intent.intentId,
    actionId,
    requestId: intent.requestId,
    roomId: intent.roomId,
    challengeId: intent.challengeId,
    kind: intent.kind,
    status,
    spawnName: `req-${intent.requestId}`,
    ...(intent.payload.duty ? { duty: intent.payload.duty } : {}),
    createdAt: now,
    updatedAt: now,
    ...(refuseReason ? { refuseReason } : {}),
  };
}

function stablePermitId(intentId: string): string {
  return createHash("sha256").update(`silver.official-team-permit.v1:${intentId}`).digest("hex").slice(0, 32);
}

function sessionHeld(roomClockDir: string, permit: OfficialTeamPermit): boolean {
  if (!permit.memberId) return false;
  const members = readRoomMembers(roomMembersPath(roomClockDir, permit.challengeId));
  const row = members?.members.find((member) => member.memberId === permit.memberId);
  return row?.status === "stopped" || row?.status === "terminal";
}

function resolveDurableMaxMembers(roomClockDir: string, caller: number): number {
  if (!Number.isInteger(caller) || caller < 1) throw new Error("official team maxMembers is invalid");
  const bindingFile = nativeSessionBindingPath(roomClockDir);
  const bindingCap = fs.existsSync(bindingFile) ? readNativeSessionBinding(roomClockDir).maxMembers : undefined;
  const fileCap = readPermitFile(roomClockDir)?.maxMembers;
  if (bindingCap !== undefined && fileCap !== undefined && bindingCap !== fileCap) {
    throw new Error(`official team maxMembers binding ${bindingCap} disagrees with permit file ${fileCap}`);
  }
  const durable = bindingCap ?? fileCap;
  if (durable !== undefined && durable !== caller) {
    throw new Error(`official team maxMembers ${caller} disagrees with durable cap ${durable}`);
  }
  return caller;
}

function readPermitFile(roomClockDir: string): PermitFile | undefined {
  const file = officialTeamPermitsPath(roomClockDir);
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`official team permits unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as PermitFile).schema !== OFFICIAL_TEAM_PERMITS_SCHEMA) {
    throw new Error("official team permits corrupt");
  }
  const permits = (parsed as PermitFile).permits;
  if (!Array.isArray(permits)) throw new Error("official team permits corrupt");
  return { ...(parsed as PermitFile), permits: permits.map((row) => normalizePermit(row)) };
}

function readIntent(roomClockDir: string, intentId: string): RoomResourceIntent | undefined {
  const file = roomResourceIntentPath(roomClockDir, intentId);
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RoomResourceIntent;
  if (parsed?.schema !== "silver.room-resource-intent.v1") return undefined;
  return parsed;
}

function settleIntent(roomClockDir: string, intent: RoomResourceIntent, patch: Partial<RoomResourceIntent>): void {
  const next: RoomResourceIntent = { ...intent, ...patch };
  if (patch.boundAttemptId === undefined) delete next.boundAttemptId;
  const file = roomResourceIntentPath(roomClockDir, intent.intentId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function writePermits(
  roomClockDir: string,
  permits: OfficialTeamPermit[],
  maxMembers?: number,
  expectedWorkers?: number,
): void {
  const file = officialTeamPermitsPath(roomClockDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prior = readPermitFile(roomClockDir);
  const cap = maxMembers ?? prior?.maxMembers;
  const expected = expectedWorkers ?? prior?.expectedWorkers;
  const body: PermitFile = {
    schema: OFFICIAL_TEAM_PERMITS_SCHEMA,
    ...(cap !== undefined ? { maxMembers: cap } : {}),
    ...(expected !== undefined ? { expectedWorkers: expected } : {}),
    permits,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
