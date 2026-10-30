import fs from "node:fs";
import path from "node:path";
import { boundUnderRoot } from "./artifacts.ts";
import type { ToolContext, ToolResult } from "./types.ts";

const MAX_WRITE = 1024 * 1024;
const MAX_GREP_FILE = 1024 * 1024;

function openNoFollow(target: string, flags: number, mode?: number): number {
  let openFlags = flags;
  if (typeof fs.constants.O_NOFOLLOW === "number") openFlags |= fs.constants.O_NOFOLLOW;
  return mode === undefined ? fs.openSync(target, openFlags) : fs.openSync(target, openFlags, mode);
}

function decodeBody(body: string, encoding: string): Buffer | undefined {
  if (encoding === "base64") {
    const buf = Buffer.from(body, "base64");
    if (body.length > 0 && buf.length === 0) return undefined;
    return buf;
  }
  return Buffer.from(body, "utf8");
}

export function fsRead(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const target = boundUnderRoot(String(args.path ?? ""), ctx.cwd);
  if (!target) return { ok: false, data: { error: "path escapes attempt" } };
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, data: { error: "not a regular file" } };
    const maxBytes = Math.min(Math.max(Number(args.maxBytes ?? 8192), 1), 64 * 1024);
    const offset = Math.max(Number(args.offset ?? 0), 0);
    const fd = openNoFollow(target, fs.constants.O_RDONLY);
    try {
      const raw = fs.readFileSync(fd);
      const slice = raw.subarray(offset, offset + maxBytes);
      const binary = slice.includes(0);
      const encoding = args.encoding === "base64" || args.encoding === "utf8"
        ? args.encoding
        : binary
          ? "base64"
          : "utf8";
      return {
        ok: true,
        data: {
          path: target,
          body: slice.toString(encoding),
          encoding,
          truncated: offset + slice.length < raw.length,
          length: raw.length,
        },
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, data: { error: "missing file" } };
  }
}

export function fsWrite(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const target = boundUnderRoot(String(args.path ?? ""), ctx.cwd);
  if (!target) return { ok: false, data: { error: "path escapes attempt" } };
  const encoding = args.encoding === "base64" ? "base64" : "utf8";
  const buf = decodeBody(String(args.body ?? ""), encoding);
  if (!buf) return { ok: false, data: { error: "invalid base64 body" } };
  if (buf.length > MAX_WRITE) return { ok: false, data: { error: "write too large" } };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = openNoFollow(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
      0o644,
    );
    try {
      fs.writeSync(fd, buf);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, data: { error: "write failed" } };
  }
  return { ok: true, data: { path: target, length: buf.length, encoding } };
}

export function fsList(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const target = boundUnderRoot(String(args.path ?? ctx.cwd), ctx.cwd);
  if (!target) return { ok: false, data: { error: "path escapes attempt" } };
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, data: { error: "not a directory" } };
    const names = fs.readdirSync(target).slice(0, 200);
    return { ok: true, data: { path: target, entries: names } };
  } catch {
    return { ok: false, data: { error: "missing directory" } };
  }
}

export function fsGrep(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { ok: false, data: { error: "pattern required" } };
  const target = boundUnderRoot(String(args.path ?? ctx.cwd), ctx.cwd);
  if (!target) return { ok: false, data: { error: "path escapes attempt" } };
  const maxMatches = Math.min(Math.max(Number(args.maxMatches ?? 50), 1), 200);
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const stack = [target];
  let filesScanned = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) stack.push(path.join(current, entry.name));
      continue;
    }
    if (!st.isFile() || st.size > MAX_GREP_FILE) continue;
    filesScanned += 1;
    let body: string;
    try {
      const fd = openNoFollow(current, fs.constants.O_RDONLY);
      try {
        body = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i] ?? "";
      if (!text.includes(pattern)) continue;
      matches.push({ path: current, line: i + 1, text: text.slice(0, 240) });
      if (matches.length >= maxMatches) return { ok: true, data: { matches, filesScanned } };
    }
  }
  return { ok: true, data: { matches, filesScanned } };
}
