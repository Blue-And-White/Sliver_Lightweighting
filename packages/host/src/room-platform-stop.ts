/**
 * Platform-accepted / room-closed full stop (production entry).
 * Durable order:
 *   ProjectRuntime.close → roster stop → convergence abort → live session stop → applied
 * Crash/replay heals ProjectRuntime from pre-stop checkpoints, resumes missing receipts,
 * and never bumps stopEpoch past the journal value.
 */
import {
  abortForPlatformAccepted,
  convergenceGenerationPath,
  readConvergenceStore,
  writeConvergenceStore,
} from "./convergence-generation.ts";
import { withRoomLedgerLock } from "./room-ledger-lock.ts";
import { ProjectRuntime } from "./project-runtime.ts";
import {
  readRoomMembers,
  roomMembersPath,
  upsertRoomMember,
  writeRoomMembers,
  type RoomMembersState,
} from "./room-members.ts";
import {
  ROOM_PLATFORM_STOP_REASON,
  ROOM_PLATFORM_STOP_SCHEMA,
  assertRoomPlatformStopJournalIdentity,
  readRoomPlatformStopJournal,
  writeRoomPlatformStopJournal,
  type RoomPlatformStopJournal,
} from "./room-platform-stop-state.ts";

export {
  ROOM_PLATFORM_STOP_REASON,
  ROOM_PLATFORM_STOP_SCHEMA,
  assertRoomAcceptsActivity,
  assertRoomPlatformStopJournalIdentity,
  isRoomPlatformStopApplied,
  isRoomPlatformStopPresent,
  readRoomPlatformStopJournal,
  roomPlatformStopPath,
  writeRoomPlatformStopJournal,
  type RoomPlatformStopJournal,
} from "./room-platform-stop-state.ts";

export type RoomPlatformStopLiveHooks = {
  /**
   * Stop live DSH sessions / wake hub / abort in-flight brokers.
   * Must be idempotent — replay may call again if sessionsStoppedAt was not receipted.
   */
  stopLiveSessions: (input: { stopReason: string }) => void | Promise<void>;
};

export type ApplyRoomPlatformAcceptedStopResult = {
  ok: true;
  outcome: "applied" | "already_applied";
  stopEpoch: number;
  stopReason: string;
  journal: RoomPlatformStopJournal;
  members?: RoomMembersState;
};

/**
 * Single production entry for platform completed / room closed.
 * Idempotent and crash-safe via the stop journal.
 */
export async function applyRoomPlatformAcceptedStop(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  projects: ProjectRuntime;
  stopReason?: string;
  nowMs?: number;
  membersFile?: string;
  stopLiveSessions?: RoomPlatformStopLiveHooks["stopLiveSessions"];
}): Promise<ApplyRoomPlatformAcceptedStopResult> {
  const roomKey = `${input.roomId}:${input.challengeId}`;
  return withRoomLedgerLock(roomKey, () => applyRoomPlatformAcceptedStopUnlocked(input));
}

async function applyRoomPlatformAcceptedStopUnlocked(input: {
  roomClockDir: string;
  roomId: string;
  challengeId: string;
  projects: ProjectRuntime;
  stopReason?: string;
  nowMs?: number;
  membersFile?: string;
  stopLiveSessions?: RoomPlatformStopLiveHooks["stopLiveSessions"];
}): Promise<ApplyRoomPlatformAcceptedStopResult> {
  const stopReason = input.stopReason?.trim() || ROOM_PLATFORM_STOP_REASON;
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const membersFile = input.membersFile ?? roomMembersPath(input.roomClockDir, input.challengeId);
  const wasApplied = readRoomPlatformStopJournal(input.roomClockDir, input.challengeId)?.status === "applied";

  let journal = readRoomPlatformStopJournal(input.roomClockDir, input.challengeId);
  if (!journal) {
    journal = {
      schema: ROOM_PLATFORM_STOP_SCHEMA,
      roomId: input.roomId,
      challengeId: input.challengeId,
      stopReason,
      stopEpoch: 0,
      status: "open",
      receipts: {},
      createdAt: now,
      updatedAt: now,
    };
    writeRoomPlatformStopJournal(input.roomClockDir, journal);
  } else {
    assertRoomPlatformStopJournalIdentity(journal, {
      roomId: input.roomId,
      challengeId: input.challengeId,
    });
    if (journal.stopReason !== stopReason) {
      throw new Error(
        `room platform stop reason conflict: journal=${journal.stopReason} requested=${stopReason}`,
      );
    }
  }

  // 1. Project close — first time bumps stopEpoch; replay heals restored active checkpoints.
  if (!journal.receipts.projectClosedAt) {
    const closed = input.projects.close(input.challengeId);
    journal = {
      ...journal,
      stopEpoch: closed.stopEpoch,
      receipts: { ...journal.receipts, projectClosedAt: now },
      updatedAt: now,
    };
    writeRoomPlatformStopJournal(input.roomClockDir, journal);
  } else {
    input.projects.ensureClosedAt(input.challengeId, journal.stopEpoch);
  }

  // 2. Roster stop
  let members: RoomMembersState | undefined;
  if (!journal.receipts.membersStoppedAt) {
    members = stopAllRoomMembers({
      membersFile,
      stopReason: journal.stopReason,
      nowMs,
    });
    journal = {
      ...journal,
      receipts: { ...journal.receipts, membersStoppedAt: now },
      updatedAt: now,
    };
    writeRoomPlatformStopJournal(input.roomClockDir, journal);
  } else {
    members = healRoomMembersStopped({
      membersFile,
      stopReason: journal.stopReason,
      nowMs,
    });
  }

  // 3. Convergence abort (idempotent if already terminalHalt)
  if (!journal.receipts.convergenceAbortedAt) {
    abortConvergenceLedger({
      roomClockDir: input.roomClockDir,
      challengeId: input.challengeId,
      nowMs,
    });
    journal = {
      ...journal,
      receipts: { ...journal.receipts, convergenceAbortedAt: now },
      updatedAt: now,
    };
    writeRoomPlatformStopJournal(input.roomClockDir, journal);
  } else {
    abortConvergenceLedger({
      roomClockDir: input.roomClockDir,
      challengeId: input.challengeId,
      nowMs,
    });
  }

  // 4. Live sessions — must succeed before journal can be applied.
  if (!journal.receipts.sessionsStoppedAt) {
    if (input.stopLiveSessions) {
      await input.stopLiveSessions({ stopReason: journal.stopReason });
    }
    journal = {
      ...journal,
      receipts: { ...journal.receipts, sessionsStoppedAt: now },
      updatedAt: now,
    };
    writeRoomPlatformStopJournal(input.roomClockDir, journal);
  }

  if (journal.status !== "applied") {
    journal = {
      ...journal,
      status: "applied",
      updatedAt: now,
    };
    writeRoomPlatformStopJournal(input.roomClockDir, journal);
  }

  return {
    ok: true,
    outcome: wasApplied ? "already_applied" : "applied",
    stopEpoch: journal.stopEpoch,
    stopReason: journal.stopReason,
    journal,
    ...(members ? { members } : {}),
  };
}

function stopAllRoomMembers(input: {
  membersFile: string;
  stopReason: string;
  nowMs: number;
}): RoomMembersState | undefined {
  const existing = readRoomMembers(input.membersFile);
  if (!existing) return undefined;
  let next = existing;
  for (const row of existing.members) {
    if (row.status === "stopped" && row.stopReason === input.stopReason) continue;
    next = upsertRoomMember(
      next,
      {
        memberId: row.memberId,
        status: "stopped",
        stopReason: input.stopReason,
      },
      input.nowMs,
    );
  }
  writeRoomMembers(input.membersFile, next);
  return next;
}

/** Re-apply roster stop if a restored roster lost stopped status. */
function healRoomMembersStopped(input: {
  membersFile: string;
  stopReason: string;
  nowMs: number;
}): RoomMembersState | undefined {
  const existing = readRoomMembers(input.membersFile);
  if (!existing) return undefined;
  const needsHeal = existing.members.some(
    (row) => row.status !== "stopped" || row.stopReason !== input.stopReason,
  );
  if (!needsHeal) return existing;
  return stopAllRoomMembers(input);
}

/**
 * Cold recovery may replay a platform-accepted stop only when Host already
 * persisted a platform completed fact. A stop journal alone must not turn
 * timeout or any other unsolved exit into accepted.
 */
export function roomTerminalRecovery(input: {
  platformSolved: boolean;
}): "platform_accepted" | "continue" {
  return input.platformSolved ? "platform_accepted" : "continue";
}

function abortConvergenceLedger(input: {
  roomClockDir: string;
  challengeId: string;
  nowMs: number;
}): void {
  const file = convergenceGenerationPath(input.roomClockDir, input.challengeId);
  const store = readConvergenceStore(file);
  if (!store) return;
  const aborted = abortForPlatformAccepted(store, {
    reason: "platform_accepted",
    nowMs: input.nowMs,
  });
  writeConvergenceStore(file, aborted.store);
}
