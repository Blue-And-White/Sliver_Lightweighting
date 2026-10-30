/**
 * Minimal Host/operator room-deadline control via the room identity directory.
 * The live Host polls deadline-request.json; CLI/operators write requests and
 * read deadline-result.json. No Solver capability or HMAC self-signing required.
 *
 * One pending request at a time: requestId correlates request/result; stale or
 * overlapped requests are rejected rather than silently applied.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RoomClockState } from "./room-clock.ts";

export const ROOM_DEADLINE_REQUEST_SCHEMA = "silver.room-deadline-request.v1" as const;
export const ROOM_DEADLINE_RESULT_SCHEMA = "silver.room-deadline-result.v1" as const;

/** Default TTL for operator deadline requests (ms). Matches CLI wait so leftovers cannot apply later. */
export const ROOM_DEADLINE_REQUEST_TTL_MS = 5_000;

export type RoomDeadlineRequest = {
  schema: typeof ROOM_DEADLINE_REQUEST_SCHEMA;
  requestId: string;
  /** Absolute wall deadline. */
  deadlineAtMs?: number;
  /** Add this many ms to the current persisted deadline. */
  extendMs?: number;
  requestedAt: string;
  /** Absolute expiry; Host must not apply after this. */
  expiresAt: string;
};

export type RoomDeadlineResult = {
  schema: typeof ROOM_DEADLINE_RESULT_SCHEMA;
  requestId: string;
  ok: boolean;
  deadlineAt?: string;
  remainingMs?: number;
  error?: string;
  appliedAt: string;
};

export function roomDeadlineRequestPath(roomClockDir: string): string {
  return path.join(roomClockDir, "deadline-request.json");
}

export function roomDeadlineResultPath(roomClockDir: string): string {
  return path.join(roomClockDir, "deadline-result.json");
}

export function roomDeadlineResultPathFor(roomClockDir: string, requestId: string): string {
  return path.join(roomClockDir, `deadline-result-${requestId}.json`);
}

/**
 * Withdraw only this requestId from the shared pending slot.
 * Returns false when another request owns the file (do not unlink).
 */
export function withdrawRoomDeadlineRequest(roomClockDir: string, requestId: string): boolean {
  const file = roomDeadlineRequestPath(roomClockDir);
  const pending = readRoomDeadlineRequest(file);
  if (!pending) return false;
  if (pending.requestId !== requestId) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function writeRoomDeadlineRequest(
  roomClockDir: string,
  input: {
    deadlineAtMs?: number;
    extendMs?: number;
    nowMs?: number;
    ttlMs?: number;
    requestId?: string;
    /** When true, replace an existing pending request (default: reject overlap). */
    replace?: boolean;
  },
): { file: string; request: RoomDeadlineRequest } {
  if (input.deadlineAtMs === undefined && input.extendMs === undefined) {
    throw new Error("room deadline request requires deadlineAtMs or extendMs");
  }
  if (input.deadlineAtMs !== undefined && input.extendMs !== undefined) {
    throw new Error("pass deadlineAtMs or extendMs, not both");
  }
  if (input.deadlineAtMs !== undefined && !Number.isFinite(input.deadlineAtMs)) {
    throw new Error("deadlineAtMs must be finite");
  }
  if (input.extendMs !== undefined && !Number.isFinite(input.extendMs)) {
    throw new Error("extendMs must be finite");
  }
  fs.mkdirSync(roomClockDir, { recursive: true });
  const file = roomDeadlineRequestPath(roomClockDir);
  const existing = readRoomDeadlineRequest(file);
  const nowMs = input.nowMs ?? Date.now();
  if (existing && !input.replace) {
    const existingFresh = Date.parse(existing.expiresAt) > nowMs;
    if (existingFresh) {
      throw new Error(
        `overlapping room deadline request ${existing.requestId} is still pending until ${existing.expiresAt}`,
      );
    }
  }
  if (existing) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* none */
    }
  }
  const ttlMs = input.ttlMs ?? ROOM_DEADLINE_REQUEST_TTL_MS;
  const request: RoomDeadlineRequest = {
    schema: ROOM_DEADLINE_REQUEST_SCHEMA,
    requestId: input.requestId ?? randomUUID(),
    ...(input.deadlineAtMs !== undefined ? { deadlineAtMs: Math.floor(input.deadlineAtMs) } : {}),
    ...(input.extendMs !== undefined ? { extendMs: Math.floor(input.extendMs) } : {}),
    requestedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
  const body = `${JSON.stringify(request, null, 2)}\n`;
  try {
    // wx: exclusive create — overlapping publishers fail instead of silently renaming over.
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeFileSync(fd, body);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : "";
    if (code === "EEXIST") {
      const raced = readRoomDeadlineRequest(file);
      throw new Error(
        raced
          ? `overlapping room deadline request ${raced.requestId} is still pending until ${raced.expiresAt}`
          : `overlapping room deadline request is still pending at ${file}`,
      );
    }
    throw err;
  }
  return { file, request };
}

export function readRoomDeadlineRequest(file: string): RoomDeadlineRequest | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    if (row.schema !== ROOM_DEADLINE_REQUEST_SCHEMA) return undefined;
    if (typeof row.requestedAt !== "string") return undefined;
    if (typeof row.requestId !== "string" || !row.requestId) return undefined;
    const expiresAt =
      typeof row.expiresAt === "string"
        ? row.expiresAt
        : new Date(Date.parse(row.requestedAt) + ROOM_DEADLINE_REQUEST_TTL_MS).toISOString();
    const out: RoomDeadlineRequest = {
      schema: ROOM_DEADLINE_REQUEST_SCHEMA,
      requestId: row.requestId,
      requestedAt: row.requestedAt,
      expiresAt,
    };
    if (row.deadlineAtMs !== undefined) {
      if (typeof row.deadlineAtMs !== "number" || !Number.isFinite(row.deadlineAtMs)) return undefined;
      out.deadlineAtMs = row.deadlineAtMs;
    }
    if (row.extendMs !== undefined) {
      if (typeof row.extendMs !== "number" || !Number.isFinite(row.extendMs)) return undefined;
      out.extendMs = row.extendMs;
    }
    if (out.deadlineAtMs === undefined && out.extendMs === undefined) return undefined;
    if (out.deadlineAtMs !== undefined && out.extendMs !== undefined) return undefined;
    return out;
  } catch {
    return undefined;
  }
}

export function resolveRoomDeadlineRequest(
  request: RoomDeadlineRequest,
  clock: RoomClockState,
): number {
  if (request.deadlineAtMs !== undefined) return Math.floor(request.deadlineAtMs);
  return Date.parse(clock.deadlineAt) + Math.floor(request.extendMs!);
}

export function writeRoomDeadlineResult(
  roomClockDir: string,
  result: Omit<RoomDeadlineResult, "schema">,
): void {
  fs.mkdirSync(roomClockDir, { recursive: true });
  const body: RoomDeadlineResult = { schema: ROOM_DEADLINE_RESULT_SCHEMA, ...result };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  const scoped = roomDeadlineResultPathFor(roomClockDir, result.requestId);
  const scopedTmp = `${scoped}.${process.pid}.tmp`;
  fs.writeFileSync(scopedTmp, text);
  fs.renameSync(scopedTmp, scoped);
  const file = roomDeadlineResultPath(roomClockDir);
  const tmp = `${file}.${result.requestId}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readRoomDeadlineResult(
  roomClockDir: string,
  requestId?: string,
): RoomDeadlineResult | undefined {
  if (requestId) {
    const scoped = readDeadlineResultFile(roomDeadlineResultPathFor(roomClockDir, requestId));
    if (scoped && scoped.requestId === requestId) return scoped;
  }
  const shared = readDeadlineResultFile(roomDeadlineResultPath(roomClockDir));
  if (requestId && shared && shared.requestId !== requestId) return undefined;
  return shared;
}

function readDeadlineResultFile(file: string): RoomDeadlineResult | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RoomDeadlineResult;
    if (parsed?.schema !== ROOM_DEADLINE_RESULT_SCHEMA) return undefined;
    if (typeof parsed.requestId !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Consume one pending request if present and not expired.
 * Expired leftovers are deleted and reported so a new Host run never applies them.
 */
export function consumeRoomDeadlineRequest(
  roomClockDir: string,
  nowMs = Date.now(),
):
  | { kind: "request"; request: RoomDeadlineRequest }
  | { kind: "expired"; request: RoomDeadlineRequest }
  | undefined {
  const file = roomDeadlineRequestPath(roomClockDir);
  const request = readRoomDeadlineRequest(file);
  if (!request) return undefined;
  try {
    fs.unlinkSync(file);
  } catch {
    /* another consumer may have taken it */
  }
  if (Date.parse(request.expiresAt) <= nowMs) {
    return { kind: "expired", request };
  }
  return { kind: "request", request };
}
