import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DshWebUiOptions {
  host?: string;
  port?: number;
  trustedHosts?: readonly string[];
  noOpen?: boolean;
  pluginPatchPath?: string;
}

export function dshWebUiArgs(options: DshWebUiOptions = {}): string[] {
  const args = ["--profile", "web"];
  if (options.pluginPatchPath) args.push("--patch", options.pluginPatchPath);
  if (options.noOpen) args.push("--no-open");
  if (options.host) args.push("--host", options.host);
  if (options.port !== undefined) args.push("--port", String(options.port));
  for (const authority of options.trustedHosts ?? []) args.push("--trusted-host", authority);
  return args;
}

/** Launch the pinned official DSH GUI without creating another Silver solver path. */
export async function runDshWebUi(repoRoot: string, options: DshWebUiOptions = {}): Promise<void> {
  const executable = path.join(repoRoot, "node_modules", ".bin", "dsh");
  if (!fs.existsSync(executable)) throw new Error("local DSH executable is missing; run npm install first");
  const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-dsh-ui-"));
  const pluginPatchPath = path.join(patchDir, "cordis.patch.yml");
  const pluginPath = path.join(repoRoot, "packages", "cli", "src", "dsh-ui-plugin.js");
  fs.writeFileSync(pluginPatchPath, `- insert:\n    - id: silver-ui\n      name: ${JSON.stringify(pluginPath)}\n`);
  const child = spawn(executable, dshWebUiArgs({ ...options, pluginPatchPath }), {
    cwd: repoRoot,
    env: { ...process.env, SILVER_REPO_ROOT: repoRoot },
    stdio: "inherit",
  });
  let forwardedSignal: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals) => {
    forwardedSignal = signal;
    if (!child.killed) child.kill(signal);
  };
  const onSigint = () => forward("SIGINT");
  const onSigterm = () => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    fs.rmSync(patchDir, { recursive: true, force: true });
  });
  if ((forwardedSignal && (exit.signal === forwardedSignal || exit.code === 0)) || exit.code === 130 || exit.code === 143) {
    process.exitCode = forwardedSignal === "SIGTERM" || exit.code === 143 ? 143 : 130;
    return;
  }
  if (exit.code !== 0) {
    throw new Error(`DSH Web UI exited with ${exit.signal ?? `status ${String(exit.code)}`}`);
  }
}
