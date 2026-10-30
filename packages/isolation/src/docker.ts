import { spawn, spawnSync } from "node:child_process";
import { OwnershipError } from "./errors.ts";
import type { DockerClient, DockerPopenResult, DockerRunResult } from "./types.ts";
import { CONTROL_TIMEOUT_SECONDS } from "./types.ts";

export class ProcessDocker implements DockerClient {
  run(argv: string[], options?: { timeout?: number; env?: NodeJS.ProcessEnv }): DockerRunResult {
    const result = spawnSync(argv[0] ?? "docker", argv.slice(1), {
      encoding: "utf8",
      timeout: options?.timeout !== undefined ? options.timeout * 1000 : undefined,
      ...(options?.env ? { env: options.env } : {}),
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const err = new Error(result.stderr || "docker command failed") as Error & {
        status: number;
        stderr: string;
        stdout: string;
      };
      err.status = result.status ?? 1;
      err.stderr = result.stderr;
      err.stdout = result.stdout;
      throw err;
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  popen(argv: string[], options: { env: NodeJS.ProcessEnv; shell: boolean }): DockerPopenResult {
    if (options.shell) {
      throw new OwnershipError("docker exec must not use a shell");
    }
    const child = spawn(argv[0] ?? "docker", argv.slice(1), {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const result: DockerPopenResult = {
      pid: child.pid ?? -1,
      kill: (signal?: NodeJS.Signals | number) => {
        child.kill(signal ?? "SIGTERM");
      },
      exit: new Promise((resolve) => {
        child.once("close", (status) => resolve({ status }));
      }),
    };
    if (child.stdin) result.stdin = child.stdin;
    if (child.stdout) result.stdout = child.stdout;
    if (child.stderr) result.stderr = child.stderr;
    return result;
  }
}

export function runCreate(docker: DockerClient, argv: string[]): DockerRunResult {
  return docker.run(argv);
}

export function runControl(docker: DockerClient, argv: string[]): DockerRunResult {
  return docker.run(argv, { timeout: CONTROL_TIMEOUT_SECONDS });
}

export function isNotFound(err: unknown): boolean {
  const text = `${String((err as { stderr?: string }).stderr ?? "")}\n${String(err)}`.toLowerCase();
  return text.includes("no such object") || text.includes("no such container");
}
