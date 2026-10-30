import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { grepArtifacts, readBoundedArtifact } from "./artifacts.ts";
import { fsGrep, fsList, fsRead, fsWrite } from "./fs-workspace.ts";
import { notebookRead, notebookWrite } from "./notebook.ts";
import { httpRequest } from "./http.ts";
import { terminalClose, terminalList, terminalOpen, terminalRead, terminalSend } from "./terminal.ts";
import { logToolExchange } from "./tool-log.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import {
  decodeChildLine,
  INTERNAL_RUN_CODE_TOOLS,
  isRunCodeTool,
  SOLVER_RUN_CODE_TOOLS,
  type RunCodeToolName,
} from "./run-code-ipc.ts";

const MAX_SOURCE_BYTES = 32 * 1024;
const CHILD_SCRIPT = fileURLToPath(new URL("./run-code-child.ts", import.meta.url));

export async function runCode(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const source = String(args.source ?? "");
  if (!source) return { ok: false, data: { error: "source required" } };
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return { ok: false, data: { error: "source too large" } };
  }
  return runInChild(source, ctx);
}

export function runCodeSdkNames(ctx: ToolContext): RunCodeToolName[] {
  const names: RunCodeToolName[] = [...SOLVER_RUN_CODE_TOOLS];
  if ((ctx.toolsPreset ?? "solver") === "internal") names.push(...INTERNAL_RUN_CODE_TOOLS);
  return names;
}

function createSdk(ctx: ToolContext): Record<string, (toolArgs?: Record<string, unknown>) => Promise<Record<string, unknown>>> {
  const all: Record<string, (toolArgs?: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
    http_request: async (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "http_request", toolArgs, () => httpRequest(toolArgs, ctx)),
    read_artifact: async (toolArgs: Record<string, unknown> = {}) => {
      const read = readBoundedArtifact(
        ctx,
        String(toolArgs.locator ?? ""),
        Number(toolArgs.offset ?? 0),
        Number(toolArgs.maxBytes ?? 8192),
      );
      const result: ToolResult = read.ok ? { ok: true, data: read } : { ok: false, data: { error: read.error } };
      return unwrapLogged(ctx, "read_artifact", toolArgs, async () => result);
    },
    grep_artifacts: async (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "grep_artifacts", toolArgs, async () => ({
        ok: true,
        data: grepArtifacts(ctx, String(toolArgs.pattern ?? "")),
      })),
    room_info: async () =>
      unwrapLogged(ctx, "room_info", {}, async () => ({
        ok: true,
        data: await ctx.host.invoke("room_info", {}),
      })),
    challenge_info: async () =>
      unwrapLogged(ctx, "challenge_info", {}, async () => ({
        ok: true,
        data: await ctx.host.invoke("challenge_info", {}),
      })),
    request_hint: async () =>
      unwrapLogged(ctx, "request_hint", {}, async () => ({
        ok: true,
        data: await ctx.host.invoke("request_hint", {}),
      })),
    terminal_open: async (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "terminal_open", toolArgs, () => terminalOpen(toolArgs, ctx)),
    terminal_send: async (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "terminal_send", toolArgs, () => terminalSend(toolArgs, ctx)),
    terminal_read: async (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "terminal_read", toolArgs, () => terminalRead(toolArgs, ctx)),
    terminal_close: async (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "terminal_close", toolArgs, () => terminalClose(toolArgs, ctx)),
    terminal_list: async () => unwrapLogged(ctx, "terminal_list", {}, () => terminalList({}, ctx)),
    fs_read: (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "fs_read", toolArgs, async () => fsRead(toolArgs, ctx)),
    fs_write: (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "fs_write", toolArgs, async () => fsWrite(toolArgs, ctx)),
    fs_list: (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "fs_list", toolArgs, async () => fsList(toolArgs, ctx)),
    fs_grep: (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "fs_grep", toolArgs, async () => fsGrep(toolArgs, ctx)),
    notebook_write: (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "notebook_write", toolArgs, async () => notebookWrite(toolArgs, ctx)),
    notebook_read: (toolArgs: Record<string, unknown> = {}) =>
      unwrapLogged(ctx, "notebook_read", toolArgs, async () => notebookRead(toolArgs, ctx)),
    intel_read: async () =>
      unwrapLogged(ctx, "intel_read", {}, async () => ({
        ok: true,
        data: await ctx.host.invoke("intel_read", {}),
      })),
    ask_skeptic: async () =>
      unwrapLogged(ctx, "ask_skeptic", {}, async () => ({
        ok: true,
        data: await ctx.host.invoke("ask_skeptic", {}),
      })),
  };
  const sdk: Record<string, (toolArgs?: Record<string, unknown>) => Promise<Record<string, unknown>>> = {};
  for (const name of runCodeSdkNames(ctx)) {
    const fn = all[name];
    if (fn) sdk[name] = fn;
  }
  return sdk;
}

async function runInChild(source: string, ctx: ToolContext): Promise<ToolResult> {
  const sdk = createSdk(ctx);
  const logs: string[] = [];
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", CHILD_SCRIPT],
    {
      cwd: ctx.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  const ipc = child.stdio[3];
  if (!child.stdin || !ipc || !("readable" in ipc)) {
    child.kill("SIGTERM");
    return { ok: false, data: { error: "run_code child ipc missing" } };
  }

  const capture = (chunk: Buffer | string) => {
    const text = String(chunk).replace(/\n$/, "");
    if (text) logs.push(text);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish({ ok: false, data: { error: "run_code child timeout", logs } }), 30_000);
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(result);
    };

    const onIpc = (line: string) => {
      const msg = decodeChildLine(line);
      if (!msg) return;
      if (msg.op === "log") {
        if (msg.text) logs.push(msg.text);
        return;
      }
      if (msg.op === "done") {
        logs.push(...msg.logs);
        if (msg.error) finish({ ok: false, data: { error: msg.error, logs } });
        else finish({ ok: true, data: { result: msg.result, logs } });
        return;
      }
      if (msg.op === "tool") {
        void (async () => {
          if (!isRunCodeTool(msg.name) || !sdk[msg.name]) {
            child.stdin?.write(
              `${JSON.stringify({ op: "tool_result", id: msg.id, error: `unknown tool ${msg.name}` })}\n`,
            );
            return;
          }
          try {
            const data = await sdk[msg.name]!(msg.args);
            child.stdin?.write(`${JSON.stringify({ op: "tool_result", id: msg.id, data })}\n`);
          } catch (err) {
            child.stdin?.write(
              `${JSON.stringify({ op: "tool_result", id: msg.id, error: err instanceof Error ? err.message : String(err) })}\n`,
            );
          }
        })();
      }
    };

    readline.createInterface({ input: ipc as NodeJS.ReadableStream }).on("line", onIpc);
    child.on("exit", (code) => {
      if (!settled) finish({ ok: false, data: { error: `run_code child exited ${code ?? "null"}`, logs } });
    });
    child.on("error", (err) => {
      finish({ ok: false, data: { error: err.message, logs } });
    });
    child.stdin.write(`${JSON.stringify({ op: "eval", source, tools: runCodeSdkNames(ctx) })}\n`);
  });
}

async function unwrapLogged(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
  run: () => Promise<ToolResult>,
): Promise<Record<string, unknown>> {
  let result: ToolResult;
  try {
    result = await run();
  } catch (err) {
    result = { ok: false, data: { error: err instanceof Error ? err.message : String(err) } };
  }
  logToolExchange(ctx, name, args, result);
  return unwrap(result);
}

function unwrap(result: ToolResult): Record<string, unknown> {
  if (!result.ok) throw new Error(JSON.stringify(result.data));
  return result.data;
}
