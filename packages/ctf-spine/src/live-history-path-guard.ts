import path from "node:path";

export const LIVE_HISTORY_PATH_REFUSED =
  "historical Silver run artifacts are out of scope; use this attempt workspace, not .silver-tmp, old executions, or other Mission traces";

export const LIVE_FILE_TOOLS = ["bash", "read", "write", "edit", "grep", "glob"] as const;

export type LiveHistoryPathPolicy = {
  cwd?: string;
  repoRoot?: string;
  replayPath?: string;
};

const ABSOLUTE_PATH = /(?:^|[\s"'=`])(\/(?:[^\s"'`;|&<>]+))/g;

export function liveHistoryPathPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveHistoryPathPolicy {
  return {
    ...(env.SILVER_CWD?.trim() ? { cwd: env.SILVER_CWD.trim() } : {}),
    ...(env.SILVER_REPO_ROOT?.trim() ? { repoRoot: env.SILVER_REPO_ROOT.trim() } : {}),
    ...(env.SILVER_REPLAY_PATH?.trim() ? { replayPath: env.SILVER_REPLAY_PATH.trim() } : {}),
  };
}

export function refuseLiveHistoryPath(input: {
  tool: string;
  args?: Record<string, unknown>;
  policy?: LiveHistoryPathPolicy;
}): string | undefined {
  if (!(LIVE_FILE_TOOLS as readonly string[]).includes(input.tool)) return undefined;
  const policy = input.policy ?? liveHistoryPathPolicyFromEnv();
  if (!policy.repoRoot && !policy.replayPath) return undefined;
  for (const raw of collectLiveToolPaths(input.tool, input.args ?? {})) {
    if (isHistoricalSilverPath(raw, policy)) return LIVE_HISTORY_PATH_REFUSED;
  }
  return undefined;
}

export function isHistoricalSilverPath(raw: string, policy: LiveHistoryPathPolicy): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const resolved = resolveLivePath(trimmed, policy.cwd);
  if (isAllowedLivePath(resolved, policy)) return false;
  if (trimmed.includes(".silver-tmp")) return true;
  if (policy.repoRoot && path.resolve(resolved) === path.resolve(policy.repoRoot)) return true;
  if (policy.repoRoot && isUnderRoot(resolved, path.join(policy.repoRoot, ".silver-tmp"))) return true;
  if (policy.repoRoot && isUnderRoot(resolved, path.join(policy.repoRoot, "executions"))) return true;
  return false;
}

export function collectLiveToolPaths(
  tool: string,
  args: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  };
  push(args.file_path);
  push(args.path);
  push(args.target_directory);
  if (tool === "bash" && typeof args.command === "string") {
    if (/\.silver-tmp(?:\/|\\|$)/.test(args.command)) out.push(args.command);
    for (const match of args.command.matchAll(ABSOLUTE_PATH)) {
      if (match[1]) out.push(match[1]);
    }
  }
  return out;
}

function isAllowedLivePath(resolved: string, policy: LiveHistoryPathPolicy): boolean {
  if (policy.cwd && isUnderRoot(resolved, policy.cwd)) return true;
  if (policy.replayPath && isUnderRoot(resolved, policy.replayPath)) return true;
  return false;
}

function resolveLivePath(raw: string, cwd?: string): string {
  const first = raw.replace(/[\s"'`;|&<>].*$/, "");
  if (path.isAbsolute(first)) return path.resolve(first);
  return path.resolve(cwd ?? process.cwd(), first);
}

function isUnderRoot(target: string, root: string): boolean {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}
