import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PUBLIC_BASE_URL as DSH_DEEPSEEK_PUBLIC_BASE_URL } from "@deepseek-ai/dsh-llm-deepseek";
import type { Presentation } from "@silver/ctf-spine";
import {
  OPEN_FLAG_PATTERN,
  defaultAutonomy,
  isAwdRole,
  isHintPolicy,
  type Autonomy,
  type AwdRole,
  type HintPolicy,
  type TrackKind,
} from "@silver/protocol";
import { isRoomFeedDelivery, type RoomFeedDelivery } from "./project-room.ts";

export type JeopardyAgent = "ctf-solver" | "skeptic" | "verifier";
export type AwdAgentName = "awd-attacker" | "awd-defender" | "awd-persister" | "awd-sniffer";
export type AgentName = JeopardyAgent | AwdAgentName;

export const LLM_PLUGINS = ["llm-deepseek", "llm-pi-ai"] as const;
export type LlmPlugin = (typeof LLM_PLUGINS)[number];

/** Official DSH DeepSeek Messages endpoint. */
export const DEFAULT_DEEPSEEK_BASE_URL = DSH_DEEPSEEK_PUBLIC_BASE_URL;

export const LLM_AUTH_MODES = ["api-key", "subscription"] as const;
export type LlmAuthMode = (typeof LLM_AUTH_MODES)[number];

export const REASONING_EFFORT_NAMES = ["off", "low", "high", "max"] as const;
export type ReasoningEffortName = (typeof REASONING_EFFORT_NAMES)[number];
export const PI_AI_CACHE_RETENTIONS = ["none", "short", "long"] as const;
export type PiAiCacheRetention = (typeof PI_AI_CACHE_RETENTIONS)[number];
export const PI_AI_BOOLEAN_COMPAT_FIELDS = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "supportsStrictMode",
  "supportsLongCacheRetention",
  "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools",
  "supportsTemperature",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "supportsStrictTools",
] as const;
export type PiAiBooleanCompatField = (typeof PI_AI_BOOLEAN_COMPAT_FIELDS)[number];
export type PiAiCompatConfig = Partial<Record<PiAiBooleanCompatField, boolean>>;
/**
 * Declared DSH `reasoningEfforts` map.
 * Only `off` may be null (disable thinking). `low` / `high` / `max` must be
 * non-empty strings. Omit the field = undeclared; do not guess.
 */
export type ReasoningEffortMap = Partial<Record<ReasoningEffortName, string | null>>;
/** `false` = declared non-reasoning. Omit the field = undeclared (do not guess). */
export type ReasoningEffortsConfig = false | ReasoningEffortMap;

export interface ProviderModelConfig {
  reasoningEfforts?: ReasoningEffortsConfig;
  contextWindow?: number;
  maxTokens?: number;
  compat?: PiAiCompatConfig;
}

export interface ModelSlice {
  provider?: string;
  model?: string;
  effort?: string;
  presentation?: Presentation;
  baseUrl?: string;
  apiKeyRef?: string;
  llmPlugin?: LlmPlugin;
  api?: string;
  auth?: LlmAuthMode;
  /** Slice-level reasoning capability. Wins over provider/model. */
  reasoningEfforts?: ReasoningEffortsConfig;
  profile?: string;
  seed?: string;
  role?: AwdRole;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKeyRef?: string;
  /** Official DSH LLM adapter. Default `llm-deepseek`. */
  llmPlugin?: LlmPlugin;
  /**
   * Wire protocol for `llm-pi-ai`. Hand-declared live api-key routes must name
   * `openai-completions` or `anthropic-messages`; official pi-ai catalog
   * routes may omit it so the adapter keeps its provider/model protocol.
   */
  api?: string;
  /** `api-key` (Host broker) or `subscription` (official PI/DSH login). */
  auth?: LlmAuthMode;
  /** Provider-wide reasoning capability. Omit = undeclared; do not guess. */
  reasoningEfforts?: ReasoningEffortsConfig;
  /** Official `llm-pi-ai` compatibility switches. Omit = let PI-AI decide. */
  compat?: PiAiCompatConfig;
  /** Official `llm-pi-ai` prompt-cache retention. Omit = adapter default. */
  cacheRetention?: PiAiCacheRetention;
  /** Per-model reasoning capability. Wins over provider-wide. */
  models?: Record<string, ProviderModelConfig>;
}

export type RoomMode = "solo" | "race" | "swarm" | "three-graph";

export interface CompetitionConfig {
  track: TrackKind;
  flagPattern: string;
  inScope: string[];
  autonomy: Autonomy;
  hintPolicy: HintPolicy;
  /** How many Challenge Rooms Host may run at once. One Challenge is one Room. */
  maxConcurrentRooms: number;
}

export interface RoomConfig {
  mode: RoomMode;
  /** Isolated solver swarms per challenge in three-graph mode. */
  swarmCount: 1 | 2;
}

export interface RaceConfig {
  /** Fixed isolated Racers in one Room. Default 3. */
  workers: number;
  /** Empty inherits the solver model. Non-empty may be heterogeneous; Racers are independent roots. */
  models: string[];
}

export type SwarmModelPolicy = "homogeneous" | "heterogeneous";

export interface SwarmChatConfig {
  /** Optional chat policy; formal teams still keep their durable Feed/Status channel. */
  enabled: boolean;
  delivery: RoomFeedDelivery;
}

/**
 * Official Team swarm. maxWorkers does not include the Lead.
 * Heterogeneous modelPolicy fails closed; dynamic mixed models are not in this batch.
 */
export interface SwarmConfig {
  initialWorkers: number;
  maxWorkers: number;
  modelPolicy: SwarmModelPolicy;
  chat: SwarmChatConfig;
  /** Optional opening responsibilities, assigned by index to initial Workers. */
  workerRoles: string[];
}

/**
 * Old swarm block, read so replay configs still parse.
 * New runs do not select a Room from these fields.
 */
export interface LegacySwarmConfig {
  initialMembers: number;
  maxMembers: number;
  allowedModels: string[];
  feedDelivery: RoomFeedDelivery;
}

export interface NativeAssistantsConfig {
  enabled: boolean;
  maxPerMember: number;
  maxDepth: number;
}

export type ExecutionProfile = "host";

export interface RuntimeLoopConfig {
  maxModelLoops: number;
  /**
   * Public web search tool. Defaults to on. `false` keeps `web_search` off the
   * model tool surface and does not restrict `web_fetch` or bash.
   */
  externalSearch: boolean;
  /** Solvers use tools installed in the current host or hosted competition image. */
  executionProfile: ExecutionProfile;
}

export interface LiveBudget {
  /** `0` means no local room deadline; an external deadline may still close the Room. */
  timeoutMs: number;
  /**
   * Chat-turn index cap. `0` means time-only: Host does not stop on turn index.
   * A positive value still races the wall clock; first bound wins.
   */
  maxTurns: number;
}

export interface SkillConfig {
  /**
   * Explicit DSH skill roots. The public build ships no bundled security catalog.
   */
  roots: string[];
  catalogDescriptionMaxLength: number;
}

export interface SilverConfig {
  defaults: Required<Pick<ModelSlice, "provider" | "model" | "effort" | "presentation">>;
  providers: Record<string, ProviderConfig>;
  agents: Partial<Record<AgentName, ModelSlice>>;
  challenges: Record<string, ModelSlice>;
  workers: Record<string, ModelSlice>;
  attemptPolicies: Record<string, { attempts: ModelSlice[] }>;
  competition: CompetitionConfig;
  room: RoomConfig;
  race: RaceConfig;
  live: LiveBudget;
  skills: SkillConfig;
  swarm: SwarmConfig;
  /** Set only when an old swarm block was present. Replay readers may use it. */
  legacySwarm?: LegacySwarmConfig;
  nativeAssistants: NativeAssistantsConfig;
  runtime: RuntimeLoopConfig;
}

export interface ResolvedModelCall {
  provider: string;
  model: string;
  effort: string;
  presentation: Presentation;
  agent: AgentName;
  llmPlugin: LlmPlugin;
  auth: LlmAuthMode;
  baseUrl?: string;
  apiKeyRef?: string;
  api?: string;
  reasoningEfforts?: ReasoningEffortsConfig;
  contextWindow?: number;
  maxTokens?: number;
  compat?: PiAiCompatConfig;
  cacheRetention?: PiAiCacheRetention;
  profile?: string;
  seed?: string;
}

export const DEEPSEEK_REASONING_EFFORTS: ReasoningEffortMap = {
  off: null,
  low: "low",
  high: "high",
  max: "max",
};

export function isReasoningEffortMap(value: ReasoningEffortsConfig | undefined): value is ReasoningEffortMap {
  return value !== undefined && value !== false;
}

export function resolveReasoningEfforts(input: {
  slice?: ReasoningEffortsConfig;
  provider?: ProviderConfig;
  model: string;
}): ReasoningEffortsConfig | undefined {
  if (input.slice !== undefined) return input.slice;
  const fromModel = input.provider?.models?.[input.model]?.reasoningEfforts;
  if (fromModel !== undefined) return fromModel;
  return input.provider?.reasoningEfforts;
}

export function resolvePiAiCompat(input: {
  provider?: ProviderConfig;
  model: string;
}): PiAiCompatConfig | undefined {
  const merged = {
    ...(input.provider?.compat ?? {}),
    ...(input.provider?.models?.[input.model]?.compat ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export const DEFAULT_SILVER_CONFIG: SilverConfig = {
  defaults: {
    provider: "deepseek-official",
    model: "deepseek-flash",
    effort: "default",
    presentation: "both",
  },
  providers: {
    "deepseek-official": {
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      apiKeyRef: "env:DEEPSEEK_API_KEY",
      reasoningEfforts: { ...DEEPSEEK_REASONING_EFFORTS },
      models: {
        // Omit capacity so official dsh-llm-deepseek catalog (1M context) applies.
        // Declare contextWindow / maxTokens independently only when overriding.
        "deepseek-flash": {},
      },
    },
    grok: { baseUrl: "https://api.x.ai/v1", apiKeyRef: "env:XAI_API_KEY" },
  },
  agents: {
    "ctf-solver": { model: "deepseek-flash" },
    skeptic: { model: "deepseek-flash" },
    verifier: { model: "deepseek-flash" },
  },
  challenges: {},
  workers: {},
  attemptPolicies: {
    "single-fast": { attempts: [{ presentation: "native" }] },
    "cheap-swarm": {
      attempts: [
        { presentation: "native" },
        { presentation: "code" },
        { presentation: "native" },
      ],
    },
    /** Three independent Groups under one Project clock and intel board. Host starts all roots. */
    "groups-3": {
      attempts: [{ presentation: "native" }, { presentation: "native" }, { presentation: "native" }],
    },
    /**
     * Same Group fan-out as groups-3. Override each slice's provider/model in repo YAML
     * when you want heterogeneous models. Defaults inherit the solver agent model.
     */
    "heterogeneous-3": {
      attempts: [{ presentation: "native" }, { presentation: "native" }, { presentation: "native" }],
    },
    /**
     * Host-started independent roots with Silver Room Feed/Status.
     * Slice count is overridden by swarm.initialMembers. Not official Team spawn.
     */
    swarm: {
      attempts: [{ presentation: "native" }, { presentation: "native" }, { presentation: "native" }],
    },
  },
  competition: {
    track: "jeopardy",
    flagPattern: OPEN_FLAG_PATTERN,
    inScope: [],
    autonomy: "autonomous",
    hintPolicy: "open",
    maxConcurrentRooms: 3,
  },
  room: { mode: "swarm", swarmCount: 2 },
  race: { workers: 3, models: [] },
  live: {
    timeoutMs: 5_400_000,
    maxTurns: 0,
  },
  skills: {
    roots: [],
    catalogDescriptionMaxLength: 500,
  },
  swarm: {
    initialWorkers: 0,
    maxWorkers: 6,
    modelPolicy: "homogeneous",
    chat: { enabled: true, delivery: "index-only" },
    workerRoles: [],
  },
  nativeAssistants: {
    enabled: true,
    maxPerMember: 3,
    maxDepth: 1,
  },
  runtime: {
    maxModelLoops: 16,
    externalSearch: true,
    executionProfile: "host",
  },
};

export function isSwarmProfile(profile?: string): boolean {
  return profile === "swarm";
}

const SECRET_KEYS = new Set(["apikey", "token", "password", "secret", "authorization"]);

export function loadSilverConfig(filePath?: string): SilverConfig {
  if (!filePath) return structuredClone(DEFAULT_SILVER_CONFIG);
  const text = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  const config = parseSilverConfig(text, ext === ".json" ? "json" : "yaml");
  config.skills.roots = config.skills.roots.map((root) =>
    path.isAbsolute(root) ? root : path.resolve(path.dirname(filePath), root),
  );
  return config;
}

export function parseSilverConfig(text: string, format: "json" | "yaml" = "yaml"): SilverConfig {
  rejectRawSecrets(text);
  const raw = format === "json" || text.trim().startsWith("{") ? JSON.parse(text) : parseYamlLite(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("silver config must be a map");
  const rec = raw as Record<string, unknown>;
  rejectSecretKeys(rec);
  const config = mergeConfig(rec);
  assertKeyRefs(config);
  return config;
}

/**
 * Priority:
 *   attempt override
 *   > attempt policy slice
 *   > worker override
 *   > challenge override
 *   > agent preset
 *   > global default
 *
 * Result is `{provider, model, ...}` for the single `ctx.llm.stream` seam.
 */
export function resolveModelCall(input: {
  config?: SilverConfig;
  agent: AgentName;
  profile?: string;
  attemptIndex?: number;
  challengeId?: string;
  workerId?: string;
  override?: ModelSlice;
}): ResolvedModelCall {
  const config = input.config ?? DEFAULT_SILVER_CONFIG;
  const profileName = input.override?.profile ?? input.profile;
  if (profileName && !config.attemptPolicies[profileName]) {
    throw new Error(`unknown attempt profile ${profileName}`);
  }
  const policy = profileName ? config.attemptPolicies[profileName] : undefined;
  const attemptSlice =
    policy && input.attemptIndex !== undefined ? policy.attempts[input.attemptIndex] : undefined;
  const merged: ModelSlice = {
    ...config.defaults,
    ...config.agents[input.agent],
    ...(input.challengeId ? config.challenges[input.challengeId] : undefined),
    ...(input.workerId ? config.workers[input.workerId] : undefined),
    ...attemptSlice,
    ...input.override,
  };
  const provider = merged.provider ?? config.defaults.provider;
  const fromProvider = config.providers[provider] ?? {};
  const resolved: ResolvedModelCall = {
    provider,
    model: merged.model ?? config.defaults.model,
    effort: merged.effort ?? config.defaults.effort,
    presentation: merged.presentation ?? config.defaults.presentation,
    agent: input.agent,
    llmPlugin: merged.llmPlugin ?? fromProvider.llmPlugin ?? "llm-deepseek",
    auth: merged.auth ?? fromProvider.auth ?? "api-key",
  };
  const baseUrl = merged.baseUrl ?? fromProvider.baseUrl;
  const apiKeyRef = merged.apiKeyRef ?? fromProvider.apiKeyRef;
  const api = merged.api ?? fromProvider.api;
  if (baseUrl) resolved.baseUrl = baseUrl;
  if (apiKeyRef) resolved.apiKeyRef = apiKeyRef;
  if (api) resolved.api = api;
  const reasoningEfforts = resolveReasoningEfforts({
    ...(merged.reasoningEfforts !== undefined ? { slice: merged.reasoningEfforts } : {}),
    provider: fromProvider,
    model: resolved.model,
  });
  if (reasoningEfforts !== undefined) resolved.reasoningEfforts = reasoningEfforts;
  const compat = resolvePiAiCompat({ provider: fromProvider, model: resolved.model });
  if (compat !== undefined) resolved.compat = compat;
  if (fromProvider.cacheRetention !== undefined) resolved.cacheRetention = fromProvider.cacheRetention;
  const modelConfig = fromProvider.models?.[resolved.model];
  if (modelConfig?.contextWindow !== undefined) resolved.contextWindow = modelConfig.contextWindow;
  if (modelConfig?.maxTokens !== undefined) resolved.maxTokens = modelConfig.maxTokens;
  if (profileName) resolved.profile = profileName;
  if (merged.seed) resolved.seed = merged.seed;
  return resolved;
}

export function resolveAttemptPlan(input: {
  config?: SilverConfig;
  profile: string;
  agent?: AgentName;
  challengeId?: string;
  workerId?: string;
}): ResolvedModelCall[] {
  const config = input.config ?? DEFAULT_SILVER_CONFIG;
  const policy = config.attemptPolicies[input.profile];
  if (!policy) throw new Error(`unknown attempt profile ${input.profile}`);
  const declared = policy.attempts;
  const count = isSwarmProfile(input.profile)
    ? (config.legacySwarm?.initialMembers ?? declared.length)
    : declared.length;
  if (count < 1) throw new Error(`attempt profile ${input.profile} has no live slices`);
  const plan = Array.from({ length: count }, (_, attemptIndex) => {
    const slice = declared[attemptIndex] ?? declared[0] ?? { presentation: "native" as const };
    return resolveModelCall({
      config,
      agent: input.agent ?? "ctf-solver",
      profile: input.profile,
      attemptIndex: Math.min(attemptIndex, Math.max(0, declared.length - 1)),
      ...(input.challengeId ? { challengeId: input.challengeId } : {}),
      ...(input.workerId ? { workerId: input.workerId } : {}),
      override: slice,
    });
  });
  if (isSwarmProfile(input.profile)) assertSwarmMemberPlan(config.swarm, config.legacySwarm, plan);
  return plan;
}

function assertSwarmMemberPlan(swarm: SwarmConfig, legacy: LegacySwarmConfig | undefined, plan: ResolvedModelCall[]): void {
  if (swarm.modelPolicy === "heterogeneous") {
    throw new Error("swarm.modelPolicy=heterogeneous is not available; fail closed");
  }
  const keys = plan.map((row) => `${row.provider}/${row.model}`);
  if (swarm.modelPolicy === "homogeneous" && keys.some((key) => key !== keys[0])) {
    throw new Error("swarm.modelPolicy=homogeneous requires every Host-started member to use the same provider/model");
  }
  const allowed = legacy?.allowedModels ?? [];
  if (allowed.length === 0) return;
  for (const row of plan) {
    if (!allowed.includes(row.model)) {
      throw new Error(`swarm member model ${row.model} is not in allowedModels`);
    }
  }
}

export function adapterInstanceKey(resolved: Pick<ResolvedModelCall, "provider" | "baseUrl" | "apiKeyRef">): string {
  return `${resolved.provider}\0${resolved.baseUrl ?? ""}\0${resolved.apiKeyRef ?? ""}`;
}

export function llmCallFromResolved(resolved: ResolvedModelCall): {
  provider: string;
  model: string;
  effort: string;
  instanceKey: string;
} {
  return {
    provider: resolved.provider,
    model: resolved.model,
    effort: resolved.effort,
    instanceKey: adapterInstanceKey(resolved),
  };
}

/**
 * Runtime secret resolver. Config files may persist references, not raw keys:
 * env:NAME or keychain:NAME. keychain first checks the legacy test/dev env
 * fallback (`SILVER_KEYCHAIN_NAME`), then macOS Keychain service `Silver`.
 */
export function resolveApiKey(ref: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("env:")) return env[ref.slice(4)];
  if (ref.startsWith("keychain:")) {
    const account = ref.slice("keychain:".length).trim();
    if (!account) return undefined;
    const fallback = env[`SILVER_KEYCHAIN_${account.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`];
    if (fallback) return fallback;
    if (env !== process.env) return undefined;
    return readMacosKeychainSecret(account);
  }
  throw new Error("apiKeyRef must be env:NAME or keychain:NAME");
}

function readMacosKeychainSecret(account: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const result = spawnSync("security", ["find-generic-password", "-w", "-s", "Silver", "-a", account], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
}

export function resolveLiveBudget(
  config: SilverConfig,
  override: { timeoutMs?: number; maxTurns?: number } = {},
): LiveBudget {
  return {
    timeoutMs: override.timeoutMs && override.timeoutMs > 0 ? Math.floor(override.timeoutMs) : config.live.timeoutMs,
    maxTurns:
      override.maxTurns === 0
        ? 0
        : override.maxTurns && override.maxTurns > 0
          ? Math.floor(override.maxTurns)
          : config.live.maxTurns,
  };
}

/** True when a positive turn cap exists and the chat-turn index has reached it. */
export function liveTurnCapReached(budget: Pick<LiveBudget, "maxTurns">, index: number): boolean {
  return budget.maxTurns > 0 && index >= budget.maxTurns;
}

export function requireLiveApiKey(resolved: ResolvedModelCall, env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = resolveApiKey(resolved.apiKeyRef, env);
  if (!apiKey) {
    const ref = resolved.apiKeyRef?.trim() || "apiKeyRef";
    throw new Error(`live run requires apiKeyRef secret (${ref})`);
  }
  return apiKey;
}

function mergeConfig(raw: Record<string, unknown>): SilverConfig {
  const defaultsRaw = asMap(raw.defaults) ?? {};
  const defaults = {
    provider: String(defaultsRaw.provider ?? DEFAULT_SILVER_CONFIG.defaults.provider),
    model: String(defaultsRaw.model ?? DEFAULT_SILVER_CONFIG.defaults.model),
    effort: String(defaultsRaw.effort ?? DEFAULT_SILVER_CONFIG.defaults.effort),
    presentation: asPresentation(defaultsRaw.presentation) ?? DEFAULT_SILVER_CONFIG.defaults.presentation,
  };
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, value] of Object.entries(DEFAULT_SILVER_CONFIG.providers)) {
    providers[name] = { ...value };
  }
  for (const [name, value] of Object.entries(asMap(raw.providers) ?? {})) {
    const rec = asMap(value) ?? {};
    const entry: ProviderConfig = { ...(providers[name] ?? {}) };
    if (typeof rec.baseUrl === "string") entry.baseUrl = rec.baseUrl;
    if (typeof rec.apiKeyRef === "string") entry.apiKeyRef = rec.apiKeyRef;
    const llmPlugin = asLlmPlugin(rec.llmPlugin);
    if (llmPlugin) entry.llmPlugin = llmPlugin;
    if (typeof rec.api === "string") entry.api = rec.api;
    const auth = asLlmAuth(rec.auth);
    if (auth) entry.auth = auth;
    if (rec.reasoningEfforts !== undefined) entry.reasoningEfforts = asReasoningEfforts(rec.reasoningEfforts);
    if (rec.compat !== undefined) entry.compat = asPiAiCompat(rec.compat);
    if (rec.cacheRetention !== undefined) entry.cacheRetention = asPiAiCacheRetention(rec.cacheRetention);
    if (rec.models !== undefined) entry.models = asProviderModels(rec.models, entry.models);
    providers[name] = entry;
  }
  const agents: SilverConfig["agents"] = {};
  for (const [name, value] of Object.entries(DEFAULT_SILVER_CONFIG.agents)) {
    agents[name as AgentName] = { ...value };
  }
  for (const [name, value] of Object.entries(asMap(raw.agents) ?? {})) {
    agents[name as AgentName] = { ...(agents[name as AgentName] ?? {}), ...asSlice(value) };
  }
  const challenges: Record<string, ModelSlice> = {};
  for (const [name, value] of Object.entries(asMap(raw.challenges) ?? {})) {
    challenges[name] = asSlice(value);
  }
  const workers: Record<string, ModelSlice> = {};
  for (const [name, value] of Object.entries(asMap(raw.workers) ?? {})) {
    workers[name] = asSlice(value);
  }
  const attemptPolicies: SilverConfig["attemptPolicies"] = {};
  for (const [name, value] of Object.entries(DEFAULT_SILVER_CONFIG.attemptPolicies)) {
    attemptPolicies[name] = { attempts: value.attempts.map((row) => ({ ...row })) };
  }
  for (const [name, value] of Object.entries(asMap(raw.attemptPolicies) ?? {})) {
    const rec = asMap(value) ?? {};
    const attempts = Array.isArray(rec.attempts) ? rec.attempts.map(asSlice) : [];
    attemptPolicies[name] = { attempts };
  }
  const competitionRaw = asMap(raw.competition) ?? {};
  const trackRaw = String(competitionRaw.track ?? DEFAULT_SILVER_CONFIG.competition.track);
  const track: TrackKind =
    trackRaw === "awd" ||
    trackRaw === "agent-awd" ||
    trackRaw === "jeopardy" ||
    trackRaw === "pentest" ||
    trackRaw === "koh" ||
    trackRaw === "vuln"
      ? trackRaw
      : "jeopardy";
  if (trackRaw !== track) throw new Error(`unknown competition track ${trackRaw}`);
  const inScopeRaw = competitionRaw.inScope;
  const inScope = Array.isArray(inScopeRaw)
    ? inScopeRaw.map((row) => String(row).trim()).filter(Boolean)
    : [];
  const autonomyRaw = competitionRaw.autonomy;
  if (autonomyRaw !== undefined && autonomyRaw !== "autonomous" && autonomyRaw !== "human_assisted") {
    throw new Error(`unknown competition autonomy ${String(autonomyRaw)}`);
  }
  const hintRaw = competitionRaw.hintPolicy;
  if (hintRaw !== undefined && !isHintPolicy(String(hintRaw))) {
    throw new Error(`unknown competition hintPolicy ${String(hintRaw)}`);
  }
  const competition: CompetitionConfig = {
    track,
    flagPattern: String(competitionRaw.flagPattern ?? DEFAULT_SILVER_CONFIG.competition.flagPattern),
    inScope,
    autonomy:
      autonomyRaw === "autonomous" || autonomyRaw === "human_assisted"
        ? autonomyRaw
        : defaultAutonomy(track),
    hintPolicy: isHintPolicy(String(hintRaw ?? "")) ? String(hintRaw) as HintPolicy : DEFAULT_SILVER_CONFIG.competition.hintPolicy,
    maxConcurrentRooms: boundedCount(
      competitionRaw.maxConcurrentRooms,
      DEFAULT_SILVER_CONFIG.competition.maxConcurrentRooms,
      "competition.maxConcurrentRooms",
    ),
  };
  const liveRaw = asMap(raw.live) ?? {};
  const timeoutMs = parseLiveTimeout(liveRaw.timeoutMs, DEFAULT_SILVER_CONFIG.live.timeoutMs);
  const maxTurns = asNonNegativeInt(liveRaw.maxTurns, DEFAULT_SILVER_CONFIG.live.maxTurns);
  const live: LiveBudget = { timeoutMs, maxTurns };
  const skillsRaw = asMap(raw.skills) ?? {};
  const skills: SkillConfig = {
    roots: asStringList(skillsRaw.roots ?? skillsRaw.root, DEFAULT_SILVER_CONFIG.skills.roots, "skills.roots"),
    catalogDescriptionMaxLength: asPositiveInt(
      skillsRaw.catalogDescriptionMaxLength,
      DEFAULT_SILVER_CONFIG.skills.catalogDescriptionMaxLength,
    ),
  };
  const room = parseRoomConfig(asMap(raw.room));
  const race = parseRaceConfig(asMap(raw.race));
  const swarmRaw = asMap(raw.swarm);
  const parsedSwarm = parseSwarmConfig(swarmRaw);
  const workerCap = track === "jeopardy" ? 6 : 10;
  if (swarmRaw?.maxWorkers === undefined && !parsedSwarm.legacy) {
    parsedSwarm.swarm.maxWorkers = workerCap;
  }
  if (parsedSwarm.swarm.maxWorkers > workerCap) {
    throw new Error(`swarm.maxWorkers must be <= ${workerCap} for competition.track ${track}`);
  }
  const nativeAssistants = parseNativeAssistants(asMap(raw.nativeAssistants));
  const runtime = parseRuntimeLoops(asMap(raw.runtime));
  return {
    defaults,
    providers,
    agents,
    challenges,
    workers,
    attemptPolicies,
    competition,
    room,
    race,
    live,
    skills,
    swarm: parsedSwarm.swarm,
    ...(parsedSwarm.legacy ? { legacySwarm: parsedSwarm.legacy } : {}),
    nativeAssistants,
    runtime,
  };
}

function parseRoomConfig(raw: Record<string, unknown> | undefined): RoomConfig {
  const modeRaw = raw?.mode;
  const mode = modeRaw ?? DEFAULT_SILVER_CONFIG.room.mode;
  if (mode !== "solo" && mode !== "race" && mode !== "swarm" && mode !== "three-graph") {
    throw new Error("room.mode must be solo, race, swarm, or three-graph");
  }
  const swarmCountRaw = raw?.swarmCount ?? DEFAULT_SILVER_CONFIG.room.swarmCount;
  if (swarmCountRaw !== 1 && swarmCountRaw !== 2) {
    throw new Error("room.swarmCount must be 1 or 2");
  }
  return { mode, swarmCount: swarmCountRaw };
}

function parseRaceConfig(raw: Record<string, unknown> | undefined): RaceConfig {
  const base = DEFAULT_SILVER_CONFIG.race;
  if (!raw) return { workers: base.workers, models: [...base.models] };
  const workers = boundedCount(raw.workers, base.workers, "race.workers");
  return { workers, models: parseModelList(raw.models, "race.models") };
}

function parseNativeAssistants(raw: Record<string, unknown> | undefined): NativeAssistantsConfig {
  const base = DEFAULT_SILVER_CONFIG.nativeAssistants;
  if (!raw) return { ...base };
  return {
    enabled: raw.enabled === undefined ? base.enabled : raw.enabled === true,
    maxPerMember: boundedCount(raw.maxPerMember, base.maxPerMember, "nativeAssistants.maxPerMember"),
    maxDepth: boundedCount(raw.maxDepth, base.maxDepth, "nativeAssistants.maxDepth"),
  };
}

function parseRuntimeLoops(raw: Record<string, unknown> | undefined): RuntimeLoopConfig {
  const base = DEFAULT_SILVER_CONFIG.runtime;
  if (!raw) return { ...base };
  if (raw.ctfLinux !== undefined) throw new Error("runtime.ctfLinux is no longer supported");
  return {
    maxModelLoops: boundedCount(raw.maxModelLoops, base.maxModelLoops, "runtime.maxModelLoops"),
    externalSearch: parseExternalSearch(raw.externalSearch, base.externalSearch),
    executionProfile: parseExecutionProfile(raw.executionProfile, base.executionProfile),
  };
}

function parseExecutionProfile(value: unknown, fallback: ExecutionProfile): ExecutionProfile {
  if (value === undefined) return fallback;
  if (value === "host") return value;
  throw new Error("runtime.executionProfile must be host");
}

function parseExternalSearch(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error("runtime.externalSearch must be a boolean");
}

function parseSwarmConfig(raw: Record<string, unknown> | undefined): { swarm: SwarmConfig; legacy?: LegacySwarmConfig } {
  const base = DEFAULT_SILVER_CONFIG.swarm;
  if (!raw) return { swarm: { ...base, chat: { ...base.chat }, workerRoles: [...base.workerRoles] } };
  const legacy = parseLegacySwarm(raw);
  const chatRaw = asMap(raw.chat);
  const modelPolicy = parseSwarmModelPolicy(raw.modelPolicy, base.modelPolicy);
  const maxWorkers = raw.maxWorkers !== undefined
    ? boundedCount(raw.maxWorkers, base.maxWorkers, "swarm.maxWorkers", true)
    : legacy
      ? Math.max(0, legacy.maxMembers - 1)
      : base.maxWorkers;
  const initialWorkers = raw.initialWorkers !== undefined
    ? boundedCount(raw.initialWorkers, base.initialWorkers, "swarm.initialWorkers", true)
    : Math.min(base.initialWorkers, maxWorkers);
  if (initialWorkers > maxWorkers) throw new Error("swarm.initialWorkers must be <= swarm.maxWorkers");
  const delivery = chatRaw && isRoomFeedDelivery(chatRaw.delivery)
    ? chatRaw.delivery
    : legacy?.feedDelivery ?? base.chat.delivery;
  if (chatRaw?.delivery !== undefined && !isRoomFeedDelivery(chatRaw.delivery)) {
    throw new Error("swarm.chat.delivery must be index-only, recent-delta, or pull-only");
  }
  return {
    swarm: {
      initialWorkers,
      maxWorkers,
      modelPolicy,
      chat: {
        enabled: chatRaw?.enabled === undefined ? base.chat.enabled : chatRaw.enabled === true,
        delivery,
      },
      workerRoles: asStringList(raw.workerRoles, base.workerRoles, "swarm.workerRoles"),
    },
    ...(legacy ? { legacy } : {}),
  };
}

function parseLiveTimeout(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (value === "unlimited" || value === 0) return 0;
  return asPositiveInt(value, fallback);
}

function parseLegacySwarm(raw: Record<string, unknown>): LegacySwarmConfig | undefined {
  const hasOld =
    raw.initialMembers !== undefined ||
    raw.maxMembers !== undefined ||
    raw.allowedModels !== undefined ||
    raw.feedDelivery !== undefined;
  if (!hasOld) return undefined;
  const initialMembers = asPositiveInt(raw.initialMembers, 3);
  const maxMembers = asPositiveInt(raw.maxMembers, 3);
  if (initialMembers > 32 || maxMembers > 32) throw new Error("swarm member counts must be 1..32");
  if (maxMembers < initialMembers) throw new Error("swarm.maxMembers must be >= initialMembers");
  if (raw.feedDelivery !== undefined && !isRoomFeedDelivery(raw.feedDelivery)) {
    throw new Error("swarm.feedDelivery must be index-only, recent-delta, or pull-only");
  }
  return {
    initialMembers,
    maxMembers,
    allowedModels: parseModelList(raw.allowedModels, "swarm.allowedModels"),
    feedDelivery: isRoomFeedDelivery(raw.feedDelivery) ? raw.feedDelivery : "index-only",
  };
}

function parseSwarmModelPolicy(value: unknown, fallback: SwarmModelPolicy): SwarmModelPolicy {
  if (value === undefined) return fallback;
  if (value === "homogeneous" || value === "heterogeneous") return value;
  throw new Error("swarm.modelPolicy must be homogeneous or heterogeneous");
}

function parseModelList(value: unknown, label: string): string[] {
  if (value === undefined || value === null || value === "" || value === "[]") return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a string list`);
  return value.map((row) => {
    if (typeof row !== "string" || !row.trim()) throw new Error(`${label} entries must be non-empty strings`);
    return row.trim();
  });
}

function boundedCount(value: unknown, fallback: number, label: string, allowZero = false): number {
  if (value === undefined) return fallback;
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n > 32 || (allowZero ? n < 0 : n < 1)) {
    throw new Error(`${label} must be an integer from ${allowZero ? 0 : 1} to 32`);
  }
  return n;
}

function asStringList(value: unknown, fallback: string[], label: string): string[] {
  if (value === undefined) return [...fallback];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be a string or string list`);
  return value.map((row) => {
    if (typeof row !== "string" || !row.trim()) throw new Error(`${label} entries must be non-empty strings`);
    return row.trim();
  });
}

function asPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function asSlice(value: unknown): ModelSlice {
  const rec = asMap(value) ?? {};
  const slice: ModelSlice = {};
  if (typeof rec.provider === "string") slice.provider = rec.provider;
  if (typeof rec.model === "string") slice.model = rec.model;
  if (typeof rec.effort === "string") slice.effort = rec.effort;
  const presentation = asPresentation(rec.presentation);
  if (presentation) slice.presentation = presentation;
  if (typeof rec.baseUrl === "string") slice.baseUrl = rec.baseUrl;
  if (typeof rec.apiKeyRef === "string") slice.apiKeyRef = rec.apiKeyRef;
  const llmPlugin = asLlmPlugin(rec.llmPlugin);
  if (llmPlugin) slice.llmPlugin = llmPlugin;
  if (typeof rec.api === "string") slice.api = rec.api;
  const auth = asLlmAuth(rec.auth);
  if (auth) slice.auth = auth;
  if (rec.reasoningEfforts !== undefined) slice.reasoningEfforts = asReasoningEfforts(rec.reasoningEfforts);
  if (typeof rec.profile === "string") slice.profile = rec.profile;
  if (typeof rec.seed === "string") slice.seed = rec.seed;
  if (typeof rec.role === "string" && isAwdRole(rec.role)) slice.role = rec.role;
  return slice;
}

function asPresentation(value: unknown): Presentation | undefined {
  if (value === "native" || value === "code" || value === "both") return value;
  return undefined;
}

function asLlmPlugin(value: unknown): LlmPlugin | undefined {
  if (value === undefined) return undefined;
  if (value === "llm-deepseek" || value === "llm-pi-ai") return value;
  throw new Error(`unknown llmPlugin ${String(value)}; use llm-deepseek or llm-pi-ai`);
}

function asLlmAuth(value: unknown): LlmAuthMode | undefined {
  if (value === undefined) return undefined;
  if (value === "api-key" || value === "subscription") return value;
  throw new Error(`unknown auth ${String(value)}; use api-key or subscription`);
}

function asPiAiCacheRetention(value: unknown): PiAiCacheRetention {
  if ((PI_AI_CACHE_RETENTIONS as readonly unknown[]).includes(value)) return value as PiAiCacheRetention;
  throw new Error(`unknown cacheRetention ${String(value)}; use none|short|long`);
}

function asPiAiCompat(value: unknown): PiAiCompatConfig {
  const rec = asMap(value);
  if (!rec) throw new Error("compat must be a map");
  const compat: PiAiCompatConfig = {};
  for (const [key, raw] of Object.entries(rec)) {
    if (!(PI_AI_BOOLEAN_COMPAT_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`unknown compat key ${key}; supported boolean compat fields only`);
    }
    if (typeof raw !== "boolean") throw new Error(`compat.${key} must be a boolean`);
    compat[key as PiAiBooleanCompatField] = raw;
  }
  return compat;
}

function asReasoningEfforts(value: unknown): ReasoningEffortsConfig {
  if (value === false) return false;
  if (value === true) throw new Error("reasoningEfforts must be false or an effort map");
  const rec = asMap(value);
  if (!rec) throw new Error("reasoningEfforts must be false or an effort map");
  const map: ReasoningEffortMap = {};
  for (const [key, raw] of Object.entries(rec)) {
    if (!(REASONING_EFFORT_NAMES as readonly string[]).includes(key)) {
      throw new Error(`unknown reasoningEfforts key ${key}; use off|low|high|max`);
    }
    const name = key as ReasoningEffortName;
    if (name === "off") {
      map.off = asOffReasoningValue(raw);
      continue;
    }
    if (typeof raw !== "string" || !raw.trim() || raw === "null") {
      throw new Error(`reasoningEfforts.${key} must be a non-empty string`);
    }
    map[name] = raw;
  }
  return map;
}

function asOffReasoningValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length === 0) return null;
  if (typeof raw === "string") {
    if (!raw.trim() || raw === "null") return null;
    return raw;
  }
  throw new Error("reasoningEfforts.off must be null or a string");
}

function asProviderModels(
  value: unknown,
  existing: Record<string, ProviderModelConfig> | undefined,
): Record<string, ProviderModelConfig> {
  const rec = asMap(value);
  if (!rec) throw new Error("providers.*.models must be a map");
  const models: Record<string, ProviderModelConfig> = { ...(existing ?? {}) };
  for (const [id, row] of Object.entries(rec)) {
    const inner = asMap(row) ?? {};
    const next: ProviderModelConfig = { ...(models[id] ?? {}) };
    if (inner.reasoningEfforts !== undefined) next.reasoningEfforts = asReasoningEfforts(inner.reasoningEfforts);
    if (inner.compat !== undefined) next.compat = asPiAiCompat(inner.compat);
    if (inner.contextWindow !== undefined) {
      next.contextWindow = asRequiredPositiveInt(inner.contextWindow, `providers.*.models.${id}.contextWindow`);
    }
    if (inner.maxTokens !== undefined) {
      next.maxTokens = asRequiredPositiveInt(inner.maxTokens, `providers.*.models.${id}.maxTokens`);
    }
    models[id] = next;
  }
  return models;
}

function asRequiredPositiveInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${field} must be a positive integer`);
  return n;
}

function asMap(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function rejectRawSecrets(text: string): void {
  const stripped = text.replace(/apiKeyRef\s*:/gi, "ref:");
  if (/\b(apiKey|token|password|authorization)\s*:/i.test(stripped)) {
    throw new Error("silver config must not contain raw secrets; use apiKeyRef");
  }
}

function rejectSecretKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretKeys(item);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      throw new Error(`silver config must not contain raw secrets; found ${key}`);
    }
    rejectSecretKeys(child);
  }
}

function assertKeyRefs(config: SilverConfig): void {
  const refs: Array<string | undefined> = [
    ...Object.values(config.providers).map((row) => row.apiKeyRef),
    ...Object.values(config.agents).map((row) => row?.apiKeyRef),
    ...Object.values(config.challenges).map((row) => row.apiKeyRef),
    ...Object.values(config.workers).map((row) => row.apiKeyRef),
    ...Object.values(config.attemptPolicies).flatMap((row) => row.attempts.map((slice) => slice.apiKeyRef)),
  ];
  for (const ref of refs) {
    if (!ref) continue;
    if (!ref.startsWith("env:") && !ref.startsWith("keychain:")) {
      throw new Error("apiKeyRef must be env:NAME or keychain:NAME");
    }
  }
}

export function parseYamlLite(text: string): unknown {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const peek = () => lines[i];
  const indentOf = (line: string) => line.match(/^[ ]*/)?.[0].length ?? 0;

  function parseValue(expectedIndent: number): unknown {
    const collected: Array<{ indent: number; raw: string }> = [];
    while (i < lines.length) {
      const raw = peek() ?? "";
      if (!raw.trim() || raw.trim().startsWith("#")) {
        i += 1;
        continue;
      }
      const indent = indentOf(raw);
      if (collected.length && indent < expectedIndent) break;
      if (collected.length === 0 && indent > expectedIndent) expectedIndent = indent;
      if (indent < expectedIndent) break;
      collected.push({ indent, raw });
      i += 1;
    }
    return build(collected, expectedIndent);
  }

  function build(block: Array<{ indent: number; raw: string }>, _base: number): unknown {
    if (block.length === 0) return {};
    const first = block[0]!.raw.trim();
    if (first.startsWith("- ")) {
      const items: unknown[] = [];
      let idx = 0;
      while (idx < block.length) {
        const line = block[idx]!;
        const body = line.raw.trim().slice(2);
        const nested: Array<{ indent: number; raw: string }> = [];
        idx += 1;
        while (idx < block.length && !block[idx]!.raw.trim().startsWith("- ") && block[idx]!.indent > line.indent) {
          nested.push(block[idx]!);
          idx += 1;
        }
        if (!body) {
          items.push(build(nested, line.indent + 2));
        } else if (body.includes(":")) {
          const colon = body.indexOf(":");
          const k = body.slice(0, colon).trim();
          const v = body.slice(colon + 1).trim();
          const obj: Record<string, unknown> = {};
          if (v) obj[k] = coerce(v);
          const child = build(nested, line.indent + 2);
          if (child && typeof child === "object" && !Array.isArray(child)) Object.assign(obj, child);
          items.push(obj);
        } else {
          items.push(coerce(body));
        }
      }
      return items;
    }
    const obj: Record<string, unknown> = {};
    let idx = 0;
    while (idx < block.length) {
      const line = block[idx]!;
      const trimmed = line.raw.trim();
      const colon = trimmed.indexOf(":");
      if (colon < 0) {
        idx += 1;
        continue;
      }
      const key = trimmed.slice(0, colon).trim();
      const rest = trimmed.slice(colon + 1).trim();
      idx += 1;
      const nested: Array<{ indent: number; raw: string }> = [];
      while (idx < block.length && block[idx]!.indent > line.indent) {
        nested.push(block[idx]!);
        idx += 1;
      }
      if (rest) obj[key] = coerce(rest);
      else obj[key] = build(nested, line.indent + 2);
    }
    return obj;
  }

  return parseValue(0);
}

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
