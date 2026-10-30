import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CELL_MOUNT,
  CHALLENGE_LABEL,
  EPHEMERAL_HOME,
  MISSION_LABEL,
  OWNER_LABEL,
  OWNER_VALUE,
  REPO_MOUNT,
  WORKDIR,
} from "@silver/protocol";
import { cidfilePath, readCidfileContainerId, validateContainerId } from "./cidfile.ts";
import { isNotFound, runControl, runCreate } from "./docker.ts";
import { OwnershipError, PathError } from "./errors.ts";
import { isSymlink, prepareExecutionView, safeChallengeDir, safeExistingDir, safeExistingFile } from "./fs-safe.ts";
import type {
  ContainerHandle,
  DockerClient,
  DockerExecResult,
  DockerPopenResult,
  NetworkMode,
  StartCellRequest,
} from "./types.ts";
import { CONTAINER_NAME_RE, ENV_NAME_RE, TARGET_ID_RE } from "./types.ts";

export interface IsolationHostOptions {
  docker: DockerClient;
}

function uid(): number {
  return os.userInfo().uid;
}

function gid(): number {
  return os.userInfo().gid;
}

function slug(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "cell").slice(0, 32);
}

function handleFor(
  missionId: string,
  challengeId: string,
  repoRoot: string,
  targetDir: string,
): ContainerHandle {
  const digest = crypto
    .createHash("sha256")
    .update(`${missionId}\0${challengeId}\0${repoRoot}\0${targetDir}`)
    .digest("hex")
    .slice(0, 12);
  const name = `silver-cell-${slug(missionId)}-${slug(challengeId)}-${digest}`.slice(0, 128);
  return { name, containerId: "", missionId, challengeId };
}

function labels(handle: ContainerHandle): Record<string, string> {
  return {
    [OWNER_LABEL]: OWNER_VALUE,
    [MISSION_LABEL]: handle.missionId,
    [CHALLENGE_LABEL]: handle.challengeId,
  };
}

function networkArgs(mode: NetworkMode): string[] {
  if (mode === "bridge") {
    return ["--network", "bridge", "--add-host", "host.docker.internal:host-gateway"];
  }
  if (mode === "host") {
    return ["--network", "host"];
  }
  throw new PathError("invalid challenge network mode");
}

function readonlyFileMountArgs(mounts: ReadonlyArray<readonly [string, string]>): string[] {
  const args: string[] = [];
  for (const [source, destination] of mounts) {
    const src = safeExistingFile(source, "executor auth file");
    const dst = String(destination);
    if (
      dst.endsWith("/") ||
      (!dst.startsWith(`${EPHEMERAL_HOME}/`) && dst !== "/work/.container-runtime/execution/.secrets/runtime-capabilities.json")
    ) {
      throw new PathError("executor auth mount destination is unsafe");
    }
    args.push("--mount", `type=bind,src=${src},dst=${dst},readonly`);
  }
  return args;
}

function authParentTmpfsArgs(mounts: ReadonlyArray<readonly [string, string]>): string[] {
  const parents = new Set<string>();
  for (const [, destination] of mounts) {
    if (destination.startsWith(`${EPHEMERAL_HOME}/.grok/`)) parents.add(`${EPHEMERAL_HOME}/.grok`);
    if (destination.startsWith(`${EPHEMERAL_HOME}/.claude/`)) parents.add(`${EPHEMERAL_HOME}/.claude`);
  }
  const args: string[] = [];
  for (const parent of [...parents].sort()) {
    args.push("--tmpfs", `${parent}:rw,nosuid,nodev,uid=${uid()},gid=${gid()},mode=700`);
  }
  return args;
}

function inspectContainerId(containerId: string, docker: DockerClient): Record<string, unknown> | undefined {
  const id = validateContainerId(containerId);
  try {
    const result = runControl(docker, ["docker", "inspect", id]);
    const payload = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(payload) || payload.length !== 1 || typeof payload[0] !== "object" || payload[0] === null) {
      throw new OwnershipError("docker inspect returned an unexpected payload");
    }
    return payload[0] as Record<string, unknown>;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    if (err instanceof OwnershipError) throw err;
    throw new OwnershipError("docker inspect failed");
  }
}

function validateHandle(handle: ContainerHandle): void {
  try {
    validateContainerId(handle.containerId);
  } catch (err) {
    throw new OwnershipError("invalid container handle id");
  }
  if (!CONTAINER_NAME_RE.test(handle.name)) {
    throw new OwnershipError("invalid container handle name");
  }
  if (!TARGET_ID_RE.test(handle.missionId)) {
    throw new OwnershipError("invalid container handle execution id");
  }
  if (!TARGET_ID_RE.test(handle.challengeId)) {
    throw new OwnershipError("invalid container handle target id");
  }
}

function assertContainer(handle: ContainerHandle, container: Record<string, unknown>): void {
  if (container.Id !== handle.containerId) {
    throw new OwnershipError(`container ${handle.containerId} id mismatch`);
  }
  if (String(container.Name ?? "").replace(/^\//, "") !== handle.name) {
    throw new OwnershipError(`container ${handle.containerId} name mismatch`);
  }
  const config = container.Config;
  if (typeof config !== "object" || config === null) {
    throw new OwnershipError(`container ${handle.containerId} missing config`);
  }
  const rawLabels = (config as { Labels?: unknown }).Labels;
  if (typeof rawLabels !== "object" || rawLabels === null) {
    throw new OwnershipError(`container ${handle.containerId} missing labels`);
  }
  const expected = labels(handle);
  for (const [key, value] of Object.entries(expected)) {
    if ((rawLabels as Record<string, unknown>)[key] !== value) {
      throw new OwnershipError(`container ${handle.containerId} label ${key} mismatch`);
    }
  }
}

function requireOwned(handle: ContainerHandle, docker: DockerClient): void {
  const container = inspectContainerId(handle.containerId, docker);
  if (!container) throw new OwnershipError(`container not found: ${handle.containerId}`);
  assertContainer(handle, container);
}

function removeContainer(handle: ContainerHandle, docker: DockerClient): boolean {
  validateHandle(handle);
  try {
    runControl(docker, ["docker", "rm", "-f", handle.containerId]);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw new OwnershipError("docker rm failed");
  }
}

function cleanupCidfileContainer(
  handle: ContainerHandle,
  cidfile: string,
  execDir: string,
  docker: DockerClient,
): void {
  if (!fs.existsSync(cidfile) && !isSymlink(cidfile)) return;
  const containerId = readCidfileContainerId(cidfile, execDir);
  const recovered: ContainerHandle = { ...handle, containerId };
  const container = inspectContainerId(containerId, docker);
  if (!container) {
    fs.unlinkSync(cidfile);
    return;
  }
  assertContainer(recovered, container);
  removeContainer(recovered, docker);
  fs.unlinkSync(cidfile);
}

export class IsolationHost {
  private readonly docker: DockerClient;

  constructor(docker: DockerClient) {
    this.docker = docker;
  }

  startCell(request: StartCellRequest): ContainerHandle {
    const repo = safeExistingDir(request.repoRoot, "repo root");
    const execution = safeExistingDir(request.execDir, "execution");
    const target = safeChallengeDir(execution, request.challengeId);
    const mounts = request.readonlyFileMounts ?? [];
    const mode = request.networkMode ?? "bridge";
    const cidfile = cidfilePath(execution, request.challengeId);
    const handle = handleFor(path.basename(execution), request.challengeId, repo, target);
    cleanupCidfileContainer(handle, cidfile, execution, this.docker);
    prepareExecutionView(target, request.challengeId);
    const command = [
      "docker",
      "create",
      "--name",
      handle.name,
      "--cidfile",
      cidfile,
      "--label",
      `${OWNER_LABEL}=${OWNER_VALUE}`,
      "--label",
      `${MISSION_LABEL}=${handle.missionId}`,
      "--label",
      `${CHALLENGE_LABEL}=${handle.challengeId}`,
      "--workdir",
      WORKDIR,
      "--env",
      `HOME=${EPHEMERAL_HOME}`,
      "--user",
      `${uid()}:${gid()}`,
      ...networkArgs(mode),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,mode=1777",
      "--tmpfs",
      "/run:rw,nosuid,nodev,mode=755",
      "--tmpfs",
      `${EPHEMERAL_HOME}:rw,nosuid,nodev,uid=${uid()},gid=${gid()},mode=700`,
      ...authParentTmpfsArgs(mounts),
      "--mount",
      `type=bind,src=${repo},dst=${REPO_MOUNT},readonly`,
      "--mount",
      `type=bind,src=${target},dst=${CELL_MOUNT}`,
      ...readonlyFileMountArgs(mounts),
      "--entrypoint",
      "sleep",
      request.image,
      "infinity",
    ];
    let created: ContainerHandle | undefined;
    try {
      const result = runCreate(this.docker, command);
      const containerId = validateContainerId(result.stdout.trim());
      created = { ...handle, containerId };
      if (readCidfileContainerId(cidfile, execution) !== containerId) {
        throw new OwnershipError("docker cidfile did not match created container");
      }
      requireOwned(created, this.docker);
      runControl(this.docker, ["docker", "start", created.containerId]);
      requireOwned(created, this.docker);
      return created;
    } catch (original) {
      if (created) {
        try {
          removeContainer(created, this.docker);
        } catch (cleanupError) {
          throw new OwnershipError(
            `start failed for container ${created.containerId}; original error: ${String(original)}; cleanup failed: ${String(cleanupError)}`,
          );
        }
      }
      throw original;
    }
  }

  stopCell(handle: ContainerHandle): boolean {
    validateHandle(handle);
    const container = inspectContainerId(handle.containerId, this.docker);
    if (!container) return false;
    assertContainer(handle, container);
    return removeContainer(handle, this.docker);
  }

  spawnWorker(
    handle: ContainerHandle,
    argv: string[],
    env: Record<string, string> = {},
  ): DockerPopenResult & { argv: string[]; clientEnv: NodeJS.ProcessEnv } {
    if (argv.length === 0) throw new Error("worker argv must not be empty");
    requireOwned(handle, this.docker);
    const { envArgs, clientEnv } = dockerExecEnv(env);
    const command = [
      "docker",
      "exec",
      "-i",
      "--workdir",
      WORKDIR,
      ...envArgs,
      handle.containerId,
      ...argv,
    ];
    const proc = this.docker.popen(command, { env: clientEnv, shell: false });
    return { ...proc, pid: proc.pid, argv: command, clientEnv };
  }

  /**
   * One-shot `docker exec`. Async so Host RPC / LLM broker can serve the cell
   * while the command runs. Values travel in the docker client env, not `--env KEY=value`.
   */
  async execOnce(
    handle: ContainerHandle,
    argv: string[],
    env: Record<string, string> = {},
    timeoutSec = 600,
  ): Promise<DockerExecResult> {
    if (argv.length === 0) throw new Error("exec argv must not be empty");
    requireOwned(handle, this.docker);
    const { envArgs, clientEnv } = dockerExecEnv(env);
    const command = ["docker", "exec", "--workdir", WORKDIR, ...envArgs, handle.containerId, ...argv];
    const proc = this.docker.popen(command, { env: clientEnv, shell: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    proc.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    const status = await waitPopenExit(proc, timeoutSec);
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (status !== 0) {
      const err = new Error(stderr || "docker command failed") as Error & {
        status: number;
        stderr: string;
        stdout: string;
      };
      err.status = status ?? 1;
      err.stderr = stderr;
      err.stdout = stdout;
      throw err;
    }
    return { stdout, stderr, argv: command, clientEnv };
  }
}

function waitPopenExit(proc: DockerPopenResult, timeoutSec: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    proc.exit.then((row) => {
      if (timer) clearTimeout(timer);
      return row.status;
    }),
    new Promise<number | null>((_, reject) => {
      timer = setTimeout(() => {
        proc.kill?.();
        const err = new Error("docker exec timed out") as Error & { code: string };
        err.code = "ETIMEDOUT";
        reject(err);
      }, timeoutSec * 1000);
    }),
  ]);
}

/** `--env KEY` copies from the docker client env. PATH is the spawnWorker exception. */
export function dockerExecEnv(env: Record<string, string>): {
  envArgs: string[];
  clientEnv: NodeJS.ProcessEnv;
} {
  const envArgs: string[] = [];
  for (const key of Object.keys(env).sort()) {
    if (!ENV_NAME_RE.test(key)) throw new Error(`invalid container env name: ${key}`);
    if (key === "PATH") envArgs.push("--env", `PATH=${env[key]}`);
    else envArgs.push("--env", key);
  }
  const clientEnv: NodeJS.ProcessEnv = { ...env };
  if (process.env.PATH) clientEnv.PATH = process.env.PATH;
  for (const key of ["PATH", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"] as const) {
    if (clientEnv[key] === undefined && process.env[key]) clientEnv[key] = process.env[key];
  }
  return { envArgs, clientEnv };
}

export { readCidfileContainerId };
