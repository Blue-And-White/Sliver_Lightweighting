/**
 * Official DSH Convergence Reviewer — short-lived ACP session.
 * Decision only via structured submit_convergence_decision → submit file slot.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CONVERGENCE_SYSTEM_ACTOR_ID,
  type ConvergenceReviewer,
  type ConvergenceReviewerInput,
  type ConvergenceReviewerResult,
} from "./convergence-episode.ts";
import {
  spawnOfficialDshAcpSession,
  type OfficialDshAcpModelSelection,
} from "./dsh-acp-client.ts";
import type { LiveRunStopReason } from "./live-run-ledger.ts";
import { DSH_LIVE_DISABLED_TOOL_PLUGINS } from "./live-dsh.ts";

export const CONVERGENCE_SUBMIT_PATH_ENV = "SILVER_CONVERGENCE_SUBMIT_PATH";
export const CONVERGENCE_REVIEWER_ENV = "SILVER_CONVERGENCE_REVIEWER";

export type OfficialDshConvergenceSession = {
  result: Promise<unknown>;
  stop(reason: LiveRunStopReason): void;
  setTimeoutMs?(timeoutMs: number): void;
  isActive?(): boolean;
};

export type SpawnOfficialDshConvergenceSession = (input: {
  repoRoot: string;
  cwd: string;
  patches?: readonly string[];
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  prompt: string;
  signal?: AbortSignal;
  modelSelection?: OfficialDshAcpModelSelection;
  onSessionReady?: (session: { sessionId: string; resumed: boolean }) => void;
}) => OfficialDshConvergenceSession;

export type OfficialDshConvergenceReviewerOptions = {
  repoRoot: string;
  /** Working directory for the short-lived Reviewer root. */
  cwd: string;
  patches: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  modelSelection?: OfficialDshAcpModelSelection;
  spawnSession?: SpawnOfficialDshConvergenceSession;
  /** Register the live session so CLI stopLiveSessions can cancel it. */
  onSession?: (session: OfficialDshConvergenceSession) => void;
};

/** Persona overlay: disable collaborative / native side-effect plugins for Reviewer. */
export function convergenceReviewerPersonaPatchYaml(): string {
  const disabled = [
    ...DSH_LIVE_DISABLED_TOOL_PLUGINS,
    "tool-bash",
    "tool-fs",
    "tool-fs-search",
    "web",
    "web-search-deepseek",
    "tool-web",
    "terminal",
    "terminal-bash",
    "tool-todo",
  ];
  const uniq = [...new Set(disabled)];
  return [
    "# Silver Convergence Reviewer — structured decision only",
    ...uniq.flatMap((id) => [`- id: ${id}`, "  disabled: true"]),
    "",
  ].join("\n");
}

export function buildConvergenceReviewerPrompt(input: ConvergenceReviewerInput): string {
  const triggers = input.triggers.map((row) => ({
    eventId: row.eventId,
    kind: row.kind,
    subjectRef: row.subjectRef,
    version: row.version,
    at: row.at,
  }));
  return [
    "You are the Host Convergence Reviewer for a solo Room.",
    "You are NOT a Room Member and NOT the Solver.",
    `Submit exactly one decision with the structured tool submit_convergence_decision.`,
    `actorMemberId MUST be ${input.systemActorId}.`,
    `expectedGeneration MUST be ${input.generationId}.`,
    `roomId=${input.roomId} challengeId=${input.challengeId}.`,
    "This solo review cannot change team tasks or the roster. Submit actions: [] as a coordination acknowledgement.",
    "Do not invent intel or evidence refs; evidence may be [].",
    "Do not solve the challenge yourself. Do not call other tools.",
    "",
    "Thin Room projection (Host facts only):",
    JSON.stringify(input.projection, null, 2),
    "",
    "This generation triggers:",
    JSON.stringify(triggers, null, 2),
  ].join("\n");
}

function readSubmittedEnvelope(submitPath: string): ConvergenceReviewerResult {
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

/**
 * Production ConvergenceReviewer: spawn official DSH, require structured tool submit.
 */
export function createOfficialDshConvergenceReviewer(
  options: OfficialDshConvergenceReviewerOptions,
): ConvergenceReviewer {
  const spawn = options.spawnSession ?? defaultSpawn;
  return {
    async synthesize(input: ConvergenceReviewerInput): Promise<ConvergenceReviewerResult> {
      if (input.signal?.aborted) {
        return { ok: false, reason: "aborted" };
      }
      fs.mkdirSync(options.cwd, { recursive: true });
      const submitPath = path.join(
        options.cwd,
        `.silver-convergence-submit-g${input.generationId}.json`,
      );
      try {
        fs.unlinkSync(submitPath);
      } catch {
        /* absent ok */
      }

      const env: NodeJS.ProcessEnv = {
        ...options.env,
        [CONVERGENCE_REVIEWER_ENV]: "1",
        [CONVERGENCE_SUBMIT_PATH_ENV]: submitPath,
        SILVER_CHALLENGE_ID: input.challengeId,
        SILVER_ATTEMPT_ID: `convergence-reviewer-g${input.generationId}`,
      };

      let stopReason: LiveRunStopReason | undefined;
      const onAbort = () => {
        stopReason = "interrupted";
        session?.stop("interrupted");
      };
      let session: OfficialDshConvergenceSession | undefined;
      if (input.signal?.aborted) return { ok: false, reason: "aborted" };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        session = spawn({
          repoRoot: options.repoRoot,
          cwd: options.cwd,
          patches: options.patches,
          timeoutMs: options.timeoutMs,
          env,
          prompt: buildConvergenceReviewerPrompt(input),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
        });
        options.onSession?.(session);
        await session.result.catch(() => undefined);
        if (input.signal?.aborted || stopReason === "interrupted") {
          return { ok: false, reason: "aborted" };
        }
        return readSubmittedEnvelope(submitPath);
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

const defaultSpawn: SpawnOfficialDshConvergenceSession = (input) =>
  spawnOfficialDshAcpSession({
    repoRoot: input.repoRoot,
    cwd: input.cwd,
    ...(input.patches ? { patches: input.patches } : {}),
    timeoutMs: input.timeoutMs,
    env: input.env,
    prompt: input.prompt,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    ...(input.onSessionReady ? { onSessionReady: input.onSessionReady } : {}),
  });

/** Re-export system actor for Reviewer prompt/tests without circular imports. */
export { CONVERGENCE_SYSTEM_ACTOR_ID };
