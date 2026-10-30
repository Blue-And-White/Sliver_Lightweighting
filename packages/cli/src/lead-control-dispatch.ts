export type LeadControlDispatch = {
  request(): void;
  flush(): void;
  dispose(): void;
  hasPending(): boolean;
  isInFlight(): boolean;
};

export function createLeadControlDispatch(input: {
  shouldStop(): boolean;
  canDispatch(): boolean;
  dispatch(): Promise<void>;
  retryMs?: number;
  onError?(error: unknown): void;
}): LeadControlDispatch {
  let pending = false;
  let inFlight = false;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const retryMs = input.retryMs ?? 5_000;

  const clearRetry = (): void => {
    if (!retry) return;
    clearTimeout(retry);
    retry = undefined;
  };
  const scheduleRetry = (): void => {
    if (disposed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      flush();
    }, retryMs);
    retry.unref?.();
  };
  const flush = (): void => {
    if (disposed) return;
    if (input.shouldStop()) {
      pending = false;
      clearRetry();
      return;
    }
    if (inFlight || !pending) return;
    if (!input.canDispatch()) {
      scheduleRetry();
      return;
    }
    pending = false;
    inFlight = true;
    let dispatched: Promise<void>;
    try {
      dispatched = input.dispatch();
    } catch (error) {
      inFlight = false;
      input.onError?.(error);
      if (disposed) return;
      pending = true;
      scheduleRetry();
      return;
    }
    void dispatched
      .then(clearRetry)
      .catch((error) => {
        input.onError?.(error);
        if (disposed) return;
        pending = true;
        scheduleRetry();
      })
      .finally(() => {
        inFlight = false;
        if (!disposed && pending && !retry) flush();
      });
  };

  return {
    request() {
      if (disposed) return;
      if (input.shouldStop()) {
        pending = false;
        clearRetry();
        return;
      }
      pending = true;
      flush();
    },
    flush,
    dispose() {
      disposed = true;
      pending = false;
      clearRetry();
    },
    hasPending: () => pending,
    isInFlight: () => inFlight,
  };
}
