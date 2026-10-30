#!/usr/bin/env node
/**
 * Isolated run_code evaluator. Host RPC lives in the parent worker.
 * Node spawn does not inherit extra parent fds; fd 3 is a dedicated IPC
 * pipe (tools/log/done). Do not close fds 4+ — libuv needs them.
 */
import fs from "node:fs";
import readline from "node:readline";
import type { ParentToChild } from "./run-code-ipc.ts";

const AsyncFunction = Object.getPrototypeOf(async function noop() {
  await Promise.resolve();
}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

const pending = new Map<string, { resolve: (row: Record<string, unknown>) => void; reject: (err: Error) => void }>();
let seq = 0;
const logs: string[] = [];

function send(msg: { op: string; [key: string]: unknown }): void {
  fs.writeSync(3, `${JSON.stringify(msg)}\n`);
}

function invoke(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `t${seq}`;
    seq += 1;
    pending.set(id, { resolve, reject });
    send({ op: "tool", id, name, args });
  });
}

const tools: Record<string, (args?: Record<string, unknown>) => Promise<Record<string, unknown>>> = {};

function installTools(names: string[]): void {
  for (const key of Object.keys(tools)) delete tools[key];
  for (const name of names) {
    tools[name] = (args: Record<string, unknown> = {}) => invoke(name, args);
  }
}

async function runEval(source: string): Promise<void> {
  try {
    const fn = new AsyncFunction("tools", "console", source);
    const result = await fn(tools, {
      log: (...parts: unknown[]) => {
        const text = parts.map(stringify).join(" ");
        logs.push(text);
        send({ op: "log", text });
      },
    });
    send({ op: "done", result, logs });
  } catch (err) {
    send({ op: "done", error: err instanceof Error ? err.message : String(err), logs });
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg: ParentToChild;
  try {
    msg = JSON.parse(line) as ParentToChild;
  } catch {
    return;
  }
  if (msg.op === "eval") {
    installTools(msg.tools);
    void runEval(msg.source);
    return;
  }
  if (msg.op === "tool_result") {
    const wait = pending.get(msg.id);
    if (!wait) return;
    pending.delete(msg.id);
    if (msg.error) wait.reject(new Error(msg.error));
    else wait.resolve(msg.data ?? {});
  }
});
