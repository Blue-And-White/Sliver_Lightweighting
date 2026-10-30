import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleRoomPersona,
  commanderPersonaWithDiscovery,
  type RoomDomain,
} from "@silver/ctf-spine";
import {
  Config as DeepSeekLlmConfig,
  plainOptions as deepSeekPlainOptions,
  type DeepSeekCatalogModel,
} from "@deepseek-ai/dsh-llm-deepseek";
import { supportedProtocols as piAiSupportedProtocols } from "@deepseek-ai/dsh-llm-pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { REPO_MOUNT } from "@silver/protocol";
import type { ProgressSnapshot } from "./progress.ts";
import { LLM_CAPABILITY_ENV } from "./llm-broker.ts";
import { liveSkillPatchYaml } from "./skill-catalog.ts";
import {
  REASONING_EFFORT_NAMES,
  isReasoningEffortMap,
  type LlmAuthMode,
  type LlmPlugin,
  type PiAiCacheRetention,
  type PiAiCompatConfig,
  type ReasoningEffortMap,
  type ReasoningEffortsConfig,
  type ResolvedModelCall,
  type SilverConfig,
} from "./silver-config.ts";

/**
 * Live overlay disables only plugins that conflict with the solver contract or
 * are separately enabled for solver roots. Jobs, attachment, and Skill stay
 * available via official DSH (the CLI supplies bundled/additional roots).
 * `runtime.externalSearch` defaults to true. Explicit `false` unmounts
 * `web_search` only. `web_fetch` and bash stay available.
 * Do not re-disable jobs or attachment solely to shrink wire size.
 */
export const DSH_LIVE_DISABLED_TOOL_PLUGINS = [
  "session-title-llm",
  "agent-instructions",
  "tool-skill",
  "skill",
  "skill-filesystem",
  "skill-badge",
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
  "tool-workflow",
  "workflow-worker-thread",
  "workflow-ptc",
  "tool-str-replace-editor",
  "plan-mode",
] as const;

export const DSH_LIVE_SKILL_PLUGIN_IDS = ["skill", "skill-filesystem", "tool-skill"] as const;

export interface LiveDshSkillMount {
  skillRoot?: string;
  skillRoots?: string[];
  catalogDescriptionMaxLength?: number;
}

export function liveSkillMountFromConfig(
  config: Pick<SilverConfig, "skills">,
  enabled: boolean | undefined,
): boolean | LiveDshSkillMount | undefined {
  if (!enabled) return undefined;
  const roots = config.skills.roots;
  if (roots.length === 0) return undefined;
  return {
    skillRoots: roots,
    catalogDescriptionMaxLength: config.skills.catalogDescriptionMaxLength,
  };
}

export interface LiveLlmBrokerRoute {
  baseUrl: string;
  apiKeyEnv?: string;
}

export interface LiveDshHomeOptions {
  skills?: boolean | LiveDshSkillMount;
  dshHomeForPatch?: string;
  credentialDshHome?: string;
  /**
   * When DSH runs inside the official cell, plugin `name` entries must resolve
   * under the existing repo mount (`REPO_MOUNT`), not the Host absolute path.
   * HostFs omits this and keeps import.meta-absolute module paths.
   */
  pluginModuleRepoRoot?: string;
  /**
   * TEST-ONLY. Lower official tool-fs-search rawOutputMaxBytes.
   * Production writeLiveDshHome never sets this.
   */
  testOnlyFsSearchRawOutputMaxBytes?: number;
  /**
   * TEST-ONLY. Pin official web_search/web_fetch onto local ctx.web providers.
   * Production writeLiveDshHome never sets this.
   */
  testOnlyLocalWeb?: boolean;
  /** Optional product persona, still mounted through official DSH personaPrefix. */
  personaPrefix?: string;
  /**
   * `runtime.externalSearch`. Omitted and `true` leave `web_search` mounted.
   * Explicit `false` unmounts `web_search` only. `web_fetch` is not tied to this flag.
   */
  externalSearch?: boolean;
  /**
   * Append hint guidance only when request_hint is mounted (hintPolicy open).
   * Commander and hint-off rooms omit it.
   */
  hint?: boolean;
  /** Legacy room-domain discriminator. All public personas are domain neutral. */
  domain?: RoomDomain;
  /** Formal room role. Only a dedicated Lead receives the coordinator persona. */
  role?: "lead" | "worker";
  /** Official Team members share this role-neutral system persona; role duties live in Host-authored tasks. */
  formalTeam?: boolean;
  /** Use official DSH compaction earlier for long-lived rooms; model capacity stays truthful. */
  roomCompaction?: boolean;
  /** Commander: Host control plus generic discovery; authenticated mutations stay on adapters. */
  commanderSurface?: boolean;
  /** Independent-root Silver Room tools/persona. Not official DSH Agent Team. */
  swarmRoom?: boolean;
  /**
   * Official adapter request bounds. Commander / Worker / Reviewer policies are
   * role-separated; callers pass the matching policy. pi-ai writes `timeoutMs`;
   * DeepSeek uses `streamIdleTimeoutMs`. `maxRetries` is `retryPolicy.mode=normal`
   * via dsh-llm-retry. Do not invent a Silver retry loop.
   */
  llmRequest?: {
    timeoutMs?: number;
    maxRetries?: number;
  };
}

/**
 * TEST-ONLY. Production inherits the official DSH bash timeout.
 */
export function testOnlyLiveWorkerBashTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.SILVER_TEST_ONLY_BASH_TIMEOUT_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n >= 1) return n;
  }
  return undefined;
}

/** Commander HTTP/idle bound written into official adapter config. Not an ACP session wall. */
export const COMMANDER_LLM_TIMEOUT_MS = 90_000;
/** Official dsh-llm-retry budget after the first Commander request. Default is 5. */
export const COMMANDER_LLM_MAX_RETRIES = 2;

/** Worker HTTP/idle bound (role-separated from Commander; same official adapter fields). */
export const WORKER_LLM_TIMEOUT_MS = 90_000;
/** Official dsh-llm-retry budget after the first Worker request. */
export const WORKER_LLM_MAX_RETRIES = 2;

export function commanderLlmRequestPolicy(env: NodeJS.ProcessEnv = process.env): {
  timeoutMs: number;
  maxRetries: number;
} {
  const raw = env.SILVER_TEST_COMMANDER_LLM_TIMEOUT_MS;
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN;
  const timeoutMs =
    Number.isFinite(parsed) && parsed >= 200 && parsed <= 180_000 ? Math.floor(parsed) : COMMANDER_LLM_TIMEOUT_MS;
  return { timeoutMs, maxRetries: COMMANDER_LLM_MAX_RETRIES };
}

export function workerLlmRequestPolicy(env: NodeJS.ProcessEnv = process.env): {
  timeoutMs: number;
  maxRetries: number;
} {
  const raw = env.SILVER_TEST_WORKER_LLM_TIMEOUT_MS;
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN;
  const timeoutMs =
    Number.isFinite(parsed) && parsed >= 200 && parsed <= 180_000 ? Math.floor(parsed) : WORKER_LLM_TIMEOUT_MS;
  return { timeoutMs, maxRetries: WORKER_LLM_MAX_RETRIES };
}

/** Short-lived Convergence Reviewer HTTP/idle bound (role-separated; must not stall Room single-flight). */
export const REVIEWER_LLM_TIMEOUT_MS = 90_000;
/** Official dsh-llm-retry budget after the first Reviewer request. */
export const REVIEWER_LLM_MAX_RETRIES = 2;

export function reviewerLlmRequestPolicy(env: NodeJS.ProcessEnv = process.env): {
  timeoutMs: number;
  maxRetries: number;
} {
  const raw = env.SILVER_TEST_REVIEWER_LLM_TIMEOUT_MS;
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN;
  const timeoutMs =
    Number.isFinite(parsed) && parsed >= 200 && parsed <= 180_000 ? Math.floor(parsed) : REVIEWER_LLM_TIMEOUT_MS;
  return { timeoutMs, maxRetries: REVIEWER_LLM_MAX_RETRIES };
}

const SECRET_ENV_NAME = /^(?:[A-Z0-9_]+_API_KEY|[A-Z0-9_]+_TOKEN|[A-Z0-9_]+_SECRET)$/;

/** Official dsh-llm-deepseek Messages adapter route shipped in dsh-base. */
export const LIVE_DSH_PROVIDER = "deepseek-official";
/** Official multi-provider adapter already mounted dormant in dsh-base. */
export const LIVE_PI_AI_PLUGIN = "llm-pi-ai" as const;
/** Official DSH authorization seam used by `llm-pi-ai` login/subscription flows. */
export const LIVE_DSH_AUTHORIZATION_PLUGIN = "authorization" as const;
/** Wire protocols `dsh-llm-pi-ai` `supportedProtocols()` currently serves. */
export const LIVE_PI_AI_APIS = piAiSupportedProtocols();
/** Host LLM broker pass-through APIs. Bodies stay native; Host only replaces the key. */
export const LIVE_PI_AI_BROKER_APIS = ["openai-completions", "anthropic-messages"] as const;
/** Default live api-key protocol. Anthropic `/messages` is also admitted as pass-through. */
export const LIVE_PI_AI_BROKER_API = "openai-completions" as const;
/** HostFs beta uses DSH's native lightweight workspace preset, not full host access. */
export const LIVE_DSH_PERMISSION_PRESET = "workspace-write" as const;
function liveDshPermissionPreset(): "workspace-write" | "danger-full-access" {
  // The hosted contest runner is already isolated by its uploaded container.
  // Its Linux host has no DSH file-sandbox backend, so confined bash cannot run.
  return process.env.SILVER_HOSTED_CONTAINER === "1" ? "danger-full-access" : LIVE_DSH_PERMISSION_PRESET;
}
export const OFFICIAL_DSH_PROFILE = "headless" as const;
export const LIVE_DSH_INVARIANTS_PLUGIN = "invariants" as const;

export interface OfficialDshInvocation {
  command: string;
  argv: string[];
}

export function ctfSpineModulePath(repoRoot: string): string {
  return path.join(repoRoot, "packages", "ctf-spine", "src", "index.ts");
}

/** Repo-relative plugin entries under packages/ctf-spine (HostFs or REPO_MOUNT). */
const LIVE_WEB_LOCAL_REL = ["packages", "ctf-spine", "src", "live-web-local.ts"] as const;

function liveWebLocalModulePath(opts?: { pluginModuleRepoRoot?: string }): string {
  return liveCtfSpinePluginModulePath(LIVE_WEB_LOCAL_REL, opts?.pluginModuleRepoRoot);
}

function liveCtfSpinePluginModulePath(
  rel: readonly string[],
  pluginModuleRepoRoot?: string,
): string {
  if (pluginModuleRepoRoot !== undefined) {
    // Existing cell mount is POSIX (`/opt/silver`). Do not invent a second install root.
    const root = pluginModuleRepoRoot.replace(/\\/g, "/").replace(/\/+$/, "") || REPO_MOUNT;
    return `${root}/${rel.join("/")}`;
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ...rel.slice(1));
}

export function writeCtfSpinePatch(dir: string, repoRoot: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const patch = path.join(dir, ".silver-ctf-spine.patch.yml");
  fs.writeFileSync(
    patch,
    [
      "# Generated by Silver. Use an absolute module entry so official DSH profiles",
      "# such as ACP do not resolve @silver/ctf-spine relative to ~/.dsh/profiles/*.",
      "- insert:",
      "    - id: silver-ctf-spine",
      `      name: ${JSON.stringify(ctfSpineModulePath(repoRoot))}`,
      "",
    ].join("\n"),
  );
  return patch;
}

export function officialDshArgs(input: {
  profile?: string;
  dumpConfig?: boolean;
  patches?: readonly string[];
  task?: string;
} = {}): string[] {
  const profile = input.profile ?? OFFICIAL_DSH_PROFILE;
  const argv = ["--profile", profile];
  if (input.dumpConfig) argv.push("--dump-config");
  for (const patch of input.patches ?? []) {
    if (!patch.trim()) throw new Error("official DSH patch path must be non-empty");
    argv.push("--patch", patch);
  }
  if (input.task !== undefined) {
    if (!input.task.trim()) throw new Error("official DSH task must be non-empty");
    argv.push(input.task);
  }
  assertOfficialDshInvocation(argv);
  return argv;
}

export function officialDshHostInvocation(input: {
  repoRoot: string;
  profile?: string;
  patches?: readonly string[];
  task?: string;
}): OfficialDshInvocation {
  const command = path.join(input.repoRoot, "node_modules", ".bin", "dsh");
  const argv = officialDshArgs({
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.patches ? { patches: input.patches } : {}),
    ...(input.task !== undefined ? { task: input.task } : {}),
  });
  assertOfficialDshInvocation([command, ...argv]);
  return { command, argv };
}

export function officialDshNodeArgv(input: {
  nodeBin?: string;
  dshBin: string;
  exposeInternals?: boolean;
  profile?: string;
  patches?: readonly string[];
  task?: string;
}): string[] {
  const argv = [
    input.nodeBin ?? "node",
    ...(input.exposeInternals === false ? [] : ["--expose-internals"]),
    input.dshBin,
    ...officialDshArgs({
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.patches ? { patches: input.patches } : {}),
      ...(input.task !== undefined ? { task: input.task } : {}),
    }),
  ];
  assertOfficialDshInvocation(argv);
  return argv;
}

export type DshReasoningEffort = (typeof REASONING_EFFORT_NAMES)[number];
export const LIVE_LLM_REASONING_UNDECLARED = "LIVE_LLM_REASONING_UNDECLARED";
export const LIVE_LLM_MAX_TOKENS_UNDECLARED = "LIVE_LLM_MAX_TOKENS_UNDECLARED";
export const LIVE_LLM_CONTEXT_WINDOW_UNDECLARED = "LIVE_LLM_CONTEXT_WINDOW_UNDECLARED";
/** Custom / unknown model without a declared context window — do not invent a fake capacity. */
export const LIVE_LLM_CONTEXT_CAPACITY_UNDECLARED = "LIVE_LLM_CONTEXT_CAPACITY_UNDECLARED";

/** Official dsh-llm-deepseek default catalog ids (adapter supplies context when Silver omits it). */
export const LIVE_DEEPSEEK_KNOWN_MODELS = [
  "deepseek-flash",
  "deepseek-v4-pro",
] as const;

export interface LiveLlmRouteReport {
  plugin: LlmPlugin;
  provider: string;
  model: string;
  api: string;
  auth: LlmAuthMode;
  authSource: string;
  admitted: boolean;
  errorCode: string;
  firstToolReached: boolean;
  reason: string;
  /** Non-fatal capacity/compaction notes for operators; empty when nothing to report. */
  capacityNotes?: string[];
}

export function apiKeyEnvName(apiKeyRef: string | undefined): string | undefined {
  if (!apiKeyRef?.startsWith("env:")) return undefined;
  const name = apiKeyRef.slice("env:".length).trim();
  return name || undefined;
}

/** Explicit effort maps to DSH; `default` leaves its selection untouched. */
export function liveReasoningEffort(effort: string): DshReasoningEffort | "default" {
  const normalized = effort.trim().toLowerCase();
  if (normalized === "default") return "default";
  if ((REASONING_EFFORT_NAMES as readonly string[]).includes(normalized)) {
    return normalized as DshReasoningEffort;
  }
  throw new Error(`live DSH reasoningEffort must be default|off|low|high|max, got ${JSON.stringify(effort)}`);
}

/** `default` leaves adapter/provider reasoning untouched; `off` disables it explicitly. */
export function liveShouldWriteReasoning(resolved: Pick<ResolvedModelCall, "effort" | "reasoningEfforts">): boolean {
  if (["default", "off"].includes(liveReasoningEffort(resolved.effort))) return false;
  return isReasoningEffortMap(resolved.reasoningEfforts);
}

function liveShouldWriteDeepSeekReasoning(resolved: Pick<ResolvedModelCall, "effort" | "reasoningEfforts">): boolean {
  return liveReasoningEffort(resolved.effort) === "off" || liveShouldWriteReasoning(resolved);
}

export function liveLlmPlugin(resolved: ResolvedModelCall): LlmPlugin {
  return resolved.llmPlugin;
}

/** Wire protocol owned by the selected official DSH adapter. */
export function liveLlmWireApi(resolved: ResolvedModelCall): "openai-completions" | "anthropic-messages" {
  return liveLlmPlugin(resolved) === LIVE_PI_AI_PLUGIN
    ? (resolved.api ?? LIVE_PI_AI_BROKER_API) as "openai-completions" | "anthropic-messages"
    : "anthropic-messages";
}

export function liveLlmAuth(resolved: ResolvedModelCall): LlmAuthMode {
  return resolved.auth;
}

/** API-key live keeps the secret on the Host broker. Subscription does not. */
export function liveNeedsApiKey(resolved: ResolvedModelCall): boolean {
  return liveLlmAuth(resolved) === "api-key";
}

export function describeLiveLlmRoute(resolved: ResolvedModelCall): LiveLlmRouteReport {
  const auth = liveLlmAuth(resolved);
  const capacityNotes = liveModelCapacityNotes(resolved);
  return {
    plugin: liveLlmPlugin(resolved),
    provider: resolved.provider,
    model: resolved.model,
    api: resolved.api ?? "unset",
    auth,
    authSource: authSourceOf(resolved),
    admitted: false,
    errorCode: "none",
    firstToolReached: false,
    reason: "",
    ...(capacityNotes.length > 0 ? { capacityNotes } : {}),
  };
}

export function formatLiveLlmRouteReport(report: LiveLlmRouteReport): string {
  return [
    `plugin=${report.plugin}`,
    `provider=${report.provider}`,
    `model=${report.model}`,
    `api=${report.api}`,
    `auth=${report.auth}`,
    `authSource=${report.authSource}`,
    `admitted=${String(report.admitted)}`,
    `errorCode=${report.errorCode}`,
    `firstToolReached=${String(report.firstToolReached)}`,
    ...(report.reason ? [`reason=${report.reason}`] : []),
    ...(report.capacityNotes?.length ? [`capacityNotes=${report.capacityNotes.join("|")}`] : []),
  ].join(" ");
}

/**
 * Live admission. `llm-deepseek` still owns `deepseek-official`.
 * `llm-pi-ai` is opt-in via `llmPlugin` and a distinct provider route.
 * Subscription login is admitted only for official pi-ai catalog routes. Silver
 * mounts DSH's authorization seam but never scrapes tokens or converts protocols.
 */
export function assertLiveDshRoute(resolved: ResolvedModelCall): void {
  liveReasoningEffort(resolved.effort);
  const plugin = liveLlmPlugin(resolved);
  if (plugin === LIVE_PI_AI_PLUGIN) {
    assertLivePiAiRoute(resolved);
    assertLiveReasoningCapability(resolved);
    assertLiveModelCapacityFloor(resolved);
    return;
  }
  if (plugin !== "llm-deepseek") {
    throw liveRouteError(resolved, "LIVE_LLM_UNKNOWN_PLUGIN", `live DSH unknown llmPlugin ${plugin}`);
  }
  if (resolved.provider !== LIVE_DSH_PROVIDER) {
    throw liveRouteError(
      resolved,
      "LIVE_LLM_NO_ADAPTER",
      `live DSH has no adapter for provider ${resolved.provider}; use ${LIVE_DSH_PROVIDER} or llmPlugin: llm-pi-ai`,
    );
  }
  if (liveLlmAuth(resolved) === "subscription") {
    throw liveRouteError(
      resolved,
      "LIVE_LLM_SUBSCRIPTION_UNSUPPORTED",
      "llm-deepseek has no subscription login; use llmPlugin: llm-pi-ai",
    );
  }
  assertLiveReasoningCapability(resolved);
  assertLiveModelCapacityFloor(resolved);
}

function assertLivePiAiRoute(resolved: ResolvedModelCall): void {
  if (resolved.provider === LIVE_DSH_PROVIDER) {
    throw liveRouteError(
      resolved,
      "LIVE_PI_AI_ROUTE_COLLISION",
      `llm-pi-ai cannot own provider ${LIVE_DSH_PROVIDER}; llm-deepseek already registers that route`,
    );
  }
  if (resolved.api && !(LIVE_PI_AI_APIS as readonly string[]).includes(resolved.api)) {
    throw liveRouteError(
      resolved,
      "LIVE_PI_AI_UNSUPPORTED_API",
      `llm-pi-ai does not serve api ${resolved.api}; supported: ${LIVE_PI_AI_APIS.join(", ")}`,
    );
  }
  if (liveLlmAuth(resolved) === "subscription") {
    assertPiAiSubscriptionCatalogRoute(resolved);
    return;
  }
  if (resolved.api && !(LIVE_PI_AI_BROKER_APIS as readonly string[]).includes(resolved.api)) {
    throw liveRouteError(
      resolved,
      "LIVE_PI_AI_BROKER_PROTOCOL",
      `live llm-pi-ai api-key route must use ${LIVE_PI_AI_BROKER_APIS.join(" or ")} through the Host broker; ${resolved.api} would need a Silver protocol converter, which is forbidden`,
    );
  }
}

function assertPiAiSubscriptionCatalogRoute(resolved: ResolvedModelCall): void {
  if (resolved.api || resolved.baseUrl || resolved.apiKeyRef) {
    throw liveRouteError(
      resolved,
      "LIVE_PI_AI_SUBSCRIPTION_CATALOG_ONLY",
      "live llm-pi-ai subscription auth only works for official pi-ai catalog routes; hand-declared baseUrl/api/apiKeyRef routes must use auth: api-key",
    );
  }
}

function assertLiveModelCapacityFloor(resolved: ResolvedModelCall): void {
  // contextWindow and maxTokens are independent. Omit either (or both) to inherit
  // official adapter route capacity / output caps. Do not invent a paired floor.
  if (resolved.contextWindow !== undefined && resolved.contextWindow < 1) {
    throw liveRouteError(
      resolved,
      "LIVE_LLM_CONTEXT_WINDOW_TOO_SMALL",
      `live route ${resolved.provider}/${resolved.model} contextWindow must be a positive integer`,
    );
  }
  if (resolved.maxTokens !== undefined && resolved.maxTokens < 1) {
    throw liveRouteError(
      resolved,
      "LIVE_LLM_MAX_TOKENS_TOO_SMALL",
      `live route ${resolved.provider}/${resolved.model} maxTokens must be a positive integer`,
    );
  }
}

/** Operator-visible notes when Silver cannot claim a known compaction capacity. */
export function liveModelCapacityNotes(resolved: ResolvedModelCall): string[] {
  const notes: string[] = [];
  if (resolved.contextWindow !== undefined && resolved.maxTokens === undefined) {
    notes.push(
      `${LIVE_LLM_MAX_TOKENS_UNDECLARED}: contextWindow=${resolved.contextWindow} without maxTokens; output cap inherits the official adapter / request default (does not change compaction trigger)`,
    );
  }
  if (resolved.maxTokens !== undefined && resolved.contextWindow === undefined) {
    notes.push(
      `${LIVE_LLM_CONTEXT_WINDOW_UNDECLARED}: maxTokens=${resolved.maxTokens} without contextWindow; compaction uses official adapter route capacity when known`,
    );
  }
  const plugin = liveLlmPlugin(resolved);
  const knownDeepseek =
    plugin === "llm-deepseek" &&
    (LIVE_DEEPSEEK_KNOWN_MODELS as readonly string[]).includes(resolved.model);
  if (plugin === "llm-deepseek" && !knownDeepseek && resolved.contextWindow === undefined) {
    notes.push(
      `${LIVE_LLM_CONTEXT_CAPACITY_UNDECLARED}: model ${resolved.provider}/${resolved.model} is outside the official deepseek catalog and has no declared contextWindow; Silver does not invent capacity. The installed dsh-llm-deepseek adapter may still apply its generic defaultContextWindow fallback (commonly 1000000) — that is an adapter default, not a proven model capacity, and must not be reported as a known catalog value`,
    );
  }
  if (plugin === LIVE_PI_AI_PLUGIN && resolved.contextWindow === undefined) {
    notes.push(
      `${LIVE_LLM_CONTEXT_CAPACITY_UNDECLARED}: llm-pi-ai route ${resolved.provider}/${resolved.model} has no declared contextWindow; compaction follows the official adapter route capacity when the catalog/provider supplies it (adapter/generic fallback ≠ proven model capacity)`,
    );
  }
  return notes;
}

function assertLiveReasoningCapability(resolved: ResolvedModelCall): void {
  const effort = liveReasoningEffort(resolved.effort);
  if (effort === "default" || effort === "off") return;
  const cap = resolved.reasoningEfforts;
  if (cap === undefined || cap === false || !Object.prototype.hasOwnProperty.call(cap, effort)) {
    throw liveRouteError(
      resolved,
      LIVE_LLM_REASONING_UNDECLARED,
      `live reasoning is undeclared for ${resolved.provider}/${resolved.model}; set reasoningEfforts or use effort: default to leave the adapter/provider unchanged`,
    );
  }
}

export const PI_AI_SUBSCRIPTION_REASON =
  "PI OAuth/subscription login uses official dsh-authorization plus the DSH credential store. Use silver auth login <provider> to start the official device flow; Silver does not scrape tokens or convert protocols.";

function assertOfficialDshInvocation(argv: readonly string[]): void {
  const joined = argv.join("\n");
  if (/@silver\/scripted-harness|packages\/scripted-harness|packages\/dsh-plane|packages\/runtime|worker\.ts/i.test(joined)) {
    throw new Error("live solver must invoke official DSH, not a Silver loop/runtime clone");
  }
}

function authSourceOf(resolved: ResolvedModelCall): string {
  if (liveLlmAuth(resolved) === "subscription") return "pi-ai-login";
  return resolved.apiKeyRef ?? "none";
}

function liveRouteError(resolved: ResolvedModelCall, errorCode: string, reason: string): Error {
  const report: LiveLlmRouteReport = {
    ...describeLiveLlmRoute(resolved),
    admitted: false,
    errorCode,
    firstToolReached: false,
    reason,
  };
  return new Error(`${reason} (${formatLiveLlmRouteReport(report)})`);
}

/** Challenge/model config for a cell. LLM keys stay on the host. */
export function liveCellEnv(
  resolved: ResolvedModelCall,
  input: {
    challengeId: string;
    targetUrl: string;
    attemptId?: string;
    inScope?: string;
    dshHome?: string;
    flagPattern?: string;
    track?: string;
    domain?: RoomDomain;
    hintPolicy?: string;
    contestSubmit?: boolean;
    contestVerify?: boolean;
    contestRestart?: boolean;
    llm?: { baseUrl: string; capability: string };
    host?:
      | { mode: "rpc"; origin: string; capability: string }
      | { mode: "mock"; platformOrigin: string };
    /** @deprecated mock/dev only; --live must pass host.mode=rpc */
    platformOrigin?: string;
    toolsPreset?: "solver" | "commander" | "internal";
    externalSearch?: boolean;
    repoRoot?: string;
    replayPath?: string;
    roomClockDir?: string;
  },
): Record<string, string> {
  assertLiveDshRoute(resolved);
  const effort = liveReasoningEffort(resolved.effort);
  const env: Record<string, string> = {
    SILVER_CHALLENGE_ID: input.challengeId,
    SILVER_ATTEMPT_ID: input.attemptId ?? "a0",
    SILVER_TARGET_URL: input.targetUrl,
    SILVER_PROVIDER: resolved.provider,
    SILVER_MODEL: resolved.model,
    SILVER_EFFORT: effort,
    SILVER_PRESENTATION: resolved.presentation,
  };
  if (input.host?.mode === "rpc") {
    env.SILVER_HOST_MODE = "rpc";
    env.SILVER_HOST_RPC = input.host.origin;
    env.SILVER_HOST_CAPABILITY = input.host.capability;
    env.SILVER_TOOLS_PRESET = input.toolsPreset ?? "solver";
  } else {
    const mockOrigin = input.host?.mode === "mock" ? input.host.platformOrigin : input.platformOrigin;
    if (mockOrigin) {
      env.SILVER_HOST_MODE = "mock";
      env.SILVER_PLATFORM_ORIGIN = mockOrigin;
    }
  }
  if (input.inScope) env.SILVER_IN_SCOPE = input.inScope;
  if (input.flagPattern) env.SILVER_FLAG_PATTERN = input.flagPattern;
  if (input.track) env.SILVER_TRACK = input.track;
  if (input.domain) env.SILVER_ROOM_DOMAIN = input.domain;
  if (input.hintPolicy) env.SILVER_HINT_POLICY = input.hintPolicy;
  if (input.contestSubmit) env.SILVER_CONTEST_SUBMIT = "1";
  if (input.contestVerify) env.SILVER_CONTEST_VERIFY = "1";
  if (input.contestRestart) env.SILVER_CONTEST_RESTART = "1";
  if (resolved.profile) env.SILVER_ATTEMPT_PROFILE = resolved.profile;
  if (input.dshHome) env.DSH_HOME = input.dshHome;
  if (input.repoRoot) env.SILVER_REPO_ROOT = input.repoRoot;
  if (input.replayPath) env.SILVER_REPLAY_PATH = input.replayPath;
  if (input.roomClockDir) env.SILVER_ROOM_CLOCK_DIR = input.roomClockDir;
  if (input.externalSearch === false) env.SILVER_EXTERNAL_SEARCH = "0";
  if (input.llm) {
    env.SILVER_BASE_URL = input.llm.baseUrl;
    env.SILVER_API_KEY_REF = `env:${LLM_CAPABILITY_ENV}`;
    env[LLM_CAPABILITY_ENV] = input.llm.capability;
  } else {
    if (resolved.baseUrl) env.SILVER_BASE_URL = resolved.baseUrl;
    if (resolved.apiKeyRef) env.SILVER_API_KEY_REF = resolved.apiKeyRef;
  }
  env.DSH_TOOLS_MODE = resolved.presentation === "code" ? "ptc" : resolved.presentation;
  // TEST-ONLY web providers run inside DSH and read these from process.env.
  const testWebHits = process.env.SILVER_TEST_ONLY_WEB_SEARCH_HITS;
  if (testWebHits) env.SILVER_TEST_ONLY_WEB_SEARCH_HITS = testWebHits;
  if (process.env.SILVER_TEST_ONLY_WEB_LOCAL === "1") env.SILVER_TEST_ONLY_WEB_LOCAL = "1";
  const testIntelDeliveryFailure = process.env.SILVER_TEST_INTEL_DELIVERY_FAIL_ONCE_FILE;
  if (testIntelDeliveryFailure) {
    env.SILVER_TEST_INTEL_DELIVERY_FAIL_ONCE_FILE = testIntelDeliveryFailure;
  }
  assertNoLlmSecretsInCellEnv(env);
  return env;
}

/**
 * Composition overlay. agent-default-model plugin config is only {provider, model};
 * reasoningEffort is on llm-deepseek (adapter default) and on settings.yaml.
 */
export function liveModelPatchYaml(
  resolved: ResolvedModelCall,
  route?: LiveLlmBrokerRoute,
  opts?: Pick<LiveDshHomeOptions, "credentialDshHome" | "llmRequest" | "roomCompaction">,
): string {
  assertLiveDshRoute(resolved);
  if (liveLlmPlugin(resolved) === LIVE_PI_AI_PLUGIN) {
    return appendRoomCompaction(livePiAiModelPatchYaml(resolved, route, opts), resolved, opts?.roomCompaction);
  }
  const { baseUrl, apiKeyEnv } = liveRoute(resolved, route);
  const modelLines = liveDeepSeekModelLines(resolved);
  const lines = [
    "# Generated from Silver resolved model call. Do not put API keys here.",
    "- id: agent-default-model",
    "  config:",
    `    provider: ${yamlBare(resolved.provider)}`,
    `    model: ${yamlBare(resolved.model)}`,
    "- id: llm-deepseek",
    "  config:",
  ];
  if (liveShouldWriteDeepSeekReasoning(resolved)) {
    lines.push(`    reasoningEffort: ${liveReasoningEffort(resolved.effort)}`);
  }
  if (baseUrl) lines.push(`    baseURL: ${yamlBare(baseUrl)}`);
  if (apiKeyEnv) lines.push(`    apiKeyEnv: ${yamlBare(apiKeyEnv)}`);
  lines.push(...liveDeepSeekRequestPolicyLines(opts?.llmRequest, "    "));
  lines.push(...modelLines);
  lines.push(...liveAcpRoutePinLines(resolved));
  return appendRoomCompaction(`${lines.join("\n")}\n`, resolved, opts?.roomCompaction);
}

const ROOM_COMPACTION_TARGET_TOKENS = 300_000;
const ROOM_COMPACTION_RETAIN_TOKENS = 64_000;

function appendRoomCompaction(
  patch: string,
  resolved: Pick<ResolvedModelCall, "contextWindow">,
  enabled: boolean | undefined,
): string {
  const window = resolved.contextWindow;
  if (!enabled || window === undefined || window <= ROOM_COMPACTION_TARGET_TOKENS) return patch;
  const thresholdRatio = Math.min(0.8, ROOM_COMPACTION_TARGET_TOKENS / window);
  return `${patch.trimEnd()}\n- id: compaction-basic\n  config:\n    thresholdRatio: ${thresholdRatio}\n    retainTokens: ${ROOM_COMPACTION_RETAIN_TOKENS}\n`;
}

/**
 * Official catalog/ACP image admission for the selected route.
 * Do not infer from the model name. Unknown custom routes stay text-only.
 * Ads and send use the same effective adapter config (capacity overlay included).
 */
export function liveRouteAcceptsImages(
  resolved: Pick<ResolvedModelCall, "provider" | "model" | "llmPlugin" | "contextWindow" | "maxTokens">,
): boolean {
  if (resolved.llmPlugin === LIVE_PI_AI_PLUGIN) {
    return officialPiAiCatalogAcceptsImages(resolved.provider, resolved.model);
  }
  return officialDeepSeekEffectiveAcceptsImages(resolved);
}

/** @deprecated Use liveRouteAcceptsImages with the resolved route. DeepSeek catalog only. */
export function liveModelAcceptsImages(model: string): boolean {
  return officialDeepSeekCatalogAcceptsImages(model);
}

function officialDeepSeekCatalogAcceptsImages(model: string): boolean {
  return deepSeekCatalogModels().find((item) => item.id === model)?.inputModalities?.includes("image") === true;
}

function officialDeepSeekEffectiveAcceptsImages(
  resolved: Pick<ResolvedModelCall, "model" | "contextWindow" | "maxTokens">,
): boolean {
  return officialDeepSeekEffectiveModel(resolved)?.inputModalities?.includes("image") === true;
}

function officialDeepSeekEffectiveModel(
  resolved: Pick<ResolvedModelCall, "model" | "contextWindow" | "maxTokens">,
): DeepSeekCatalogModel | undefined {
  const overlay: Record<string, unknown> = {};
  const models = liveDeepSeekOverlayModels(resolved);
  if (models) overlay.models = models;
  try {
    return deepSeekPlainOptions(DeepSeekLlmConfig(overlay)).models?.find((item) => item.id === resolved.model);
  } catch {
    return undefined;
  }
}

function deepSeekCatalogModels(): DeepSeekCatalogModel[] {
  try {
    return [...(deepSeekPlainOptions(DeepSeekLlmConfig({})).models ?? [])];
  } catch {
    return [];
  }
}

type OfficialPiAiResolvedModel = {
  provider: string;
  id: string;
  name?: string;
  inputModalities?: readonly string[];
};

function officialPiAiResolveModel(provider: string, model: string): OfficialPiAiResolvedModel | undefined {
  try {
    const catalog = builtinProviders().find((item) => item.id === provider);
    const row = catalog?.getModels().find((item) => item.id === model);
    if (!row) return undefined;
    return {
      provider,
      id: row.id,
      name: row.name,
      inputModalities: row.input,
    };
  } catch {
    return undefined;
  }
}

/**
 * Exact official catalog route only. Do not borrow another provider's same
 * model id — that made custom text-only routes advertise image.
 */
function officialPiAiCatalogModel(provider: string, model: string): OfficialPiAiResolvedModel | undefined {
  return officialPiAiResolveModel(provider, model);
}

function officialPiAiCatalogAcceptsImages(provider: string, model: string): boolean {
  return officialPiAiCatalogModel(provider, model)?.inputModalities?.includes("image") === true;
}

function liveDeepSeekOverlayModels(
  resolved: Pick<ResolvedModelCall, "model" | "contextWindow" | "maxTokens">,
): DeepSeekCatalogModel[] | undefined {
  if (resolved.contextWindow === undefined && resolved.maxTokens === undefined) return undefined;
  const official = deepSeekCatalogModels().find((item) => item.id === resolved.model);
  const row: DeepSeekCatalogModel = official ? { ...official, id: resolved.model } : { id: resolved.model };
  if (resolved.contextWindow !== undefined) row.contextWindow = resolved.contextWindow;
  if (resolved.maxTokens !== undefined) row.maxTokens = resolved.maxTokens;
  return [row];
}

function liveDeepSeekModelLines(resolved: ResolvedModelCall, indent = "    "): string[] {
  // Overlay only caller-set capacity. Keep the official model description so
  // ACP initialize and the Host image gate read the same effective Config.
  const models = liveDeepSeekOverlayModels(resolved);
  if (!models) return [];
  return [`${indent}models:`, ...models.flatMap((model) => liveDeepSeekCatalogModelYaml(model, `${indent}  `))];
}

function liveDeepSeekCatalogModelYaml(model: DeepSeekCatalogModel, indent: string): string[] {
  const lines = [`${indent}- id: ${yamlBare(model.id)}`];
  if (model.name) lines.push(`${indent}  name: ${yamlBare(model.name)}`);
  if (model.description) lines.push(`${indent}  description: ${yamlBare(model.description)}`);
  if (model.contextWindow !== undefined) lines.push(`${indent}  contextWindow: ${model.contextWindow}`);
  if (model.maxTokens !== undefined) lines.push(`${indent}  maxTokens: ${model.maxTokens}`);
  if (model.inputModalities && model.inputModalities.length > 0) {
    lines.push(`${indent}  inputModalities:`);
    for (const modality of model.inputModalities) lines.push(`${indent}    - ${yamlBare(modality)}`);
  }
  if (model.imagePixelBudget !== undefined) {
    lines.push(
      `${indent}  imagePixelBudget: ${
        typeof model.imagePixelBudget === "number" ? model.imagePixelBudget : yamlBare(model.imagePixelBudget)
      }`,
    );
  }
  if (model.imageMaxBytes !== undefined) lines.push(`${indent}  imageMaxBytes: ${model.imageMaxBytes}`);
  if (model.systemPromptUpdate) lines.push(`${indent}  systemPromptUpdate: ${yamlBare(model.systemPromptUpdate)}`);
  return lines;
}

function liveAcpRoutePinLines(resolved: Pick<ResolvedModelCall, "provider" | "model">): string[] {
  return [
    "- id: acp",
    "  config:",
    `    provider: ${yamlBare(resolved.provider)}`,
    `    model: ${yamlBare(resolved.model)}`,
  ];
}

/**
 * Official dsh-base tool-result-pruner defaults (documentation reference only —
 * Silver must not re-hardcode these into the live overlay).
 * Installed cordis.patch.yml: thresholdChars 8192, headChars 4096, tailChars 1024.
 */
export const OFFICIAL_TOOL_RESULT_PRUNE_THRESHOLD_CHARS = 8192;
export const OFFICIAL_TOOL_RESULT_PRUNE_HEAD_CHARS = 4096;
export const OFFICIAL_TOOL_RESULT_PRUNE_TAIL_CHARS = 1024;

function livePiAiModelPatchYaml(
  resolved: ResolvedModelCall,
  route?: LiveLlmBrokerRoute,
  opts?: Pick<LiveDshHomeOptions, "credentialDshHome" | "llmRequest">,
): string {
  if (liveLlmAuth(resolved) === "subscription") {
    return [
      "# Generated from Silver resolved model call. Official dsh-llm-pi-ai subscription route.",
      "# This mounts DSH authorization; Silver does not scrape tokens or proxy a login.",
      ...liveAuthorizationPatchLines(),
      ...liveCredentialHomePatchLines(opts?.credentialDshHome),
      "- id: agent-default-model",
      "  config:",
      `    provider: ${yamlBare(resolved.provider)}`,
      `    model: ${yamlBare(resolved.model)}`,
      livePiAiRoutePatchYaml({ ...piAiSubscriptionOverlayInput(resolved), ...llmRequestFields(opts) }).trimEnd(),
      ...liveAcpRoutePinLines(resolved),
      "",
    ].join("\n");
  }
  const { baseUrl, apiKeyEnv } = liveRoute(resolved, route);
  if (!baseUrl || !apiKeyEnv) {
    throw liveRouteError(
      resolved,
      "LIVE_PI_AI_OVERLAY_INCOMPLETE",
      "live llm-pi-ai overlay requires baseURL and apiKeyEnv",
    );
  }
  return [
    "# Generated from Silver resolved model call. Official dsh-llm-pi-ai. Do not put API keys here.",
    "- id: agent-default-model",
    "  config:",
    `    provider: ${yamlBare(resolved.provider)}`,
    `    model: ${yamlBare(resolved.model)}`,
    livePiAiRoutePatchYaml({ ...piAiOverlayInput(resolved, { baseUrl, apiKeyEnv }), ...llmRequestFields(opts) }).trimEnd(),
    ...liveAcpRoutePinLines(resolved),
    "",
  ].join("\n");
}

/**
 * Official `@deepseek-ai/dsh-llm-pi-ai` overlay. DSH already mounts this plugin
 * dormant; this supplies a provider route. Not a Silver protocol converter:
 * the wire shape is whatever `api` names (`anthropic-messages`,
 * `openai-completions`, …). Catalog routes may omit `api` / `models`.
 */
export type LivePiAiRoutePatchInput = {
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  api?: string;
  effort?: string;
  reasoningEfforts?: ReasoningEffortsConfig;
  contextWindow?: number;
  maxTokens?: number;
  compat?: PiAiCompatConfig;
  cacheRetention?: PiAiCacheRetention;
  timeoutMs?: number;
  maxRetries?: number;
};

export function livePiAiRoutePatchYaml(
  input: LivePiAiRoutePatchInput | readonly LivePiAiRoutePatchInput[],
): string {
  const routes = Array.isArray(input) ? input : [input];
  return [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    ...routes.flatMap((route) => livePiAiProfileLines(route, 6)),
    "",
  ].join("\n");
}

function piAiOverlayInput(
  resolved: ResolvedModelCall,
  route: { baseUrl: string; apiKeyEnv: string },
): {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  api?: string;
  effort: string;
  reasoningEfforts?: ReasoningEffortsConfig;
  contextWindow?: number;
  maxTokens?: number;
  compat?: PiAiCompatConfig;
  cacheRetention?: PiAiCacheRetention;
} {
  const input: {
    provider: string;
    model: string;
    baseUrl: string;
    apiKeyEnv: string;
    api?: string;
    effort: string;
    reasoningEfforts?: ReasoningEffortsConfig;
    contextWindow?: number;
    maxTokens?: number;
    compat?: PiAiCompatConfig;
    cacheRetention?: PiAiCacheRetention;
  } = {
    provider: resolved.provider,
    model: resolved.model,
    baseUrl: route.baseUrl,
    apiKeyEnv: route.apiKeyEnv,
    effort: resolved.effort,
  };
  if (resolved.api) input.api = resolved.api;
  if (resolved.reasoningEfforts !== undefined) input.reasoningEfforts = resolved.reasoningEfforts;
  if (resolved.contextWindow !== undefined) input.contextWindow = resolved.contextWindow;
  if (resolved.maxTokens !== undefined) input.maxTokens = resolved.maxTokens;
  if (resolved.compat !== undefined) input.compat = resolved.compat;
  if (resolved.cacheRetention !== undefined) input.cacheRetention = resolved.cacheRetention;
  return input;
}

function piAiSubscriptionOverlayInput(resolved: ResolvedModelCall): {
  provider: string;
  model?: string;
  effort: string;
  reasoningEfforts?: ReasoningEffortsConfig;
  contextWindow?: number;
  maxTokens?: number;
  compat?: PiAiCompatConfig;
  cacheRetention?: PiAiCacheRetention;
} {
  const input: {
    provider: string;
    model?: string;
    effort: string;
    reasoningEfforts?: ReasoningEffortsConfig;
    contextWindow?: number;
    maxTokens?: number;
    compat?: PiAiCompatConfig;
    cacheRetention?: PiAiCacheRetention;
  } = {
    provider: resolved.provider,
    effort: resolved.effort,
  };
  if (
    resolved.contextWindow !== undefined ||
    resolved.maxTokens !== undefined ||
    resolved.reasoningEfforts !== undefined ||
    resolved.compat !== undefined ||
    resolved.cacheRetention !== undefined
  ) {
    input.model = resolved.model;
  }
  if (resolved.reasoningEfforts !== undefined) input.reasoningEfforts = resolved.reasoningEfforts;
  if (resolved.contextWindow !== undefined) input.contextWindow = resolved.contextWindow;
  if (resolved.maxTokens !== undefined) input.maxTokens = resolved.maxTokens;
  if (resolved.compat !== undefined) input.compat = resolved.compat;
  if (resolved.cacheRetention !== undefined) input.cacheRetention = resolved.cacheRetention;
  return input;
}

function livePiAiProfileLines(
  input: {
    provider: string;
    model?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    api?: string;
    effort?: string;
    reasoningEfforts?: ReasoningEffortsConfig;
    contextWindow?: number;
    maxTokens?: number;
    compat?: PiAiCompatConfig;
    cacheRetention?: PiAiCacheRetention;
    timeoutMs?: number;
    maxRetries?: number;
  },
  indent: number,
): string[] {
  const pad = " ".repeat(indent);
  const inner = `${pad}  `;
  const lines = [`${pad}${yamlBare(input.provider)}:`, `${inner}displayName: ${yamlBare(input.provider)}`];
  if (input.apiKeyEnv) lines.push(`${inner}apiKeyEnv: ${yamlBare(input.apiKeyEnv)}`);
  if (input.api) lines.push(`${inner}api: ${yamlBare(input.api)}`);
  if (input.baseUrl) lines.push(`${inner}baseURL: ${yamlBare(input.baseUrl)}`);
  if (input.timeoutMs !== undefined) lines.push(`${inner}timeoutMs: ${input.timeoutMs}`);
  lines.push(...liveOfficialRetryPolicyLines(input.maxRetries, inner));
  if (input.cacheRetention) lines.push(`${inner}cacheRetention: ${input.cacheRetention}`);
  if (input.compat && Object.keys(input.compat).length > 0) {
    lines.push(`${inner}compat:`);
    for (const [key, value] of Object.entries(input.compat)) lines.push(`${inner}  ${key}: ${String(value)}`);
  }
  if (input.model) {
    const modelPad = `${inner}  `;
    const official = officialPiAiCatalogModel(input.provider, input.model);
    lines.push(`${inner}models:`, `${modelPad}- id: ${yamlBare(input.model)}`);
    lines.push(`${modelPad}  name: ${yamlBare(official?.name ?? input.model)}`);
    if (official?.inputModalities && official.inputModalities.length > 0) {
      lines.push(`${modelPad}  input:`);
      for (const modality of official.inputModalities) lines.push(`${modelPad}    - ${yamlBare(modality)}`);
    }
    if (input.contextWindow !== undefined) lines.push(`${modelPad}  contextWindow: ${input.contextWindow}`);
    if (input.maxTokens !== undefined) lines.push(`${modelPad}  maxTokens: ${input.maxTokens}`);
    if (
      liveShouldWriteReasoning({
        effort: input.effort ?? "off",
        ...(input.reasoningEfforts !== undefined ? { reasoningEfforts: input.reasoningEfforts } : {}),
      })
    ) {
      const cap = input.reasoningEfforts;
      if (isReasoningEffortMap(cap)) lines.push(...reasoningEffortsYamlLines(cap, `${modelPad}  `));
    }
  }
  return lines;
}

function reasoningEffortsYamlLines(map: ReasoningEffortMap, indent: string): string[] {
  const lines = [`${indent}reasoningEfforts:`];
  for (const key of REASONING_EFFORT_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
    const value = map[key];
    if (value == null || value === "") lines.push(`${indent}  ${key}:`);
    else lines.push(`${indent}  ${key}: ${yamlBare(value)}`);
  }
  return lines;
}

/**
 * Official DSH settings document ($DSH_HOME/settings.yaml).
 * Headless reads agent-default-model.reasoningEffort via currentSelection()
 * and installModelSelection puts it on agent/request.
 */
export function liveSettingsYaml(
  resolved: ResolvedModelCall,
  route?: LiveLlmBrokerRoute,
  opts?: Pick<LiveDshHomeOptions, "llmRequest">,
): string {
  assertLiveDshRoute(resolved);
  const { baseUrl, apiKeyEnv } = liveRoute(resolved, route);
  if (liveLlmPlugin(resolved) === LIVE_PI_AI_PLUGIN) {
    if (liveLlmAuth(resolved) === "subscription") {
      const defaultModel = [
        "agent-default-model:",
        `  provider: ${yamlBare(resolved.provider)}`,
        `  model: ${yamlBare(resolved.model)}`,
      ];
      if (liveShouldWriteReasoning(resolved)) {
        defaultModel.push(`  reasoningEffort: ${liveReasoningEffort(resolved.effort)}`);
      }
      return [
        "# Generated from Silver resolved model call. Official dsh-llm-pi-ai subscription route.",
        "# DSH credentials live in this DSH_HOME; no raw provider key is written here.",
        ...defaultModel,
        "llm-pi-ai:",
        "  providers:",
        ...livePiAiProfileLines({ ...piAiSubscriptionOverlayInput(resolved), ...llmRequestFields(opts) }, 4),
        "permission:",
        `  defaultPreset: ${liveDshPermissionPreset()}`,
        "",
      ].join("\n");
    }
    if (!baseUrl || !apiKeyEnv) {
      throw liveRouteError(
        resolved,
        "LIVE_PI_AI_OVERLAY_INCOMPLETE",
        "live llm-pi-ai overlay requires baseURL and apiKeyEnv",
      );
    }
    const defaultModel = [
      "agent-default-model:",
      `  provider: ${yamlBare(resolved.provider)}`,
      `  model: ${yamlBare(resolved.model)}`,
    ];
    if (liveShouldWriteReasoning(resolved)) {
      defaultModel.push(`  reasoningEffort: ${liveReasoningEffort(resolved.effort)}`);
    }
    return [
      "# Generated from Silver resolved model call. Official dsh-llm-pi-ai. Do not put API keys here.",
      ...defaultModel,
      "llm-pi-ai:",
      "  providers:",
      ...livePiAiProfileLines({ ...piAiOverlayInput(resolved, { baseUrl, apiKeyEnv }), ...llmRequestFields(opts) }, 4),
      "permission:",
      `  defaultPreset: ${liveDshPermissionPreset()}`,
      "",
    ].join("\n");
  }
  const lines = [
    "# Generated from Silver resolved model call. Do not put API keys here.",
    "agent-default-model:",
    `  provider: ${yamlBare(resolved.provider)}`,
    `  model: ${yamlBare(resolved.model)}`,
  ];
  if (liveShouldWriteDeepSeekReasoning(resolved)) {
    const written = liveReasoningEffort(resolved.effort);
    lines.push(`  reasoningEffort: ${written}`, "llm-deepseek:", `  reasoningEffort: ${written}`);
  } else {
    lines.push("llm-deepseek:");
  }
  if (baseUrl) lines.push(`  baseURL: ${yamlBare(baseUrl)}`);
  if (apiKeyEnv) lines.push(`  apiKeyEnv: ${yamlBare(apiKeyEnv)}`);
  lines.push(...liveDeepSeekRequestPolicyLines(opts?.llmRequest, "  "));
  lines.push(...liveDeepSeekModelLines(resolved, "  "));
  lines.push("permission:", `  defaultPreset: ${liveDshPermissionPreset()}`);
  return `${lines.join("\n")}\n`;
}

function llmRequestFields(opts?: Pick<LiveDshHomeOptions, "llmRequest">): {
  timeoutMs?: number;
  maxRetries?: number;
} {
  const req = opts?.llmRequest;
  if (!req) return {};
  return {
    ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    ...(req.maxRetries !== undefined ? { maxRetries: req.maxRetries } : {}),
  };
}

function liveOfficialRetryPolicyLines(maxRetries: number | undefined, indent: string): string[] {
  if (maxRetries === undefined) return [];
  return [`${indent}retryPolicy:`, `${indent}  mode: normal`, `${indent}  maxRetries: ${maxRetries}`];
}

/** DeepSeek adapter has no HTTP timeoutMs; streamIdleTimeoutMs is the official hang bound. */
function liveDeepSeekRequestPolicyLines(
  req: LiveDshHomeOptions["llmRequest"] | undefined,
  indent: string,
): string[] {
  if (!req) return [];
  const lines: string[] = [];
  if (req.timeoutMs !== undefined) lines.push(`${indent}streamIdleTimeoutMs: ${req.timeoutMs}`);
  lines.push(...liveOfficialRetryPolicyLines(req.maxRetries, indent));
  return lines;
}

function liveAuthorizationPatchLines(): string[] {
  return [
    "- insert:",
    `    - id: ${LIVE_DSH_INVARIANTS_PLUGIN}`,
    "      name: '@deepseek-ai/dsh-invariants'",
    `    - id: ${LIVE_DSH_AUTHORIZATION_PLUGIN}`,
    "      name: '@deepseek-ai/dsh-authorization'",
    "    - id: authorization-invariant",
    "      name: '@deepseek-ai/dsh-authorization/invariant'",
  ];
}

function liveCredentialHomePatchLines(credentialDshHome: string | undefined): string[] {
  if (!credentialDshHome) return [];
  return [
    "- id: credentials",
    "  config:",
    `    dshHome: ${yamlBare(path.resolve(credentialDshHome))}`,
  ];
}

export const LIVE_SESSION_PROJECTION_CACHE_WRITE_EVERY_EVENTS = 20;
export const LIVE_SESSION_PROJECTION_CACHE_WRITE_INTERVAL_MS = 5_000;

export function liveStoragePatchYaml(dshHome: string): string {
  const storageRoot = path.join(path.resolve(dshHome), "storage");
  return [
    "# Generated DSH-native storage overrides for live session projection cache.",
    "- id: storage-json",
    "  config:",
    `    root: ${yamlBare(storageRoot)}`,
    "- id: storage-domain",
    "  config:",
    "    backend: json",
    "- id: session-projection-cache",
    "  config:",
    `    writeEveryEvents: ${LIVE_SESSION_PROJECTION_CACHE_WRITE_EVERY_EVENTS}`,
    `    writeIntervalMs: ${LIVE_SESSION_PROJECTION_CACHE_WRITE_INTERVAL_MS}`,
    "",
  ].join("\n");
}

/** Headless overlay. HostFs and the official cell runtime both use DSH native bash/files. */
export function livePersonaPatchYaml(opts?: {
  compactPersona?: boolean;
  skills?: boolean | LiveDshSkillMount;
  pluginModuleRepoRoot?: string;
  testOnlyFsSearchRawOutputMaxBytes?: number;
  testOnlyLocalWeb?: boolean;
  personaPrefix?: string;
  swarmRoom?: boolean;
  commanderSurface?: boolean;
  externalSearch?: boolean;
  hint?: boolean;
  /** Legacy Commander-domain discriminator. Public prompts remain domain neutral. */
  domain?: RoomDomain;
  /** Formal room role. Only a dedicated Lead receives the coordinator persona. */
  role?: "lead" | "worker";
  /** Official Team members share this role-neutral system persona; role duties live in Host-authored tasks. */
  formalTeam?: boolean;
}): string {
  const skillMount = normalizeLiveSkillMount(opts?.skills);
  const commanderSurface = Boolean(opts?.commanderSurface);
  const pluginModuleRepoRoot = opts?.pluginModuleRepoRoot;
  const configuredPersona =
    opts?.personaPrefix ??
    assembleRoomPersona({
      domain: opts?.domain ?? "ctf",
      ...(opts?.role ? { role: opts.role } : {}),
      ...(opts?.formalTeam ? { formalTeam: true } : {}),
      compact: Boolean(opts?.compactPersona),
      skills: Boolean(skillMount),
      room: Boolean(opts?.swarmRoom),
    });
  const personaBase = commanderSurface && opts?.personaPrefix === undefined
    ? commanderPersonaWithDiscovery(configuredPersona)
    : configuredPersona;
  const persona = personaBase;
  const body = persona.split("\n").map((line) => (line.length ? `      ${line}` : "")).join("\n");
  const dshBash = [
    "# Use official DSH one-shot bash and native Jobs. Each call is a fresh shell.",
    "# Long work uses run_in_background and job_output/job_kill.",
    `# DSH file policy: ${liveDshPermissionPreset()}; the configured task environment is the execution boundary.`,
    "# Official silver-cell installs Linux DSH dependencies at /opt/silver-runtime.",
    ...(!commanderSurface
      ? [
          "# Foreground timeout kills the process; Workers retain explicit run_in_background.",
          "- id: tool-bash",
          "  config:",
          "    promoteOnTimeout: false",
        ]
      : []),
  ];
  const disabledToolPlugins = DSH_LIVE_DISABLED_TOOL_PLUGINS.filter(
    (id) => !skillMount || !(DSH_LIVE_SKILL_PLUGIN_IDS as readonly string[]).includes(id),
  );
  const commanderGeneric = commanderSurface
    ? [
        "terminal",
        "terminal-bash",
        "tool-todo",
        "tool-jobs",
      ]
    : [];
  const webSearchOff = opts?.externalSearch === false;
  const extra = [
    commanderSurface
      ? "# Commander surface: Host control plus generic bash/read/grep/glob/web_fetch/web_search discovery."
      : webSearchOff
        ? "# runtime.externalSearch is false: web_search is not mounted. web_fetch and bash stay available."
        : "# Disable deferred/conflicting extras only. web_search and web_fetch stay official.",
    "# plan-mode and workflows are not Worker tools; native subagents use a separate child-policy patch.",
    "# Immediate tool output sizes inherit official DSH defaults (no Silver micro-caps).",
    ...disabledToolPlugins.flatMap((id) => [`- id: ${id}`, "  disabled: true"]),
    ...commanderGeneric.flatMap((id) => [`- id: ${id}`, "  disabled: true"]),
    ...webSearchOffPatchLines(webSearchOff),
    ...(skillMount
      ? liveSkillPatchYaml(skillMount.skillRoots, {
          catalogDescriptionMaxLength: skillMount.catalogDescriptionMaxLength,
        }).split("\n")
      : []),
    ...testOnlyLiveNativeBashPatchLines(testOnlyLiveWorkerBashTimeoutMs()),
    ...testOnlyFsSearchPatchLines(commanderSurface ? undefined : opts?.testOnlyFsSearchRawOutputMaxBytes),
    ...testOnlyLocalWebPatchLines(commanderSurface ? false : opts?.testOnlyLocalWeb, pluginModuleRepoRoot),
  ];
  return [
    ...dshBash,
    ...extra,
    "# Generated long-task Worker persona. Replaces the headless coding-agent default.",
    "- id: system-prompt",
    "  config:",
    "    personaSuffix: Use the current Session working directory.",
    "    personaPrefix: |",
    body,
    "",
  ].join("\n");
}

function testOnlyLiveNativeBashPatchLines(bashTimeoutMs: number | undefined): string[] {
  if (bashTimeoutMs === undefined) return [];
  return ["- id: bash-sandbox", "  config:", `    timeoutMs: ${bashTimeoutMs}`];
}

/**
 * TEST-ONLY. Production never sets SILVER_TEST_ONLY_FS_SEARCH_RAW_OUTPUT_MAX_BYTES.
 * Product tests may lower official tool-fs-search rawOutputMaxBytes so a wide
 * grep can produce a real SEARCH_RAW_OUTPUT_OVERFLOW without changing defaults.
 */
export function testOnlyFsSearchRawOutputMaxBytes(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.SILVER_TEST_ONLY_FS_SEARCH_RAW_OUTPUT_MAX_BYTES;
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

/**
 * TEST-ONLY. Production never sets SILVER_TEST_ONLY_WEB_LOCAL.
 * Product tests may pin official web tools onto labeled local ctx.web providers.
 */
export function testOnlyLocalWebEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SILVER_TEST_ONLY_WEB_LOCAL === "1";
}

function webSearchOffPatchLines(webSearchOff: boolean): string[] {
  if (!webSearchOff) return [];
  return [
    "# runtime.externalSearch is false. Do not mount web_search. web_fetch stays the official provider.",
    "- id: web-search-deepseek",
    "  disabled: true",
    "- id: tool-web",
    "  config:",
    "    search: false",
  ];
}

function testOnlyLocalWebPatchLines(enabled?: boolean, pluginModuleRepoRoot?: string): string[] {
  if (!enabled) return [];
  return [
    "# TEST-ONLY: SILVER_TEST_ONLY_WEB_LOCAL. Not a public search/fetch verification.",
    "- id: web",
    "  config:",
    "    searchProvider: silver-test-search",
    "    fetchProvider: silver-test-fetch",
    "- insert:",
    "    - id: silver-live-web-local",
    `      name: ${JSON.stringify(
        liveWebLocalModulePath(
          pluginModuleRepoRoot !== undefined ? { pluginModuleRepoRoot } : undefined,
        ),
      )}`,
  ];
}

function testOnlyFsSearchPatchLines(rawOutputMaxBytes?: number): string[] {
  if (rawOutputMaxBytes === undefined || !Number.isInteger(rawOutputMaxBytes) || rawOutputMaxBytes < 1) {
    return [];
  }
  return [
    "# TEST-ONLY: SILVER_TEST_ONLY_FS_SEARCH_RAW_OUTPUT_MAX_BYTES. Not a production default.",
    "- id: tool-fs-search",
    "  config:",
    "    sampleOverCapGlobResults: false",
    `    rawOutputMaxBytes: ${rawOutputMaxBytes}`,
  ];
}

interface NormalizedLiveDshSkillMount {
  skillRoots: string[];
  catalogDescriptionMaxLength: number;
}

function normalizeLiveSkillMount(input: boolean | LiveDshSkillMount | undefined): NormalizedLiveDshSkillMount | undefined {
  if (!input) return undefined;
  if (input === true) return undefined;
  const roots = [
    ...(input.skillRoots ?? []),
    ...(input.skillRoot ? [input.skillRoot] : []),
  ];
  if (roots.length === 0) return undefined;
  return {
    skillRoots: roots.map((root) => path.resolve(root)),
    catalogDescriptionMaxLength: input.catalogDescriptionMaxLength ?? 500,
  };
}

export function writeLiveDshHome(
  dir: string,
  resolved: ResolvedModelCall,
  route?: LiveLlmBrokerRoute,
  opts?: LiveDshHomeOptions,
): { dshHome: string; modelPatch: string; storagePatch: string; personaPatch: string } {
  assertLiveDshRoute(resolved);
  const dshHome = path.join(dir, ".silver-dsh");
  fs.mkdirSync(dshHome, { recursive: true });
  fs.writeFileSync(path.join(dshHome, "settings.yaml"), liveSettingsYaml(resolved, route, opts));
  const modelPatch = path.join(dir, ".silver-dsh-model.patch.yml");
  fs.writeFileSync(modelPatch, liveModelPatchYaml(resolved, route, opts));
  const storagePatch = path.join(dir, ".silver-dsh-storage.patch.yml");
  fs.writeFileSync(storagePatch, liveStoragePatchYaml(opts?.dshHomeForPatch ?? dshHome));
  const personaPatch = path.join(dir, ".silver-dsh-persona.patch.yml");
  fs.writeFileSync(
    personaPatch,
    livePersonaPatchYaml({
      ...opts,
      compactPersona: true,
    }),
  );
  return { dshHome, modelPatch, storagePatch, personaPatch };
}

function liveRoute(
  resolved: ResolvedModelCall,
  route?: LiveLlmBrokerRoute,
): { baseUrl?: string; apiKeyEnv?: string } {
  if (route) {
    return { baseUrl: route.baseUrl, apiKeyEnv: route.apiKeyEnv ?? LLM_CAPABILITY_ENV };
  }
  const apiKeyEnv = apiKeyEnvName(resolved.apiKeyRef);
  return {
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  };
}

/** Fixture --live is only a win when Host CAS accepted every remaining flag. */
export function assertLiveHostAccepted(snapshot: {
  challengeId?: unknown;
  status?: unknown;
  remainingFlags?: unknown;
}): void {
  if (snapshot.status === "solved" && snapshot.remainingFlags === 0) return;
  throw new Error(
    `live DSH exited without Host accepted for ${String(snapshot.challengeId ?? "challenge")}; status=${String(snapshot.status)} remaining=${String(snapshot.remainingFlags)}`,
  );
}

/**
 * --mission/--target is candidate-report: record verified candidates only.
 * It does not perform platform acceptance.
 */
const REPORT_SECRET =
  /flag\{[A-Za-z0-9_.:=+\-/]{8,}[^}\s]{0,200}\}?|Cookie\s*:\s*[^\n]+|Set-Cookie\s*:\s*[^\n]+|\bPHPSESSID=[^\s;]+|\bctf_token=[^\s&]+|\bpassport_token=[^\s&]+|\bsession[_-]?token=[^\s&]+|\bCTF_TOKEN=[^\s&]+|\bapi[_-]?key=[^\s&]+|\b(sk-|xai-|gsk_)[A-Za-z0-9._-]{8,}/gi;

export function redactLiveReportValue(value: unknown): unknown {
  return redactReportValue(value);
}

function redactReportValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(REPORT_SECRET, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redactReportValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactReportValue(child);
  }
  return out;
}

export function liveMissionReport(input: {
  snapshot: { challengeId?: unknown; status?: unknown; remainingFlags?: unknown };
  dshStatus: number;
  progress?: ProgressSnapshot;
  candidates?: unknown[];
}): Record<string, unknown> {
  return redactReportValue({
    mode: "candidate-report",
    platformAccepted: false,
    reason: "candidate-report mode records verified candidates only; it does not perform platform acceptance",
    dshStatus: input.dshStatus,
    challengeId: input.snapshot.challengeId,
    status: input.snapshot.status,
    remainingFlags: input.snapshot.remainingFlags,
    ...(input.progress ? { progress: input.progress } : {}),
    candidates: input.candidates ?? [],
  }) as Record<string, unknown>;
}

const HOST_SPAWN_FROM_PROCESS = new Set(["PATH", "TERM"]);
const HOST_SPAWN_LOCKED = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TERM",
  "DSH_TELEMETRY_DISABLED",
  "DSH_TELEMETRY_MODE",
  "DSH_PERMISSION_MODE",
  "NODE_OPTIONS",
]);

function isHostSpawnKey(key: string): boolean {
  if (HOST_SPAWN_FROM_PROCESS.has(key) || key === "HOME" || key === "TMPDIR") return true;
  if (key === "DSH_HOME" || key === "DSH_TOOLS_MODE" || key === "DSH_TELEMETRY_DISABLED" || key === "DSH_TELEMETRY_MODE") {
    return true;
  }
  if (key === "DSH_PERMISSION_MODE") return true;
  if (key.startsWith("SILVER_")) return true;
  return false;
}

/** Join the challenge origin with competition.inScope for SILVER_IN_SCOPE. */
export function liveContestScope(origin: string, extra: string[] = []): string {
  return [...new Set([origin, ...extra].map((row) => row.trim()).filter(Boolean))].join(",");
}

/**
 * Minimal env for official dsh on the host sandbox.
 * DSH_PERMISSION_MODE is workspace-write on local hosts. Hosted contest
 * containers use full access inside their existing container boundary because
 * the platform does not provide a DSH Linux sandbox backend.
 * Do not inherit AWS keys, SSH sockets, or DSH telemetry from the operator shell.
 */
export function hostSpawnEnv(
  cellEnv: Record<string, string>,
  opts: { home: string; tmpDir: string; binDir?: string; toolsRoot?: string },
): Record<string, string> {
  const toolBins = opts.toolsRoot
    ? [
        path.join(opts.toolsRoot, "bin"),
        path.join(opts.toolsRoot, "venv", "bin"),
        path.join(opts.toolsRoot, "node", "node_modules", ".bin"),
      ].filter((dir) => fs.existsSync(dir))
    : [];
  const pathValue = [opts.binDir, ...toolBins, process.env.PATH?.trim() || "/usr/bin:/bin"]
    .filter(Boolean)
    .join(path.delimiter);
  const env: Record<string, string> = {
    PATH: pathValue,
    TERM: process.env.TERM?.trim() || "dumb",
    HOME: opts.home,
    TMPDIR: opts.tmpDir,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_TELEMETRY_MODE: "DISABLED",
    DSH_PERMISSION_MODE: liveDshPermissionPreset(),
    NODE_OPTIONS: "--experimental-strip-types --no-warnings",
  };
  for (const [key, value] of Object.entries(cellEnv)) {
    if (!isHostSpawnKey(key) || HOST_SPAWN_LOCKED.has(key)) continue;
    env[key] = value;
  }
  assertNoLlmSecretsInCellEnv(env);
  return env;
}

export function writeHostFsToolShims(cwd: string): string {
  const binDir = path.join(cwd, ".silver-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const timeoutPath = path.join(binDir, "timeout");
  fs.writeFileSync(
    timeoutPath,
    `#!/usr/bin/env python3
import signal
import subprocess
import sys

def seconds(raw):
    value = raw.strip()
    multiplier = 1.0
    if value.endswith("s"):
        value = value[:-1]
    elif value.endswith("m"):
        value = value[:-1]
        multiplier = 60.0
    elif value.endswith("h"):
        value = value[:-1]
        multiplier = 3600.0
    return max(0.0, float(value) * multiplier)

if len(sys.argv) < 3:
    print("usage: timeout SECONDS COMMAND [ARG...]", file=sys.stderr)
    sys.exit(125)

try:
    limit = seconds(sys.argv[1])
except ValueError:
    print("timeout: invalid duration", file=sys.stderr)
    sys.exit(125)

try:
    # Stay in DSH's managed process group so session/job teardown also owns
    # this command. Starting a new session here would let it survive its Room.
    proc = subprocess.Popen(sys.argv[2:])
except FileNotFoundError:
    sys.exit(127)

try:
    sys.exit(proc.wait(timeout=limit))
except subprocess.TimeoutExpired:
    try:
        proc.terminate()
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=0.2)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        proc.wait()
    sys.exit(124)
`,
    { mode: 0o755 },
  );
  fs.chmodSync(timeoutPath, 0o755);
  return binDir;
}

export function assertNoLlmSecretsInCellEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_NAME.test(key)) {
      throw new Error(`live cell env must not carry host secret ${key}`);
    }
    if (looksLikeRawApiKey(value)) {
      throw new Error(`live cell env ${key} must not carry a raw API key`);
    }
  }
}

function looksLikeRawApiKey(value: string): boolean {
  return /^(sk-|xai-|gsk_)[A-Za-z0-9_-]{8,}$/.test(value);
}

function yamlBare(value: string): string {
  if (/^[A-Za-z0-9_.:/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
