import fs from "node:fs";
import path from "node:path";
import { loadSilverConfig, type SilverConfig } from "@silver/host";

export function discoverSilverConfigPath(
  explicitPath: string | undefined,
  cwd: string,
  repoRoot: string,
): string | undefined {
  if (explicitPath) return explicitPath;
  const candidates = [
    path.join(cwd, "silver.local.yaml"),
    path.join(cwd, "silver.local.yml"),
    path.join(repoRoot, "silver.local.yaml"),
    path.join(repoRoot, "silver.local.yml"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

export function loadProductSilverConfig(
  explicitPath: string | undefined,
  cwd: string,
  repoRoot: string,
): SilverConfig {
  return loadSilverConfig(discoverSilverConfigPath(explicitPath, cwd, repoRoot));
}
