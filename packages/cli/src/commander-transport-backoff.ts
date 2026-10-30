export async function waitForCommanderTransportBackoff(
  signal: AbortSignal,
  delayMs = 30_000,
): Promise<"retry" | "aborted"> {
  if (signal.aborted) return "aborted";

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const elapsed = new Promise<"retry">((resolve) => {
    timer = setTimeout(() => resolve("retry"), delayMs);
  });

  try {
    return await Promise.race([elapsed, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
