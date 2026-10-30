import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundUnderRoot } from "@silver/ctf-spine";
import { OWNER_LABEL, OWNER_VALUE } from "@silver/protocol";

const CHECKER_IMAGES = [
  "ai4pentest/target-cell-kali:0.1",
  "ghcr.io/astral-sh/uv:python3.14-bookworm-slim",
  "python:3.12-alpine",
  "python:3-alpine",
  "python:3.11-alpine",
];

export interface CheckerRun {
  ok: boolean;
  exitCode: number | null;
  reason: string;
}

let cachedImage: string | undefined;

export function resetCheckerImageCache(): void {
  cachedImage = undefined;
}

export async function runJailedChecker(input: {
  argv: string[];
  challengeRoot: string;
  attemptRoot: string;
  raw: string;
  timeoutMs?: number;
}): Promise<CheckerRun> {
  if (!Array.isArray(input.argv) || input.argv.length === 0) {
    return { ok: false, exitCode: null, reason: "checker argv required" };
  }
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 15_000, 100), 30_000);
  const jail = path.join(input.attemptRoot, ".tmp", "checker-run");
  fs.rmSync(jail, { recursive: true, force: true });
  fs.mkdirSync(jail, { recursive: true });
  const rewritten: string[] = [];
  for (const part of input.argv) {
    const abs = path.resolve(input.challengeRoot, part);
    if (fs.existsSync(abs)) {
      const bounded = boundUnderRoot(part, input.challengeRoot);
      if (!bounded) return { ok: false, exitCode: null, reason: "checker path escapes challenge" };
      try {
        const st = fs.lstatSync(bounded);
        if (st.isSymbolicLink() || !st.isFile()) {
          return { ok: false, exitCode: null, reason: "checker is not a regular file" };
        }
      } catch {
        return { ok: false, exitCode: null, reason: "checker missing" };
      }
      const dest = path.join(jail, path.basename(bounded));
      fs.copyFileSync(bounded, dest);
      rewritten.push(path.basename(bounded));
    } else {
      rewritten.push(part);
    }
  }
  if (rewritten[0] !== "python3" && rewritten[0] !== "python") {
    return { ok: false, exitCode: null, reason: "checker interpreter must be python3" };
  }
  const scriptIndex = rewritten.findIndex((part, i) => i > 0 && part.endsWith(".py"));
  const script = scriptIndex >= 0 ? rewritten[scriptIndex] : undefined;
  if (!script) return { ok: false, exitCode: null, reason: "checker script required" };
  if (!dockerInfoOk()) {
    return { ok: false, exitCode: null, reason: "isolated checker runtime unavailable" };
  }
  const image = resolveCheckerImage();
  if (!image) {
    return { ok: false, exitCode: null, reason: "isolated checker image unavailable" };
  }

  const user = `${os.userInfo().uid}:${os.userInfo().gid}`;
  const argv = [
    "docker",
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777",
    "--user",
    user,
    "--label",
    `${OWNER_LABEL}=${OWNER_VALUE}`,
    "--label",
    "silver.role=checker",
    "--mount",
    `type=bind,src=${jail},dst=/work,readonly`,
    "--workdir",
    "/work",
    "--env",
    "HOME=/tmp",
    "--env",
    "PYTHONUNBUFFERED=1",
    "--env",
    "PYTHONDONTWRITEBYTECODE=1",
    "--env",
    "LANG=C.UTF-8",
    "--entrypoint",
    "python3",
    image,
    "-I",
    "-u",
    script,
    ...rewritten.slice(scriptIndex + 1),
  ];
  const result = spawnSync(argv[0]!, argv.slice(1), {
    encoding: "utf8",
    input: input.raw,
    timeout: timeoutMs,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      ok: false,
      exitCode: null,
      reason: timedOut ? "local checker timeout" : result.error.message,
    };
  }
  const code = result.status;
  const detail = `${result.stdout.trim()} ${result.stderr.trim()}`.trim();
  return {
    ok: code === 0,
    exitCode: code,
    reason:
      code === 0
        ? "local checker accepted"
        : `local checker exit ${code ?? "killed"}${detail ? `: ${detail.slice(0, 240)}` : ""}`,
  };
}

function dockerInfoOk(): boolean {
  const result = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 8000 });
  return result.status === 0;
}

function imageExists(image: string): boolean {
  const inspect = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8", timeout: 8000 });
  return inspect.status === 0;
}

function imageHasPython(image: string): boolean {
  const probe = spawnSync(
    "docker",
    ["run", "--rm", "--network", "none", "--entrypoint", "python3", image, "-c", "print(1)"],
    { encoding: "utf8", timeout: 60_000 },
  );
  return probe.status === 0;
}

function resolveCheckerImage(): string | undefined {
  if (cachedImage) return cachedImage;
  const pinned = process.env.SILVER_CHECKER_IMAGE;
  const candidates = [pinned, ...CHECKER_IMAGES].filter((image): image is string => Boolean(image));
  for (const image of candidates) {
    if (!imageExists(image)) continue;
    if (!imageHasPython(image)) continue;
    cachedImage = image;
    return cachedImage;
  }
  if (process.env.SILVER_CHECKER_PULL === "1") {
    const want = pinned ?? "python:3-alpine";
    const pull = spawnSync("docker", ["pull", want], { encoding: "utf8", timeout: 120_000 });
    if (pull.status === 0 && imageExists(want) && imageHasPython(want)) {
      cachedImage = want;
      return cachedImage;
    }
  }
  return undefined;
}
