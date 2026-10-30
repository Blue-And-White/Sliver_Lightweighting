/** Fan-out latch. One signal resolves every current waiter. Cancel drops one waiter. */
export function createWaitBroadcast<T>(): {
  wait: () => Promise<T>;
  waitCancelable: () => { promise: Promise<T>; cancel: () => void };
  signal: (value: T) => number;
  pending: () => number;
} {
  const waiters: Array<(value: T) => void> = [];
  const enroll = (): { promise: Promise<T>; cancel: () => void } => {
    let resolveWait: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolve) => {
      resolveWait = resolve;
      waiters.push(resolve);
    });
    return {
      promise,
      cancel() {
        const index = waiters.indexOf(resolveWait);
        if (index >= 0) waiters.splice(index, 1);
      },
    };
  };
  return {
    wait() {
      return enroll().promise;
    },
    waitCancelable: enroll,
    signal(value) {
      const batch = waiters.splice(0, waiters.length);
      for (const resolve of batch) resolve(value);
      return batch.length;
    },
    pending() {
      return waiters.length;
    },
  };
}
