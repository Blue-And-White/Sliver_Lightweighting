import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ChallengePolicyName = "single-fast" | "cheap-swarm";

export interface CoordinatorConfig {
  policy: ChallengePolicyName;
  maxAttempts: number;
  idleCyclesBeforeSpawn: number;
}

export const DEFAULT_COORDINATOR: Record<ChallengePolicyName, CoordinatorConfig> = {
  "single-fast": { policy: "single-fast", maxAttempts: 2, idleCyclesBeforeSpawn: 2 },
  "cheap-swarm": { policy: "cheap-swarm", maxAttempts: 3, idleCyclesBeforeSpawn: 2 },
};

/** Content-hash set of regular files. Duplicate HTTP bodies do not count as progress. */
export function artifactContentStamp(root: string): string {
  const hashes: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!st.isFile()) continue;
        hashes.push(createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
      } catch {
        continue;
      }
    }
  }
  hashes.sort();
  return hashes.join(",");
}

export function shouldLazySpawn(input: {
  idleCycles: number;
  idleThreshold: number;
  liveCount: number;
  maxAttempts: number;
  remainingFlags: number;
}): boolean {
  if (input.remainingFlags <= 0) return false;
  if (input.liveCount < 1) return false;
  if (input.liveCount >= input.maxAttempts) return false;
  return input.idleCycles >= input.idleThreshold;
}
