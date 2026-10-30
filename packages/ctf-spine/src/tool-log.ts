import { compileFlagPolicy, type FlagPolicy } from "@silver/protocol";
import { redactHeaderRecord, redactHttpRequestArgs, redactPayloadPreview, redactPayloadSecrets, SENSITIVE_HEADER_NAMES } from "./redact.ts";
import type { ToolContext, ToolResult } from "./types.ts";

const HEADER_JSON = new RegExp(
  `"(${[...SENSITIVE_HEADER_NAMES].join("|")})"\\s*:\\s*"[^"]*"`,
  "gi",
);

const SENSITIVE_DATA_KEYS = new Set([
  "raw",
  "flag",
  "token",
  "accesstoken",
  "refreshtoken",
  "cookie",
  "password",
  "passwd",
  "secret",
  "apikey",
  "authorization",
  "proxyauthorization",
  "setcookie",
  "session",
  "sessionid",
  "credential",
  "credentials",
]);

export function redactSecretsInText(text: string, policy: FlagPolicy = compileFlagPolicy()): string {
  let out = redactPayloadSecrets(policy.redact(text));
  out = out.replace(HEADER_JSON, `"$1":"[REDACTED]"`);
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+=\/]+/gi, "Bearer [REDACTED]");
  return out;
}

/** Cookie/token hygiene for model-visible bodies. Flags stay so the solver can submit. */
export function redactSensitiveValues(text: string): string {
  return text
    .replace(HEADER_JSON, `"$1":"[REDACTED]"`)
    .replace(/Bearer\s+[A-Za-z0-9._\-+=\/]+/gi, "Bearer [REDACTED]");
}

export function redactToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === "http_request") return redactHttpRequestArgs(args);
  if (name !== "submit_candidate" && name !== "verify_candidate") return args;
  if (!("raw" in args)) return args;
  return { ...args, raw: "[REDACTED]" };
}

export function redactToolData(
  name: string,
  data: Record<string, unknown>,
  policy: FlagPolicy = compileFlagPolicy(),
): Record<string, unknown> {
  const copy = redactDeep(data, policy) as Record<string, unknown>;
  if (name === "submit_candidate" || name === "verify_candidate") delete copy.raw;
  if (name === "http_request") {
    delete copy.body;
    const req = copy.request;
    if (req && typeof req === "object" && !Array.isArray(req)) {
      const request = { ...(req as Record<string, unknown>) };
      delete request.body;
      delete request.bodyFile;
      if (request.headers && typeof request.headers === "object" && !Array.isArray(request.headers)) {
        request.headers = redactHeaderRecord(request.headers as Record<string, string>);
      }
      if (typeof request.bodyPreview === "string") request.bodyPreview = redactPayloadPreview(request.bodyPreview);
      copy.request = request;
    }
    if (typeof copy.preview === "string") copy.preview = redactPayloadPreview(copy.preview);
    if (copy.headers && typeof copy.headers === "object") {
      copy.headers = redactHeaderRecord(copy.headers as Record<string, string>);
    }
  }
  return copy;
}

export function logToolCall(ctx: ToolContext, name: string, args: Record<string, unknown>): void {
  ctx.session?.append("tool_call", { name, args: redactToolArgs(name, args) });
}

export function logToolResult(ctx: ToolContext, name: string, result: ToolResult): void {
  ctx.session?.append("tool_result", {
    name,
    ok: result.ok,
    data: redactToolData(name, result.data, ctx.flagPolicy),
  });
}

export function logToolExchange(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
): void {
  logToolCall(ctx, name, args);
  logToolResult(ctx, name, result);
}

function redactDeep(value: unknown, policy: FlagPolicy): unknown {
  if (typeof value === "string") return redactSecretsInText(value, policy);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, policy));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sensitiveDataKey(key) ? "[REDACTED]" : redactDeep(child, policy);
  }
  return out;
}

function sensitiveDataKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return SENSITIVE_DATA_KEYS.has(normalized);
}
