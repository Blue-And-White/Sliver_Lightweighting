/**
 * C6 Live Lead synthesizer — same Room Lead DSH session, serial decision turns.
 * Reuses submit_convergence_decision → submit file → C3 apply (no second resident model).
 */
import fs from "node:fs";
import path from "node:path";
import {
  type ConvergenceReviewer,
  type ConvergenceReviewerInput,
  type ConvergenceReviewerResult,
} from "./convergence-episode.ts";
import { SWARM_LEAD_MEMBER_ID } from "./swarm-episode.ts";
import { CONVERGENCE_SUBMIT_PATH_ENV } from "./convergence-reviewer-dsh.ts";
import { quietRoomNoticeText } from "../../ctf-spine/src/plugin.ts";
import { readQuietRoomWake } from "../../ctf-spine/src/quiet-room-wake.ts";
import { officialDecisionProofMatches } from "@silver/protocol";
import { officialTeamDecisionAddendum, readOfficialTeamPermits } from "./official-team-c3.ts";
import { readRoomMembers, roomMembersPath } from "./room-members.ts";
import { rosterMemberIsLead } from "./team-member-identity.ts";

export { CONVERGENCE_SUBMIT_PATH_ENV };

/** Env flag on the Lead DSH root: expose submit_convergence_decision with actor=lead. */
export const ROOM_SWARM_ENV = "SILVER_ROOM_SWARM";

export function swarmLeadSubmitPath(roomClockDir: string, generationId: number): string {
  return path.join(roomClockDir, `.silver-swarm-lead-submit-g${generationId}.json`);
}

/**
 * Stable path for the persistent Official Team Lead.
 * The child env is snapshotted at spawn; a per-generation path set later is invisible.
 */
export function swarmLeadSubmitChannel(roomClockDir: string): string {
  return path.join(roomClockDir, ".silver-swarm-lead-submit.json");
}

/**
 * Quiet-room copy for a stall_boundary coordination turn.
 * The Host reports only the checkpoint event; the Lead decides how to coordinate.
 */
export function quietRoomStallLeadAddendum(
  triggers: readonly { kind: string }[],
  roomClockDir?: string,
): string | undefined {
  if (!triggers.some((row) => row.kind === "stall_boundary")) return undefined;
  const wake = roomClockDir ? readQuietRoomWake(roomClockDir) : undefined;
  const stalls = wake?.stallsSinceCandidate ?? 1;
  return quietRoomNoticeText(stalls);
}

export function buildSwarmLeadDecisionPrompt(input: ConvergenceReviewerInput): string {
  const leadId = input.systemActorId || SWARM_LEAD_MEMBER_ID;
  const triggers = input.triggers.map((row) => ({
    eventId: row.eventId,
    kind: row.kind,
    subjectRef: row.subjectRef,
    version: row.version,
    at: row.at,
  }));
  return [
    "Host wake: Room Swarm coordination turn for formal member lead.",
    "You are the Room Lead. Serialize coordination on this same session — do not explore in this turn.",
    `Submit exactly one decision with the structured tool submit_convergence_decision.`,
    `actorMemberId MUST be ${leadId}.`,
    `expectedGeneration MUST be ${input.generationId}.`,
    `roomId=${input.roomId} challengeId=${input.challengeId}.`,
    "Allowed actions: recruit (worker only) or remove. DSH Team tasks record outcome-level responsibilities and owners; they do not establish facts or prescribe execution methods.",
    "Do not invent intel or evidence refs; evidence may be [].",
    "Do not solve the challenge in this turn. Prefer submit_convergence_decision then end your turn.",
    "",
    "Thin Room projection (Host facts only):",
    JSON.stringify(input.projection, null, 2),
    "",
    "This generation triggers:",
    JSON.stringify(triggers, null, 2),
  ].join("\n");
}

export function readSwarmLeadSubmittedEnvelope(submitPath: string): ConvergenceReviewerResult {
  if (!fs.existsSync(submitPath)) {
    return { ok: false, reason: "decision_not_submitted" };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(submitPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `submit_read_failed:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `submit_json_invalid:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, envelope: parsed };
}

/** A durable submit for this generation is the decision. Do not unlink it or ask the model again. */
function submittedEnvelopeForGeneration(
  submitPath: string,
  generationId: number,
): ConvergenceReviewerResult | undefined {
  const read = readSwarmLeadSubmittedEnvelope(submitPath);
  if (!read.ok) return undefined;
  const raw = read.envelope;
  if (!raw || typeof raw !== "object") return undefined;
  const expected = Number((raw as { expectedGeneration?: unknown }).expectedGeneration);
  if (expected !== generationId) return undefined;
  return read;
}

export type ResumeLeadDecisionTurn = (input: {
  prompt: string;
  submitPath: string;
  generationId: number;
  signal?: AbortSignal;
}) => Promise<void>;

export type LeadSessionSwarmSynthesizerOptions = {
  roomClockDir: string;
  /** Resume the existing Lead ACP session with a coordination prompt (serial; never a second root). */
  resumeLeadDecisionTurn: ResumeLeadDecisionTurn;
  leadMemberId?: string;
  /** Append Official Team permit rules. Does not switch the default swarm prompt. */
  officialTeam?: boolean;
  /** Attempt capability. Official Team files must be sealed with it. */
  leadCapability?: () => string | undefined;
};

function officialLeadFileAccepted(roomClockDir: string, raw: unknown, capability: string | undefined): boolean {
  if (!capability || !raw || typeof raw !== "object") return false;
  const row = raw as Record<string, unknown>;
  const sessionId = typeof row.principalSessionId === "string" ? row.principalSessionId.trim() : "";
  const proof = typeof row.principalProof === "string" ? row.principalProof : "";
  const challengeId = typeof row.challengeId === "string" ? row.challengeId.trim() : "";
  if (!sessionId || !proof || !challengeId) return false;
  if (!officialDecisionProofMatches(capability, { sessionId }, row, proof)) return false;
  const members = readRoomMembers(roomMembersPath(roomClockDir, challengeId))?.members ?? [];
  return rosterMemberIsLead(members, { sessionId });
}

/**
 * Production swarm synthesizer: wake the Room Lead session, require structured submit.
 */
export function createLeadSessionSwarmSynthesizer(
  options: LeadSessionSwarmSynthesizerOptions,
): ConvergenceReviewer {
  const leadMemberId = options.leadMemberId ?? SWARM_LEAD_MEMBER_ID;
  return {
    async synthesize(input: ConvergenceReviewerInput): Promise<ConvergenceReviewerResult> {
      if (input.signal?.aborted) {
        return { ok: false, reason: "aborted" };
      }
      const submitPath = options.officialTeam
        ? swarmLeadSubmitChannel(options.roomClockDir)
        : swarmLeadSubmitPath(options.roomClockDir, input.generationId);
      const gateOfficialFile = (read: ConvergenceReviewerResult): ConvergenceReviewerResult => {
        if (!options.officialTeam || !read.ok) return read;
        if (officialLeadFileAccepted(options.roomClockDir, read.envelope, options.leadCapability?.())) return read;
        try {
          fs.unlinkSync(submitPath);
        } catch {
          /* absent ok */
        }
        return { ok: false, reason: "lead_principal_rejected" };
      };
      const already = submittedEnvelopeForGeneration(submitPath, input.generationId);
      if (already) return gateOfficialFile(already);
      try {
        fs.unlinkSync(submitPath);
      } catch {
        /* absent ok */
      }
      const promptInput: ConvergenceReviewerInput = {
        ...input,
        systemActorId: leadMemberId,
      };
      const stall = options.officialTeam
        ? quietRoomStallLeadAddendum(promptInput.triggers, options.roomClockDir)
        : undefined;
      const prompt = options.officialTeam
        ? [
            buildSwarmLeadDecisionPrompt(promptInput),
            officialTeamDecisionAddendum(readOfficialTeamPermits(options.roomClockDir)),
            ...(stall ? [stall] : []),
          ].join("\n\n")
        : buildSwarmLeadDecisionPrompt(promptInput);
      try {
        await options.resumeLeadDecisionTurn({
          prompt,
          submitPath,
          generationId: input.generationId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (err) {
        const raced = submittedEnvelopeForGeneration(submitPath, input.generationId);
        if (raced) return gateOfficialFile(raced);
        const message = err instanceof Error ? err.message : String(err);
        if (message === "lead_session_still_active") {
          return { ok: false, reason: "lead_session_still_active" };
        }
        throw err;
      }
      if (input.signal?.aborted) {
        const raced = submittedEnvelopeForGeneration(submitPath, input.generationId);
        if (raced) return gateOfficialFile(raced);
        return { ok: false, reason: "aborted" };
      }
      return gateOfficialFile(readSwarmLeadSubmittedEnvelope(submitPath));
    },
  };
}
