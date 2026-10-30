import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { boundUnderRoot } from "./artifacts.ts";
import type { ToolContext, ToolResult } from "./types.ts";

const MAX_SESSIONS = 4;
const MAX_UNREAD = 1024 * 1024;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const DEFAULT_READ_BYTES = 4096;
const DEFAULT_IDLE_MS = 100;
const EXIT_GRACE_MS = 400;

// python3 -c SCRIPT argv...  → sys.argv == ["-c", ...argv]. Do not insert "--":
// that would make pty.spawn(["--", ...]) and exec fail.
const PTY_BOOTSTRAP = [
  "import pty, sys",
  "argv = sys.argv[1:]",
  "if argv[:1] == ['--']: argv = argv[1:]",
  "if not argv: raise SystemExit(2)",
  "raise SystemExit(pty.spawn(argv))",
].join("\n");

export interface TerminalSnapshot {
  id: string;
  argv: string[];
  pid: number;
  running: boolean;
  locator: string;
  cwd: string;
  pty: boolean;
  logBytes: number;
  logTruncated: boolean;
}

class TerminalSession {
  readonly id: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly pty: boolean;
  readonly child: ChildProcessWithoutNullStreams;
  readonly locator: string;
  unread = Buffer.alloc(0);
  logBytes = 0;
  logTruncated = false;
  spawnError: string | undefined;
  private waiters: Array<() => void> = [];
  private readonly spawned: Promise<void>;

  constructor(
    id: string,
    argv: string[],
    cwd: string,
    pty: boolean,
    child: ChildProcessWithoutNullStreams,
    locator: string,
  ) {
    this.id = id;
    this.argv = argv;
    this.cwd = cwd;
    this.pty = pty;
    this.child = child;
    this.locator = locator;
    fs.writeFileSync(locator, "");
    this.spawned = new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onEarlyError);
        resolve();
      };
      const onEarlyError = (err: Error) => {
        child.off("spawn", onSpawn);
        this.spawnError = err.message;
        reject(err);
      };
      child.once("spawn", onSpawn);
      child.once("error", onEarlyError);
    });
    child.stdout.on("data", (chunk: Buffer) => this.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.push(chunk));
    child.on("error", (err) => {
      this.spawnError = err.message;
      this.flushWaiters();
    });
    child.on("exit", () => this.flushWaiters());
  }

  ready(): Promise<void> {
    return this.spawned;
  }

  private push(chunk: Buffer): void {
    if (this.logBytes < MAX_LOG_BYTES) {
      const room = MAX_LOG_BYTES - this.logBytes;
      const spilled = chunk.length > room ? chunk.subarray(0, room) : chunk;
      fs.appendFileSync(this.locator, spilled);
      this.logBytes += spilled.length;
      if (chunk.length > room) this.logTruncated = true;
    } else {
      this.logTruncated = true;
    }
    this.unread = Buffer.concat([this.unread, chunk]);
    if (this.unread.length > MAX_UNREAD) {
      this.unread = this.unread.subarray(this.unread.length - MAX_UNREAD);
    }
    this.flushWaiters();
  }

  private flushWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const wait of waiters) wait();
  }

  private waitOnce(ms: number): Promise<void> {
    if (!this.running()) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.push(done);
      if (!this.running()) done();
    });
  }

  async waitForOutput(opts: { waitMs: number; idleMs: number; expect?: string }): Promise<void> {
    const deadline = Date.now() + opts.waitMs;
    const needle = opts.expect ?? "";
    let lastLen = this.unread.length;
    let sawData = lastLen > 0;
    let lastChange = sawData ? Date.now() : 0;

    while (true) {
      if (needle && bufferHas(this.unread, needle)) return;
      if (!this.running() && this.unread.length === lastLen) return;

      const now = Date.now();
      const remaining = deadline - now;
      if (remaining <= 0) return;

      if (sawData && !needle && now - lastChange >= opts.idleMs) return;

      const slice = needle || !sawData ? remaining : Math.min(remaining, Math.max(opts.idleMs, 1));
      await this.waitOnce(slice);

      if (this.unread.length > lastLen) {
        lastLen = this.unread.length;
        lastChange = Date.now();
        sawData = true;
        if (opts.idleMs === 0 && !needle) return;
      }
    }
  }

  take(maxBytes: number): { text: string; truncated: boolean } {
    const truncated = this.unread.length > maxBytes;
    const slice = truncated ? this.unread.subarray(this.unread.length - maxBytes) : this.unread;
    this.unread = Buffer.alloc(0);
    return { text: slice.toString("utf8"), truncated };
  }

  running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  writeStdin(data: string): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !this.running()) {
      return Promise.reject(new Error("stdin closed"));
    }
    return new Promise((resolve, reject) => {
      stdin.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.running()) {
      signalGroup(this.child, "SIGTERM");
      if (!(await waitExit(this.child, EXIT_GRACE_MS))) {
        signalGroup(this.child, "SIGKILL");
        await waitExit(this.child, EXIT_GRACE_MS);
      }
    }
    destroyStdio(this.child);
  }
}

export class TerminalHub {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly attemptRoot: string;
  private seq = 0;

  constructor(attemptRoot: string) {
    this.attemptRoot = attemptRoot;
  }

  async open(args: Record<string, unknown>): Promise<ToolResult> {
    if (this.sessions.size >= MAX_SESSIONS) {
      return { ok: false, data: { error: `max ${MAX_SESSIONS} IAT sessions` } };
    }
    const argv = normalizeArgv(args.argv);
    if (!argv) return { ok: false, data: { error: "argv must be a non-empty string array; no shell" } };
    const cwd = boundUnderRoot(String(args.cwd ?? this.attemptRoot), this.attemptRoot);
    if (!cwd) return { ok: false, data: { error: "cwd escapes attempt" } };
    const pty = Boolean(args.pty);
    const spawnArgv = pty ? ["python3", "-u", "-c", PTY_BOOTSTRAP, ...argv] : argv;
    const id = `t${(this.seq += 1)}`;
    const locator = path.join(this.attemptRoot, "artifacts", `term-${id}.log`);
    fs.mkdirSync(path.dirname(locator), { recursive: true });
    const tmp = path.join(cwd, ".tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const child = spawn(spawnArgv[0]!, spawnArgv.slice(1), {
      cwd,
      env: childEnv(cwd, pty),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: true,
    }) as ChildProcessWithoutNullStreams;
    if (!child.stdin || !child.stdout || !child.stderr) {
      signalGroup(child, "SIGKILL");
      return { ok: false, data: { error: "stdio pipe failed" } };
    }
    const session = new TerminalSession(id, argv, cwd, pty, child, locator);
    this.sessions.set(id, session);
    try {
      await session.ready();
    } catch (err) {
      this.sessions.delete(id);
      await session.close();
      return { ok: false, data: { error: err instanceof Error ? err.message : String(err) } };
    }
    return { ok: true, data: snapshot(session) };
  }

  async send(args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.must(String(args.id ?? ""));
    if (!session.ok) return session;
    if (!session.session.running()) return { ok: false, data: { error: "session exited" } };
    const newline = args.newline !== false;
    const data = String(args.data ?? "");
    try {
      await session.session.writeStdin(newline ? `${data}\n` : data);
    } catch (err) {
      return { ok: false, data: { error: err instanceof Error ? err.message : String(err) } };
    }
    return { ok: true, data: { id: session.session.id, written: data.length + (newline ? 1 : 0) } };
  }

  async read(args: Record<string, unknown>): Promise<ToolResult> {
    const session = this.must(String(args.id ?? ""));
    if (!session.ok) return session;
    const waitMs = boundInt(args.waitMs, 200, 0, 10_000);
    const idleMs = boundInt(args.idleMs, DEFAULT_IDLE_MS, 0, 2000);
    const expect = expectNeedle(args);
    const maxBytes = boundInt(args.maxBytes, DEFAULT_READ_BYTES, 1, 64 * 1024);
    if (waitMs > 0) await session.session.waitForOutput({ waitMs, idleMs, ...(expect ? { expect } : {}) });
    const chunk = session.session.take(maxBytes);
    return {
      ok: true,
      data: {
        ...snapshot(session.session),
        text: chunk.text,
        truncated: chunk.truncated,
      },
    };
  }

  async close(id: string): Promise<ToolResult> {
    const session = this.must(id);
    if (!session.ok) return session;
    await session.session.close();
    this.sessions.delete(id);
    return { ok: true, data: { id, running: false } };
  }

  list(): ToolResult {
    return {
      ok: true,
      data: { sessions: [...this.sessions.values()].map(snapshot) },
    };
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    for (const id of ids) await this.close(id);
  }

  private must(id: string): { ok: true; session: TerminalSession } | { ok: false; data: Record<string, unknown> } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, data: { error: `unknown session ${id}` } };
    return { ok: true, session };
  }
}

function snapshot(session: TerminalSession): TerminalSnapshot & Record<string, unknown> {
  return {
    id: session.id,
    argv: session.argv,
    pid: session.child.pid ?? -1,
    running: session.running(),
    locator: session.locator,
    cwd: session.cwd,
    pty: session.pty,
    logBytes: session.logBytes,
    logTruncated: session.logTruncated,
  };
}

function normalizeArgv(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const argv = raw.map((part) => String(part));
  if (argv.some((part) => part.length === 0 || part.length > 4096)) return undefined;
  return argv;
}

function childEnv(cwd: string, pty: boolean): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: cwd,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    TMPDIR: path.join(cwd, ".tmp"),
    TERM: pty ? "xterm" : "dumb",
  };
}

function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

async function waitExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    await once(child, "exit", { signal: ac.signal });
    return true;
  } catch {
    return child.exitCode !== null || child.signalCode !== null;
  } finally {
    clearTimeout(timer);
  }
}

function destroyStdio(child: ChildProcessWithoutNullStreams): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream.destroy();
    } catch {
      // already closed
    }
  }
}

function boundInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function expectNeedle(args: Record<string, unknown>): string {
  if (typeof args.expect === "string" && args.expect.length > 0) return args.expect;
  if (typeof args.until === "string" && args.until.length > 0) return args.until;
  return "";
}

function bufferHas(buf: Buffer, needle: string): boolean {
  return buf.includes(needle);
}

export async function terminalOpen(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return ctx.terminals.open(args);
}

export async function terminalSend(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return ctx.terminals.send(args);
}

export async function terminalRead(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return ctx.terminals.read(args);
}

export async function terminalClose(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return ctx.terminals.close(String(args.id ?? ""));
}

export async function terminalList(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  return ctx.terminals.list();
}
