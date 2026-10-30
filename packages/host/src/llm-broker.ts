import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  appendLiveTurnFile,
  mergeLiveUsage,
  toolNamesFromSseData,
  usageFromSseData,
  type LiveRunUsage,
} from "./live-run-ledger.ts";

/** Cell env name for the broker capability. Not a provider API key. */
export const LLM_CAPABILITY_ENV = "SILVER_LLM_CAPABILITY";

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface LlmBrokerOptions {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  capability: string;
  /** Bind address. Default 127.0.0.1 (host-only). In-cell live uses 0.0.0.0. */
  listenHost?: string;
  /** Hostname advertised to cells. Must not be 0.0.0.0. */
  advertisedHost?: string;
  /** JSONL of model turns (tool names only). Attempt-local; no raw secrets. */
  ledgerPath?: string;
  /**
   * Redacted LLM wire JSONL. Gitignored when written next to a live ledger.
   * No raw keys or challenge tokens.
   */
  wireDebugPath?: string;
  provider?: string;
  model?: string;
  api?: string;
  /** Silver-selected output cap. Enforced before provider I/O. */
  maxTokens?: number;
  /** Silver-selected reasoning effort. `off` removes adapter-default thinking. */
  effort?: string;
  /** HostFs live budget: return false to refuse a new chat turn before provider I/O. */
  admitChatTurn?: (index: number) => boolean;
  /** Called with the forwarded request body after admission (no secrets added yet beyond upstream key on the wire). */
  onForwardedRequestBody?: (body: Buffer, pathname: string) => void;
  /** Refuse later provider calls after this many consecutive upstream 5xx turns. 0/undefined disables it. */
  maxConsecutiveFailedTurns?: number;
  /** HostFs live budget: called after a chat/completions or /messages turn finishes streaming. */
  onChatTurn?: (index: number, actions: readonly string[]) => void;
  /** HostFs live budget: called after a new chat turn is refused before provider I/O. */
  onRejectedChatTurn?: (index: number) => void;
  /** Called once when maxConsecutiveFailedTurns is reached. */
  onTransportFailureBudget?: (index: number, count: number) => void;
}

export interface LlmBrokerHandle {
  /** Origin advertised to the cell (host.docker.internal for in-cell live). */
  origin: string;
  listenHost: string;
  advertisedHost: string;
  port: number;
  /** HostFs recovery seam: clear and return the consecutive upstream 5xx count. */
  resetTransportFailures?: () => number;
  /** Destroy owned outgoing upstream requests/streams (local cancel; does not retract billed work). */
  abortActive(reason?: string): void;
  activeUpstreamCount(): number;
  close(): Promise<void>;
}

export interface LiveLlmAccessProbe {
  ok: boolean;
  status?: number;
  errorType?: string;
  errorMessage?: string;
}

/** Bind every interface so a bridge cell can reach the host; advertise Docker's host alias. */
export function cellBrokerBind(): { listenHost: string; advertisedHost: string } {
  return { listenHost: "0.0.0.0", advertisedHost: "host.docker.internal" };
}

export function randomLlmCapability(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** One minimal provider request used before a contest run opens any challenge. */
export async function probeLiveLlmAccess(input: {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  model: string;
  api?: string;
  timeoutMs?: number;
}): Promise<LiveLlmAccessProbe> {
  const api = input.api ?? "openai-completions";
  const anthropic = api === "anthropic-messages";
  const requestPath = anthropic ? "/v1/messages" : "/chat/completions";
  const upstream = new URL(input.upstreamBaseUrl);
  const url = new URL(joinUpstreamPath(upstream.pathname, requestPath), `${upstream.protocol}//${upstream.host}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-deepseek-harness-session-id": `silver-probe-${crypto.randomUUID()}`,
    };
    if (anthropic) {
      headers["x-api-key"] = input.upstreamApiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${input.upstreamApiKey}`;
    }
    const body = anthropic
      ? {
          model: input.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "Return OK." }],
        }
      : {
          model: input.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "Return OK." }],
        };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    return {
      ok: res.ok,
      status: res.status,
      ...summarizeLlmProbeError(res.status, text),
    };
  } catch (err) {
    const message = err instanceof Error ? sanitizeProbeError(err.message) : undefined;
    return {
      ok: false,
      errorType: err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error",
      ...(message ? { errorMessage: message } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Host-side broker. Runs in a child process so the listener is on the real
 * host network (in-process servers in some sandboxes are not reachable via
 * host.docker.internal). The child receives the upstream key via env, not argv.
 */
export function listenLlmBroker(options: LlmBrokerOptions): Promise<LlmBrokerHandle> {
  if (process.env.SILVER_LLM_BROKER_CHILD === "1") return bindLlmBroker(options);
  if (!options.capability.trim()) throw new Error("llm broker capability must not be empty");
  if (!options.upstreamApiKey.trim()) throw new Error("llm broker upstream api key must not be empty");
  const listenHost = options.listenHost ?? "127.0.0.1";
  const advertisedHost =
    options.advertisedHost ?? (listenHost === "0.0.0.0" || listenHost === "::" ? "127.0.0.1" : listenHost);
  if (advertisedHost === "0.0.0.0" || advertisedHost === "::") {
    throw new Error("llm broker advertisedHost must be a reachable hostname, not a wildcard bind");
  }
  if (listenHost === "127.0.0.1" || listenHost === "::1") return bindLlmBroker({ ...options, listenHost, advertisedHost });
  const childPath = fileURLToPath(new URL("./llm-broker-child.ts", import.meta.url));
  const args = childPath.endsWith(".ts")
    ? ["--experimental-strip-types", "--no-warnings", childPath]
    : [childPath];
  const child = spawn(process.execPath, args, {
    env: brokerChildEnv(options, { listenHost, advertisedHost }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(err);
    };
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n").find((row) => row.startsWith("silver-llm-broker "));
      if (!line || settled) return;
      settled = true;
      try {
        const ready = JSON.parse(line.slice("silver-llm-broker ".length)) as {
          port: number;
          origin: string;
          listenHost: string;
          advertisedHost: string;
        };
        resolve({
          origin: ready.origin,
          listenHost: ready.listenHost,
          advertisedHost: ready.advertisedHost,
          port: ready.port,
          abortActive: () => {
            child.kill("SIGTERM");
          },
          activeUpstreamCount: () => 0,
          close: () =>
            new Promise((done) => {
              child.once("exit", () => done());
              child.kill("SIGTERM");
            }),
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
    child.once("error", (err) => fail(err));
    child.once("exit", (code) => {
      if (!settled) fail(new Error(`llm broker child exited ${String(code)}: ${stderr || stdout}`));
    });
  });
}

export function brokerChildEnv(
  options: LlmBrokerOptions,
  bind: { listenHost: string; advertisedHost: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    ...(process.env.TERM ? { TERM: process.env.TERM } : {}),
    SILVER_LLM_BROKER_CHILD: "1",
    SILVER_LLM_UPSTREAM: options.upstreamBaseUrl,
    SILVER_LLM_UPSTREAM_KEY: options.upstreamApiKey,
    SILVER_LLM_CAPABILITY: options.capability,
    SILVER_LLM_LISTEN_HOST: bind.listenHost,
    SILVER_LLM_ADVERTISED_HOST: bind.advertisedHost,
    ...(options.ledgerPath ? { SILVER_LLM_LEDGER: options.ledgerPath } : {}),
    ...(resolveWireDebugPath(options) ? { SILVER_LLM_WIRE: resolveWireDebugPath(options)! } : {}),
    ...(options.provider ? { SILVER_LLM_PROVIDER: options.provider } : {}),
    ...(options.model ? { SILVER_LLM_MODEL: options.model } : {}),
    ...(options.api ? { SILVER_LLM_API: options.api } : {}),
    ...(options.maxTokens !== undefined ? { SILVER_LLM_MAX_TOKENS: String(options.maxTokens) } : {}),
    ...(options.effort ? { SILVER_LLM_EFFORT: options.effort } : {}),
    ...(options.maxConsecutiveFailedTurns !== undefined
      ? { SILVER_LLM_MAX_CONSECUTIVE_FAILED_TURNS: String(options.maxConsecutiveFailedTurns) }
      : {}),
  };
  return env;
}

export function bindLlmBroker(options: LlmBrokerOptions): Promise<LlmBrokerHandle> {
  if (!options.capability.trim()) throw new Error("llm broker capability must not be empty");
  if (!options.upstreamApiKey.trim()) throw new Error("llm broker upstream api key must not be empty");
  const upstream = new URL(options.upstreamBaseUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("llm broker upstream must be http or https");
  }
  const transport = upstream.protocol === "https:" ? https : http;
  const listenHost = options.listenHost ?? "127.0.0.1";
  const advertisedHost =
    options.advertisedHost ?? (listenHost === "0.0.0.0" || listenHost === "::" ? "127.0.0.1" : listenHost);
  if (advertisedHost === "0.0.0.0" || advertisedHost === "::") {
    throw new Error("llm broker advertisedHost must be a reachable hostname, not a wildcard bind");
  }

  let turnSeq = 0;
  let consecutiveFailedTurns = 0;
  let transportFailureBudgetReached = false;
  const activeUpstreams = new Set<{
    req: http.ClientRequest;
    upRes?: http.IncomingMessage;
    clientRes: ServerResponse;
  }>();
  const abortActive = (_reason?: string): void => {
    for (const tracked of [...activeUpstreams]) {
      activeUpstreams.delete(tracked);
      try {
        tracked.req.destroy();
      } catch {
        /* already gone */
      }
      try {
        tracked.upRes?.destroy();
      } catch {
        /* already gone */
      }
      try {
        if (!tracked.clientRes.writableEnded) tracked.clientRes.destroy();
      } catch {
        /* already gone */
      }
    }
  };
  const wireDebugPath = resolveWireDebugPath(options);
  const maxConsecutiveFailedTurns = positiveIntOrZero(options.maxConsecutiveFailedTurns);
  const recordTransportStatus = (index: number, status: number): void => {
    if (index < 1 || maxConsecutiveFailedTurns <= 0) return;
    if (status >= 500) {
      consecutiveFailedTurns += 1;
      if (!transportFailureBudgetReached && consecutiveFailedTurns >= maxConsecutiveFailedTurns) {
        transportFailureBudgetReached = true;
        options.onTransportFailureBudget?.(index, consecutiveFailedTurns);
      }
      return;
    }
    if (status < 500) consecutiveFailedTurns = 0;
  };
  const server = http.createServer((req, res) => {
    void handleBrokerRequest(req, res, {
      upstream,
      transport,
      capability: options.capability,
      upstreamApiKey: options.upstreamApiKey,
      activeUpstreams,
      ...(options.ledgerPath ? { ledgerPath: options.ledgerPath } : {}),
      ...(wireDebugPath ? { wireDebugPath } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.api ? { api: options.api } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.admitChatTurn ? { admitChatTurn: options.admitChatTurn } : {}),
      ...(options.onForwardedRequestBody ? { onForwardedRequestBody: options.onForwardedRequestBody } : {}),
      ...(options.onChatTurn ? { onChatTurn: options.onChatTurn } : {}),
      ...(options.onRejectedChatTurn ? { onRejectedChatTurn: options.onRejectedChatTurn } : {}),
      ...(maxConsecutiveFailedTurns > 0
        ? {
            admitProviderRequest: () => !transportFailureBudgetReached,
            recordTransportStatus,
          }
        : {}),
      nextTurn: () => {
        turnSeq += 1;
        return turnSeq;
      },
    });
  });

  return new Promise((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    server.once("error", onListenError);
    server.listen(0, listenHost, () => {
      server.removeListener("error", onListenError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("llm broker failed to bind a TCP port"));
        return;
      }
      resolve({
        origin: `http://${advertisedHost}:${address.port}`,
        listenHost,
        advertisedHost,
        port: address.port,
        resetTransportFailures: () => {
          const failedTurns = consecutiveFailedTurns;
          consecutiveFailedTurns = 0;
          transportFailureBudgetReached = false;
          return failedTurns;
        },
        abortActive,
        activeUpstreamCount: () => activeUpstreams.size,
        close: () =>
          new Promise((done, fail) => {
            abortActive("broker-close");
            if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

async function handleBrokerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    upstream: URL;
    transport: typeof http | typeof https;
    capability: string;
    upstreamApiKey: string;
    activeUpstreams: Set<{
      req: http.ClientRequest;
      upRes?: http.IncomingMessage;
      clientRes: ServerResponse;
    }>;
    ledgerPath?: string;
    wireDebugPath?: string;
    provider?: string;
    model?: string;
    api?: string;
    maxTokens?: number;
    effort?: string;
    admitChatTurn?: (index: number) => boolean;
    onForwardedRequestBody?: (body: Buffer, pathname: string) => void;
    onChatTurn?: (index: number, actions: readonly string[]) => void;
    onRejectedChatTurn?: (index: number) => void;
    admitProviderRequest?: () => boolean;
    recordTransportStatus?: (index: number, status: number) => void;
    nextTurn: () => number;
  },
): Promise<void> {
  const presented = presentedCapability(req);
  if (!presented || !tokenEqual(presented, input.capability)) {
    json(res, 401, { error: { message: "unauthorized" } });
    return;
  }
  const pathname = pathnameOf(req.url);
  if (!isAllowedLlmPath(req.method ?? "GET", pathname)) {
    json(res, 404, { error: { message: "not found" } });
    return;
  }
  const started = Date.now();
  const anthropic = isAnthropicMessagesPath(pathname);
  const turnIndex = isLlmTurnPath(req.method ?? "GET", pathname) ? input.nextTurn() : 0;
  if (turnIndex > 0 && input.admitChatTurn && !input.admitChatTurn(turnIndex)) {
    req.resume();
    json(res, 429, { error: { message: "live turn budget reached" } });
    input.onRejectedChatTurn?.(turnIndex);
    return;
  }
  const rawBody = await collectRequestBody(req);
  const body =
    turnIndex > 0
      ? applyLiveRequestLimits(rawBody, {
          ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          api: input.api ?? (anthropic ? "anthropic-messages" : "openai-completions"),
        })
      : rawBody;
  const betas = anthropicBetaTokens(req.headers["anthropic-beta"]);
  const requestShape = summarizeLlmWireRequest(pathname, body, {
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.api ? { api: input.api } : {}),
    ...(betas ? { betas } : {}),
  });
  if (turnIndex > 0 && input.admitProviderRequest && !input.admitProviderRequest()) {
    if (input.wireDebugPath) {
      appendLlmWireDebug(input.wireDebugPath, {
        ...requestShape,
        status: 429,
        durationMs: Math.max(0, Date.now() - started),
        errorType: "transport_failure_budget",
        errorMessage: "live LLM transport failure budget reached",
      });
    }
    json(res, 429, { error: { message: "live LLM transport failure budget reached" } });
    input.onRejectedChatTurn?.(turnIndex);
    return;
  }
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (
      HOP.has(lower) ||
      lower === "host" ||
      lower === "authorization" ||
      lower === "x-api-key" ||
      lower === "accept-encoding"
    ) continue;
    headers[key] = value;
  }
  headers.host = input.upstream.host;
  applyUpstreamAuth(headers, anthropic, input.upstreamApiKey);
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  headers["content-length"] = String(body.length);
  input.onForwardedRequestBody?.(body, pathname);

  const actions: string[] = [];
  let lastUsage: LiveRunUsage | undefined;
  let assistantTextChars = 0;
  let assistantTextBytes = 0;
  const finishReasons: string[] = [];
  let peek = "";
  const tracked: {
    req: http.ClientRequest;
    upRes?: http.IncomingMessage;
    clientRes: ServerResponse;
  } = { req: null as unknown as http.ClientRequest, clientRes: res };
  const upstreamReq = input.transport.request(
    {
      protocol: input.upstream.protocol,
      hostname: input.upstream.hostname,
      port: input.upstream.port,
      path: joinUpstreamPath(input.upstream.pathname, req.url),
      method: req.method,
      headers,
    },
    (upRes) => {
      tracked.upRes = upRes;
      if (!input.activeUpstreams.has(tracked)) {
        upRes.destroy();
        return;
      }
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        if (HOP.has(lower) || lower === "set-cookie" || lower === "content-length") continue;
        out[key] = value;
      }
      const status = upRes.statusCode ?? 502;
      res.writeHead(status, out);
      const sanitizeSseData = createChatCompletionSseSanitizer(`silver-${turnIndex || Date.now()}`);
      upRes.on("end", () => {
        input.activeUpstreams.delete(tracked);
      });
      pipeUpstreamSse(upRes, res, {
        ...(anthropic ? {} : { mutateData: sanitizeSseData }),
        onRaw: (chunk) => {
          if (peek.length < 2048) peek += chunk.slice(0, 2048 - peek.length);
        },
        onData: (data) => {
          const textSize = assistantTextSizeFromSseData(data);
          assistantTextChars += textSize.chars;
          assistantTextBytes += textSize.bytes;
          for (const reason of finishReasonsFromSseData(data)) {
            if (!finishReasons.includes(reason)) finishReasons.push(reason);
          }
          if (!input.ledgerPath || turnIndex < 1) return;
          for (const name of toolNamesFromSseData(data)) actions.push(name);
          const usage = usageFromSseData(data);
          if (usage) lastUsage = mergeLiveUsage(lastUsage, usage);
        },
        onEnd: () => {
          if (input.wireDebugPath) {
            appendLlmWireDebug(input.wireDebugPath, {
              ...requestShape,
              status,
              durationMs: Math.max(0, Date.now() - started),
              ...summarizeLlmWireError(status, peek),
            });
          }
          input.recordTransportStatus?.(turnIndex, status);
          if (turnIndex < 1) return;
          if (input.ledgerPath) {
            recordBrokerTurn(input.ledgerPath, turnIndex, started, actions, lastUsage, {
              assistantTextChars,
              assistantTextBytes,
              finishReasons,
            });
          }
          input.onChatTurn?.(turnIndex, actions);
        },
      });
    },
  );
  tracked.req = upstreamReq;
  input.activeUpstreams.add(tracked);
  res.on("close", () => {
    if (!res.writableEnded && input.activeUpstreams.has(tracked)) {
      input.activeUpstreams.delete(tracked);
      try {
        upstreamReq.destroy();
      } catch {
        /* ignore */
      }
      try {
        tracked.upRes?.destroy();
      } catch {
        /* ignore */
      }
    }
  });
  upstreamReq.on("error", () => {
    input.activeUpstreams.delete(tracked);
    if (input.wireDebugPath) {
      appendLlmWireDebug(input.wireDebugPath, {
        ...requestShape,
        status: 502,
        durationMs: Math.max(0, Date.now() - started),
        errorType: "upstream_unavailable",
      });
    }
    input.recordTransportStatus?.(turnIndex, 502);
    if (!res.headersSent) json(res, 502, { error: { message: "upstream unavailable" } });
    else res.destroy();
  });
  upstreamReq.end(body);
}

function positiveIntOrZero(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function summarizeLlmProbeError(status: number, text: string): Pick<LiveLlmAccessProbe, "errorType" | "errorMessage"> {
  if (status < 400) return {};
  const summarized = summarizeLlmWireError(status, text);
  return {
    ...(summarized.errorType ? { errorType: summarized.errorType } : {}),
    ...(summarized.errorMessage ? { errorMessage: sanitizeProbeError(summarized.errorMessage) } : {}),
  };
}

function sanitizeProbeError(message: string): string {
  return message.replace(WIRE_SECRET, "[REDACTED]").slice(0, 160);
}

/**
 * Cap request max_tokens at the configured model output limit without raising a
 * smaller official request budget (e.g. compaction-basic summarization).
 * Missing max_tokens is filled from the configured cap when present.
 */
export function applyLiveRequestLimits(
  body: Buffer,
  limits: { maxTokens?: number; effort?: string; api?: string },
): Buffer {
  const cap = limits.maxTokens;
  const effort = limits.effort?.trim().toLowerCase();
  if (cap === undefined && effort !== "off") return body;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
    let changed = false;
    if (cap !== undefined) {
      const hasCompletionCap =
        typeof parsed.max_completion_tokens === "number" && Number.isFinite(parsed.max_completion_tokens);
      if (hasCompletionCap) {
        // OpenAI-compatible gateways reject setting both spellings together.
        if (Object.prototype.hasOwnProperty.call(parsed, "max_tokens")) {
          delete parsed.max_tokens;
          changed = true;
        }
        if ((parsed.max_completion_tokens as number) > cap) {
          parsed.max_completion_tokens = cap;
          changed = true;
        }
      } else {
        const current = parsed.max_tokens;
        if (typeof current !== "number" || !Number.isFinite(current)) {
          parsed.max_tokens = cap;
          changed = true;
        } else if (current > cap) {
          parsed.max_tokens = cap;
          changed = true;
        }
      }
    }
    if (effort === "off" && Object.prototype.hasOwnProperty.call(parsed, "thinking")) {
      delete parsed.thinking;
      changed = true;
    }
    return changed ? Buffer.from(JSON.stringify(parsed)) : body;
  } catch {
    return body;
  }
}

/**
 * OpenAI-compatible gateways often send a later tool_call fragment with
 * `id: ""` / `name: ""`. Official dsh-llm-deepseek treats those as present and
 * overwrites the real name, so the cell executes unknown tool "".
 */
export function sanitizeChatCompletionSseData(data: string): string {
  return createChatCompletionSseSanitizer("silver")(data);
}

export function createChatCompletionSseSanitizer(idPrefix: string): (data: string) => string {
  const idsByChoiceAndIndex = new Map<string, string>();
  let nextSyntheticId = 0;
  const stablePrefix = idPrefix.replace(/[^A-Za-z0-9_-]/g, "_") || "silver";
  return (data: string): string => {
    const trimmed = data.trim();
    if (!trimmed || trimmed === "[DONE]") return data;
    try {
      const obj = JSON.parse(trimmed) as {
        choices?: Array<{
          index?: unknown;
          delta?: {
            tool_calls?: Array<{ index?: unknown; id?: unknown; function?: { name?: unknown } }>;
          };
        }>;
      };
      let choiceOffset = 0;
      for (const choice of obj.choices ?? []) {
        const choiceIndex =
          typeof choice.index === "number" || typeof choice.index === "string" ? String(choice.index) : String(choiceOffset);
        choiceOffset += 1;
        for (const call of choice.delta?.tool_calls ?? []) {
          const toolIndex =
            typeof call.index === "number" || typeof call.index === "string" ? String(call.index) : String(nextSyntheticId);
          const key = `${choiceIndex}:${toolIndex}`;
          if (typeof call.id === "string" && call.id.trim().length > 0) {
            idsByChoiceAndIndex.set(key, call.id);
          } else {
            let id = idsByChoiceAndIndex.get(key);
            if (!id) {
              nextSyntheticId += 1;
              id = `call_${stablePrefix}_${choiceIndex}_${toolIndex}_${nextSyntheticId}`;
              idsByChoiceAndIndex.set(key, id);
            }
            call.id = id;
          }
          if (call.function && (call.function.name === "" || call.function.name == null)) {
            delete call.function.name;
          }
        }
      }
      return JSON.stringify(obj);
    } catch {
      return data;
    }
  };
}

function pipeUpstreamSse(
  up: NodeJS.ReadableStream,
  res: ServerResponse,
  hooks?: {
    mutateData?: (data: string) => string;
    onRaw?: (chunk: string) => void;
    onData?: (data: string) => void;
    onEnd?: () => void;
  },
): void {
  let buf = "";
  const emitData = (payload: string): string => {
    const data = hooks?.mutateData ? hooks.mutateData(payload) : payload;
    hooks?.onData?.(data);
    return data;
  };
  up.on("data", (chunk) => {
    const text = String(chunk);
    hooks?.onRaw?.(text);
    buf += text;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const payload = line.startsWith("data: ") ? line.slice(6) : line.slice(5).trimStart();
        out += `data: ${emitData(payload)}\n`;
      } else out += `${line}\n`;
    }
    if (out) res.write(out);
  });
  up.on("end", () => {
    if (buf.startsWith("data:")) {
      const payload = buf.startsWith("data: ") ? buf.slice(6) : buf.slice(5).trimStart();
      res.write(`data: ${emitData(payload)}`);
    } else if (buf) res.write(buf);
    res.end();
    hooks?.onEnd?.();
  });
  up.on("error", () => {
    if (!res.writableEnded) res.destroy();
  });
}

function recordBrokerTurn(
  file: string,
  index: number,
  started: number,
  actions: string[],
  usage?: LiveRunUsage,
  diagnostics?: {
    assistantTextChars: number;
    assistantTextBytes: number;
    finishReasons: readonly string[];
  },
): void {
  const turn: Parameters<typeof appendLiveTurnFile>[1] = {
    index,
    at: new Date().toISOString(),
    actions,
    skillFirst: actions[0] === "skill",
    durationMs: Math.max(0, Date.now() - started),
  };
  if (usage) turn.usage = usage;
  if (diagnostics) {
    if (diagnostics.assistantTextChars > 0) turn.assistantTextChars = diagnostics.assistantTextChars;
    if (diagnostics.assistantTextBytes > 0) turn.assistantTextBytes = diagnostics.assistantTextBytes;
    if (diagnostics.finishReasons.length > 0) turn.finishReasons = [...diagnostics.finishReasons];
  }
  appendLiveTurnFile(file, turn);
}

export interface LlmWireToolStat {
  name: string;
  descriptionBytes: number;
  schemaBytes: number;
}

export interface LlmWireDebugRecord {
  ts: string;
  path: string;
  api: "anthropic-messages" | "openai-completions" | "other";
  provider?: string;
  model?: string;
  toolCount: number;
  toolNames: string[];
  /** Per-tool size only. No descriptions, no schema bodies, no keys. */
  tools?: LlmWireToolStat[];
  hasThinking: boolean;
  thinkingType?: string;
  stream?: boolean;
  maxTokens?: number;
  systemBytes?: number;
  /** True when this is an official DSH compaction LLM request. No prompt text is stored. */
  isCompaction?: boolean;
  /** `anthropic-beta` tokens, if the cell sent that header. */
  betas?: string[];
  bodyBytes: number;
  messageCount: number;
  status?: number;
  errorType?: string;
  errorMessage?: string;
  durationMs?: number;
}

const WIRE_SECRET =
  /Bearer\s+\S+|sk-[A-Za-z0-9._-]+|xai-[A-Za-z0-9._-]+|gsk_[A-Za-z0-9._-]+|flag\{[^}]+\}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function assistantTextSizeFromSseData(data: string): { chars: number; bytes: number } {
  const text = assistantTextFromSseData(data);
  return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
}

function assistantTextFromSseData(data: string): string {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return "";
  try {
    const obj = JSON.parse(trimmed) as {
      type?: unknown;
      delta?: { text?: unknown; thinking?: unknown };
      choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
    };
    const chunks: string[] = [];
    if (obj.type === "content_block_delta") {
      if (typeof obj.delta?.text === "string") chunks.push(obj.delta.text);
      if (typeof obj.delta?.thinking === "string") chunks.push(obj.delta.thinking);
    }
    for (const choice of obj.choices ?? []) {
      if (typeof choice.delta?.content === "string") chunks.push(choice.delta.content);
      if (typeof choice.delta?.reasoning_content === "string") chunks.push(choice.delta.reasoning_content);
    }
    return chunks.join("");
  } catch {
    return "";
  }
}

export function finishReasonsFromSseData(data: string): string[] {
  const trimmed = data.trim();
  if (!trimmed || trimmed === "[DONE]") return [];
  try {
    const obj = JSON.parse(trimmed) as {
      type?: unknown;
      stop_reason?: unknown;
      delta?: { stop_reason?: unknown };
      choices?: Array<{ finish_reason?: unknown }>;
    };
    const out: string[] = [];
    if (typeof obj.stop_reason === "string" && obj.stop_reason) out.push(obj.stop_reason);
    if (typeof obj.delta?.stop_reason === "string" && obj.delta.stop_reason) out.push(obj.delta.stop_reason);
    for (const choice of obj.choices ?? []) {
      if (typeof choice.finish_reason === "string" && choice.finish_reason) out.push(choice.finish_reason);
    }
    return out;
  } catch {
    return [];
  }
}

export function resolveWireDebugPath(options: {
  wireDebugPath?: string;
  ledgerPath?: string;
}): string | undefined {
  const explicit = options.wireDebugPath?.trim() || process.env.SILVER_LLM_WIRE_DEBUG?.trim();
  if (explicit) return explicit;
  if (options.ledgerPath) return path.join(path.dirname(options.ledgerPath), "llm-wire.jsonl");
  return undefined;
}

export function summarizeLlmWireRequest(
  pathname: string,
  body: Buffer,
  meta: { provider?: string; model?: string; api?: string; betas?: string[] } = {},
): LlmWireDebugRecord {
  const api: LlmWireDebugRecord["api"] = isAnthropicMessagesPath(pathname)
    ? "anthropic-messages"
    : pathname === "/chat/completions"
      ? "openai-completions"
      : "other";
  let model = meta.model;
  let toolStats: LlmWireToolStat[] = [];
  let hasThinking = false;
  let thinkingType: string | undefined;
  let messageCount = 0;
  let stream: boolean | undefined;
  let maxTokens: number | undefined;
  let systemBytes: number | undefined;
  let isCompaction = false;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.model === "string" && parsed.model.trim()) model = parsed.model.trim();
    if (typeof parsed.stream === "boolean") stream = parsed.stream;
    if (typeof parsed.max_tokens === "number" && Number.isFinite(parsed.max_tokens)) {
      maxTokens = parsed.max_tokens;
    }
    if (typeof parsed.system === "string") systemBytes = Buffer.byteLength(parsed.system, "utf8");
    else if (parsed.system != null) systemBytes = Buffer.byteLength(JSON.stringify(parsed.system), "utf8");
    toolStats = toolStatsFromBody(parsed.tools);
    if (parsed.thinking && typeof parsed.thinking === "object") {
      hasThinking = true;
      const typ = (parsed.thinking as { type?: unknown }).type;
      if (typeof typ === "string") thinkingType = typ;
    }
    if (Array.isArray(parsed.messages)) messageCount = parsed.messages.length;
    isCompaction = isDshCompactionRequest(parsed);
  } catch {
    /* unparsed body still records size */
  }
  const toolNames = toolStats.map((row) => row.name);
  const record: LlmWireDebugRecord = {
    ts: new Date().toISOString(),
    path: pathname,
    api: meta.api === "anthropic-messages" || meta.api === "openai-completions" ? meta.api : api,
    toolCount: toolNames.length,
    toolNames,
    hasThinking,
    bodyBytes: body.length,
    messageCount,
  };
  if (meta.provider) record.provider = meta.provider;
  if (model) record.model = model;
  if (thinkingType) record.thinkingType = thinkingType;
  if (stream !== undefined) record.stream = stream;
  if (maxTokens !== undefined) record.maxTokens = maxTokens;
  if (systemBytes !== undefined) record.systemBytes = systemBytes;
  if (isCompaction) record.isCompaction = true;
  if (toolStats.length > 0) record.tools = toolStats;
  if (meta.betas && meta.betas.length > 0) record.betas = meta.betas;
  return record;
}

function isDshCompactionRequest(parsed: Record<string, unknown>): boolean {
  const text = JSON.stringify([parsed.system, parsed.messages]);
  return text.includes("You are now acting as a compaction engine") && text.includes("Output EXACTLY the Markdown structure");
}

function toolStatsFromBody(tools: unknown): LlmWireToolStat[] {
  if (!Array.isArray(tools)) return [];
  const stats: LlmWireToolStat[] = [];
  for (const row of tools) {
    if (!row || typeof row !== "object") continue;
    const rec = row as {
      name?: unknown;
      description?: unknown;
      input_schema?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
    };
    const name = typeof rec.name === "string" ? rec.name : typeof rec.function?.name === "string" ? rec.function.name : "";
    if (!name) continue;
    const description =
      typeof rec.description === "string"
        ? rec.description
        : typeof rec.function?.description === "string"
          ? rec.function.description
          : "";
    const schema = rec.input_schema ?? rec.function?.parameters ?? {};
    stats.push({
      name,
      descriptionBytes: Buffer.byteLength(description, "utf8"),
      schemaBytes: Buffer.byteLength(JSON.stringify(schema), "utf8"),
    });
  }
  return stats;
}

export function anthropicBetaTokens(header: string | string[] | undefined): string[] | undefined {
  const raw = headerValue(header);
  if (!raw) return undefined;
  const tokens = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
}

export function summarizeLlmWireError(status: number, peek: string): { errorType?: string; errorMessage?: string } {
  const out: { errorType?: string; errorMessage?: string } = {};
  if (status < 400 && !peek.trim()) return out;
  const redacted = peek.replace(WIRE_SECRET, "[REDACTED]").slice(0, 240);
  try {
    const jsonStart = redacted.indexOf("{");
    const parsed = JSON.parse(jsonStart >= 0 ? redacted.slice(jsonStart) : redacted) as {
      type?: unknown;
      error?: { type?: unknown; message?: unknown };
      message?: unknown;
    };
    const nested = parsed.error;
    const errorType = typeof nested?.type === "string" ? nested.type : typeof parsed.type === "string" ? parsed.type : undefined;
    const errorMessage =
      typeof nested?.message === "string" ? nested.message : typeof parsed.message === "string" ? parsed.message : undefined;
    if (errorType) out.errorType = errorType;
    if (errorMessage) out.errorMessage = errorMessage.replace(WIRE_SECRET, "[REDACTED]").slice(0, 160);
  } catch {
    if (status >= 400 && redacted.trim()) out.errorMessage = redacted.replace(/\s+/g, " ").trim().slice(0, 160);
  }
  return out;
}

function appendLlmWireDebug(file: string, record: LlmWireDebugRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    WIRE_SECRET.lastIndex = 0;
    if (WIRE_SECRET.test(line)) return;
    fs.appendFileSync(file, line);
  } catch {
    /* wire debug must not break the live path */
  }
}

function collectRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Join the configured upstream prefix (`/v1`) with the cell request (`/chat/completions`). */
export function joinUpstreamPath(upstreamPathname: string, requestUrl: string | undefined): string {
  const request = new URL(requestUrl ?? "/", "http://silver-llm-broker.invalid");
  const prefix = (upstreamPathname || "/").replace(/\/+$/u, "");
  let suffix = request.pathname;
  if (!suffix.startsWith("/")) suffix = `/${suffix}`;
  const path = prefix ? `${prefix}${suffix}` : suffix;
  return `${path}${request.search}`;
}

export function isAllowedLlmPath(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "POST" && pathname === "/chat/completions") return true;
  if (verb === "POST" && isAnthropicMessagesPath(pathname)) return true;
  if ((verb === "GET" || verb === "POST") && pathname === "/files") return true;
  if ((verb === "GET" || verb === "DELETE") && /^\/files\/[^/]+$/.test(pathname)) return true;
  return false;
}

export function isAnthropicMessagesPath(pathname: string): boolean {
  return pathname === "/messages" || pathname === "/v1/messages";
}

function isLlmTurnPath(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== "POST") return false;
  return pathname === "/chat/completions" || isAnthropicMessagesPath(pathname);
}

function presentedCapability(req: IncomingMessage): string | undefined {
  const apiKey = headerValue(req.headers["x-api-key"]);
  if (apiKey) return apiKey;
  return bearerToken(req.headers.authorization);
}

function applyUpstreamAuth(headers: http.OutgoingHttpHeaders, anthropic: boolean, upstreamApiKey: string): void {
  if (anthropic) {
    headers["x-api-key"] = upstreamApiKey;
    return;
  }
  headers.authorization = `Bearer ${upstreamApiKey}`;
}

function headerValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = raw?.trim();
  return value || undefined;
}

function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://silver-llm-broker.invalid").pathname;
  } catch {
    return "/";
  }
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim());
  return match?.[1];
}

function tokenEqual(left: string, right: string): boolean {
  const a = crypto.createHash("sha256").update(left).digest();
  const b = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
  res.end(payload);
}
