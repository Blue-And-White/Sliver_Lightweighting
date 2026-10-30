import fs from "node:fs";
import path from "node:path";
import {
  bindFingerprint,
  compileFlagPolicy,
  type CandidateRef,
  type FlagPolicy,
  type OracleVerdict,
} from "@silver/protocol";

export interface OracleResult {
  oracle: OracleVerdict;
  reason: string;
  evidenceRef?: string;
  /** Canonical write location when a ref escaped the attempt artifacts root. */
  attemptArtifactsRoot?: string;
  guidance?: string;
}

/** Human-facing instruction after an artifact_ref escape. Detection stays unchanged. */
export function artifactRefEscapeGuidance(attemptArtifactsRoot: string): string {
  return `write evidence under ${attemptArtifactsRoot}; refs outside it are rejected.`;
}

export function artifactRefEscapeReason(attemptArtifactsRoot: string): string {
  return `artifact_ref escapes attempt artifacts root; ${artifactRefEscapeGuidance(attemptArtifactsRoot)}`;
}

export interface VerifyOptions {
  artifactsRoot: string;
  attemptRoot?: string;
  checker?: (raw: string) => boolean;
  flagPolicy?: FlagPolicy;
}

export function artifactInAttemptRoot(artifactRef: string, artifactsRoot: string): string | undefined {
  try {
    const root = fs.realpathSync(artifactsRoot);
    const ref = artifactRef.trim();
    const presented = path.resolve(path.isAbsolute(ref) ? ref : resolveRelativeArtifactRef(ref, root));
    const st = fs.lstatSync(presented);
    if (st.isSymbolicLink() || !st.isFile()) return undefined;
    const realFile = fs.realpathSync(presented);
    if (realFile !== root && !realFile.startsWith(root + path.sep)) return undefined;
    return realFile;
  } catch {
    return undefined;
  }
}

function resolveRelativeArtifactRef(artifactRef: string, artifactsRoot: string): string {
  const normalized = artifactRef.replace(/^\.\//, "");
  if (normalized === "artifacts" || normalized.startsWith("artifacts/")) {
    return path.join(path.dirname(artifactsRoot), normalized);
  }
  return path.join(artifactsRoot, normalized);
}

export function verifyCandidate(candidate: CandidateRef, options: VerifyOptions): OracleResult {
  if (!candidate.artifactRef) {
    return { oracle: "fail", reason: "missing provenance artifact_ref" };
  }
  const bound = bindFingerprint(candidate);
  if (!bound.ok) {
    return { oracle: "fail", reason: bound.reason };
  }
  const bounded = artifactInAttemptRoot(candidate.artifactRef, options.artifactsRoot);
  if (!bounded) {
    const guidance = artifactRefEscapeGuidance(options.artifactsRoot);
    return {
      oracle: "fail",
      reason: artifactRefEscapeReason(options.artifactsRoot),
      evidenceRef: candidate.artifactRef,
      attemptArtifactsRoot: options.artifactsRoot,
      guidance,
    };
  }
  const policy = options.flagPolicy ?? compileFlagPolicy();
  const raw = candidate.raw ?? "";
  if (policy.shapeRequired && !policy.matches(raw)) {
    return { oracle: "fail", reason: "flag shape mismatch", evidenceRef: bounded };
  }
  if (!raw.trim()) {
    return { oracle: "fail", reason: "candidate raw missing", evidenceRef: bounded };
  }
  if (!artifactContains(bounded, raw)) {
    return { oracle: "fail", reason: "candidate not present in artifact", evidenceRef: bounded };
  }
  if (options.attemptRoot) {
    const external = externalTempEvidenceReference(bounded, options.attemptRoot);
    if (external) {
      return {
        oracle: "fail",
        reason: `artifact evidence references host-global temp path outside attempt workspace: ${external}`,
        evidenceRef: bounded,
      };
    }
  }
  if (options.checker) {
    return options.checker(candidate.raw ?? "")
      ? { oracle: "pass", reason: "local checker accepted", evidenceRef: bounded }
      : { oracle: "fail", reason: "local checker rejected", evidenceRef: bounded };
  }
  return { oracle: "pass", reason: "shape+provenance", evidenceRef: bounded };
}

function artifactContains(artifactRef: string, raw: string): boolean {
  try {
    const st = fs.lstatSync(artifactRef);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    let flags = fs.constants.O_RDONLY;
    if (typeof fs.constants.O_NOFOLLOW === "number") flags |= fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(artifactRef, flags);
    try {
      const buf = fs.readFileSync(fd);
      return buf.includes(Buffer.from(raw, "utf8")) || buf.toString("utf8").includes(raw);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

const ARTIFACT_SCAN_BYTES = 2 * 1024 * 1024;
const HOST_TEMP_PATH_RE =
  /(?:^|[\s"'`:=([{,])((?:\/private)?\/tmp\/[^\s"'`)<>{}\]]+|\/var\/folders\/[^\s"'`)<>{}\]]+\/T\/[^\s"'`)<>{}\]]+)/g;

function externalTempEvidenceReference(artifactRef: string, attemptRoot: string): string | undefined {
  let text: string;
  try {
    const fd = openNoFollow(artifactRef);
    try {
      const buf = Buffer.alloc(ARTIFACT_SCAN_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const commandText = evidenceCommandText(text);
  if (!commandText) return undefined;
  const realAttemptRoot = safeRealpath(attemptRoot) ?? path.resolve(attemptRoot);
  for (const raw of tempPathMatches(commandText)) {
    const normalized = normalizeEvidencePath(raw);
    if (!normalized) continue;
    if (isPathInsideAttempt(normalized, realAttemptRoot)) continue;
    return displayEvidencePath(normalized);
  }
  return undefined;
}

function evidenceCommandText(text: string): string {
  const parsed = parseJsonObject(text);
  if (!parsed) return text;
  const tool = typeof parsed.tool === "string" ? parsed.tool : "";
  if (!tool) return text;
  const fields = [
    parsed.arguments,
    parsed.argv,
    parsed.command,
    parsed.path,
    parsed.file_path,
  ].filter((value) => value !== undefined);
  try {
    return JSON.stringify({ tool, fields });
  } catch {
    return fields.map((value) => String(value)).join("\n");
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

function tempPathMatches(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(HOST_TEMP_PATH_RE)) {
    const value = match[1];
    if (value) out.push(value);
  }
  return out;
}

function normalizeEvidencePath(raw: string): string | undefined {
  const trimmed = raw
    .replace(/\\n.*$/s, "")
    .replace(/[.,;:]+$/g, "")
    .trim();
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
}

function isPathInsideAttempt(candidatePath: string, realAttemptRoot: string): boolean {
  const real = safeRealpath(candidatePath) ?? candidatePath;
  return real === realAttemptRoot || real.startsWith(realAttemptRoot + path.sep);
}

function displayEvidencePath(candidatePath: string): string {
  if (candidatePath.startsWith("/var/folders/")) return "/var/folders/.../T/<outside-attempt>";
  return candidatePath;
}

function safeRealpath(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

function openNoFollow(file: string): number {
  let flags = fs.constants.O_RDONLY;
  if (typeof fs.constants.O_NOFOLLOW === "number") flags |= fs.constants.O_NOFOLLOW;
  return fs.openSync(file, flags);
}
