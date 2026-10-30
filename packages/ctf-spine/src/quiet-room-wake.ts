/**
 * Persisted stall notice for the Lead session. The wake file is the only
 * record: pending, host handoff, or delivered. Delivery is complete only
 * after the notice is in the Lead session. A handoff is not delivery.
 * Replay does not mint a convergence generation.
 */
import fs from "node:fs";
import path from "node:path";

export const QUIET_ROOM_WAKE_FILE = "quiet-room-wake.json";

export type QuietRoomWake = {
  eventId: string;
  /** Host copied the text into an in-flight Lead prompt. Crash recovery still owes the notice. */
  handoff: boolean;
  /** True only after that prompt or tool-boundary message is in the Lead session. */
  delivered: boolean;
  /** Stall wakes since the last candidate, including this one. */
  stallsSinceCandidate?: number;
};

export function quietRoomWakePath(roomClockDir: string): string {
  return path.join(roomClockDir, QUIET_ROOM_WAKE_FILE);
}

export function stallLeaseFilePath(roomClockDir: string, challengeId: string): string {
  const safe = challengeId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(roomClockDir, `stall-lease-${safe}.json`);
}

export function persistedStallEventId(challengeId: string, generation: number): string {
  return `stall_boundary:${challengeId}:g${generation}`;
}

/** Progress after an emission bumps generation past lastEmitted+1. That stall is no longer quiet. */
export function quietStallSupersededByProgress(snapshot: {
  lastEmittedGeneration?: number;
  generation?: number;
}): boolean {
  const emitted = snapshot.lastEmittedGeneration;
  const generation = snapshot.generation;
  if (typeof emitted !== "number" || typeof generation !== "number") return false;
  return emitted > 0 && generation > emitted + 1;
}

function writeWake(roomClockDir: string, wake: QuietRoomWake): void {
  const eventId = wake.eventId.trim();
  if (!eventId) return;
  fs.mkdirSync(roomClockDir, { recursive: true });
  const file = quietRoomWakePath(roomClockDir);
  const tmp = `${file}.${process.pid}.tmp`;
  const prior = readQuietRoomWake(roomClockDir);
  const stallsSinceCandidate = wake.stallsSinceCandidate ?? prior?.stallsSinceCandidate;
  const body: {
    eventId: string;
    handoff?: true;
    delivered?: true;
    stallsSinceCandidate?: number;
  } = { eventId };
  if (wake.handoff) body.handoff = true;
  if (wake.delivered) body.delivered = true;
  if (stallsSinceCandidate !== undefined) body.stallsSinceCandidate = stallsSinceCandidate;
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  fs.renameSync(tmp, file);
}

export function readQuietRoomWake(roomClockDir: string): QuietRoomWake | undefined {
  const file = quietRoomWakePath(roomClockDir);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      eventId?: unknown;
      handoff?: unknown;
      delivered?: unknown;
      stallsSinceCandidate?: unknown;
    };
    if (typeof parsed.eventId !== "string" || !parsed.eventId.trim()) return undefined;
    const stallsSinceCandidate =
      typeof parsed.stallsSinceCandidate === "number" && Number.isInteger(parsed.stallsSinceCandidate)
        ? parsed.stallsSinceCandidate
        : undefined;
    return {
      eventId: parsed.eventId.trim(),
      handoff: parsed.handoff === true,
      delivered: parsed.delivered === true,
      ...(stallsSinceCandidate !== undefined ? { stallsSinceCandidate } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Event id still owed to the Lead. A delivered wake is not owed. */
export function readQuietRoomWakeEventId(roomClockDir: string): string | undefined {
  const wake = readQuietRoomWake(roomClockDir);
  if (!wake || wake.delivered) return undefined;
  return wake.eventId;
}

export function writeQuietRoomWakeFile(
  roomClockDir: string,
  eventId: string,
  stallsSinceCandidate?: number,
): void {
  writeWake(roomClockDir, {
    eventId,
    handoff: false,
    delivered: false,
    ...(stallsSinceCandidate !== undefined ? { stallsSinceCandidate } : {}),
  });
}

export function armQuietRoomWakeHandoff(roomClockDir: string, eventId: string): void {
  writeWake(roomClockDir, { eventId, handoff: true, delivered: false });
}

export function markQuietRoomWakeDelivered(roomClockDir: string, eventId: string): void {
  writeWake(roomClockDir, { eventId, handoff: false, delivered: true });
}

/** Intel, candidate, or worker_result landed. Drop a notice that has not been delivered. */
export function dropUndeliveredQuietWake(roomClockDir: string): void {
  const wake = readQuietRoomWake(roomClockDir);
  if (!wake || wake.delivered) return;
  try {
    fs.rmSync(quietRoomWakePath(roomClockDir), { force: true });
  } catch {
    /* already gone */
  }
}

type LeaseWakeRow = {
  status?: unknown;
  lastEmittedGeneration?: unknown;
  generation?: unknown;
};

function readLeaseWakeRow(roomClockDir: string, challengeId: string): LeaseWakeRow | undefined {
  const leasePath = stallLeaseFilePath(roomClockDir, challengeId);
  if (!fs.existsSync(leasePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(leasePath, "utf8")) as LeaseWakeRow;
  } catch {
    return undefined;
  }
}

/**
 * Rewrite a missing wake for the lease's latest emission. Does not mint a
 * generation. Progress after that emission drops the notice instead.
 * A handoff or pending wake is left in place. A delivered wake for the same
 * event is not resurrected.
 */
export function restorePersistedStallWake(roomClockDir: string, challengeId: string): string | undefined {
  const id = challengeId.trim();
  if (!id) return undefined;
  const parsed = readLeaseWakeRow(roomClockDir, id);
  if (!parsed || parsed.status === "cancelled") return undefined;
  const emitted = parsed.lastEmittedGeneration;
  if (typeof emitted !== "number" || !Number.isInteger(emitted) || emitted <= 0) return undefined;
  if (quietStallSupersededByProgress(parsed as { lastEmittedGeneration: number; generation: number })) {
    dropUndeliveredQuietWake(roomClockDir);
    return undefined;
  }
  const eventId = persistedStallEventId(id, emitted);
  const wake = readQuietRoomWake(roomClockDir);
  if (wake?.delivered && wake.eventId === eventId) return undefined;
  if (wake && !wake.delivered) return undefined;
  writeQuietRoomWakeFile(roomClockDir, eventId);
  return eventId;
}
