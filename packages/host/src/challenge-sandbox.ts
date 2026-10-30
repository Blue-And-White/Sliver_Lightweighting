import fs from "node:fs";
import path from "node:path";
import {
  IsolationHost,
  type ContainerHandle,
  type DockerExecResult,
  type DockerPopenResult,
} from "@silver/isolation";
import { REPO_MOUNT, WORKDIR } from "@silver/protocol";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  spawnOfficialDshAcpSession,
  type OfficialDshAcpModelSelection,
} from "./dsh-acp-client.ts";
import { assertNoLlmSecretsInCellEnv, officialDshNodeArgv } from "./live-dsh.ts";

export const CELL_RUNTIME_MOUNT = "/opt/silver-runtime";
export const CELL_DSH_BIN = `${CELL_RUNTIME_MOUNT}/node_modules/@deepseek-ai/dsh/lib/bin.js`;

const PRIVATE_HOST_CHANNEL_MARKER = "silver-private-host-channel";
const PRIVATE_HOST_CHANNEL_WRAPPER = [
  "set -eu",
  "umask 077",
  'channel_file="/tmp/silver-host-channel-$$"',
  'IFS= read -r channel',
  'printf "%s" "$channel" > "$channel_file"',
  'exec 3<"$channel_file"',
  'rm -f "$channel_file"',
  'exec "$@"',
].join("\n");

export interface ChallengeCell {
  challengeId: string;
  workspace: string;
}

export interface ChallengeSandbox {
  attach(spec: ChallengeCell): { containerId?: string };
  detach(challengeId: string): void;
  detachAll(): void;
  startRuntime?(challengeId: string): DockerPopenResult | undefined;
  mapPath?(hostPath: string, challengeId: string): string;
}

/** IsolationHost cell directory: execDir/targets/<challengeId>. */
export function isolationCellDir(execDir: string, challengeId: string): string {
  return path.join(execDir, "targets", challengeId);
}

function ensureChallengeDirs(root: string): void {
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(root, "intel"), { recursive: true });
  fs.mkdirSync(path.join(root, "workspace", "artifacts"), { recursive: true });
}

/** Cell Node resolves plugins from the Linux runtime baked into the cell image. */
function ensureCellNodeModulesLink(cellRoot: string): void {
  const dest = path.join(cellRoot, "workspace", "node_modules");
  const src = `${CELL_RUNTIME_MOUNT}/node_modules`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink() && fs.readlinkSync(dest) === src) return;
    fs.rmSync(dest, { recursive: true, force: true });
  } catch {
    // absent: create below
  }
  fs.symlinkSync(src, dest);
}

/**
 * HostFs live needs local workspace plugins resolvable from the attempt cwd.
 * Link only Silver's Cordis plugin package, not the whole repository node_modules tree.
 */
export function linkHostFsCtfSpinePackage(dir: string, repoRoot: string): void {
  const nodeModules = path.join(dir, "node_modules");
  try {
    if (fs.lstatSync(nodeModules).isSymbolicLink()) fs.rmSync(nodeModules, { recursive: true, force: true });
  } catch {
    // absent: create the scoped package link below
  }
  const scope = path.join(nodeModules, "@silver");
  const dest = path.join(scope, "ctf-spine");
  const src = path.join(repoRoot, "packages", "ctf-spine");
  fs.mkdirSync(scope, { recursive: true });
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink() && fs.readlinkSync(dest) === src) return;
    fs.rmSync(dest, { recursive: true, force: true });
  } catch {
    // absent: create below
  }
  fs.symlinkSync(src, dest);
}

/** Dummy capability container id for the host filesystem sandbox. Not a Docker cid. */
export const HOSTFS_CONTAINER_ID = "h".repeat(64);

/** Default: host filesystem sandbox only. v1 live and run:mini; not IsolationHost. */
export class HostFsSandbox implements ChallengeSandbox {
  attach(spec: ChallengeCell): { containerId?: string } {
    ensureChallengeDirs(spec.workspace);
    return {};
  }

  detach(_challengeId: string): void {}

  detachAll(): void {}
}

/** One IsolationHost cell per challenge. Sibling challenge dirs are not mounted. */
export class IsolationSandbox implements ChallengeSandbox {
  private readonly isolation: IsolationHost;
  private readonly repoRoot: string;
  private readonly execDir: string;
  private readonly image: string;
  private readonly mapCellPaths: boolean;
  private readonly workerArgv: string[];
  private readonly handles = new Map<string, ContainerHandle>();

  constructor(input: {
    isolation: IsolationHost;
    repoRoot: string;
    execDir: string;
    image: string;
    mapCellPaths?: boolean;
    workerArgv?: string[];
  }) {
    this.isolation = input.isolation;
    this.repoRoot = input.repoRoot;
    this.execDir = input.execDir;
    this.image = input.image;
    this.mapCellPaths = input.mapCellPaths ?? true;
    this.workerArgv =
      input.workerArgv ??
      officialDshNodeArgv({
        dshBin: CELL_DSH_BIN,
      });
  }

  attach(spec: ChallengeCell): { containerId?: string } {
    fs.mkdirSync(this.repoRoot, { recursive: true });
    const cell = isolationCellDir(this.execDir, spec.challengeId);
    ensureChallengeDirs(cell);
    if (path.resolve(spec.workspace) !== path.resolve(cell)) ensureChallengeDirs(spec.workspace);
    const handle = this.isolation.startCell({
      repoRoot: this.repoRoot,
      execDir: this.execDir,
      challengeId: spec.challengeId,
      image: this.image,
    });
    this.handles.set(spec.challengeId, handle);
    return { containerId: handle.containerId };
  }

  detach(challengeId: string): void {
    const handle = this.handles.get(challengeId);
    if (!handle) return;
    this.isolation.stopCell(handle);
    this.handles.delete(challengeId);
  }

  detachAll(): void {
    for (const id of [...this.handles.keys()]) this.detach(id);
  }

  startRuntime(challengeId: string): DockerPopenResult | undefined {
    const handle = this.handles.get(challengeId);
    if (!handle) return undefined;
    return this.isolation.spawnWorker(handle, this.workerArgv);
  }

  /** Official dsh ACP inside this challenge cell. Host drives the official session protocol over docker exec stdio. */
  spawnOfficialDshAcpSession(
    challengeId: string,
    input: {
      repoRoot: string;
      cwd: string;
      task: string | ContentBlock | ContentBlock[];
      env?: NodeJS.ProcessEnv;
      patches?: readonly string[];
      timeoutMs: number;
      modelSelection?: OfficialDshAcpModelSelection;
      signal?: AbortSignal;
    },
  ): ReturnType<typeof spawnOfficialDshAcpSession> {
    const handle = this.handles.get(challengeId);
    if (!handle) throw new Error(`challenge ${challengeId} has no IsolationHost cell`);
    const env = {
      HOME: "/tmp/silver-home",
      SILVER_CWD: WORKDIR,
      ...(input.env ?? {}),
    };
    assertNoLlmSecretsInCellEnv(env);
    ensureCellNodeModulesLink(isolationCellDir(this.execDir, challengeId));
    const patches = [
      `${REPO_MOUNT}/packages/ctf-spine/cordis.patch.yml`,
      ...(input.patches ?? []),
    ];
    const argv = officialDshNodeArgv({
      nodeBin: this.workerArgv[0] ?? "node",
      dshBin: this.workerArgv.find((row) => row.includes("@deepseek-ai/dsh/lib/bin.js")) ?? CELL_DSH_BIN,
      exposeInternals: this.workerArgv.includes("--expose-internals"),
      profile: "acp",
      patches,
    });
    return spawnOfficialDshAcpSession({
      repoRoot: input.repoRoot,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env,
      prompt: input.task,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      spawnProcess: (request) => {
        const channel = request.privateHostChannel;
        const workerArgv = channel
          ? ["/bin/sh", "-c", PRIVATE_HOST_CHANNEL_WRAPPER, PRIVATE_HOST_CHANNEL_MARKER, ...argv]
          : argv;
        if (channel && channel.fd !== 3) {
          throw new Error(`unsupported isolated private Host channel fd ${channel.fd}`);
        }
        const child = this.isolation.spawnWorker(handle, workerArgv, definedEnv(request.env));
        if (!channel) return child;
        if (!child.stdin || typeof child.stdin.write !== "function") {
          child.kill?.("SIGKILL");
          throw new Error("isolated DSH private Host channel requires writable stdin");
        }
        child.stdin.write(`${channel.payload}\n`);
        return child;
      },
    });
  }

  /** No model, no task: prove official dsh exists in this Node cell. */
  probeOfficialDsh(challengeId: string): Promise<DockerExecResult> {
    const handle = this.handles.get(challengeId);
    if (!handle) throw new Error(`challenge ${challengeId} has no IsolationHost cell`);
    const nodeBin = this.workerArgv[0] ?? "node";
    const dshBin = this.workerArgv.find((row) => row.includes("@deepseek-ai/dsh/lib/bin.js")) ?? CELL_DSH_BIN;
    return this.isolation.execOnce(handle, [nodeBin, dshBin, "--help"], { HOME: "/tmp/silver-home" }, 60);
  }

  execOnce(
    challengeId: string,
    argv: string[],
    env: Record<string, string> = {},
    timeoutSec = 60,
  ): Promise<DockerExecResult> {
    const handle = this.handles.get(challengeId);
    if (!handle) throw new Error(`challenge ${challengeId} has no IsolationHost cell`);
    return this.isolation.execOnce(handle, argv, env, timeoutSec);
  }

  mapPath(hostPath: string, challengeId: string): string {
    if (!this.mapCellPaths) return hostPath;
    const cell = isolationCellDir(this.execDir, challengeId);
    const rel = path.relative(cell, hostPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return hostPath;
    return `/work/${rel.split(path.sep).join("/")}`;
  }
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
