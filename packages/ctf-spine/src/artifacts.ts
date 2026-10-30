import fs from "node:fs";
import path from "node:path";
import { artifactInAttemptRoot } from "@silver/oracle";
import type { ToolContext } from "./types.ts";

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

export function boundUnderRoot(presented: string, root: string): string | undefined {
  try {
    const resolved = path.resolve(root, presented);
    const realRoot = fs.realpathSync(root);
    if (isSymlink(resolved)) return undefined;
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined;
      return real;
    }
    const parent = boundUnderRoot(path.dirname(resolved), root);
    if (!parent) return undefined;
    return path.join(parent, path.basename(resolved));
  } catch {
    return undefined;
  }
}

export function artifactDir(ctx: ToolContext): string {
  const dir = path.join(ctx.cwd, "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newArtifactPath(ctx: ToolContext, prefix: string, ext = "json"): string {
  return path.join(
    artifactDir(ctx),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`,
  );
}

function walkRegularFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile()) out.push(full);
      } catch {
        continue;
      }
    }
  }
  return out;
}

export function grepArtifacts(ctx: ToolContext, pattern: string, maxMatches = 50): {
  matches: Array<{ locator: string; line: number; text: string }>;
  filesScanned: number;
} {
  if (!pattern) return { matches: [], filesScanned: 0 };
  const root = artifactDir(ctx);
  const matches: Array<{ locator: string; line: number; text: string }> = [];
  const files = walkRegularFiles(root);
  for (const file of files) {
    const bounded = artifactInAttemptRoot(file, root);
    if (!bounded) continue;
    let body: string;
    try {
      let flags = fs.constants.O_RDONLY;
      if (typeof fs.constants.O_NOFOLLOW === "number") flags |= fs.constants.O_NOFOLLOW;
      const fd = fs.openSync(bounded, flags);
      try {
        body = fs.readFileSync(fd).toString("utf8");
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
      matches.push({ locator: bounded, line: i + 1, text: text.slice(0, 240) });
      if (matches.length >= maxMatches) {
        return { matches, filesScanned: files.length };
      }
    }
  }
  return { matches, filesScanned: files.length };
}

export function readBoundedArtifact(
  ctx: ToolContext,
  locator: string,
  offset = 0,
  maxBytes = 8192,
): {
  ok: false;
  error: string;
} | { ok: true; locator: string; body: string; encoding: "utf8" | "base64"; truncated: boolean; length: number } {
  const bounded = artifactInAttemptRoot(locator, artifactDir(ctx));
  if (!bounded) return { ok: false, error: "artifact locator escapes attempt" };
  try {
    const st = fs.lstatSync(bounded);
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: "artifact is not a regular file" };
    let flags = fs.constants.O_RDONLY;
    if (typeof fs.constants.O_NOFOLLOW === "number") flags |= fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(bounded, flags);
    try {
      const raw = fs.readFileSync(fd);
      const start = Math.max(0, offset);
      const slice = raw.subarray(start, start + maxBytes);
      const binary = bounded.endsWith(".bin") || slice.includes(0);
      const body = binary ? slice.toString("base64") : slice.toString("utf8");
      return {
        ok: true,
        locator: bounded,
        body,
        encoding: binary ? "base64" : "utf8",
        truncated: start + slice.length < raw.length,
        length: raw.length,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, error: "missing artifact" };
  }
}
