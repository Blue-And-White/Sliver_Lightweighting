import fs from "node:fs";
import path from "node:path";
import type { DshRuntimeFingerprint } from "./dsh-native-tools.ts";

/** First model tool on a live turn must touch the challenge, not load a skill. */
export const FIRST_TURN_TOOLS = ["room_info", "bash", "read", "grep", "glob"] as const;

export type LiveRunEntry = "case" | "mission" | "target";
export type LiveRunOutcome = "solved" | "reported" | "candidate" | "stalled" | "failed";
export type LiveAcceptanceMode = "platform" | "candidate-report";

export interface LiveRunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LiveRunTurn {
  index: number;
  at: string;
  /** Tool names the model requested this turn, in order. Empty = final text. */
  actions: string[];
  /** Assistant text size only. The ledger never stores assistant text content. */
  assistantTextChars?: number;
  assistantTextBytes?: number;
  /** Provider stop signals, for diagnosing no-tool turns and truncation. */
  finishReasons?: string[];
  skillFirst: boolean;
  durationMs: number;
  usage?: LiveRunUsage;
}

export interface LiveRunTerminal {
  status?: string;
  remainingFlags?: number;
  accepted: boolean;
  reported: boolean;
  candidateCount: number;
}

export type LiveRunDiagnostic =
  | "llm_transport"
  | "no_tool"
  | "length_stop"
  | "stale_todo"
  | "host_file_probe"
  | "context_pressure"
  | "compaction_active";

export type LiveRunStopReason =
  | "host_terminal_stop"
  | "timeout"
  | "max_turns"
  | "stagnation_checkpoint"
  | "candidate_checkpoint"
  | "llm_transport_failure"
  | "coordination_failure"
  | "interrupted"
  | "bootstrap_degraded"
  | "defer_unavailable";

export interface LiveRunWireError {
  request: number;
  status: number;
  bodyBytes: number;
  messageCount: number;
  toolCount: number;
  errorType?: string;
  errorMessage?: string;
}

export interface LiveRunWireSummary {
  requests: number;
  failedRequests: number;
  statusCounts: Record<string, number>;
  /** Unique tool names exposed to the model by the upstream request body, in first-seen order. */
  toolNames: string[];
  maxBodyBytes: number;
  lastBodyBytes: number;
  maxMessageCount: number;
  lastMessageCount: number;
  maxToolCount: number;
  maxToolBytes: number;
  maxSystemBytes: number;
  thinkingRequests: number;
  thinkingDisabledRequests: number;
  thinkingUnknownRequests: number;
  compactionRequests: number;
  messageCountDrops: number;
  errors: LiveRunWireError[];
}

export interface LiveDshSessionLogSummary {
  path: string;
  bytes: number;
  jsonlLines?: number;
}

export interface LiveDshSessionPersistenceSummary {
  root: string;
  logCount: number;
  totalBytes: number;
  jsonlLines: number | null;
  logs: LiveDshSessionLogSummary[];
}

export interface LiveDshStorageFileSummary {
  path: string;
  bytes: number;
}

export interface LiveDshStorageSummary {
  root: string;
  fileCount: number;
  totalBytes: number;
  files: LiveDshStorageFileSummary[];
}

export interface LiveRunLedger {
  schema: "silver.live-run-ledger.v1";
  caseId: string;
  entry: LiveRunEntry;
  acceptanceMode: LiveAcceptanceMode;
  startedAt: string;
  endedAt: string;
  wallTimeMs: number;
  dshStatus: number;
  /** Official DSH ACP session id. Use this to join live reports with DSH storage/session probes. */
  dshSessionId?: string;
  /** DSH process restarts that resumed this same ACP session. */
  dshProcessRestarts?: number;
  /** Official ACP session resumes, including recovery by a later Silver process. */
  dshSessionResumes?: number;
  /** Append order from the LLM broker. Not used for first-tool / summary judgment. */
  rawTurns: LiveRunTurn[];
  /** Request-index order. firstTool / tool summary are computed from this. */
  turns: LiveRunTurn[];
  firstTool: string | null;
  skillFirst: boolean;
  toolCalls: number;
  noToolTurns: number;
  maxNoToolStreak: number;
  lengthStops: number;
  assistantTextBytes: number;
  maxAssistantTextBytes: number;
  /** Official DSH slash skill gestures injected in the run prompt. Names only; no prompt text. */
  promptSkillGestures: string[];
  skillCalls: number;
  todoCalls: number;
  lastTodoTurn: number | null;
  turnsSinceTodo: number | null;
  outcome: LiveRunOutcome;
  terminal: LiveRunTerminal;
  stopReason?: LiveRunStopReason;
  /** Official ACP stop signal, e.g. end_turn/cancelled, separate from Silver's host stop reason. */
  acpStopReason?: string;
  usage?: LiveRunUsage;
  wire?: LiveRunWireSummary;
  dshRuntime?: DshRuntimeFingerprint;
  dshSession?: LiveDshSessionPersistenceSummary;
  dshStorage?: LiveDshStorageSummary;
}

export interface LiveRunReplayRow {
  caseId: string;
  outcome: LiveRunOutcome;
  wallTimeMs: number;
  turns: number;
  toolCalls: number;
  noToolTurns: number;
  maxNoToolStreak: number;
  lengthStops: number;
  assistantTextBytes: number;
  maxAssistantTextBytes: number;
  firstTool: string | null;
  promptSkillGestures: string[];
  promptSkillGestureCount: number;
  skillCalls: number;
  todoCalls: number;
  lastTodoTurn: number | null;
  turnsSinceTodo: number | null;
  stopReason?: LiveRunStopReason;
  acpStopReason?: string;
  dshSessionId?: string;
  dshProcessRestarts?: number;
  dshSessionResumes?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  wireRequests?: number;
  wireFailures?: number;
  maxBodyBytes?: number;
  maxMessageCount?: number;
  maxToolCount?: number;
  wireToolNames?: string[];
  thinkingRequests?: number;
  thinkingDisabledRequests?: number;
  thinkingUnknownRequests?: number;
  compactionRequests?: number;
  messageCountDrops?: number;
  dshSessionLogs?: number;
  dshSessionBytes?: number;
  dshSessionJsonlLines?: number | null;
  dshStorageFiles?: number;
  dshStorageBytes?: number;
  dshVersion?: string;
  dshFeaturePlugins?: DshRuntimeFingerprint["featurePlugins"];
  workMemoryState?: string;
  workMemoryNextCheckCount?: number;
  workMemoryEvidenceCount?: number;
  workMemoryHypothesisCount?: number;
  hostFileProbeCount?: number;
  assetCounts?: Record<string, number>;
  explorationCounts?: Record<string, number>;
  findingStatusCounts?: Record<string, number>;
  findingKindCounts?: Record<string, number>;
  memoryAssetNodes?: number;
  memoryExplorationAxes?: number;
  memoryObservations?: number;
  diagnostics?: LiveRunDiagnostic[];
}

export function toolNamesFromSseData(data: string): string[] {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return [];
  try {
    const obj = JSON.parse(trimmed) as {
      type?: unknown;
      content_block?: { type?: unknown; name?: unknown };
      choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { name?: unknown } }> } }>;
    };
    const names: string[] = [];
    if (obj.type === "content_block_start" && obj.content_block?.type === "tool_use") {
      const name = obj.content_block.name;
      if (typeof name === "string" && name) names.push(name);
    }
    for (const choice of obj.choices ?? []) {
      for (const call of choice.delta?.tool_calls ?? []) {
        const name = call.function?.name;
        if (typeof name === "string" && name) names.push(name);
      }
    }
    return names;
  } catch {
    return [];
  }
}

export function usageFromSseData(data: string): LiveRunUsage | undefined {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return undefined;
  try {
    const obj = JSON.parse(trimmed) as {
      usage?: Record<string, unknown>;
      message?: { usage?: Record<string, unknown> };
    };
    const usage = obj.usage ?? obj.message?.usage;
    if (!usage) return undefined;
    const promptTokens = tokenNumber(usage.prompt_tokens) ?? anthropicPromptTokens(usage);
    const completionTokens = tokenNumber(usage.completion_tokens) ?? tokenNumber(usage.output_tokens) ?? 0;
    const explicitTotalTokens = tokenNumber(usage.total_tokens);
    const totalTokens = Math.max(explicitTotalTokens ?? 0, promptTokens + completionTokens);
    if (![promptTokens, completionTokens, totalTokens].every((n) => Number.isFinite(n) && n >= 0)) return undefined;
    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;
    return { promptTokens, completionTokens, totalTokens };
  } catch {
    return undefined;
  }
}

function tokenNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function anthropicPromptTokens(usage: Record<string, unknown>): number {
  return (
    (tokenNumber(usage.input_tokens) ?? 0) +
    (tokenNumber(usage.cache_creation_input_tokens) ?? 0) +
    (tokenNumber(usage.cache_read_input_tokens) ?? 0)
  );
}

/** Keep Anthropic message_start input_tokens when a later message_delta only has output_tokens. */
export function mergeLiveUsage(prev: LiveRunUsage | undefined, next: LiveRunUsage): LiveRunUsage {
  if (!prev) return next;
  const promptTokens = next.promptTokens > 0 ? next.promptTokens : prev.promptTokens;
  const completionTokens = next.completionTokens > 0 ? next.completionTokens : prev.completionTokens;
  const totalTokens = Math.max(next.totalTokens, prev.totalTokens, promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens };
}

export function sumLiveUsage(turns: LiveRunTurn[]): LiveRunUsage | undefined {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let any = false;
  for (const turn of turns) {
    if (!turn.usage) continue;
    any = true;
    promptTokens += turn.usage.promptTokens;
    completionTokens += turn.usage.completionTokens;
    totalTokens += turn.usage.totalTokens;
  }
  if (!any) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

export function appendLiveTurnFile(file: string, turn: LiveRunTurn): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(turn)}\n`);
}

export function readLiveTurns(file: string): LiveRunTurn[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LiveRunTurn);
}

/** Direct subscription routes bypass the Host LLM broker; recover their tool
 * sequence from the existing writer-sanitized CTF session event log. */
export function readCtfSessionToolTurns(file: string): LiveRunTurn[] {
  if (!fs.existsSync(file)) return [];
  const turns: LiveRunTurn[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { ts?: unknown; type?: unknown; payload?: { name?: unknown } };
      if (event.type !== "tool_call" && event.type !== "native_tool_call") continue;
      const name = typeof event.payload?.name === "string" ? event.payload.name.trim() : "";
      if (!name) continue;
      const at = typeof event.ts === "string" && !Number.isNaN(Date.parse(event.ts))
        ? new Date(event.ts).toISOString()
        : new Date(0).toISOString();
      turns.push({
        index: turns.length + 1,
        at,
        actions: [name],
        skillFirst: name === "skill",
        durationMs: 0,
      });
    } catch {
      // A partially written final line must not erase earlier observations.
    }
  }
  return turns;
}

export function readObservedLiveTurns(input: { brokerFile: string; sessionFile?: string }): LiveRunTurn[] {
  const brokerTurns = readLiveTurns(input.brokerFile);
  if (brokerTurns.length > 0 || !input.sessionFile) return brokerTurns;
  return readCtfSessionToolTurns(input.sessionFile);
}

export function readDshProjectedUsage(dshHome: string, sessionId: string): LiveRunUsage | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  const file = path.join(dshHome, "storage", "session_projcache", "sessions", `${sessionId}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      record?: { rows?: { tokenUsage?: { val?: { totals?: Record<string, unknown> } } } };
    };
    const totals = parsed.record?.rows?.tokenUsage?.val?.totals;
    if (!totals) return undefined;
    const promptTokens =
      (tokenNumber(totals.uncachedInputTokens) ?? 0) +
      (tokenNumber(totals.cacheReadTokens) ?? 0) +
      (tokenNumber(totals.cacheWriteTokens) ?? 0);
    const completionTokens = tokenNumber(totals.outputTokens) ?? 0;
    const totalTokens = promptTokens + completionTokens;
    if (totalTokens === 0) return undefined;
    return { promptTokens, completionTokens, totalTokens };
  } catch {
    return undefined;
  }
}

export function summarizeLiveWireFile(file: string): LiveRunWireSummary | undefined {
  if (!fs.existsSync(file)) return undefined;
  const records = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(parseWireRecord)
    .filter((row): row is WireRecord => row !== undefined);
  if (records.length === 0) return undefined;
  const summary: LiveRunWireSummary = {
    requests: 0,
    failedRequests: 0,
    statusCounts: {},
    toolNames: [],
    maxBodyBytes: 0,
    lastBodyBytes: 0,
    maxMessageCount: 0,
    lastMessageCount: 0,
    maxToolCount: 0,
    maxToolBytes: 0,
    maxSystemBytes: 0,
    thinkingRequests: 0,
    thinkingDisabledRequests: 0,
    thinkingUnknownRequests: 0,
    compactionRequests: 0,
    messageCountDrops: 0,
    errors: [],
  };
  let previousMessageCount: number | undefined;
  let request = 0;
  const toolNames = new Set<string>();
  for (const row of records) {
    request += 1;
    summary.requests += 1;
    for (const name of row.toolNames) toolNames.add(name);
    summary.maxBodyBytes = Math.max(summary.maxBodyBytes, row.bodyBytes);
    summary.lastBodyBytes = row.bodyBytes;
    summary.maxMessageCount = Math.max(summary.maxMessageCount, row.messageCount);
    summary.lastMessageCount = row.messageCount;
    summary.maxToolCount = Math.max(summary.maxToolCount, row.toolCount);
    summary.maxToolBytes = Math.max(summary.maxToolBytes, row.tools.reduce((n, tool) => n + tool.descriptionBytes + tool.schemaBytes, 0));
    summary.maxSystemBytes = Math.max(summary.maxSystemBytes, row.systemBytes ?? 0);
    if (row.hasThinking) {
      if (row.thinkingType === "enabled") summary.thinkingRequests += 1;
      else if (row.thinkingType === "disabled") summary.thinkingDisabledRequests += 1;
      else summary.thinkingUnknownRequests += 1;
    }
    if (row.isCompaction) summary.compactionRequests += 1;
    if (previousMessageCount !== undefined && row.messageCount > 0 && previousMessageCount > 0 && row.messageCount < previousMessageCount) {
      summary.messageCountDrops += 1;
    }
    if (row.messageCount > 0) previousMessageCount = row.messageCount;
    const statusKey = row.status === undefined ? "unknown" : String(row.status);
    summary.statusCounts[statusKey] = (summary.statusCounts[statusKey] ?? 0) + 1;
    if (row.status !== undefined && row.status >= 400) {
      summary.failedRequests += 1;
      if (summary.errors.length < 3) {
        const error: LiveRunWireError = {
          request,
          status: row.status,
          bodyBytes: row.bodyBytes,
          messageCount: row.messageCount,
          toolCount: row.toolCount,
        };
        if (row.errorType) error.errorType = row.errorType;
        if (row.errorMessage) error.errorMessage = row.errorMessage;
        summary.errors.push(error);
      }
    }
  }
  summary.toolNames = [...toolNames];
  return summary;
}

export function mergeLiveWireSummaries(
  input: readonly (LiveRunWireSummary | undefined | null)[],
): LiveRunWireSummary | undefined {
  const summaries = input.filter((wire): wire is LiveRunWireSummary => Boolean(wire));
  if (summaries.length === 0) return undefined;
  const statusCounts: Record<string, number> = {};
  const toolNames: string[] = [];
  const seenTools = new Set<string>();
  const errors: LiveRunWireError[] = [];
  for (const wire of summaries) {
    for (const [status, count] of Object.entries(wire.statusCounts)) {
      statusCounts[status] = (statusCounts[status] ?? 0) + count;
    }
    for (const name of wire.toolNames ?? []) {
      if (seenTools.has(name)) continue;
      seenTools.add(name);
      toolNames.push(name);
    }
    errors.push(...(wire.errors ?? []));
  }
  const last = summaries[summaries.length - 1]!;
  return {
    requests: summaries.reduce((sum, wire) => sum + wire.requests, 0),
    failedRequests: summaries.reduce((sum, wire) => sum + wire.failedRequests, 0),
    statusCounts,
    toolNames,
    maxBodyBytes: Math.max(...summaries.map((wire) => wire.maxBodyBytes)),
    lastBodyBytes: last.lastBodyBytes,
    maxMessageCount: Math.max(...summaries.map((wire) => wire.maxMessageCount)),
    lastMessageCount: last.lastMessageCount,
    maxToolCount: Math.max(...summaries.map((wire) => wire.maxToolCount)),
    maxToolBytes: Math.max(...summaries.map((wire) => wire.maxToolBytes)),
    maxSystemBytes: Math.max(...summaries.map((wire) => wire.maxSystemBytes)),
    thinkingRequests: summaries.reduce((sum, wire) => sum + wire.thinkingRequests, 0),
    thinkingDisabledRequests: summaries.reduce((sum, wire) => sum + wire.thinkingDisabledRequests, 0),
    thinkingUnknownRequests: summaries.reduce((sum, wire) => sum + wire.thinkingUnknownRequests, 0),
    compactionRequests: summaries.reduce((sum, wire) => sum + wire.compactionRequests, 0),
    messageCountDrops: summaries.reduce((sum, wire) => sum + wire.messageCountDrops, 0),
    errors,
  };
}

const DSH_SESSION_LOG_SUMMARY_LIMIT = 16;
const DSH_STORAGE_SUMMARY_LIMIT = 24;

export function summarizeDshSessionPersistence(dshHome: string): LiveDshSessionPersistenceSummary | undefined {
  const root = path.join(path.resolve(dshHome), "sessions");
  if (!isDirectory(root)) return undefined;
  const logs: LiveDshSessionLogSummary[] = [];
  let logCount = 0;
  let totalBytes = 0;
  let knownJsonlLines = 0;
  let hasUnknownLines = false;
  for (const file of findDshSessionLogs(root)) {
    const st = safeLstat(file);
    if (!st?.isFile() || st.isSymbolicLink()) continue;
    const bytes = st.size;
    const lineCount = path.basename(file).endsWith(".jsonl") ? countNewlines(file) : undefined;
    logCount += 1;
    totalBytes += bytes;
    if (lineCount === undefined) hasUnknownLines = true;
    else knownJsonlLines += lineCount;
    if (logs.length < DSH_SESSION_LOG_SUMMARY_LIMIT) {
      logs.push({
        path: path.relative(root, file),
        bytes,
        ...(lineCount === undefined ? {} : { jsonlLines: lineCount }),
      });
    }
  }
  if (logCount === 0) return undefined;
  return {
    root,
    logCount,
    totalBytes,
    jsonlLines: hasUnknownLines ? null : knownJsonlLines,
    logs,
  };
}

export function summarizeDshStorage(dshHome: string): LiveDshStorageSummary | undefined {
  const root = path.join(path.resolve(dshHome), "storage");
  if (!isDirectory(root)) return undefined;
  const files: LiveDshStorageFileSummary[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  for (const file of findRegularFiles(root)) {
    const st = safeLstat(file);
    if (!st?.isFile() || st.isSymbolicLink()) continue;
    fileCount += 1;
    totalBytes += st.size;
    if (files.length < DSH_STORAGE_SUMMARY_LIMIT) {
      files.push({ path: path.relative(root, file), bytes: st.size });
    }
  }
  if (fileCount === 0) return undefined;
  return { root, fileCount, totalBytes, files };
}

function findDshSessionLogs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const name of entries) {
      const full = path.join(dir, name);
      const st = safeLstat(full);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && isDshSessionLogName(name)) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

function findRegularFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const name of entries) {
      const full = path.join(dir, name);
      const st = safeLstat(full);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(full);
    }
  }
  out.sort();
  return out;
}

function isDshSessionLogName(name: string): boolean {
  return /^session(?:\.v\d+)?\.jsonl(?:\.zst|\.zstd)?$/.test(name);
}

function countNewlines(file: string): number | undefined {
  try {
    const buf = fs.readFileSync(file);
    let count = 0;
    for (const byte of buf) {
      if (byte === 10) count += 1;
    }
    return count;
  } catch {
    return undefined;
  }
}

function isDirectory(file: string): boolean {
  const st = safeLstat(file);
  return Boolean(st?.isDirectory()) && !st!.isSymbolicLink();
}

function safeLstat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}

interface WireRecord {
  bodyBytes: number;
  messageCount: number;
  toolCount: number;
  toolNames: string[];
  tools: Array<{ name?: string; descriptionBytes: number; schemaBytes: number }>;
  hasThinking: boolean;
  thinkingType?: string;
  status?: number;
  systemBytes?: number;
  errorType?: string;
  errorMessage?: string;
  isCompaction?: boolean;
}

function parseWireRecord(line: string): WireRecord | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const bodyBytes = finiteNumber(parsed.bodyBytes);
    const messageCount = finiteNumber(parsed.messageCount);
    const toolCount = finiteNumber(parsed.toolCount);
    if (bodyBytes === undefined || messageCount === undefined || toolCount === undefined) return undefined;
    const tools = parseWireToolStats(parsed.tools);
    const toolNames = parseWireToolNames(parsed.toolNames);
    for (const tool of tools) {
      if (tool.name) toolNames.push(tool.name);
    }
    const record: WireRecord = {
      bodyBytes,
      messageCount,
      toolCount,
      toolNames: [...new Set(toolNames)],
      tools,
      hasThinking: parsed.hasThinking === true,
      isCompaction: parsed.isCompaction === true,
    };
    if (typeof parsed.thinkingType === "string") record.thinkingType = parsed.thinkingType;
    const status = finiteNumber(parsed.status);
    if (status !== undefined) record.status = status;
    const systemBytes = finiteNumber(parsed.systemBytes);
    if (systemBytes !== undefined) record.systemBytes = systemBytes;
    if (typeof parsed.errorType === "string") record.errorType = parsed.errorType;
    if (typeof parsed.errorMessage === "string") record.errorMessage = parsed.errorMessage;
    return record;
  } catch {
    return undefined;
  }
}

function parseWireToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const row of value) {
    if (typeof row === "string" && row) seen.add(row);
  }
  return [...seen];
}

function parseWireToolStats(value: unknown): WireRecord["tools"] {
  if (!Array.isArray(value)) return [];
  const out: WireRecord["tools"] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { name?: unknown; descriptionBytes?: unknown; schemaBytes?: unknown };
    const name = typeof rec.name === "string" ? rec.name : undefined;
    out.push({
      ...(name ? { name } : {}),
      descriptionBytes: finiteNumber(rec.descriptionBytes) ?? 0,
      schemaBytes: finiteNumber(rec.schemaBytes) ?? 0,
    });
  }
  return out;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Judgment order: request index, then original append position for ties. */
export function sortTurnsByIndex(turns: LiveRunTurn[]): LiveRunTurn[] {
  return turns
    .map((turn, appended) => ({ turn, appended }))
    .sort((left, right) => left.turn.index - right.turn.index || left.appended - right.appended)
    .map((row) => row.turn);
}

export function firstTurnTool(turns: LiveRunTurn[]): string | null {
  for (const turn of sortTurnsByIndex(turns)) {
    const tool = turn.actions[0];
    if (tool) return tool;
  }
  return null;
}

export function countNamedCalls(turns: LiveRunTurn[], name: string): number {
  return turns.reduce((n, turn) => n + turn.actions.filter((row) => row === name).length, 0);
}

export function promptSkillGesturesFromText(text: string): string[] {
  const out: string[] = [];
  const rx = /(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;
  for (const match of text.matchAll(rx)) {
    const name = match[1];
    if (name) out.push(name);
  }
  return dedupeSkillNames(out);
}

function dedupeSkillNames(names: string[]): string[] {
  const seen = new Set<string>();
  for (const name of names) {
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) seen.add(name);
  }
  return [...seen];
}

export function countToolCalls(turns: LiveRunTurn[]): number {
  return turns.reduce((n, turn) => n + turn.actions.length, 0);
}

export function countNoToolTurns(turns: LiveRunTurn[]): number {
  return turns.reduce((n, turn) => n + (turn.actions.length === 0 ? 1 : 0), 0);
}

export function maxNoToolStreak(turns: LiveRunTurn[]): number {
  let current = 0;
  let max = 0;
  for (const turn of sortTurnsByIndex(turns)) {
    if (turn.actions.length === 0) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

export function countLengthStops(turns: LiveRunTurn[]): number {
  return turns.reduce((n, turn) => n + (hasLengthStop(turn) ? 1 : 0), 0);
}

function hasLengthStop(turn: LiveRunTurn): boolean {
  return (turn.finishReasons ?? []).some((reason) => reason === "length" || reason === "max_tokens");
}

export function sumAssistantTextBytes(turns: LiveRunTurn[]): number {
  return turns.reduce((n, turn) => n + (turn.assistantTextBytes ?? 0), 0);
}

export function maxAssistantTextBytes(turns: LiveRunTurn[]): number {
  return turns.length ? Math.max(...turns.map((turn) => turn.assistantTextBytes ?? 0)) : 0;
}

export function lastNamedCallTurnIndex(turns: LiveRunTurn[], name: string): number | null {
  const sorted = sortTurnsByIndex(turns);
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i]?.actions.includes(name)) return sorted[i]!.index;
  }
  return null;
}

export function turnsSinceNamedCall(turns: LiveRunTurn[], name: string): number | null {
  const sorted = sortTurnsByIndex(turns);
  let last = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i]?.actions.includes(name)) last = i;
  }
  return last < 0 ? null : sorted.length - 1 - last;
}

export function buildLiveRunLedger(input: {
  caseId: string;
  entry: LiveRunEntry;
  acceptanceMode: LiveAcceptanceMode;
  startedAt: Date;
  endedAt?: Date;
  dshStatus: number;
  dshSessionId?: string;
  dshProcessRestarts?: number;
  dshSessionResumes?: number;
  turns: LiveRunTurn[];
  promptSkillGestures?: string[];
  snapshot?: { status?: unknown; remainingFlags?: unknown };
  candidates?: Array<{ oracle?: unknown; submission?: unknown }>;
  stopReason?: LiveRunStopReason;
  acpStopReason?: string;
  wirePath?: string;
  dshRuntime?: DshRuntimeFingerprint;
  dshHome?: string;
}): LiveRunLedger {
  const endedAt = input.endedAt ?? new Date();
  const rawTurns = [...input.turns];
  const turns = sortTurnsByIndex(rawTurns);
  const firstTool = firstTurnTool(turns);
  const promptSkillGestures = dedupeSkillNames(input.promptSkillGestures ?? []);
  const skillCalls = countNamedCalls(turns, "skill");
  const todoCalls = countNamedCalls(turns, "todo_write");
  const accepted = input.snapshot?.status === "solved" && input.snapshot.remainingFlags === 0;
  const reported = (input.candidates ?? []).some((row) => row.submission === "reported");
  const oraclePass = (input.candidates ?? []).some((row) => row.oracle === "pass");
  const terminal: LiveRunTerminal = {
    accepted,
    reported,
    candidateCount: input.candidates?.length ?? 0,
  };
  if (typeof input.snapshot?.status === "string") terminal.status = input.snapshot.status;
  if (typeof input.snapshot?.remainingFlags === "number") terminal.remainingFlags = input.snapshot.remainingFlags;
  const ledger: LiveRunLedger = {
    schema: "silver.live-run-ledger.v1",
    caseId: input.caseId,
    entry: input.entry,
    acceptanceMode: input.acceptanceMode,
    startedAt: input.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    wallTimeMs: Math.max(0, endedAt.getTime() - input.startedAt.getTime()),
    dshStatus: input.dshStatus,
    ...(input.dshSessionId ? { dshSessionId: input.dshSessionId } : {}),
    ...(input.dshProcessRestarts ? { dshProcessRestarts: input.dshProcessRestarts } : {}),
    ...(input.dshSessionResumes ? { dshSessionResumes: input.dshSessionResumes } : {}),
    rawTurns,
    turns,
    firstTool,
    skillFirst: firstTool === "skill",
    toolCalls: countToolCalls(turns),
    noToolTurns: countNoToolTurns(turns),
    maxNoToolStreak: maxNoToolStreak(turns),
    lengthStops: countLengthStops(turns),
    assistantTextBytes: sumAssistantTextBytes(turns),
    maxAssistantTextBytes: maxAssistantTextBytes(turns),
    promptSkillGestures,
    skillCalls,
    todoCalls,
    lastTodoTurn: lastNamedCallTurnIndex(turns, "todo_write"),
    turnsSinceTodo: turnsSinceNamedCall(turns, "todo_write"),
    outcome: liveOutcome({
      accepted,
      reported,
      oraclePass,
      ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    }),
    terminal,
  };
  if (input.stopReason) ledger.stopReason = input.stopReason;
  if (input.acpStopReason) ledger.acpStopReason = input.acpStopReason;
  const usage = sumLiveUsage(turns);
  if (usage) ledger.usage = usage;
  if (input.wirePath) {
    const wire = summarizeLiveWireFile(input.wirePath);
    if (wire) ledger.wire = wire;
  }
  if (input.dshRuntime) ledger.dshRuntime = input.dshRuntime;
  if (input.dshHome) {
    const dshSession = summarizeDshSessionPersistence(input.dshHome);
    if (dshSession) ledger.dshSession = dshSession;
    const dshStorage = summarizeDshStorage(input.dshHome);
    if (dshStorage) ledger.dshStorage = dshStorage;
    if (!ledger.usage && input.dshSessionId) {
      const projectedUsage = readDshProjectedUsage(input.dshHome, input.dshSessionId);
      if (projectedUsage) ledger.usage = projectedUsage;
    }
  }
  return ledger;
}

export function summarizeLiveRun(ledger: LiveRunLedger): LiveRunReplayRow {
  const row: LiveRunReplayRow = {
    caseId: ledger.caseId,
    outcome: ledger.outcome,
    wallTimeMs: ledger.wallTimeMs,
    turns: ledger.turns.length,
    toolCalls: ledger.toolCalls,
    noToolTurns: ledger.noToolTurns ?? countNoToolTurns(ledger.turns),
    maxNoToolStreak: ledger.maxNoToolStreak ?? maxNoToolStreak(ledger.turns),
    lengthStops: ledger.lengthStops ?? countLengthStops(ledger.turns),
    assistantTextBytes: ledger.assistantTextBytes ?? sumAssistantTextBytes(ledger.turns),
    maxAssistantTextBytes: ledger.maxAssistantTextBytes ?? maxAssistantTextBytes(ledger.turns),
    firstTool: ledger.firstTool,
    promptSkillGestures: ledger.promptSkillGestures ?? [],
    promptSkillGestureCount: (ledger.promptSkillGestures ?? []).length,
    skillCalls: ledger.skillCalls,
    todoCalls: ledger.todoCalls ?? countNamedCalls(ledger.turns, "todo_write"),
    lastTodoTurn: ledger.lastTodoTurn ?? lastNamedCallTurnIndex(ledger.turns, "todo_write"),
    turnsSinceTodo: ledger.turnsSinceTodo ?? turnsSinceNamedCall(ledger.turns, "todo_write"),
  };
  if (ledger.stopReason) row.stopReason = ledger.stopReason;
  if (ledger.acpStopReason) row.acpStopReason = ledger.acpStopReason;
  if (ledger.dshSessionId) row.dshSessionId = ledger.dshSessionId;
  if (ledger.dshProcessRestarts) row.dshProcessRestarts = ledger.dshProcessRestarts;
  if (ledger.dshSessionResumes) row.dshSessionResumes = ledger.dshSessionResumes;
  if (ledger.usage) {
    row.promptTokens = ledger.usage.promptTokens;
    row.completionTokens = ledger.usage.completionTokens;
    row.totalTokens = ledger.usage.totalTokens;
  }
  if (ledger.wire) {
    row.wireRequests = ledger.wire.requests;
    row.wireFailures = ledger.wire.failedRequests;
    row.maxBodyBytes = ledger.wire.maxBodyBytes;
    row.maxMessageCount = ledger.wire.maxMessageCount;
    row.maxToolCount = ledger.wire.maxToolCount;
    row.wireToolNames = ledger.wire.toolNames;
    row.thinkingRequests = ledger.wire.thinkingRequests;
    row.thinkingDisabledRequests = ledger.wire.thinkingDisabledRequests;
    row.thinkingUnknownRequests = ledger.wire.thinkingUnknownRequests;
    row.compactionRequests = ledger.wire.compactionRequests;
    row.messageCountDrops = ledger.wire.messageCountDrops;
  }
  if (ledger.dshRuntime) {
    if (ledger.dshRuntime.version) row.dshVersion = ledger.dshRuntime.version;
    row.dshFeaturePlugins = ledger.dshRuntime.featurePlugins;
  }
  if (ledger.dshSession) {
    row.dshSessionLogs = ledger.dshSession.logCount;
    row.dshSessionBytes = ledger.dshSession.totalBytes;
    row.dshSessionJsonlLines = ledger.dshSession.jsonlLines;
  }
  if (ledger.dshStorage) {
    row.dshStorageFiles = ledger.dshStorage.fileCount;
    row.dshStorageBytes = ledger.dshStorage.totalBytes;
  }
  row.diagnostics = diagnoseLiveRunRow(row);
  return row;
}

export function summarizeLiveRunWithReport(ledger: LiveRunLedger, reportPath?: string, memoryPath?: string): LiveRunReplayRow {
  const row = summarizeLiveRun(ledger);
  const progress = loadReportProgressStats(reportPath);
  if (progress) {
    row.workMemoryState = progress.state;
    row.workMemoryNextCheckCount = progress.nextCheckCount;
    row.workMemoryEvidenceCount = progress.evidenceCount;
    row.workMemoryHypothesisCount = progress.hypothesisCount;
    row.hostFileProbeCount = progress.hostFileProbeCount;
    if (Object.keys(progress.assetCounts).length > 0) row.assetCounts = progress.assetCounts;
    if (Object.keys(progress.explorationCounts).length > 0) row.explorationCounts = progress.explorationCounts;
    if (Object.keys(progress.findingStatusCounts).length > 0) row.findingStatusCounts = progress.findingStatusCounts;
    if (Object.keys(progress.findingKindCounts).length > 0) row.findingKindCounts = progress.findingKindCounts;
  }
  const memory = loadMemoryLedgerStats(memoryPath);
  if (memory) {
    row.memoryAssetNodes = memory.assetNodes;
    row.memoryExplorationAxes = memory.explorationAxes;
    row.memoryObservations = memory.observations;
  }
  row.diagnostics = diagnoseLiveRunRow(row);
  return row;
}

export function diagnoseLiveRunRow(row: LiveRunReplayRow): LiveRunDiagnostic[] {
  const diagnostics: LiveRunDiagnostic[] = [];
  if (row.stopReason === "llm_transport_failure" || (row.wireFailures ?? 0) > 0) diagnostics.push("llm_transport");
  if (row.firstTool == null || row.maxNoToolStreak >= 3) diagnostics.push("no_tool");
  if (row.lengthStops > 0) diagnostics.push("length_stop");
  if (row.turnsSinceTodo != null && row.turnsSinceTodo >= 8) diagnostics.push("stale_todo");
  if ((row.hostFileProbeCount ?? 0) > 0) diagnostics.push("host_file_probe");
  if ((row.maxMessageCount ?? 0) >= 10 || (row.maxBodyBytes ?? 0) >= 24_000) diagnostics.push("context_pressure");
  if ((row.compactionRequests ?? 0) > 0) diagnostics.push("compaction_active");
  return diagnostics;
}

export function formatReplaySummary(rows: LiveRunReplayRow[]): string {
  const header = [
    "case",
    "outcome",
    "wall_ms",
    "turns",
    "tools",
    "no_tool",
    "no_tool_max",
    "len_stop",
    "text_max",
    "first_tool",
    "skill_gesture",
    "skills",
    "todo",
    "todo_age",
    "work",
    "work_next",
    "host_file",
    "compact",
    "wire_max",
    "wire_5xx",
    "diag",
    "stop",
    "acp_stop",
    "dsh_restarts",
    "dsh_resumes",
  ];
  const body = rows.map((row) => [
    row.caseId,
    row.outcome,
    String(row.wallTimeMs),
    String(row.turns),
    String(row.toolCalls),
    String(row.noToolTurns),
    String(row.maxNoToolStreak),
    String(row.lengthStops),
    String(row.maxAssistantTextBytes),
    row.firstTool ?? "-",
    row.promptSkillGestures.length ? row.promptSkillGestures.join(",") : "-",
    String(row.skillCalls),
    String(row.todoCalls),
    row.turnsSinceTodo == null ? "-" : String(row.turnsSinceTodo),
    row.workMemoryState ?? "-",
    row.workMemoryNextCheckCount === undefined ? "-" : String(row.workMemoryNextCheckCount),
    row.hostFileProbeCount === undefined ? "-" : String(row.hostFileProbeCount),
    row.compactionRequests === undefined ? "-" : String(row.compactionRequests),
    row.maxBodyBytes === undefined ? "-" : String(row.maxBodyBytes),
    row.wireFailures === undefined ? "-" : String(row.wireFailures),
    row.diagnostics?.length ? row.diagnostics.join(",") : "-",
    row.stopReason ?? "-",
    row.acpStopReason ?? "-",
    String(row.dshProcessRestarts ?? 0),
    String(row.dshSessionResumes ?? 0),
  ]);
  const widths = header.map((title, i) => Math.max(title.length, ...body.map((line) => line[i]?.length ?? 0)));
  const fmt = (line: string[]) => line.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
  const table = [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt)].join("\n");
  return `${table}\n${JSON.stringify({ replay: rows }, null, 2)}\n`;
}

export interface LiveBenchmarkSummary {
  schema: "silver.small-benchmark.v1";
  n: number;
  solved: number;
  reported: number;
  candidate: number;
  failed: number;
  stalled: number;
  wallTimeMs: number;
  turns: number;
  toolCalls: number;
  noToolTurns: number;
  maxNoToolStreak: number;
  lengthStops: number;
  assistantTextBytes: number;
  maxAssistantTextBytes: number;
  promptSkillGestureCount: number;
  promptSkillGestures: Record<string, number>;
  skillCalls: number;
  todoCalls: number;
  staleTodoRuns: number;
  workMemoryStates: Record<string, number>;
  workMemoryNextCheckCount: number;
  workMemoryEvidenceCount: number;
  workMemoryHypothesisCount: number;
  hostFileProbeCount: number;
  assetCounts: Record<string, number>;
  explorationCounts: Record<string, number>;
  findingStatusCounts: Record<string, number>;
  findingKindCounts: Record<string, number>;
  memoryAssetNodes: number;
  memoryExplorationAxes: number;
  memoryObservations: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  wireRequests: number | null;
  wireFailures: number | null;
  maxBodyBytes: number | null;
  maxMessageCount: number | null;
  maxToolCount: number | null;
  thinkingRequests: number | null;
  thinkingDisabledRequests: number | null;
  thinkingUnknownRequests: number | null;
  compactionRequests: number | null;
  messageCountDrops: number | null;
  dshStorageFiles: number;
  dshStorageBytes: number;
  dshVersions: Record<string, number>;
  diagnostics: Partial<Record<LiveRunDiagnostic, number>>;
  rows: LiveRunReplayRow[];
}

export function summarizeSmallBenchmark(rows: LiveRunReplayRow[]): LiveBenchmarkSummary {
  const tokenRows = rows.filter((row) => typeof row.totalTokens === "number");
  const wireRows = rows.filter((row) => typeof row.wireRequests === "number");
  const workMemoryStates: Record<string, number> = {};
  const assetCounts: Record<string, number> = {};
  const explorationCounts: Record<string, number> = {};
  const findingStatusCounts: Record<string, number> = {};
  const findingKindCounts: Record<string, number> = {};
  const dshVersions: Record<string, number> = {};
  const promptSkillGestures: Record<string, number> = {};
  const diagnostics: Partial<Record<LiveRunDiagnostic, number>> = {};
  for (const row of rows) {
    if (!row.workMemoryState) continue;
    workMemoryStates[row.workMemoryState] = (workMemoryStates[row.workMemoryState] ?? 0) + 1;
  }
  for (const row of rows) {
    mergeCountRecord(assetCounts, row.assetCounts);
    mergeCountRecord(explorationCounts, row.explorationCounts);
    mergeCountRecord(findingStatusCounts, row.findingStatusCounts);
    mergeCountRecord(findingKindCounts, row.findingKindCounts);
  }
  for (const row of rows) {
    const version = row.dshVersion ?? "unknown";
    dshVersions[version] = (dshVersions[version] ?? 0) + 1;
  }
  for (const row of rows) {
    for (const name of row.promptSkillGestures) {
      promptSkillGestures[name] = (promptSkillGestures[name] ?? 0) + 1;
    }
  }
  for (const row of rows) {
    for (const diagnostic of row.diagnostics ?? diagnoseLiveRunRow(row)) {
      diagnostics[diagnostic] = (diagnostics[diagnostic] ?? 0) + 1;
    }
  }
  return {
    schema: "silver.small-benchmark.v1",
    n: rows.length,
    solved: rows.filter((row) => row.outcome === "solved").length,
    reported: rows.filter((row) => row.outcome === "reported").length,
    candidate: rows.filter((row) => row.outcome === "candidate").length,
    failed: rows.filter((row) => row.outcome === "failed").length,
    stalled: rows.filter(isStalledReplayRow).length,
    wallTimeMs: rows.reduce((n, row) => n + row.wallTimeMs, 0),
    turns: rows.reduce((n, row) => n + row.turns, 0),
    toolCalls: rows.reduce((n, row) => n + row.toolCalls, 0),
    noToolTurns: rows.reduce((n, row) => n + row.noToolTurns, 0),
    maxNoToolStreak: rows.length ? Math.max(...rows.map((row) => row.maxNoToolStreak)) : 0,
    lengthStops: rows.reduce((n, row) => n + row.lengthStops, 0),
    assistantTextBytes: rows.reduce((n, row) => n + row.assistantTextBytes, 0),
    maxAssistantTextBytes: rows.length ? Math.max(...rows.map((row) => row.maxAssistantTextBytes)) : 0,
    promptSkillGestureCount: rows.reduce((n, row) => n + row.promptSkillGestureCount, 0),
    promptSkillGestures,
    skillCalls: rows.reduce((n, row) => n + row.skillCalls, 0),
    todoCalls: rows.reduce((n, row) => n + row.todoCalls, 0),
    staleTodoRuns: rows.filter((row) => row.turnsSinceTodo != null && row.turnsSinceTodo >= 8).length,
    workMemoryStates,
    workMemoryNextCheckCount: rows.reduce((n, row) => n + (row.workMemoryNextCheckCount ?? 0), 0),
    workMemoryEvidenceCount: rows.reduce((n, row) => n + (row.workMemoryEvidenceCount ?? 0), 0),
    workMemoryHypothesisCount: rows.reduce((n, row) => n + (row.workMemoryHypothesisCount ?? 0), 0),
    hostFileProbeCount: rows.reduce((n, row) => n + (row.hostFileProbeCount ?? 0), 0),
    assetCounts,
    explorationCounts,
    findingStatusCounts,
    findingKindCounts,
    memoryAssetNodes: rows.reduce((n, row) => n + (row.memoryAssetNodes ?? 0), 0),
    memoryExplorationAxes: rows.reduce((n, row) => n + (row.memoryExplorationAxes ?? 0), 0),
    memoryObservations: rows.reduce((n, row) => n + (row.memoryObservations ?? 0), 0),
    promptTokens: tokenRows.length ? tokenRows.reduce((n, row) => n + (row.promptTokens ?? 0), 0) : null,
    completionTokens: tokenRows.length ? tokenRows.reduce((n, row) => n + (row.completionTokens ?? 0), 0) : null,
    totalTokens: tokenRows.length ? tokenRows.reduce((n, row) => n + (row.totalTokens ?? 0), 0) : null,
    wireRequests: wireRows.length ? wireRows.reduce((n, row) => n + (row.wireRequests ?? 0), 0) : null,
    wireFailures: wireRows.length ? wireRows.reduce((n, row) => n + (row.wireFailures ?? 0), 0) : null,
    maxBodyBytes: wireRows.length ? Math.max(...wireRows.map((row) => row.maxBodyBytes ?? 0)) : null,
    maxMessageCount: wireRows.length ? Math.max(...wireRows.map((row) => row.maxMessageCount ?? 0)) : null,
    maxToolCount: wireRows.length ? Math.max(...wireRows.map((row) => row.maxToolCount ?? 0)) : null,
    thinkingRequests: wireRows.length ? wireRows.reduce((n, row) => n + (row.thinkingRequests ?? 0), 0) : null,
    thinkingDisabledRequests: wireRows.length ? wireRows.reduce((n, row) => n + (row.thinkingDisabledRequests ?? 0), 0) : null,
    thinkingUnknownRequests: wireRows.length ? wireRows.reduce((n, row) => n + (row.thinkingUnknownRequests ?? 0), 0) : null,
    compactionRequests: wireRows.length ? wireRows.reduce((n, row) => n + (row.compactionRequests ?? 0), 0) : null,
    messageCountDrops: wireRows.length ? wireRows.reduce((n, row) => n + (row.messageCountDrops ?? 0), 0) : null,
    dshStorageFiles: rows.reduce((n, row) => n + (row.dshStorageFiles ?? 0), 0),
    dshStorageBytes: rows.reduce((n, row) => n + (row.dshStorageBytes ?? 0), 0),
    dshVersions,
    diagnostics,
    rows,
  };
}

function isStalledReplayRow(row: LiveRunReplayRow): boolean {
  return (
    row.stopReason === "timeout" ||
    row.stopReason === "max_turns" ||
    row.stopReason === "stagnation_checkpoint" ||
    row.stopReason === "candidate_checkpoint" ||
    row.stopReason === "llm_transport_failure"
  );
}

export function formatBenchmarkSummary(rows: LiveRunReplayRow[]): string {
  const summary = summarizeSmallBenchmark(rows);
  const tokens = summary.totalTokens == null ? "-" : String(summary.totalTokens);
  const maxBody = summary.maxBodyBytes == null ? "-" : String(summary.maxBodyBytes);
  const wireFailures = summary.wireFailures == null ? "-" : String(summary.wireFailures);
  const thinkingEnabled = summary.thinkingRequests == null ? "-" : String(summary.thinkingRequests);
  const thinkingDisabled = summary.thinkingDisabledRequests == null ? "-" : String(summary.thinkingDisabledRequests);
  const thinkingUnknown = summary.thinkingUnknownRequests == null ? "-" : String(summary.thinkingUnknownRequests);
  const compactionRequests = summary.compactionRequests == null ? "-" : String(summary.compactionRequests);
  const workStates = Object.keys(summary.workMemoryStates).length ? JSON.stringify(summary.workMemoryStates) : "-";
  const assetCounts = Object.keys(summary.assetCounts).length ? JSON.stringify(summary.assetCounts) : "-";
  const explorationCounts = Object.keys(summary.explorationCounts).length ? JSON.stringify(summary.explorationCounts) : "-";
  const findingStatusCounts = Object.keys(summary.findingStatusCounts).length ? JSON.stringify(summary.findingStatusCounts) : "-";
  const findingKindCounts = Object.keys(summary.findingKindCounts).length ? JSON.stringify(summary.findingKindCounts) : "-";
  const promptSkillGestures = Object.keys(summary.promptSkillGestures).length ? JSON.stringify(summary.promptSkillGestures) : "-";
  const dshVersions = Object.keys(summary.dshVersions).length ? JSON.stringify(summary.dshVersions) : "-";
  const diagnostics = Object.keys(summary.diagnostics).length ? JSON.stringify(summary.diagnostics) : "-";
  const rates = [
    `n=${summary.n}`,
    `solved=${summary.solved}`,
    `reported=${summary.reported}`,
    `failed=${summary.failed}`,
    `stalled=${summary.stalled}`,
    `wall_ms=${summary.wallTimeMs}`,
    `turns=${summary.turns}`,
    `tools=${summary.toolCalls}`,
    `no_tool=${summary.noToolTurns}`,
    `no_tool_max=${summary.maxNoToolStreak}`,
    `len_stop=${summary.lengthStops}`,
    `text_max=${summary.maxAssistantTextBytes}`,
    `skill_gestures=${summary.promptSkillGestureCount}`,
    `skill_gesture_names=${promptSkillGestures}`,
    `skills=${summary.skillCalls}`,
    `todo=${summary.todoCalls}`,
    `stale_todo=${summary.staleTodoRuns}`,
    `work_states=${workStates}`,
    `work_next=${summary.workMemoryNextCheckCount}`,
    `host_file=${summary.hostFileProbeCount}`,
    `assets=${assetCounts}`,
    `exploration=${explorationCounts}`,
    `findings_status=${findingStatusCounts}`,
    `findings_kind=${findingKindCounts}`,
    `memory_assets=${summary.memoryAssetNodes}`,
    `memory_axes=${summary.memoryExplorationAxes}`,
    `memory_observations=${summary.memoryObservations}`,
    `tokens=${tokens}`,
    `dsh_versions=${dshVersions}`,
    `dsh_storage_files=${summary.dshStorageFiles}`,
    `diagnostics=${diagnostics}`,
    `thinking_enabled=${thinkingEnabled}`,
    `thinking_disabled=${thinkingDisabled}`,
    `thinking_unknown=${thinkingUnknown}`,
    `compaction=${compactionRequests}`,
    `wire_max_body=${maxBody}`,
    `wire_failures=${wireFailures}`,
  ].join("  ");
  return `${formatReplaySummary(rows)}${rates}\n${JSON.stringify({ benchmark: summary }, null, 2)}\n`;
}

export function writeLiveRunLedger(file: string, ledger: LiveRunLedger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function loadLiveRunLedger(file: string): LiveRunLedger {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LiveRunLedger;
  if (parsed.schema !== "silver.live-run-ledger.v1") {
    throw new Error(`unsupported live-run ledger schema ${String(parsed.schema)}`);
  }
  if (!parsed.wire) {
    const wire = summarizeLiveWireFile(path.join(path.dirname(file), "llm-wire.jsonl"));
    if (wire) parsed.wire = wire;
  }
  return parsed;
}

export function collectLiveRunLedgers(target: string): LiveRunLedger[] {
  const st = fs.statSync(target);
  if (st.isFile()) return [loadLiveRunLedger(target)];
  const found: string[] = [];
  walkLedgerFiles(target, found);
  found.sort();
  return found.map(loadLiveRunLedger);
}

export function collectLiveRunReplayRows(target: string): LiveRunReplayRow[] {
  const st = fs.statSync(target);
  if (st.isFile()) {
    return [summarizeLiveRunWithReport(loadLiveRunLedger(target), candidateReportPathForLedger(target), memoryLedgerPathForLedger(target))];
  }
  const found: string[] = [];
  walkLedgerFiles(target, found);
  found.sort();
  return found.map((file) => summarizeLiveRunWithReport(loadLiveRunLedger(file), candidateReportPathForLedger(file), memoryLedgerPathForLedger(file)));
}

function candidateReportPathForLedger(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), "candidate-report.json");
}

function memoryLedgerPathForLedger(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), "memory-ledger.json");
}

function mergeCountRecord(target: Record<string, number>, source: Record<string, number> | undefined): void {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    target[key] = (target[key] ?? 0) + value;
  }
}

function loadReportProgressStats(
  reportPath: string | undefined,
):
  | {
      state: string;
      nextCheckCount: number;
      evidenceCount: number;
      hypothesisCount: number;
      hostFileProbeCount: number;
      assetCounts: Record<string, number>;
      explorationCounts: Record<string, number>;
      findingStatusCounts: Record<string, number>;
      findingKindCounts: Record<string, number>;
    }
  | undefined {
  if (!reportPath || !fs.existsSync(reportPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
      progress?: {
        assetMemory?: { counts?: unknown };
        explorationMemory?: {
          attemptedAxes?: unknown;
          findings?: unknown;
          openObservations?: unknown;
        };
        findingLedger?: {
          counts?: unknown;
          kindCounts?: unknown;
        };
        hostFileProbes?: unknown;
        workMemory?: {
          state?: unknown;
          nextChecks?: unknown;
          evidence?: unknown;
          activeHypotheses?: unknown;
        };
      };
    };
    const workMemory = parsed.progress?.workMemory;
    if (!workMemory || typeof workMemory.state !== "string" || !workMemory.state) return undefined;
    return {
      state: workMemory.state,
      nextCheckCount: Array.isArray(workMemory.nextChecks) ? workMemory.nextChecks.length : 0,
      evidenceCount: Array.isArray(workMemory.evidence) ? workMemory.evidence.length : 0,
      hypothesisCount: Array.isArray(workMemory.activeHypotheses) ? workMemory.activeHypotheses.length : 0,
      hostFileProbeCount: Array.isArray(parsed.progress?.hostFileProbes) ? parsed.progress.hostFileProbes.length : 0,
      assetCounts: numericRecord(parsed.progress?.assetMemory?.counts),
      explorationCounts: compactReportExplorationCounts(parsed.progress?.explorationMemory),
      findingStatusCounts: numericRecord(parsed.progress?.findingLedger?.counts),
      findingKindCounts: numericRecord(parsed.progress?.findingLedger?.kindCounts),
    };
  } catch {
    return undefined;
  }
}

function compactReportExplorationCounts(
  value: { attemptedAxes?: unknown; findings?: unknown; openObservations?: unknown } | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(value?.attemptedAxes) && value.attemptedAxes.length > 0) out.attemptedAxes = value.attemptedAxes.length;
  if (Array.isArray(value?.findings) && value.findings.length > 0) out.findings = value.findings.length;
  if (Array.isArray(value?.openObservations) && value.openObservations.length > 0) out.openObservations = value.openObservations.length;
  return out;
}

function numericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) out[key] = raw;
  }
  return out;
}

function loadMemoryLedgerStats(
  memoryPath: string | undefined,
): { assetNodes: number; explorationAxes: number; observations: number } | undefined {
  if (!memoryPath || !fs.existsSync(memoryPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(memoryPath, "utf8")) as {
      schema?: unknown;
      assetGraph?: { nodes?: unknown };
      explorationGraph?: { axes?: unknown; observations?: unknown };
    };
    if (parsed.schema !== "silver.memory-ledger.v1") return undefined;
    return {
      assetNodes: Array.isArray(parsed.assetGraph?.nodes) ? parsed.assetGraph.nodes.length : 0,
      explorationAxes: Array.isArray(parsed.explorationGraph?.axes) ? parsed.explorationGraph.axes.length : 0,
      observations: Array.isArray(parsed.explorationGraph?.observations) ? parsed.explorationGraph.observations.length : 0,
    };
  } catch {
    return undefined;
  }
}

export function replayOutputPath(replayPath: string | undefined, attemptCwd: string): string {
  if (!replayPath) return path.join(attemptCwd, "live-run-ledger.json");
  const st = fs.existsSync(replayPath) ? fs.statSync(replayPath) : undefined;
  if (st?.isDirectory() || replayPath.endsWith(path.sep)) {
    return path.join(replayPath, "live-run-ledger.json");
  }
  return replayPath;
}

/**
 * Observational helper for tests. Skill-first (zero or many skills) is legal;
 * production completion is decided by Host CAS / candidate report, not tool order.
 * Does not reject `skill` as firstTool.
 */
export function assertFirstTurnTouchesTarget(ledger: LiveRunLedger): void {
  const first = ledger.firstTool;
  if (!first) {
    throw new Error(`first tool missing; expected a tool call before asserting turn order`);
  }
  if (first === "skill") return;
  if (!(FIRST_TURN_TOOLS as readonly string[]).includes(first)) {
    throw new Error(`first tool must be skill | ${FIRST_TURN_TOOLS.join(" | ")}, got ${String(first)}`);
  }
}

export function assertCaseSolvedByHostCas(ledger: LiveRunLedger): void {
  if (ledger.entry !== "case") throw new Error(`Host CAS assertion requires --case, got ${ledger.entry}`);
  if (ledger.outcome !== "solved" || !ledger.terminal.accepted || ledger.terminal.remainingFlags !== 0) {
    throw new Error(
      `--case ${ledger.caseId} is not Host CAS accepted; outcome=${ledger.outcome} status=${String(ledger.terminal.status)} remaining=${String(ledger.terminal.remainingFlags)}`,
    );
  }
}

/** Host CAS accepted, or candidate-report submit recorded. Not DSH idle. */
export function hostReachedLiveTerminal(input: {
  acceptanceMode: LiveAcceptanceMode;
  snapshot?: { status?: unknown; remainingFlags?: unknown };
  candidates?: Array<{ submission?: unknown }>;
  /** Host is forwarding submit_candidate to a contest board. */
  contestSubmit?: boolean;
  platformCompleted?: boolean;
}): boolean {
  if (input.contestSubmit) return input.platformCompleted === true;
  if (input.acceptanceMode === "candidate-report") {
    return (input.candidates ?? []).some((row) => row.submission === "reported");
  }
  return input.snapshot?.status === "solved" && input.snapshot.remainingFlags === 0;
}

export function assertMissionCandidateReport(ledger: LiveRunLedger): void {
  if (ledger.entry === "case") throw new Error("mission assertion requires --mission/--target");
  if (ledger.acceptanceMode !== "candidate-report") {
    throw new Error("--mission/--target must be candidate-report");
  }
  if (ledger.outcome === "solved" || ledger.terminal.accepted) {
    throw new Error("--mission/--target must not become platform accepted");
  }
}

function liveOutcome(input: {
  accepted: boolean;
  reported: boolean;
  oraclePass: boolean;
  stopReason?: LiveRunStopReason;
}): LiveRunOutcome {
  if (input.accepted) return "solved";
  if (input.reported) return "reported";
  if (input.oraclePass) return "candidate";
  if (isStalledStopReason(input.stopReason)) return "stalled";
  return "failed";
}

function isStalledStopReason(stopReason: LiveRunStopReason | undefined): boolean {
  return (
    stopReason === "timeout" ||
    stopReason === "max_turns" ||
    stopReason === "stagnation_checkpoint" ||
    stopReason === "candidate_checkpoint" ||
    stopReason === "llm_transport_failure" ||
    stopReason === "coordination_failure" ||
    stopReason === "interrupted" ||
    stopReason === "defer_unavailable"
  );
}

function walkLedgerFiles(dir: string, out: string[]): void {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkLedgerFiles(full, out);
    else if (st.isFile() && name === "live-run-ledger.json") out.push(full);
  }
}
