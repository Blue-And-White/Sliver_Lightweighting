/**
 * Platform verdict facts for the existing quiet/verdict notice.
 * Host reports the count and one fingerprint. It does not classify the next attempt.
 */
import fs from "node:fs";
import { readOfficialTeamRejectedFingerprints } from "./official-team-rejected.ts";

export function rejectedVerdictFacts(roomClockDir: string): { rejectedCount: number; fingerprint?: string } | undefined {
  const fingerprints = [...readOfficialTeamRejectedFingerprints(roomClockDir)];
  const fingerprint = fingerprints[0];
  if (!fingerprint) return undefined;
  return { rejectedCount: fingerprints.length, fingerprint };
}

export function rejectedVerdictText(facts: { rejectedCount: number; fingerprint?: string; status?: string }): string {
  const status = facts.status ?? "rejected";
  const fingerprint = facts.fingerprint ? ` fingerprint ${facts.fingerprint}` : "";
  return `Platform ${status} count ${facts.rejectedCount}.${fingerprint} status=${status}. Host records this exact platform fact and does not classify candidate families or prescribe the next action.`;
}
