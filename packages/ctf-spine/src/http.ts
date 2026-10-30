import { createHash } from "node:crypto";
import fs from "node:fs";
import { urlAllowed } from "@silver/protocol";
import { newArtifactPath } from "./artifacts.ts";
import { boundedTextPreview, PAYLOAD_PREVIEW_BYTES } from "./redact.ts";
import type { HttpBaseline, ToolContext, ToolResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_PREVIEW_BYTES = 64 * 1024;
export const HTTP_PREVIEW_BYTES = PAYLOAD_PREVIEW_BYTES;

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function headerDiffs(prev: Record<string, string>, next: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const changes: string[] = [];
  for (const key of keys) {
    if (prev[key] !== next[key]) changes.push(key);
  }
  return changes.sort();
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function spillBody(
  locator: string,
  buf: Buffer,
  binary: boolean,
): { encoding: "binary" | "utf8"; body?: string; bodyFile?: string } {
  if (binary) {
    const bodyFile = locator.replace(/\.json$/, ".bin");
    fs.writeFileSync(bodyFile, buf);
    return { encoding: "binary", bodyFile };
  }
  return { encoding: "utf8", body: buf.toString("utf8") };
}

function previewLimit(args: Record<string, unknown>): number {
  return Math.min(Math.max(Number(args.maxBytes ?? HTTP_PREVIEW_BYTES), 1), MAX_PREVIEW_BYTES);
}

function requestSnapshot(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyBuf: Buffer;
  previewBytes: number;
  cookiesSent: boolean;
  locator: string;
}): Record<string, unknown> {
  const binary = input.bodyBuf.length > 0 && isBinary(input.bodyBuf);
  const spilled = spillBody(input.locator.replace(/\.json$/, ".req.json"), input.bodyBuf, binary);
  const snap: Record<string, unknown> = {
    method: input.method,
    url: input.url,
    headers: input.headers,
    bodyLength: input.bodyBuf.length,
    bodySha256: sha256(input.bodyBuf),
    encoding: spilled.encoding,
    cookiesSent: input.cookiesSent,
  };
  if (spilled.bodyFile) snap.bodyFile = spilled.bodyFile;
  if (spilled.body) snap.body = spilled.body;
  if (!binary && input.bodyBuf.length > 0) {
    snap.bodyPreview = boundedTextPreview(input.bodyBuf.toString("utf8"), input.previewBytes);
  }
  return snap;
}

export async function httpRequest(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = String(args.url ?? "");
  const method = String(args.method ?? "GET").toUpperCase();
  if (!url) return { ok: false, data: { error: "url required" } };
  if (!/^https?:\/\//i.test(url)) return { ok: false, data: { error: "url must be http or https" } };
  const scoped = urlAllowed(url, ctx.inScopeUrls ?? []);
  if (!scoped.ok) return { ok: false, data: { error: scoped.reason } };
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? DEFAULT_TIMEOUT_MS), 1), MAX_TIMEOUT_MS);
  const previewBytes = previewLimit(args);
  const started = Date.now();
  try {
    const headers: Record<string, string> = {};
    if (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)) {
      Object.assign(headers, args.headers as Record<string, string>);
    }
    const hasCookie = Object.keys(headers).some((key) => key.toLowerCase() === "cookie");
    let cookiesSent = hasCookie;
    if (!hasCookie) {
      const jarCookie = ctx.cookies.headerFor(url);
      if (jarCookie) {
        headers.cookie = jarCookie;
        cookiesSent = true;
      }
    }
    const sendBody = args.body !== undefined && method !== "GET" && method !== "HEAD";
    const requestBuf = sendBody ? Buffer.from(String(args.body), "utf8") : Buffer.alloc(0);
    const init: RequestInit = { method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) };
    if (Object.keys(headers).length > 0) init.headers = headers;
    if (sendBody) init.body = requestBuf;
    const response = await fetch(url, init);
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
    ctx.cookies.ingest(url, setCookies);

    const rawBuf = Buffer.from(await response.arrayBuffer());
    const timingMs = Date.now() - started;
    const hash = sha256(rawBuf);
    const rawHeaders = collectHeaders(response.headers);
    const location = response.headers.get("location") ?? undefined;
    const redirected = response.status >= 300 && response.status < 400;
    const locator = newArtifactPath(ctx, "http");
    const binary = isBinary(rawBuf);
    const spilled = spillBody(locator, rawBuf, binary);
    const request = requestSnapshot({
      method,
      url,
      headers,
      bodyBuf: requestBuf,
      previewBytes,
      cookiesSent,
      locator,
    });
    const responseRecord: Record<string, unknown> = {
      status: response.status,
      headers: rawHeaders,
      length: rawBuf.length,
      storedBytes: rawBuf.length,
      hash,
      timingMs,
      redirected,
      encoding: spilled.encoding,
      cookiesCaptured: setCookies.length > 0,
    };
    if (location) responseRecord.location = location;
    if (spilled.bodyFile) responseRecord.bodyFile = spilled.bodyFile;
    if (spilled.body !== undefined) responseRecord.body = spilled.body;

    const record = { request, response: responseRecord };
    fs.writeFileSync(locator, JSON.stringify(record, null, 2), "utf8");

    const key = `${method} ${url}`;
    const prev = ctx.httpBaseline.get(key);
    const current: HttpBaseline = {
      locator,
      status: response.status,
      length: rawBuf.length,
      hash,
      headers: rawHeaders,
    };
    const diff = prev
      ? {
          vs: prev.locator,
          status: current.status - prev.status,
          length: current.length - prev.length,
          hashChanged: current.hash !== prev.hash,
          headerChanges: headerDiffs(prev.headers, current.headers),
        }
      : undefined;
    ctx.httpBaseline.set(key, current);

    const requestView: Record<string, unknown> = {
      method,
      url,
      headers: request.headers,
      bodyLength: request.bodyLength,
      bodySha256: request.bodySha256,
    };
    if (request.bodyPreview !== undefined) requestView.bodyPreview = request.bodyPreview;
    if (request.encoding !== "binary" && requestBuf.length > previewBytes) requestView.bodyTruncated = true;
    if (cookiesSent) requestView.cookiesSent = true;

    const data: Record<string, unknown> = {
      method,
      url,
      status: response.status,
      headers: rawHeaders,
      length: rawBuf.length,
      hash,
      timingMs,
      locator,
      redirected,
      encoding: spilled.encoding,
      request: requestView,
    };
    if (location) data.location = location;
    if (diff) data.diff = diff;
    if (setCookies.length > 0) data.cookiesCaptured = true;
    if (!binary) {
      data.preview = boundedTextPreview(rawBuf.subarray(0, previewBytes).toString("utf8"), previewBytes);
      data.previewTruncated = rawBuf.length > previewBytes;
    }
    const result: ToolResult = { ok: true, data };
    ctx.onToolResult?.("http_request", args, result);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut =
      (err instanceof Error && err.name === "TimeoutError") || /aborted due to timeout|TimeoutError/i.test(message);
    return { ok: false, data: { error: timedOut ? `http timeout after ${timeoutMs}ms` : message } };
  }
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return true;
  let odd = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) odd += 1;
  }
  return sample.length > 0 && odd / sample.length > 0.3;
}
