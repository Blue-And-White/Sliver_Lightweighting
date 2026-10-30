import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type LiveSessionStateStatus = "active" | "stalled" | "interrupted" | "terminal";
export const LIVE_SESSION_MAX_RESUMES = 3;

export interface LiveSessionState {
  schema: "silver.live-session-state.v1";
  challengeId: string;
  attemptId: string;
  targetFingerprint: string;
  provider: string;
  model: string;
  routeFingerprint: string;
  sessionId: string;
  cwd: string;
  dshHome: string;
  status: LiveSessionStateStatus;
  /** Transport / ACP fault resume count only — never Host wake count. */
  resumeCount: number;
  /** Formal-member Host wake count; optional for older state files. */
  hostWakeCount?: number;
  startedAt: string;
  updatedAt: string;
  stopReason?: string;
}

export interface LiveSessionIdentity {
  challengeId: string;
  attemptId: string;
  targetUrl: string;
  provider: string;
  model: string;
  routeFingerprint: string;
  cwd: string;
  dshHome: string;
}

export function liveSessionStatePath(ledgerPath: string): string {
  const resolved = path.resolve(ledgerPath);
  const base = path.basename(resolved);
  if (base === "live-run-ledger.json") return path.join(path.dirname(resolved), "live-session-state.json");
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  return path.join(path.dirname(resolved), `${stem}.session-state.json`);
}

/**
 * A fresh attempt does not resume the previous DSH session.
 * Crash resume of the same attempt still uses the persisted or bound session id.
 */
export function liveSessionIdForAttempt(input: {
  freshAttempt?: boolean;
  persistedSessionId?: string;
  bindingSessionId?: string;
}): string | undefined {
  if (input.freshAttempt) return undefined;
  const persisted = input.persistedSessionId?.trim();
  if (persisted) return persisted;
  const binding = input.bindingSessionId?.trim();
  return binding || undefined;
}

export function readResumableLiveSessionState(
  file: string,
  expected: LiveSessionIdentity,
): LiveSessionState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!isLiveSessionState(parsed) || parsed.status === "terminal" || parsed.status === "stalled") return undefined;
  if (
    parsed.challengeId !== expected.challengeId ||
    parsed.attemptId !== expected.attemptId ||
    parsed.targetFingerprint !== targetFingerprint(expected.targetUrl) ||
    parsed.provider !== expected.provider ||
    parsed.model !== expected.model ||
    parsed.routeFingerprint !== expected.routeFingerprint ||
    path.resolve(parsed.cwd) !== path.resolve(expected.cwd) ||
    path.resolve(parsed.dshHome) !== path.resolve(expected.dshHome)
  ) {
    return undefined;
  }
  if (!fs.existsSync(parsed.cwd) || !fs.existsSync(parsed.dshHome)) return undefined;
  return parsed;
}

export function hasLiveSessionResumeBudget(
  resumeCount: number,
  maxResumes = LIVE_SESSION_MAX_RESUMES,
): boolean {
  return Number.isInteger(resumeCount) && resumeCount >= 0 && resumeCount < maxResumes;
}

export function writeLiveSessionState(
  file: string,
  input: LiveSessionIdentity & {
    sessionId: string;
    status: LiveSessionStateStatus;
    resumeCount: number;
    hostWakeCount?: number;
    startedAt?: Date;
    stopReason?: string;
    updatedAt?: Date;
  },
): LiveSessionState {
  const state: LiveSessionState = {
    schema: "silver.live-session-state.v1",
    challengeId: input.challengeId,
    attemptId: input.attemptId,
    targetFingerprint: targetFingerprint(input.targetUrl),
    provider: input.provider,
    model: input.model,
    routeFingerprint: input.routeFingerprint,
    sessionId: input.sessionId,
    cwd: path.resolve(input.cwd),
    dshHome: path.resolve(input.dshHome),
    status: input.status,
    resumeCount: Math.max(0, Math.floor(input.resumeCount)),
    ...(input.hostWakeCount !== undefined
      ? { hostWakeCount: Math.max(0, Math.floor(input.hostWakeCount)) }
      : {}),
    startedAt: (input.startedAt ?? input.updatedAt ?? new Date()).toISOString(),
    updatedAt: (input.updatedAt ?? new Date()).toISOString(),
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return state;
}

function isLiveSessionState(value: unknown): value is LiveSessionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.schema === "silver.live-session-state.v1" &&
    typeof row.challengeId === "string" &&
    typeof row.attemptId === "string" &&
    typeof row.targetFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(row.targetFingerprint) &&
    typeof row.provider === "string" &&
    typeof row.model === "string" &&
    typeof row.routeFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(row.routeFingerprint) &&
    typeof row.sessionId === "string" &&
    typeof row.cwd === "string" &&
    typeof row.dshHome === "string" &&
    (row.status === "active" || row.status === "stalled" || row.status === "interrupted" || row.status === "terminal") &&
    typeof row.resumeCount === "number" &&
    Number.isInteger(row.resumeCount) &&
    row.resumeCount >= 0 &&
    typeof row.startedAt === "string" &&
    Number.isFinite(Date.parse(row.startedAt)) &&
    typeof row.updatedAt === "string" &&
    Number.isFinite(Date.parse(row.updatedAt))
  );
}

function targetFingerprint(targetUrl: string): string {
  return createHash("sha256").update(targetUrl).digest("hex");
}
