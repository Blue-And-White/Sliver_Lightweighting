/**
 * Room deadline stop is a hard action. Convergence, stall, and Lead notices
 * are best-effort and must not delay stopAll.
 */
export function beginRoomDeadlineStop(input: {
  stopAll: (reason: "timeout") => void;
  noteConvergence?: () => Promise<unknown>;
  onNoteError?: (err: unknown) => void;
}): void {
  input.stopAll("timeout");
  const note = input.noteConvergence;
  if (!note) return;
  void Promise.resolve()
    .then(() => note())
    .catch((err: unknown) => {
      input.onNoteError?.(err);
    });
}
