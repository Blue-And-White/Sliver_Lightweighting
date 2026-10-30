/** Per-Room serialization for convergence ledger and platform-stop mutations. */

const roomLedgerTails = new Map<string, Promise<unknown>>();

/** Serialize durable Room ledger mutations (convergence + platform stop). */
export async function withRoomLedgerLock<T>(roomKey: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = roomLedgerTails.get(roomKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(
    () => gate,
    () => gate,
  );
  roomLedgerTails.set(roomKey, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}
