import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const OWNER_LABEL = "silver.owner";
export const MISSION_LABEL = "silver.mission_id";
export const CHALLENGE_LABEL = "silver.challenge_id";
export const OWNER_VALUE = "challenge-sandbox";

export const CELL_MOUNT = "/work";
export const REPO_MOUNT = "/opt/silver";
export const WORKDIR = "/work/workspace";
export const EPHEMERAL_HOME = "/tmp/silver-home";

export type Autonomy = "autonomous" | "human_assisted";
export type OracleVerdict = "pass" | "fail" | "unknown";
export type SubmissionStatus =
  | "submitting"
  | "accepted"
  | "rejected"
  | "unknown"
  | "duplicate"
  | "reported";
export type AcceptanceMode = "platform" | "candidate-report";
export type ChallengeStatus = "queued" | "running" | "solved" | "failed" | "stopped";
export type AttemptStatus = "queued" | "running" | "stopped" | "exhausted";

export interface CandidateRef {
  candidateId: string;
  fingerprint: string;
  artifactRef: string;
  shape: string;
  raw?: string;
}

/** Public platform-submit input. Host derives the fingerprint and fills provenance defaults. */
export interface CandidateSubmitInput {
  raw: string;
}

export interface RpcCapability {
  challengeId: string;
  containerId: string;
  attemptId: string;
  generation: number;
  exp: number;
  scopes: RpcScope[];
}

export type RpcScope =
  | "submit_candidate"
  | "verify_candidate"
  | "snapshot"
  | "challenge_info"
  | "intel_read"
  | "intel_publish"
  | "intel_update"
  | "graph_overview"
  | "graph_query"
  | "intel_record"
  | "exploration_update"
  // Hidden legacy RPC aliases for an already-running pre-migration plugin.
  | "intel_comment"
  | "intel_revise"
  | "intel_retract"
  | "ask_skeptic"
  | "request_hint"
  | "restart_challenge"
  | "set_room_deadline"
  | "submit_convergence_decision"
  | "contest_list"
  | "contest_start"
  | "queue_target"
  | "mission_status"
  | "review_room_allocation"
  | "record_target_result"
  | "resolve_room_request"
  | "mission_done"
  | "room_feed_post"
  | "room_feed_read"
  | "room_status_set"
  | "room_status_read";

export type HostRpcMethod =
  | "room_info"
  | "challenge_info"
  | "verify_candidate"
  | "submit_candidate"
  | "snapshot"
  | "intel_read"
  | "intel_publish"
  | "intel_update"
  | "graph_overview"
  | "graph_query"
  | "intel_record"
  | "exploration_update"
  // Hidden legacy RPC aliases for an already-running pre-migration plugin.
  | "intel_comment"
  | "intel_revise"
  | "intel_retract"
  | "ask_skeptic"
  | "request_hint"
  | "restart_challenge"
  | "set_room_deadline"
  | "submit_convergence_decision"
  | "contest_list"
  | "contest_start"
  | "queue_target"
  | "mission_status"
  | "review_room_allocation"
  | "record_target_result"
  | "resolve_room_request"
  | "mission_done"
  | "room_feed_post"
  | "room_feed_read"
  | "room_status_set"
  | "room_status_read";

/**
 * Session facts copied from DSH ToolExecution.
 * They are not a credential by themselves. Official Team authorization also
 * requires sessionProof, an HMAC only the plugin can produce after it has
 * removed the Host capability from the process environment.
 */
export interface NativeSessionRpcMeta {
  sessionId: string;
  parentSessionId?: string;
}

export interface HostRpcRequest {
  method: HostRpcMethod;
  capability: string;
  payload: Record<string, unknown>;
  nativeSession?: NativeSessionRpcMeta;
  /** HMAC of nativeSession under the Host capability. Not a model argument. */
  sessionProof?: string;
}

/** Bind a ToolExecution session to the capability held in the plugin closure. */
export function officialSessionProof(
  capability: string,
  session: { sessionId: string; parentSessionId?: string },
): string {
  const canonical = `${session.sessionId}\n${session.parentSessionId ?? ""}`;
  return createHmac("sha256", capability).update(canonical).digest("base64url");
}

export function officialSessionProofMatches(
  capability: string,
  session: { sessionId: string; parentSessionId?: string },
  proof: string,
): boolean {
  const expected = officialSessionProof(capability, session);
  const left = Buffer.from(expected);
  const right = Buffer.from(proof);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function sealOfficialTeamRequest<T extends HostRpcRequest>(request: T): T {
  if (!request.nativeSession?.sessionId || !request.capability) return request;
  return {
    ...request,
    sessionProof: officialSessionProof(request.capability, request.nativeSession),
  };
}

export interface HostRpcResponse {
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

export type TrackKind = "jeopardy" | "awd" | "agent-awd" | "pentest" | "koh" | "vuln";
export type HintPolicy = "off" | "open";

export function isHintPolicy(value: string): value is HintPolicy {
  return value === "off" || value === "open";
}

/** AWD tracks retain their operator-in-the-loop fallback unless config says otherwise. */
export function defaultAutonomy(track: TrackKind): Autonomy {
  return track === "awd" || track === "agent-awd" ? "human_assisted" : "autonomous";
}

export type AwdRole = "attacker" | "defender" | "persister" | "sniffer";
export type ImplantDurability = "hidden" | "immortal";
export type AwdMoveKind = "patch" | "implant" | "honeypot" | "dirty" | "attack_submit" | "foothold" | "sniff";
export type DirtyKind =
  | "checker-race"
  | "patch-secret-path"
  | "poison-comment"
  | "wipe-hidden"
  | "clean-immortal";
export type OperatorDecision = "approve" | "reject";

export const AWD_ROLES: readonly AwdRole[] = ["attacker", "defender", "persister", "sniffer"];
export const AWD_MOVE_KINDS: readonly AwdMoveKind[] = [
  "patch",
  "implant",
  "honeypot",
  "dirty",
  "attack_submit",
  "foothold",
  "sniff",
];
export const DIRTY_KINDS: readonly DirtyKind[] = [
  "checker-race",
  "patch-secret-path",
  "poison-comment",
  "wipe-hidden",
  "clean-immortal",
];

export function isAwdRole(value: string): value is AwdRole {
  return (AWD_ROLES as readonly string[]).includes(value);
}

export function isImplantDurability(value: string): value is ImplantDurability {
  return value === "hidden" || value === "immortal";
}

export function isAwdMoveKind(value: string): value is AwdMoveKind {
  return (AWD_MOVE_KINDS as readonly string[]).includes(value);
}

export function isDirtyKind(value: string): value is DirtyKind {
  return (DIRTY_KINDS as readonly string[]).includes(value);
}

/**
 * Classic Jeopardy shape for an explicit pattern, and the fallback when a
 * configured regex does not compile. Unset competition config is `any`.
 */
export const DEFAULT_FLAG_PATTERN = String.raw`flag\{[ -~]{1,256}\}`;
export const OPEN_FLAG_PATTERN = "any";
export const FLAG_SHAPE = new RegExp(`^${DEFAULT_FLAG_PATTERN}$`);

/** Mission or config pattern when set. Missing means open shape, not flag{}. */
export function flagPatternOrAny(source?: string | null): string {
  const trimmed = source?.trim() ?? "";
  return trimmed || OPEN_FLAG_PATTERN;
}

export interface FlagPolicy {
  source: string;
  shapeRequired: boolean;
  matches(raw: string): boolean;
  redact(text: string): string;
}

const OPEN_SHAPE = new Set(["", "any", "*", "none"]);

function defaultRedact(text: string): string {
  return text.replace(/flag\{[ -~]{1,256}\}/gi, "flag{[REDACTED]}");
}

export function compileFlagPolicy(source = DEFAULT_FLAG_PATTERN): FlagPolicy {
  const trimmed = source.trim();
  if (OPEN_SHAPE.has(trimmed.toLowerCase())) {
    return {
      source: trimmed || "any",
      shapeRequired: false,
      matches: (raw) => raw.trim().length > 0,
      redact: defaultRedact,
    };
  }
  const pattern = trimmed || DEFAULT_FLAG_PATTERN;
  let matchRe: RegExp;
  let findRe: RegExp;
  try {
    const anchored = pattern.startsWith("^") || pattern.endsWith("$") ? pattern : `^(?:${pattern})$`;
    matchRe = new RegExp(anchored);
    const inner = pattern.replace(/^\^/, "").replace(/\$$/, "");
    findRe = new RegExp(inner, "gi");
  } catch {
    return compileFlagPolicy(DEFAULT_FLAG_PATTERN);
  }
  return {
    source: pattern,
    shapeRequired: true,
    matches(raw: string) {
      matchRe.lastIndex = 0;
      return matchRe.test(raw.trim());
    },
    redact(text: string) {
      findRe.lastIndex = 0;
      const shaped = text.replace(findRe, (match) => {
        const open = match.indexOf("{");
        if (open >= 0 && match.endsWith("}")) return `${match.slice(0, open + 1)}[REDACTED]}`;
        return "[REDACTED]";
      });
      return defaultRedact(shaped);
    },
  };
}

/** Empty / * / any = unrestricted. Entries may be origin, URL prefix, hostname, or *.domain. */
export function urlAllowed(url: string, rules: string[]): { ok: true } | { ok: false; reason: string } {
  const open = rules.map((row) => row.trim()).filter(Boolean);
  if (open.length === 0 || open.some((row) => row === "*" || row.toLowerCase() === "any")) {
    return { ok: true };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  for (const rule of open) {
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1);
      if (parsed.hostname === rule.slice(2) || parsed.hostname.endsWith(suffix)) return { ok: true };
      continue;
    }
    if (rule.includes("://")) {
      if (url.startsWith(rule) || parsed.origin === rule || parsed.href.startsWith(rule)) return { ok: true };
      continue;
    }
    if (parsed.hostname === rule || parsed.hostname.endsWith(`.${rule}`)) return { ok: true };
  }
  return { ok: false, reason: "url not in challenge scope" };
}

export function scopeRules(input: { targetUrl?: string; inScopeUrls?: string[]; inScopeAgentUrls?: string[] }): string[] {
  const rules = [...(input.inScopeUrls ?? []), ...(input.inScopeAgentUrls ?? [])].map((row) => row.trim()).filter(Boolean);
  if (rules.length === 0 || rules.some((row) => row === "*" || row.toLowerCase() === "any")) return [];
  if (input.targetUrl) {
    try {
      rules.push(new URL(input.targetUrl).origin);
    } catch {
      /* ignore */
    }
  }
  return [...new Set(rules)];
}

export function fingerprintCandidate(raw: string): string {
  return createHash("sha256").update(raw.trim(), "utf8").digest("hex");
}

/** Host-authoritative fingerprint. Caller-supplied fingerprint is never trusted. */
export function bindFingerprint(
  candidate: { raw?: string; fingerprint?: string },
): { ok: true; fingerprint: string } | { ok: false; reason: string } {
  if (!candidate.raw) {
    return { ok: false, reason: "candidate raw missing" };
  }
  const fingerprint = fingerprintCandidate(candidate.raw);
  if (candidate.fingerprint && candidate.fingerprint !== fingerprint) {
    return { ok: false, reason: "fingerprint does not match SHA256(raw)" };
  }
  return { ok: true, fingerprint };
}

export {
  DECISION_ENVELOPE_SCHEMA,
  officialDecisionProof,
  officialDecisionProofMatches,
  parseDecisionEnvelope,
} from "./decision-envelope.ts";
export type {
  DecisionAction,
  DecisionEnvelope,
  DecisionEvidenceRef,
  DecisionRecruitAction,
  DecisionRemoveAction,
} from "./decision-envelope.ts";
