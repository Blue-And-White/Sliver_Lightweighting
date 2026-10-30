/**
 * Durable platform-stop journal read helpers (no ProjectRuntime / roster writes).
 * Kept separate so decision gates do not cycle with the stop applicator.
 */
import fs from "node:fs";
import path from "node:path";

export const ROOM_PLATFORM_STOP_SCHEMA = "silver.room-platform-stop.v1" as const;
export const ROOM_PLATFORM_STOP_REASON = "host_terminal_stop" as const;

export type RoomPlatformStopReceipts = {
  projectClosedAt?: string;
  membersStoppedAt?: string;
  convergenceAbortedAt?: string;
  /** Live DSH session / broker / wake-hub stop completed (after session.result settles). */
  sessionsStoppedAt?: string;
};

export type RoomPlatformStopJournal = {
  schema: typeof ROOM_PLATFORM_STOP_SCHEMA;
  roomId: string;
  challengeId: string;
  stopReason: string;
  stopEpoch: number;
  status: "open" | "applied";
  receipts: RoomPlatformStopReceipts;
  createdAt: string;
  updatedAt: string;
};

export function roomPlatformStopPath(roomClockDir: string, challengeId: string): string {
  const safe = challengeId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(roomClockDir, `room-platform-stop-${safe}.json`);
}

export function readRoomPlatformStopJournal(
  roomClockDir: string,
  challengeId: string,
): RoomPlatformStopJournal | undefined {
  const file = roomPlatformStopPath(roomClockDir, challengeId);
  if (!fs.existsSync(file)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `room platform stop journal unreadable: ${challengeId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`room platform stop journal corrupt (invalid json): ${challengeId}`);
  }
  if (!isRoomPlatformStopJournal(parsed)) {
    throw new Error(`room platform stop journal corrupt (schema): ${challengeId}`);
  }
  return parsed;
}

export function isRoomPlatformStopApplied(roomClockDir: string, challengeId: string): boolean {
  return readRoomPlatformStopJournal(roomClockDir, challengeId)?.status === "applied";
}

/** True once a stop journal exists (open or applied) — room must not accept new activity. */
export function isRoomPlatformStopPresent(roomClockDir: string, challengeId: string): boolean {
  return readRoomPlatformStopJournal(roomClockDir, challengeId) !== undefined;
}

export function assertRoomAcceptsActivity(input: {
  roomClockDir: string;
  challengeId: string;
  activity: string;
}): void {
  if (isRoomPlatformStopPresent(input.roomClockDir, input.challengeId)) {
    throw new Error(
      `room_platform_stopped: refuse ${input.activity} after platform accepted stop for ${input.challengeId}`,
    );
  }
}

export function assertRoomPlatformStopJournalIdentity(
  journal: RoomPlatformStopJournal,
  input: { roomId: string; challengeId: string },
): void {
  if (journal.roomId !== input.roomId || journal.challengeId !== input.challengeId) {
    throw new Error(
      `room platform stop journal identity mismatch: journal=${journal.roomId}/${journal.challengeId} expected=${input.roomId}/${input.challengeId}`,
    );
  }
}

export function writeRoomPlatformStopJournal(
  roomClockDir: string,
  journal: RoomPlatformStopJournal,
): void {
  const file = roomPlatformStopPath(roomClockDir, journal.challengeId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function isValidReceiptTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function isRoomPlatformStopReceipts(value: unknown): value is RoomPlatformStopReceipts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = [
    "projectClosedAt",
    "membersStoppedAt",
    "convergenceAbortedAt",
    "sessionsStoppedAt",
  ] as const;
  for (const key of keys) {
    if (row[key] === undefined) continue;
    if (!isValidReceiptTimestamp(row[key])) return false;
  }
  // Reject unknown receipt keys that could confuse step gating.
  for (const key of Object.keys(row)) {
    if (!(keys as readonly string[]).includes(key)) return false;
  }
  return true;
}

function isRoomPlatformStopJournal(value: unknown): value is RoomPlatformStopJournal {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    row.schema === ROOM_PLATFORM_STOP_SCHEMA &&
    typeof row.roomId === "string" &&
    row.roomId.trim().length > 0 &&
    typeof row.challengeId === "string" &&
    row.challengeId.trim().length > 0 &&
    typeof row.stopReason === "string" &&
    row.stopReason.trim().length > 0 &&
    Number.isInteger(row.stopEpoch) &&
    (row.stopEpoch as number) >= 0 &&
    (row.status === "open" || row.status === "applied") &&
    isRoomPlatformStopReceipts(row.receipts) &&
    typeof row.createdAt === "string" &&
    typeof row.updatedAt === "string"
  );
}
