/**
 * Room deadline is a terminal release of the platform container.
 * It reuses the contest close call. The local result stays timeout/exhausted.
 * A successful close is what projects the container as released. A timeout or
 * crash leaves that projection absent so the next process closes once.
 */
import type { ContestBoardRow } from "./contest-platform.ts";

const ALREADY_CLOSED =
  /already[\s_-]*closed|already[\s_-]*stopped|container[\s_-]*stopped|not[\s_-]*running|no active container|challenge[\s_-]*(is[\s_-]*)?closed|task already (finished|closed|stopped)/i;

export function contestCloseFailureIsIdempotent(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return ALREADY_CLOSED.test(message);
}

export function contestBoardStopped(row: Pick<ContestBoardRow, "containerStatus" | "containerAddr"> | undefined): boolean {
  if (!row) return false;
  return row.containerStatus.trim().toLowerCase() === "stopped";
}

type ReleasePlatform = {
  close(boardId: string): Promise<void>;
  list(): Promise<ContestBoardRow[]>;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("contest close timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * One platform close. `stopped` or an already-closed response is success.
 * Timeout and any other failure reject so the caller does not project a release.
 */
export async function releaseContestBoard(
  platform: ReleasePlatform,
  boardId: string,
  timeoutMs = 15_000,
): Promise<{ idempotent: boolean }> {
  try {
    await withTimeout(platform.close(boardId), timeoutMs);
    return { idempotent: false };
  } catch (err) {
    if (contestCloseFailureIsIdempotent(err)) return { idempotent: true };
    try {
      const rows = await withTimeout(platform.list(), timeoutMs);
      if (contestBoardStopped(rows.find((row) => row.boardId === boardId))) return { idempotent: true };
    } catch {
      /* the close error remains the failure */
    }
    throw err;
  }
}

type LifecycleEvent = {
  type?: unknown;
  boardId?: unknown;
  targetId?: unknown;
  started?: unknown;
  error?: unknown;
};

function eventBoardId(event: LifecycleEvent): string {
  if (typeof event.boardId === "string" && event.boardId.trim()) return event.boardId.trim();
  if (typeof event.targetId === "string" && event.targetId.trim()) return event.targetId.trim();
  return "";
}

function parseEvents(eventLog: string): LifecycleEvent[] {
  const rows: LifecycleEvent[] = [];
  for (const line of eventLog.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LifecycleEvent);
    } catch {
      /* skip a torn line */
    }
  }
  return rows;
}

export function contestTargetWasStarted(eventLog: string, boardId: string): boolean {
  return parseEvents(eventLog).some((event) => {
    if (eventBoardId(event) !== boardId) return false;
    if (event.type === "challenge-start" || event.type === "solver-start" || event.type === "worker-start") return true;
    return event.type === "queue-target" && event.started === true;
  });
}

export function contestCloseProjected(eventLog: string, boardId: string): boolean {
  let latestStart = -1;
  let latestClose = -1;
  for (const [index, event] of parseEvents(eventLog).entries()) {
    if (eventBoardId(event) !== boardId) continue;
    if (
      event.type === "challenge-start" ||
      event.type === "solver-start" ||
      event.type === "worker-start" ||
      (event.type === "queue-target" && event.started === true)
    ) {
      latestStart = index;
    }
    if (event.type === "challenge-close" && !event.error) latestClose = index;
  }
  return latestClose >= 0 && latestClose >= latestStart;
}

const NON_DEADLINE_STOPS = new Set(["llm_transport_failure", "candidate_checkpoint", "interrupted"]);

/**
 * Deadline release is owed only for an expired room whose container was started
 * and whose close has not been projected. Transport failure, candidate
 * checkpoint, and a room that is still inside its clock are not a close.
 */
export function deadlineContestReleaseOwed(input: {
  eventLog: string;
  boardId: string;
  roomExpired: boolean;
  stopReason?: string;
}): boolean {
  if (!input.roomExpired) return false;
  if (input.stopReason && NON_DEADLINE_STOPS.has(input.stopReason)) return false;
  if (input.stopReason && input.stopReason !== "timeout") return false;
  if (!contestTargetWasStarted(input.eventLog, input.boardId)) return false;
  if (contestCloseProjected(input.eventLog, input.boardId)) return false;
  return true;
}
