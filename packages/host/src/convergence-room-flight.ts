/**
 * Per-Room single-flight for live Convergence Episodes (C5b solo or C6 swarm).
 * Concurrent kicks join the in-flight promise — never run two synthesizers for the same Room.
 */
import {
  runSoloConvergenceEpisode,
  type SoloConvergenceEpisodeInput,
  type SoloConvergenceEpisodeResult,
} from "./convergence-episode.ts";
import {
  runSwarmConvergenceEpisode,
  type SwarmConvergenceEpisodeInput,
  type SwarmConvergenceEpisodeResult,
} from "./swarm-episode.ts";

export type RoomConvergenceFlight = {
  promise: Promise<SoloConvergenceEpisodeResult | SwarmConvergenceEpisodeResult>;
  abort: AbortController;
  startedAtMs: number;
};

const flights = new Map<string, RoomConvergenceFlight>();

export function roomConvergenceFlightKey(roomId: string, challengeId: string): string {
  return `${roomId}:${challengeId}`;
}

function linkAbortSignals(parent: AbortSignal | undefined, child: AbortController): void {
  if (!parent) return;
  if (parent.aborted) {
    child.abort(parent.reason);
    return;
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  child.signal.addEventListener(
    "abort",
    () => parent.removeEventListener("abort", onAbort),
    { once: true },
  );
}

/**
 * Run or join the single in-flight solo episode for this Room.
 * Optional `run` injects the episode runner (tests).
 */
export async function runSoloConvergenceEpisodeSingleFlight(
  input: SoloConvergenceEpisodeInput,
  run: typeof runSoloConvergenceEpisode = runSoloConvergenceEpisode,
): Promise<SoloConvergenceEpisodeResult> {
  const key = roomConvergenceFlightKey(input.roomId, input.challengeId);
  const existing = flights.get(key);
  if (existing) return existing.promise as Promise<SoloConvergenceEpisodeResult>;

  const abort = new AbortController();
  linkAbortSignals(input.signal, abort);
  const flightInput: SoloConvergenceEpisodeInput = {
    ...input,
    signal: abort.signal,
  };
  const promise = run(flightInput).finally(() => {
    const cur = flights.get(key);
    if (cur?.promise === promise) flights.delete(key);
  });
  flights.set(key, { promise, abort, startedAtMs: Date.now() });
  return promise;
}

/**
 * Run or join the single in-flight swarm episode for this Room.
 * Lead session synthesizer is serial; concurrent member idles join the same flight.
 */
export async function runSwarmConvergenceEpisodeSingleFlight(
  input: SwarmConvergenceEpisodeInput,
  run: typeof runSwarmConvergenceEpisode = runSwarmConvergenceEpisode,
): Promise<SwarmConvergenceEpisodeResult> {
  const key = roomConvergenceFlightKey(input.roomId, input.challengeId);
  const existing = flights.get(key);
  if (existing) return existing.promise as Promise<SwarmConvergenceEpisodeResult>;

  const abort = new AbortController();
  linkAbortSignals(input.signal, abort);
  const flightInput: SwarmConvergenceEpisodeInput = {
    ...input,
    signal: abort.signal,
  };
  const promise = run(flightInput).finally(() => {
    const cur = flights.get(key);
    if (cur?.promise === promise) flights.delete(key);
  });
  flights.set(key, { promise, abort, startedAtMs: Date.now() });
  return promise;
}

/** Cancel the in-flight Reviewer/Lead synthesizer episode (platform stop / deadline / SIGINT). */
export function cancelRoomConvergenceFlight(roomId: string, challengeId: string, reason?: unknown): boolean {
  const key = roomConvergenceFlightKey(roomId, challengeId);
  const flight = flights.get(key);
  if (!flight) return false;
  flight.abort.abort(reason ?? "room_convergence_cancelled");
  return true;
}

/** Test / recovery helper — clears the in-memory flight table. */
export function resetRoomConvergenceFlightsForTests(): void {
  for (const flight of flights.values()) {
    flight.abort.abort("test_reset");
  }
  flights.clear();
}

export function activeRoomConvergenceFlight(
  roomId: string,
  challengeId: string,
): RoomConvergenceFlight | undefined {
  return flights.get(roomConvergenceFlightKey(roomId, challengeId));
}
