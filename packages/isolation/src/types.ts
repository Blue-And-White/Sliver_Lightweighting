export interface ContainerHandle {
  name: string;
  containerId: string;
  missionId: string;
  challengeId: string;
}

export type NetworkMode = "bridge" | "host";

export interface StartCellRequest {
  repoRoot: string;
  execDir: string;
  challengeId: string;
  image: string;
  networkMode?: NetworkMode;
  readonlyFileMounts?: ReadonlyArray<readonly [string, string]>;
}

export interface DockerRunResult {
  stdout: string;
  stderr: string;
}

export interface DockerPopenResult {
  pid: number;
  stdin?: NodeJS.WritableStream;
  stdout?: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill?: (signal?: NodeJS.Signals | number) => void;
  /** Settles when the process exits. Required so execOnce does not block the Host event loop. */
  exit: Promise<{ status: number | null }>;
}

export interface DockerRunOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface DockerExecResult extends DockerRunResult {
  argv: string[];
  clientEnv: NodeJS.ProcessEnv;
}

export interface DockerClient {
  run(argv: string[], options?: DockerRunOptions): DockerRunResult;
  popen(
    argv: string[],
    options: { env: NodeJS.ProcessEnv; shell: boolean },
  ): DockerPopenResult;
}

export const CONTROL_TIMEOUT_SECONDS = 5;

export const TARGET_ID_RE = /^[A-Za-z0-9_.-]+$/;
export const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
