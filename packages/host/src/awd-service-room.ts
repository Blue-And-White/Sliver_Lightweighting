/**
 * Own-service AWD room lifetime. One service keeps one Room across rounds.
 * Jeopardy accepted-stop does not go through this file.
 * A round, a local check, or a platform health report is not a match end.
 */
import fs from "node:fs";
import path from "node:path";

export const AWD_SERVICE_ROOM_SCHEMA = "silver.awd-service-room.v1" as const;

export type AwdServiceRoomPhase = "open" | "closing" | "closed";

export type AwdServiceRoomState = {
  schema: typeof AWD_SERVICE_ROOM_SCHEMA;
  roomId: string;
  challengeId: string;
  phase: AwdServiceRoomPhase;
  /** Highest round fact accepted. Older notices do not rewind it. */
  round: number;
  localChecks: number;
  platformStages: number;
  /** Platform health is not a local check. */
  lastHealth?: { ok: boolean; at: string };
  /** Idle or a finished work budget. Never a match-completed conclusion. */
  work: "running" | "idle" | "budget_exhausted";
  /** Restored rooms do not claim the previous member processes are still alive. */
  membersAttached: boolean;
  closeReason?: "match_end" | "operator_stop";
  /**
   * Incremented only after resource cleanup succeeds.
   * A closing room can be retried. A repeat stop does not increment.
   */
  cleanups: number;
};

export type AwdServiceRoomNotice = {
  at: string;
  round?: number;
  /** Local verification passed. Not a platform health report. */
  localCheckPassed?: boolean;
  /** Platform scoring / health for a round. Not a local check. */
  platformStage?: boolean;
  health?: { ok: boolean };
  memberIdle?: boolean;
  workBudgetExhausted?: boolean;
  matchEnded?: boolean;
  operatorStop?: boolean;
};

export type AwdServiceRoomEffect = {
  state: AwdServiceRoomState;
  /**
   * True while resource cleanup is still required.
   * The cleanup count stays unchanged until that cleanup succeeds.
   */
  close: boolean;
  /** True when this notice created the room identity. */
  created: boolean;
};

function fileFor(roomClockDir: string, challengeId: string): string {
  const safe = challengeId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(roomClockDir, `awd-service-room-${safe}.json`);
}

export function readAwdServiceRoom(roomClockDir: string, challengeId: string): AwdServiceRoomState | undefined {
  const file = fileFor(roomClockDir, challengeId);
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as AwdServiceRoomState;
  if (parsed?.schema !== AWD_SERVICE_ROOM_SCHEMA) return undefined;
  return { ...parsed, membersAttached: false };
}

function writeState(roomClockDir: string, state: AwdServiceRoomState): void {
  const file = fileFor(roomClockDir, state.challengeId);
  fs.mkdirSync(roomClockDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...state, membersAttached: false }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function blank(roomId: string, challengeId: string): AwdServiceRoomState {
  return {
    schema: AWD_SERVICE_ROOM_SCHEMA,
    roomId,
    challengeId,
    phase: "open",
    round: 0,
    localChecks: 0,
    platformStages: 0,
    work: "running",
    membersAttached: false,
    cleanups: 0,
  };
}

/**
 * Record that resource cleanup finished. Refuses to count a cleanup that has not been requested,
 * and does not count a second time once the room is already closed.
 */
export function commitAwdServiceRoomCleanup(roomClockDir: string, challengeId: string): AwdServiceRoomState {
  const prior = readAwdServiceRoom(roomClockDir, challengeId);
  if (!prior) throw new Error(`awd service room ${challengeId} has no close to commit`);
  if (prior.phase === "closed") return prior;
  if (prior.phase !== "closing") {
    throw new Error(`awd service room ${challengeId} is ${prior.phase}; cleanup is not pending`);
  }
  const state: AwdServiceRoomState = {
    ...prior,
    phase: "closed",
    cleanups: prior.cleanups + 1,
    membersAttached: false,
  };
  writeState(roomClockDir, state);
  return readAwdServiceRoom(roomClockDir, challengeId) ?? state;
}

/**
 * Apply one own-service fact. Identity stays on roomId.
 * Match end and operator stop request one shared cleanup. The count moves only after it succeeds.
 * A repeated terminal notice while cleanup is still pending asks for that cleanup again.
 */
export function applyAwdServiceRoom(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  notice: AwdServiceRoomNotice;
}): AwdServiceRoomEffect {
  const prior = readAwdServiceRoom(input.roomClockDir, input.challengeId);
  const created = !prior;
  const state = prior ?? blank(input.roomId, input.challengeId);
  if (state.roomId !== input.roomId) {
    throw new Error(`awd service room ${input.challengeId} is bound to ${state.roomId}, not ${input.roomId}`);
  }
  const notice = input.notice;
  if (typeof notice.round === "number" && Number.isInteger(notice.round) && notice.round > state.round) {
    state.round = notice.round;
  }
  if (notice.localCheckPassed) state.localChecks += 1;
  if (notice.platformStage) state.platformStages += 1;
  if (notice.health) state.lastHealth = { ok: notice.health.ok, at: notice.at };
  if (notice.memberIdle) state.work = "idle";
  if (notice.workBudgetExhausted) state.work = "budget_exhausted";
  const terminal = notice.matchEnded === true || notice.operatorStop === true;
  let close = false;
  if (terminal && state.phase === "open") {
    state.phase = "closing";
    state.closeReason = notice.operatorStop ? "operator_stop" : "match_end";
    state.work = "idle";
    close = true;
  } else if (terminal && state.phase === "closing") {
    close = true;
  }
  state.membersAttached = false;
  writeState(input.roomClockDir, state);
  return { state: readAwdServiceRoom(input.roomClockDir, input.challengeId) ?? state, close, created };
}
