import { hasLiveSessionResumeBudget } from "@silver/host";

type LiveSessionResult = {
  status: number;
  dshSessionId?: string;
  closed?: boolean;
  stopReason?: string;
};

export function shouldResumeLiveSession(
  result: LiveSessionResult,
  signal?: AbortSignal,
): result is LiveSessionResult & { dshSessionId: string } {
  if (signal?.aborted || !result.dshSessionId || result.closed === true) return false;
  return result.stopReason === "llm_transport_failure" || (result.status !== 0 && result.stopReason === undefined);
}

export function liveSessionRecoveryAction(
  result: LiveSessionResult,
  resumeCount: number,
  signal?: AbortSignal,
): "resume" | "exhausted" | "complete" {
  if (!shouldResumeLiveSession(result, signal)) return "complete";
  return hasLiveSessionResumeBudget(resumeCount) ? "resume" : "exhausted";
}

function liveSessionResumePrompt(): string {
  return "Continue the current task from the persisted DSH session. Reconcile any tool outcome marked unknown before repeating a side effect.";
}

export function liveMemberResumePrompt(
  memberId: string,
  role: "lead" | "worker",
  officialTeam = false,
): string {
  if (officialTeam) {
    return [
      liveSessionResumePrompt(),
      `You remain formal member ${memberId} (${role}).`,
      "Re-read room_info and reconcile unknown side effects. At the next natural boundary, pull current Status, DSH Team tasks, unread Feed, and new Intel before taking a substantial new direction.",
    ].join(" ");
  }
  return [
    liveSessionResumePrompt(),
    `You remain formal member ${memberId} (${role}). Re-read room_info before repeating side effects.`,
  ].join(" ");
}

export function liveLeadControlResumePrompt(memberId: string): string {
  return [
    `You remain formal member ${memberId} (lead).`,
    "An external control request was resolved. Call room_info, reconcile the authoritative result with the room-visible Team task map, and resume coordination.",
    "Use public task, Status, Feed, and Intel records. Do not inspect Worker command details, prescribe methods, or rebroadcast unchanged state.",
    "If no owner, priority, blocker, or completion state changed, end the turn without a routine summary.",
  ].join(" ");
}
