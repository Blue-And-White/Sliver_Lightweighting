import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SILVER_ROOM_CORE_TOOLS, SILVER_FS_LEAVES, SILVER_IAT_LEAVES } from "@silver/ctf-spine";
import { OFFICIAL_DSH_PROFILE, officialDshArgs } from "./live-dsh.ts";

/** Official DSH generic tools that make up the default HostFs solver surface. */
export const DSH_BUILTIN_GENERIC_TOOLS = ["read", "write", "edit", "grep", "glob", "bash"] as const;

/**
 * Headless base-profile generic tool plugin ids from official DSH.
 */
export const DSH_HEADLESS_GENERIC_TOOL_PLUGINS = ["tool-bash", "tool-fs", "tool-fs-search"] as const;

/** Patched live HostFs generic tool plugins that remain model-facing. */
export const DSH_LIVE_GENERIC_TOOL_PLUGINS = ["tool-bash", "tool-fs", "tool-fs-search"] as const;

export const DSH_RUNTIME_FEATURE_PLUGIN_IDS = [
  "agent-loop",
  "llm-retry",
  "session-title-llm",
  "session-log-deepseek",
  "session-persistence-jsonl",
  "session-query-sqlite",
  "session-projection",
  "session-projection-cache",
  "token-meter",
  "compaction-basic",
  "storage",
  "storage-json",
  "storage-domain",
  "session-checkpoint-policy",
  "timeout-policy",
  "terminal",
  "terminal-bash",
  "tool-bash",
  "tool-fs",
  "tool-fs-search",
  "spill-local",
  "spill-policy",
  "tool-result-pruner",
  "agent-instructions",
  "skill",
  "skill-filesystem",
  "skill-badge",
  "tool-skill",
  "tool-todo",
  "tool-pwsh",
  "tool-jobs",
  "tool-goal",
  "tool-ralph",
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-report",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "subagent",
  "subagent-spawn-in-process",
  "subagent-fork-in-process",
  "ptc-runtime",
  "workflow-ptc",
  "workflow-worker-thread",
  "tool-workflow",
  "tool-str-replace-editor",
  "plan-mode",
  "attachment-local",
  "repeat-tool-reminder",
  "fs-sandbox",
  "code-runtime",
  "web",
  "web-search-deepseek",
  "tool-web",
  "web-fetch-http",
  "acp-app-startup",
  "acp",
] as const;

export type DshRuntimePluginState = "enabled" | "disabled" | "missing";

export interface DshRuntimePlugin {
  id: string;
  disabled: boolean;
  config?: Record<string, string | number | boolean | null>;
}

export interface DshRuntimeFingerprint {
  kernel: "official-dsh";
  command: string;
  profile: string;
  version: string | null;
  pluginCount: number;
  featurePlugins: Record<(typeof DSH_RUNTIME_FEATURE_PLUGIN_IDS)[number], DshRuntimePluginState>;
}

export const REQUIRED_LIVE_DSH_FEATURE_PLUGINS = [
  "agent-loop",
  "session-persistence-jsonl",
  "session-projection-cache",
  "token-meter",
  "compaction-basic",
  "storage",
  "storage-json",
  "storage-domain",
  "tool-result-pruner",
  "tool-bash",
  "tool-jobs",
  "tool-fs",
  "tool-fs-search",
] as const satisfies readonly (typeof DSH_RUNTIME_FEATURE_PLUGIN_IDS)[number][];

export const REQUIRED_ACP_DSH_FEATURE_PLUGINS = [
  "acp-app-startup",
  "acp",
  "agent-loop",
  "session-persistence-jsonl",
  "session-projection-cache",
  "storage",
  "storage-json",
  "storage-domain",
] as const satisfies readonly (typeof DSH_RUNTIME_FEATURE_PLUGIN_IDS)[number][];

export const DISABLED_LIVE_DSH_FEATURE_PLUGINS = [
  "session-title-llm",
  "agent-instructions",
  "skill",
  "skill-filesystem",
  "skill-badge",
  "tool-skill",
  "tool-pwsh",
  "tool-goal",
  "tool-ralph",
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-report",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "subagent",
  "subagent-spawn-in-process",
  "subagent-fork-in-process",
  "workflow-ptc",
  "workflow-worker-thread",
  "tool-workflow",
  "tool-str-replace-editor",
  "plan-mode",
] as const satisfies readonly (typeof DSH_RUNTIME_FEATURE_PLUGIN_IDS)[number][];

const SKILL_OPT_IN_LIVE_DSH_FEATURE_PLUGINS = ["skill", "skill-filesystem", "skill-badge", "tool-skill"] as const;

export function assertLiveDshRuntimeReady(
  runtime: DshRuntimeFingerprint,
  options: { allowSkills?: boolean } = {},
): void {
  const disabled = options.allowSkills
    ? DISABLED_LIVE_DSH_FEATURE_PLUGINS.filter(
        (id) => !(SKILL_OPT_IN_LIVE_DSH_FEATURE_PLUGINS as readonly string[]).includes(id),
      )
    : DISABLED_LIVE_DSH_FEATURE_PLUGINS;
  const missingOrDisabled = REQUIRED_LIVE_DSH_FEATURE_PLUGINS.filter(
    (id) => runtime.featurePlugins[id] !== "enabled",
  );
  const unexpectedlyEnabled = disabled.filter((id) => runtime.featurePlugins[id] === "enabled");
  if (missingOrDisabled.length === 0 && unexpectedlyEnabled.length === 0) return;
  const parts: string[] = [];
  if (missingOrDisabled.length > 0) {
    parts.push(`missing required official DSH live plugins: ${missingOrDisabled.join(", ")}`);
  }
  if (unexpectedlyEnabled.length > 0) {
    parts.push(`unexpected model-facing DSH plugins enabled: ${unexpectedlyEnabled.join(", ")}`);
  }
  throw new Error(`LIVE_DSH_RUNTIME_NOT_READY: ${parts.join("; ")}`);
}

export function assertAcpDshRuntimeReady(runtime: DshRuntimeFingerprint): void {
  const missingOrDisabled = REQUIRED_ACP_DSH_FEATURE_PLUGINS.filter(
    (id) => runtime.featurePlugins[id] !== "enabled",
  );
  if (runtime.profile === "acp" && missingOrDisabled.length === 0) return;
  const parts = [
    runtime.profile === "acp" ? undefined : `profile is ${runtime.profile}, expected acp`,
    missingOrDisabled.length > 0
      ? `missing required official DSH ACP plugins: ${missingOrDisabled.join(", ")}`
      : undefined,
  ].filter(Boolean);
  throw new Error(`LIVE_DSH_ACP_NOT_READY: ${parts.join("; ")}`);
}

/**
 * Candidate official/community plugins. Not in the live hot path.
 * Do not insert these into cordis.patch.yml or writeLiveDshHome.
 */
export const DSH_CANDIDATE_PLUGIN_ALLOWLIST = [
  { klass: "browser", plugins: ["playwright", "browser"] },
  { klass: "vision", plugins: ["ocr", "vision"] },
  { klass: "context", plugins: ["memory", "context"] },
] as const;

export const GENERIC_CAPABILITY_OVERLAP = [
  { capability: "read", dsh: ["read"], silver: ["fs_read"] },
  { capability: "write", dsh: ["write", "edit"], silver: ["fs_write"] },
  { capability: "grep", dsh: ["grep", "glob"], silver: ["fs_grep"] },
  { capability: "bash", dsh: ["bash"], silver: ["terminal_open", "terminal_send", "terminal_read", "terminal_close", "terminal_list"] },
  { capability: "fs", dsh: ["read", "write", "edit", "glob", "grep"], silver: ["fs_read", "fs_write", "fs_list", "fs_grep"] },
  { capability: "terminal", dsh: ["bash"], silver: ["terminal_open", "terminal_send", "terminal_read", "terminal_close", "terminal_list"] },
] as const;

export function silverOwnedSolverTools(): readonly string[] {
  return SILVER_ROOM_CORE_TOOLS;
}

/** Internal compatibility leaves. Not DSH-registered on the live solver. */
export function frozenSilverSolverLeaves(): readonly string[] {
  return SILVER_IAT_LEAVES;
}

export function unregisteredSilverFsLeaves(): readonly string[] {
  return SILVER_FS_LEAVES;
}

export function parseDumpConfigPluginIds(text: string): string[] {
  return parseDumpConfigPlugins(text).map((row) => row.id);
}

export function parseDumpConfigPlugins(text: string): DshRuntimePlugin[] {
  const plugins: DshRuntimePlugin[] = [];
  let current: DshRuntimePlugin | undefined;
  let inConfig = false;
  let configIndent = -1;
  for (const line of text.split(/\r?\n/)) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const match = /^- id: (\S+)$/.exec(trimmed);
    if (match?.[1]) {
      current = { id: match[1], disabled: false };
      plugins.push(current);
      inConfig = false;
      configIndent = -1;
      continue;
    }
    if (current && /^config:\s*$/.test(trimmed)) {
      current.config = {};
      inConfig = true;
      configIndent = indent;
      continue;
    }
    if (current && inConfig && trimmed && indent <= configIndent) {
      inConfig = false;
      configIndent = -1;
    }
    if (current && inConfig) {
      const configMatch = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(trimmed);
      if (configMatch?.[1]) {
        current.config ??= {};
        current.config[configMatch[1]] = parseDumpScalar(configMatch[2]);
      }
    }
    if (current && /^disabled:\s*true\b/.test(trimmed)) {
      current.disabled = true;
    }
  }
  return plugins;
}

function parseDumpScalar(raw: string | undefined): string | number | boolean | null {
  if (raw === undefined || raw === "") return null;
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  const quoted = /^['"](.*)['"]$/.exec(value);
  return quoted?.[1] ?? value;
}

export function dumpHeadlessLiveConfig(input: { repoRoot: string; extraPatches?: string[] }): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dsh = path.join(input.repoRoot, "node_modules", ".bin", "dsh");
  const spine = path.join(input.repoRoot, "packages", "ctf-spine", "cordis.patch.yml");
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "silver-dsh-dump-"));
  try {
    const result = spawnSync(dsh, officialDshArgs({ dumpConfig: true, patches: [spine, ...(input.extraPatches ?? [])] }), {
      encoding: "utf8",
      cwd: input.repoRoot,
      timeout: 20_000,
      env: probeEnv(dshHome),
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } finally {
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
}

export function describeOfficialDshRuntime(input: {
  repoRoot: string;
  profile?: string;
  patches?: string[];
}): DshRuntimeFingerprint {
  const command = path.join(input.repoRoot, "node_modules", ".bin", "dsh");
  const version = officialDshVersion(command, input.repoRoot);
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "silver-dsh-fingerprint-"));
  let dump: ReturnType<typeof dumpOfficialDshConfig>;
  try {
    dump = dumpOfficialDshConfig({
      repoRoot: input.repoRoot,
      command,
      profile: input.profile ?? OFFICIAL_DSH_PROFILE,
      patches: input.patches ?? [path.join(input.repoRoot, "packages", "ctf-spine", "cordis.patch.yml")],
      dshHome,
    });
  } finally {
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
  const plugins = dump.status === 0 ? parseDumpConfigPlugins(dump.stdout) : [];
  const byId = new Map(plugins.map((row) => [row.id, row]));
  const featurePlugins = Object.fromEntries(
    DSH_RUNTIME_FEATURE_PLUGIN_IDS.map((id) => {
      const row = byId.get(id);
      return [id, row ? (row.disabled ? "disabled" : "enabled") : "missing"];
    }),
  ) as DshRuntimeFingerprint["featurePlugins"];
  return {
    kernel: "official-dsh",
    command,
    profile: input.profile ?? OFFICIAL_DSH_PROFILE,
    version,
    pluginCount: plugins.length,
    featurePlugins,
  };
}

function dumpOfficialDshConfig(input: {
  repoRoot: string;
  command: string;
  profile: string;
  patches: string[];
  dshHome: string;
}): ReturnType<typeof dumpHeadlessLiveConfig> {
  const result = spawnSync(
    input.command,
    officialDshArgs({ dumpConfig: true, profile: input.profile, patches: input.patches }),
    {
      encoding: "utf8",
      cwd: input.repoRoot,
      timeout: 20_000,
      env: probeEnv(input.dshHome),
    },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function officialDshVersion(command: string, repoRoot: string): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    cwd: repoRoot,
    timeout: 10_000,
    env: probeEnv(),
  });
  if (result.status !== 0) return null;
  const version = result.stdout.trim();
  return version || null;
}

function probeEnv(dshHome?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(dshHome ? { DSH_HOME: dshHome } : {}),
    DSH_TELEMETRY_DISABLED: "1",
    DSH_TELEMETRY_MODE: "DISABLED",
  };
}

/** Official package tool names from defineTool({ name }) in dsh-tool-*. */
export function dshPackageToolNames(repoRoot: string, pkg: string): string[] {
  const file = path.join(repoRoot, "node_modules", "@deepseek-ai", pkg, "lib", "index.js");
  const text = fs.readFileSync(file, "utf8");
  const names: string[] = [];
  const re = /defineTool\(\{\s*name:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

export function repoRootFromHost(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}
