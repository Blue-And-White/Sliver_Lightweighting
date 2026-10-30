export type ThreeGraphSlotEvent<T> =
  | { kind: "planned"; slot: number; turn: T | undefined }
  | { kind: "finished"; slot: number }
  | { kind: "stopped" };

export const THREE_GRAPH_WORKER_COUNT = 3;

export function nextThreeGraphSlotEvent<T>(input: {
  planning?: { slot: number; turn: Promise<T | undefined> };
  active: ReadonlyMap<number, Promise<void>>;
  stopped: Promise<void>;
}): Promise<ThreeGraphSlotEvent<T>> {
  return Promise.race([
    ...(input.planning
      ? [
          input.planning.turn.then((turn) => ({
            kind: "planned" as const,
            slot: input.planning!.slot,
            turn,
          })),
        ]
      : []),
    ...[...input.active].map(([slot, run]) =>
      run.then(
        () => ({ kind: "finished" as const, slot }),
        () => ({ kind: "finished" as const, slot }),
      ),
    ),
    input.stopped.then(() => ({ kind: "stopped" as const })),
  ]);
}
