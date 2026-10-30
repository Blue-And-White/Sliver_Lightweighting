/**
 * Production RPC gate: a contest submit that the platform marks complete
 * stops the room. Local submission counts do not.
 */
import { ChallengeRuntime, hostReachedLiveTerminal } from "@silver/host";
import type { HostRpcRequest, HostRpcResponse } from "@silver/protocol";

export function liveAcceptanceMode(mission: boolean, contestSubmit = false): "platform" | "candidate-report" {
  if (contestSubmit) return "platform";
  return mission ? "candidate-report" : "platform";
}

export function hostTerminalForLive(
  runtime: ChallengeRuntime,
  challengeId: string,
  mission: boolean,
  contestSubmit = false,
  candidateReportIsNonTerminal = false,
): boolean {
  if (candidateReportIsNonTerminal && mission && !contestSubmit) return false;
  if (contestSubmit) return runtime.platformCompleted(challengeId);
  return hostReachedLiveTerminal({
    acceptanceMode: liveAcceptanceMode(mission, contestSubmit),
    snapshot: runtime.snapshot(challengeId),
    candidates: runtime.candidateRecords(challengeId),
  });
}

export function dispatchUntilHostTerminal(
  runtime: ChallengeRuntime,
  challengeId: string,
  mission: boolean,
  stop: () => void,
  contestSubmit = false,
  candidateReportIsNonTerminal = false,
  onCandidateReported?: (event: {
    fingerprint: string;
    status: "reported" | "duplicate";
  }) => void | Promise<void>,
  isReviewHold?: () => boolean,
  blockSubmitDuringReview = true,
): (request: HostRpcRequest) => Promise<HostRpcResponse> {
  return async (request) => {
    if (blockSubmitDuringReview && !contestSubmit && isReviewHold?.() && request.method === "submit_candidate") {
      // Hold already applied — still re-enter the callback so a missed C2 note can be repaired.
      const held =
        [...runtime.candidateRecords(challengeId)].reverse().find((row) => row.submission)?.fingerprint ?? "";
      if (candidateReportIsNonTerminal && held) {
        await onCandidateReported?.({ fingerprint: held, status: "duplicate" });
      }
      return {
        ok: true,
        result: {
          status: "duplicate",
          reason: "review_hold",
          acceptanceMode: "candidate-report",
          ...(held ? { fingerprint: held } : {}),
        },
      };
    }
    const response = await runtime.dispatchRpc(request);
    const reportStatus = String(response.result?.status ?? "");
    if (
      !contestSubmit &&
      candidateReportIsNonTerminal &&
      request.method === "submit_candidate" &&
      response.ok &&
      (reportStatus === "reported" || reportStatus === "duplicate")
    ) {
      await onCandidateReported?.({
        fingerprint: String(response.result?.fingerprint ?? ""),
        status: reportStatus as "reported" | "duplicate",
      });
    }
    if (hostTerminalForLive(runtime, challengeId, mission, contestSubmit, candidateReportIsNonTerminal)) {
      if (contestSubmit) {
        try {
          runtime.settleAuthoritativePlatformCompletion(challengeId);
        } catch {
          // The adapter verdict is already authoritative. Local settlement can
          // be repaired by later platform reconciliation after the room stops.
        }
      }
      setImmediate(stop);
    }
    return response;
  };
}
