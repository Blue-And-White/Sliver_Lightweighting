import fs from "node:fs";
import path from "node:path";
import type { ChallengeBundle } from "@silver/host";
import type { HintPolicy } from "@silver/protocol";

export interface MissionBrief {
  title: string;
  target: string;
  inScope: string[];
  challengeId: string;
  /** Exact operator prose for a Commander, or exact Commander child task for a Room. */
  body: string;
  flagPattern?: string;
  hintPolicy?: HintPolicy;
  challengeBundle?: ChallengeBundle;
}

/**
 * Natural-language Commander entry. Silver does not parse, trim, redact, or
 * interpret the operator's prose. Platform discovery belongs to the Commander.
 */
export function readCommanderMissionFile(filePath: string): MissionBrief {
  const text = fs.readFileSync(filePath, "utf8");
  const fallbackId = path.basename(filePath, path.extname(filePath));
  return {
    title: fallbackId || "mission",
    target: "https://mission.invalid/",
    inScope: [],
    challengeId: slug(fallbackId),
    body: text,
  };
}

/** Explicit single-target diagnostic entry; this is CLI data, not Mission prose. */
export function missionFromTarget(target: string): MissionBrief {
  const url = target.trim();
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("--target must be an http(s) URL");
  let host = "target";
  try {
    host = new URL(url).hostname || "target";
  } catch {
    throw new Error("--target must be an http(s) URL");
  }
  return {
    title: host,
    target: url,
    inScope: [new URL(url).origin],
    challengeId: slug(host),
    body: `Solve the authorized CTF at ${url}.`,
  };
}

function slug(value: string): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return out || "mission";
}
