export const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}

export function redactHeaderRecord(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveHeader(key) ? "[REDACTED]" : value;
  }
  return out;
}

export const PAYLOAD_PREVIEW_BYTES = 2048;

const FORM_SECRET = /(password|passwd|token|secret|api[_-]?key)\s*=\s*[^&\s]*/gi;
const JSON_SECRET = /"(password|passwd|token|secret|api[_-]?key)"\s*:\s*"[^"]*"/gi;

/** Byte-bounded preview only. CTF target-side evidence stays faithful for the solver. */
export function boundedTextPreview(text: string, maxBytes = PAYLOAD_PREVIEW_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

export function redactPayloadSecrets(text: string): string {
  return text
    .replace(FORM_SECRET, "$1=[REDACTED]")
    .replace(JSON_SECRET, '"$1":"[REDACTED]"')
    .replace(/"(authorization|proxy-authorization|cookie|set-cookie|x-api-key)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/gi, "Bearer [REDACTED]");
}

/** Bounded payload for logs/reports. Ordinary exploit bodies stay readable. */
export function redactPayloadPreview(text: string, maxBytes = PAYLOAD_PREVIEW_BYTES): string {
  return boundedTextPreview(redactPayloadSecrets(text), maxBytes);
}

export function redactHttpRequestArgs(args: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...args };
  if (copy.headers && typeof copy.headers === "object" && !Array.isArray(copy.headers)) {
    copy.headers = redactHeaderRecord(copy.headers as Record<string, string>);
  }
  if (typeof copy.body === "string") copy.body = redactPayloadPreview(copy.body);
  else if ("body" in copy) copy.body = "[REDACTED]";
  return copy;
}
