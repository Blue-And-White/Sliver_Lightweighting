/**
 * Recovery invariant for an Official Team room. Not a new scheduler.
 * A non-terminal fault must not leave the room pending, processing, or
 * active-but-unwakeable. The next step is a durable no-op, a single
 * redelivery, a soft-fail, a same-room resume, or a real terminal stop.
 */
import type { ConvergenceStore } from "./convergence-generation.ts";
import { deadlineContestReleaseOwed } from "./contest-deadline-release.ts";

export function exhaustedDecisionNeedsNoop(
  store: Pick<ConvergenceStore, "active" | "terminalHalt">,
): boolean {
  if (store.terminalHalt) return false;
  const active = store.active;
  if (!active) return false;
  if (active.state !== "pending" && active.state !== "processing") return false;
  if (active.decisionRedeliveryExhausted) return true;
  return active.state === "processing" && (active.decisionRedeliveries ?? 0) >= 1;
}

export type OfficialTeamRecoveryDisposition =
  | { kind: "terminal_stop"; reason: string }
  | { kind: "noop_apply"; generationId: number }
  | { kind: "retry_deadline_close" }
  | { kind: "resume_transport" }
  | { kind: "continue" };

/**
 * Precedence: accepted/operator terminal halt, then transport resume,
 * then an unprojected deadline close, then an exhausted decision no-op.
 * Anything else stays wakeable.
 */
export function officialTeamRecoveryDisposition(input: {
  convergence?: Pick<ConvergenceStore, "active" | "terminalHalt">;
  eventLog?: string;
  boardId?: string;
  roomExpired?: boolean;
  stopReason?: string;
}): OfficialTeamRecoveryDisposition {
  const halt = input.convergence?.terminalHalt;
  if (halt) return { kind: "terminal_stop", reason: halt.reason };
  if (input.stopReason === "llm_transport_failure") return { kind: "resume_transport" };
  if (
    input.eventLog !== undefined &&
    input.boardId &&
    deadlineContestReleaseOwed({
      eventLog: input.eventLog,
      boardId: input.boardId,
      roomExpired: input.roomExpired === true,
      ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    })
  ) {
    return { kind: "retry_deadline_close" };
  }
  const active = input.convergence?.active;
  if (input.convergence && exhaustedDecisionNeedsNoop(input.convergence) && active) {
    return { kind: "noop_apply", generationId: active.generationId };
  }
  return { kind: "continue" };
}
