import { bindFingerprint, type CandidateRef } from "@silver/protocol";
import type { Ledger } from "@silver/ledger";
import type { MockPlatform } from "@silver/platform-mock";

export interface SubmitOutcome {
  status: "accepted" | "rejected" | "unknown" | "duplicate" | "reported";
  remainingFlags?: number;
  slot?: number;
  reason?: string;
  fingerprint?: string;
}

export class SubmitBroker {
  private readonly ledger: Ledger;
  private readonly platform: MockPlatform;

  constructor(ledger: Ledger, platform: MockPlatform) {
    this.ledger = ledger;
    this.platform = platform;
  }

  async submit(input: {
    challengeId: string;
    attemptId: string;
    candidate: CandidateRef;
  }): Promise<SubmitOutcome> {
    const bound = bindFingerprint(input.candidate);
    if (!bound.ok) {
      return { status: "rejected", reason: bound.reason };
    }
    const fingerprint = bound.fingerprint;
    if (!this.ledger.hasOraclePass(input.challengeId, input.attemptId, fingerprint)) {
      return {
        status: "rejected",
        reason: "submit requires a matching preflight pass; candidate correctness is only the platform verdict",
      };
    }
    const inserted = this.ledger.insertSubmitting(input.challengeId, input.attemptId, fingerprint);
    if (inserted === "duplicate") {
      this.ledger.appendEvent(
        "submit_duplicate",
        { fingerprint },
        { missionId: "n/a", challengeId: input.challengeId, attemptId: input.attemptId },
      );
      return { status: "duplicate" };
    }
    try {
      const verdict = this.platform.submit(input.challengeId, input.candidate.raw ?? "");
      if (verdict.status === "accepted") {
        const cas = this.ledger.acceptedCas(input.challengeId, input.attemptId);
        if (!cas.won) {
          this.ledger.finishSubmission(input.challengeId, fingerprint, "rejected", verdict.slot);
          return { status: "rejected", reason: "flag slot already taken", remainingFlags: cas.remaining };
        }
        this.ledger.finishSubmission(input.challengeId, fingerprint, "accepted", verdict.slot);
        const outcome: SubmitOutcome = { status: "accepted", remainingFlags: cas.remaining };
        if (typeof verdict.slot === "number") outcome.slot = verdict.slot;
        return outcome;
      }
      this.ledger.finishSubmission(input.challengeId, fingerprint, "rejected", verdict.slot);
      return { status: "rejected" };
    } catch {
      this.ledger.markUnknown(input.challengeId, fingerprint);
      return { status: "unknown" };
    }
  }
}
