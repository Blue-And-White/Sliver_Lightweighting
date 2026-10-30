import { spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  client as createAcpClient,
  methods,
  ndJsonStream,
  RequestError,
  type AgentCapabilities,
  type ClientContext,
  type ContentBlock,
  type SessionConfigOption,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { officialDshHostInvocation } from "./live-dsh.ts";
import type { LiveRunStopReason } from "./live-run-ledger.ts";
import { HOST_CHANNEL_FD_ENV } from "@silver/ctf-spine";

// DSH owns descendant cleanup. Its process shutdown is bounded at five seconds,
// so Silver's SIGKILL fallback must leave that teardown enough time to finish.
const ACP_STOP_SIGTERM_MS = 5_000;
const ACP_STOP_SIGKILL_MS = 10_000;
const ACP_EXIT_WAIT_MS = 6_000;
const ACP_SIGKILL_EXIT_WAIT_MS = 1_000;

export interface OfficialDshAcpProcess {
  pid?: number;
  stdin?: NodeJS.WritableStream;
  stdout?: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill?: (signal?: NodeJS.Signals | number) => boolean | void;
  exit?: Promise<{ status: number | null }>;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  once?: (event: "exit", listener: () => void) => unknown;
  stdio?: Array<NodeJS.ReadableStream | NodeJS.WritableStream | null>;
}

export interface OfficialDshAcpSpawnRequest {
  command: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  privateHostChannel?: { fd: number; payload: string };
}

const HOST_CHANNEL_FD = 3;

export function prepareOfficialDshHostChannel(base: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  privateHostChannel?: { fd: number; payload: string };
} {
  const env = acpSpawnEnv(base);
  const capability = env.SILVER_HOST_CAPABILITY?.trim();
  const submitPath = env.SILVER_CONVERGENCE_SUBMIT_PATH?.trim();
  delete env.SILVER_HOST_CAPABILITY;
  delete env.SILVER_CONVERGENCE_SUBMIT_PATH;
  if (!capability && !submitPath) return { env };
  env[HOST_CHANNEL_FD_ENV] = String(HOST_CHANNEL_FD);
  return {
    env,
    privateHostChannel: {
      fd: HOST_CHANNEL_FD,
      payload: JSON.stringify({ ...(capability ? { capability } : {}), ...(submitPath ? { submitPath } : {}) }),
    },
  };
}

export interface OfficialDshAcpProbe {
  kernel: "official-dsh";
  profile: "acp";
  command: string;
  protocolVersion: number;
  agentName: string | null;
  sessionNew: boolean;
  sessionList: boolean;
  sessionResume: boolean;
  sessionClose: boolean;
  sessionCount: number;
}

export interface OfficialDshAcpPersistenceProbe {
  kernel: "official-dsh";
  profile: "acp";
  createdSessionId: string;
  listedAfterRestart: boolean;
  resumeRequestSucceeded: boolean;
  closeRequestSucceeded: boolean;
  listedAfterCloseRestart: boolean;
  configOptionCount: number;
}

export interface OfficialDshAcpPromptProbe {
  kernel: "official-dsh";
  profile: "acp";
  sessionId: string;
  resumed: boolean;
  closed: boolean;
  stopReason: StopReason;
  updateKinds: string[];
  text: string;
}

export interface OfficialDshAcpCancelProbe {
  kernel: "official-dsh";
  profile: "acp";
  sessionId: string;
  cancelRequestSucceeded: boolean;
  closed: boolean;
  stopReason: StopReason;
  updateKinds: string[];
}

export interface OfficialDshAcpModelSelectionProbe {
  kernel: "official-dsh";
  profile: "acp";
  sessionId: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  selected: boolean;
  closed: boolean;
}

export interface OfficialDshAcpSessionResult {
  status: number;
  stdout: string;
  stderr: string;
  dshSessionId?: string;
  resumed?: boolean;
  closed?: boolean;
  dshProcessRestarts?: number;
  stopReason?: LiveRunStopReason;
  acpStopReason?: StopReason;
}

/**
 * Identify the recoverable provider/transport rejection emitted by DSH ACP for
 * a failed prompt turn. Keep cancellation and unrelated ACP failures on their
 * existing error path; callers use this only to enter the bounded session
 * resume flow.
 */
export function isOfficialDshAcpPromptTransportError(error: unknown): boolean {
  if (error instanceof RequestError && error.code === -32800) return false;
  const row = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const data = row?.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : undefined;
  const stableCode = [row?.code, data?.code, data?.errorType]
    .find((value) => typeof value === "string")
    ?.toString()
    .toUpperCase();
  if (stableCode === "TRANSPORT" || stableCode === "UPSTREAM_UNAVAILABLE") return true;
  if (error instanceof RequestError && error.code !== -32603) return false;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\b(?:connection error|network error|upstream unavailable|transport failure budget|rate limit(?:ed)?|too many requests|fetch failed|socket hang up|connection (?:closed|reset)|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|HTTP (?:429|50[0-4]))\b/iu.test(
    message,
  );
}

export interface OfficialDshAcpModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export async function probeOfficialDshAcp(input: {
  repoRoot: string;
  cwd?: string;
  patches?: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<OfficialDshAcpProbe> {
  return withOfficialDshAcp(input, async (ctx, invocation) => {
    const init = await initializeAcp(ctx);
    const capabilities = init.agentCapabilities ?? {};
    assertAcpSessionCapabilities(capabilities);
    const cwd = path.resolve(input.cwd ?? input.repoRoot);
    const sessions = await ctx.request(methods.agent.session.list, { cwd });
    const created = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
    await ctx.request(methods.agent.session.close, { sessionId: created.sessionId });
    return {
      kernel: "official-dsh",
      profile: "acp",
      command: invocation.command,
      protocolVersion: init.protocolVersion,
      agentName: init.agentInfo?.name ?? null,
      sessionNew: Boolean(created.sessionId),
      sessionList: Boolean(capabilities.sessionCapabilities?.list),
      sessionResume: Boolean(capabilities.sessionCapabilities?.resume),
      sessionClose: Boolean(capabilities.sessionCapabilities?.close),
      sessionCount: sessions.sessions.length,
    };
  });
}

/**
 * Resume one existing official ACP session without opening a new one.
 * Used to prove V2→V3 storage migration on a copied historical session.
 */
export async function resumeExistingOfficialDshAcpSession(input: {
  repoRoot: string;
  cwd?: string;
  patches?: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
}): Promise<{
  listedSessionIds: string[];
  listedTarget: boolean;
  resumedSessionId: string;
  closeRequestSucceeded: boolean;
}> {
  const cwd = path.resolve(input.cwd ?? input.repoRoot);
  return withOfficialDshAcp(input, async (ctx) => {
    await initializeAcp(ctx);
    const listed = await ctx.request(methods.agent.session.list, { cwd });
    const listedSessionIds = listed.sessions.map((row) => row.sessionId);
    await ctx.request(methods.agent.session.resume, {
      cwd,
      sessionId: input.sessionId,
      mcpServers: [],
    });
    await ctx.request(methods.agent.session.close, { sessionId: input.sessionId });
    return {
      listedSessionIds,
      listedTarget: listedSessionIds.includes(input.sessionId),
      resumedSessionId: input.sessionId,
      closeRequestSucceeded: true,
    };
  });
}

export async function probeOfficialDshAcpPersistence(input: {
  repoRoot: string;
  cwd?: string;
  patches?: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<OfficialDshAcpPersistenceProbe> {
  const cwd = path.resolve(input.cwd ?? input.repoRoot);
  const created = await withOfficialDshAcp(input, async (ctx) => {
    await initializeAcp(ctx);
    return await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
  });
  const listed = await withOfficialDshAcp(input, async (ctx) => {
    await initializeAcp(ctx);
    return await ctx.request(methods.agent.session.list, { cwd });
  });
  const resumed = await withOfficialDshAcp(input, async (ctx) => {
    await initializeAcp(ctx);
    const out = await ctx.request(methods.agent.session.resume, {
      cwd,
      sessionId: created.sessionId,
      mcpServers: [],
    });
    await ctx.request(methods.agent.session.close, { sessionId: created.sessionId });
    return out;
  });
  const afterClose = await withOfficialDshAcp(input, async (ctx) => {
    await initializeAcp(ctx);
    return await ctx.request(methods.agent.session.list, { cwd });
  });
  return {
    kernel: "official-dsh",
    profile: "acp",
    createdSessionId: created.sessionId,
    listedAfterRestart: listed.sessions.some((row) => row.sessionId === created.sessionId),
    resumeRequestSucceeded: true,
    closeRequestSucceeded: true,
    listedAfterCloseRestart: afterClose.sessions.some((row) => row.sessionId === created.sessionId),
    configOptionCount: resumed.configOptions?.length ?? 0,
  };
}

export async function probeOfficialDshAcpPrompt(input: {
  repoRoot: string;
  cwd?: string;
  patches?: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  prompt: string | ContentBlock | ContentBlock[];
  sessionId?: string;
  closeSession?: boolean;
}): Promise<OfficialDshAcpPromptProbe> {
  const cwd = path.resolve(input.cwd ?? input.repoRoot);
  const updates: SessionNotification[] = [];
  let activeSessionId = input.sessionId;
  let closed = false;

  return await withOfficialDshAcp(
    input,
    async (ctx) => {
      await initializeAcp(ctx);
      const resumed = activeSessionId !== undefined;
      if (activeSessionId) {
        await ctx.request(methods.agent.session.resume, { cwd, sessionId: activeSessionId, mcpServers: [] });
      } else {
        const created = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        activeSessionId = created.sessionId;
      }

      try {
        const response = await ctx.request(methods.agent.session.prompt, {
          sessionId: activeSessionId,
          prompt: promptBlocks(input.prompt),
        });
        closed = await maybeCloseAcpSession(ctx, activeSessionId, input.closeSession ?? true);

        return {
          kernel: "official-dsh",
          profile: "acp",
          sessionId: activeSessionId,
          resumed,
          closed,
          stopReason: response.stopReason,
          updateKinds: updates.map((row) => row.update.sessionUpdate),
          text: updates.map(textFromUpdate).filter(Boolean).join(""),
        };
      } finally {
        if ((input.closeSession ?? true) && activeSessionId && !closed) {
          closed = await maybeCloseAcpSession(ctx, activeSessionId, true);
        }
      }
    },
    {
      onSessionUpdate(notification) {
        if (!activeSessionId || notification.sessionId !== activeSessionId) return;
        updates.push(notification);
      },
    },
  );
}

export async function probeOfficialDshAcpCancel(input: {
  repoRoot: string;
  cwd?: string;
  patches?: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  prompt: string | ContentBlock | ContentBlock[];
  cancelAfterMs?: number;
  closeSession?: boolean;
}): Promise<OfficialDshAcpCancelProbe> {
  const cwd = path.resolve(input.cwd ?? input.repoRoot);
  const updates: SessionNotification[] = [];
  let sessionId = "";
  let closed = false;

  return await withOfficialDshAcp(
    input,
    async (ctx) => {
      await initializeAcp(ctx);
      const created = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
      sessionId = created.sessionId;
      const prompt = ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: promptBlocks(input.prompt),
      });
      await sleep(input.cancelAfterMs ?? 100);
      await ctx.notify(methods.agent.session.cancel, { sessionId });
      const response = await prompt;
      closed = await maybeCloseAcpSession(ctx, sessionId, input.closeSession ?? true);
      return {
        kernel: "official-dsh",
        profile: "acp",
        sessionId,
        cancelRequestSucceeded: true,
        closed,
        stopReason: response.stopReason,
        updateKinds: updates.map((row) => row.update.sessionUpdate),
      };
    },
    {
      onSessionUpdate(notification) {
        if (!sessionId || notification.sessionId !== sessionId) return;
        updates.push(notification);
      },
    },
  );
}

export async function probeOfficialDshAcpModelSelection(input: {
  repoRoot: string;
  cwd?: string;
  patches?: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  modelSelection: OfficialDshAcpModelSelection;
}): Promise<OfficialDshAcpModelSelectionProbe> {
  const cwd = path.resolve(input.cwd ?? input.repoRoot);
  let sessionId = "";
  let closed = false;
  return await withOfficialDshAcp(input, async (ctx) => {
    await initializeAcp(ctx);
    const created = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
    sessionId = created.sessionId;
    try {
      await selectOfficialAcpModel(ctx, sessionId, created.configOptions ?? [], input.modelSelection);
      closed = await maybeCloseAcpSession(ctx, sessionId, true);
      return {
        kernel: "official-dsh",
        profile: "acp",
        sessionId,
        provider: input.modelSelection.provider,
        model: input.modelSelection.model,
        ...(input.modelSelection.reasoningEffort && !["default", "off"].includes(input.modelSelection.reasoningEffort)
          ? { reasoningEffort: input.modelSelection.reasoningEffort }
          : {}),
        selected: true,
        closed,
      };
    } finally {
      if (!closed) closed = await maybeCloseAcpSession(ctx, sessionId, true).catch(() => false);
    }
  });
}

export interface OfficialDshAcpPromptResult {
  sessionId: string;
  resumed: boolean;
  closed: boolean;
  stopReason: StopReason;
  updateKinds: string[];
  text: string;
  updates: SessionNotification[];
}

export interface OfficialDshAcpProcessHandle {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export interface OfficialDshAcpSessionApi {
  prompt: (request: {
    prompt: string | ContentBlock | ContentBlock[];
    sessionId?: string;
    closeSession?: boolean;
  }) => Promise<OfficialDshAcpPromptResult>;
  /** Close the active ACP session without killing the DSH process yet. */
  closeActiveSession: () => Promise<boolean>;
  process: OfficialDshAcpProcessHandle;
}

/**
 * Drive multiple official ACP prompts on one DSH process.
 * Composition tests use this to resume the Lead between turns without a
 * Silver-owned agent loop.
 */
export async function withOfficialDshAcpSession<T>(
  input: {
    repoRoot: string;
    cwd?: string;
    patches?: readonly string[];
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
  op: (api: OfficialDshAcpSessionApi) => Promise<T>,
): Promise<T> {
  let activeSessionId: string | undefined;
  let sessionLive = false;
  let updates: SessionNotification[] = [];
  let initialized = false;
  return withOfficialDshAcp(
    input,
    async (ctx, _invocation, proc) => {
      const processHandle: OfficialDshAcpProcessHandle = {
        get pid() {
          return proc.pid;
        },
        get exitCode() {
          return proc.exitCode;
        },
        get signalCode() {
          return proc.signalCode;
        },
      };
      return await op({
        process: processHandle,
        async closeActiveSession() {
          if (!activeSessionId || !sessionLive) return false;
          const closed = await maybeCloseAcpSession(ctx, activeSessionId, true);
          if (closed) sessionLive = false;
          return closed;
        },
        async prompt(request) {
          if (!initialized) {
            await initializeAcp(ctx);
            initialized = true;
          }
          const cwd = path.resolve(input.cwd ?? input.repoRoot);
          updates = [];
          const requestedId = request.sessionId ?? activeSessionId;
          let resumed = false;
          if (requestedId && sessionLive && requestedId === activeSessionId) {
            // Same open session in this process — prompt again without resume.
          } else if (requestedId) {
            await ctx.request(methods.agent.session.resume, {
              cwd,
              sessionId: requestedId,
              mcpServers: [],
            });
            activeSessionId = requestedId;
            sessionLive = true;
            resumed = true;
          } else {
            const created = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
            activeSessionId = created.sessionId;
            sessionLive = true;
          }
          const response = await ctx.request(methods.agent.session.prompt, {
            sessionId: activeSessionId!,
            prompt: promptBlocks(request.prompt),
          });
          const closed = await maybeCloseAcpSession(ctx, activeSessionId!, request.closeSession ?? false);
          if (closed) sessionLive = false;
          return {
            sessionId: activeSessionId!,
            resumed,
            closed,
            stopReason: response.stopReason,
            updateKinds: updates.map((row) => row.update.sessionUpdate),
            text: updates.map(textFromUpdate).filter(Boolean).join(""),
            updates: [...updates],
          };
        },
      });
    },
    {
      onSessionUpdate(notification) {
        if (!activeSessionId || notification.sessionId !== activeSessionId) return;
        updates.push(notification);
      },
    },
  );
}

export type OfficialDshAcpLiveSession = {
  result: Promise<OfficialDshAcpSessionResult>;
  /** Resolves after the bounded DSH process/Job teardown and exit checks finish. */
  settled: Promise<void>;
  stop(reason: LiveRunStopReason): void;
  setTimeoutMs(timeoutMs: number): void;
  isActive(): boolean;
  isPrompting(): boolean;
  /** Cancel the in-flight prompt without ending the process. Resolves after that prompt settles. */
  cancelPrompt(): Promise<void>;
  /** Serial follow-up on the same live session. Refuses if another prompt is in flight. */
  prompt(text: string | ContentBlock | ContentBlock[]): Promise<OfficialDshAcpSessionResult>;
};

export function spawnOfficialDshAcpSession(input: {
  repoRoot: string;
  cwd: string;
  patches?: readonly string[];
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  prompt: string | ContentBlock | ContentBlock[];
  sessionId?: string;
  modelSelection?: OfficialDshAcpModelSelection;
  signal?: AbortSignal;
  preserveOnStopReasons?: readonly LiveRunStopReason[];
  preserveOnFailure?: boolean;
  onSessionReady?: (session: { sessionId: string; resumed: boolean }) => void;
  onSessionUpdate?: (update: SessionNotification) => void;
  spawnProcess?: (request: OfficialDshAcpSpawnRequest) => OfficialDshAcpProcess;
  /**
   * Keep the Lead ACP process after this prompt turn. Teammates stay running.
   * The next Lead prompt is serial on this session — not a second process.
   */
  keepOfficialTeamLeadAlive?: boolean;
}): OfficialDshAcpLiveSession {
  const cwd = path.resolve(input.cwd);
  const invocation = officialDshHostInvocation({
    repoRoot: input.repoRoot,
    profile: "acp",
    ...(input.patches ? { patches: input.patches } : {}),
  });
  const prepared = prepareOfficialDshHostChannel(input.env);
  const env = prepared.env;
  const child: OfficialDshAcpProcess = input.spawnProcess
    ? input.spawnProcess({
        command: invocation.command,
        argv: invocation.argv,
        cwd,
        env,
        ...(prepared.privateHostChannel ? { privateHostChannel: prepared.privateHostChannel } : {}),
      })
    : (spawn(invocation.command, invocation.argv, {
        cwd,
        env,
        stdio: prepared.privateHostChannel ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      }) as OfficialDshAcpProcess);
  if (prepared.privateHostChannel && !input.spawnProcess) {
    const sink = child.stdio?.[prepared.privateHostChannel.fd];
    if (!sink || typeof (sink as NodeJS.WritableStream).end !== "function") {
      child.kill?.("SIGKILL");
      throw new Error("official DSH private Host channel was not opened");
    }
    (sink as NodeJS.WritableStream).end(prepared.privateHostChannel.payload);
  }
  let stderr = "";
  let sessionId = input.sessionId ?? "";
  let resumed = false;
  let closed = false;
  let promptFailed = false;
  let prompting = false;
  let activePromptSettled: Promise<void> | undefined;
  let ctxRef: ClientContext | undefined;
  let stopReason: LiveRunStopReason | undefined;
  let hardKillTimer: NodeJS.Timeout | undefined;
  const keepAlive = input.keepOfficialTeamLeadAlive === true;
  let endLifetime: (() => void) | undefined;
  const lifetime = new Promise<void>((resolve) => {
    endLifetime = resolve;
  });
  let firstResultResolve: ((value: OfficialDshAcpSessionResult) => void) | undefined;
  const firstResult = new Promise<OfficialDshAcpSessionResult>((resolve) => {
    firstResultResolve = resolve;
  });
  const publishFirst = (value: OfficialDshAcpSessionResult): OfficialDshAcpSessionResult => {
    firstResultResolve?.(value);
    firstResultResolve = undefined;
    return value;
  };
  let resolveProcessSettled: (() => void) | undefined;
  const processSettled = new Promise<void>((resolve) => {
    resolveProcessSettled = resolve;
  });

  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const hardKill = (signal: NodeJS.Signals = "SIGTERM"): void => {
    try {
      child.kill?.(signal);
    } catch {
      /* already gone */
    }
  };
  let timeout: NodeJS.Timeout | undefined;
  let sigkillTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  const clearSessionTimeout = (): void => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const clearStopTimers = (): void => {
    if (hardKillTimer) {
      clearTimeout(hardKillTimer);
      hardKillTimer = undefined;
    }
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
      sigkillTimer = undefined;
    }
  };
  const cancelInFlightPrompt = async (): Promise<void> => {
    if (!ctxRef || !sessionId) throw new Error("lead session is not ready");
    const settled = activePromptSettled;
    await ctxRef.notify(methods.agent.session.cancel, { sessionId });
    if (!settled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("lead prompt did not settle after cancellation")), 10_000);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const stop = (reason: LiveRunStopReason): void => {
    if (stopReason) return;
    stopReason = reason;
    clearSessionTimeout();
    // Official DSH: session/cancel owns in-flight prompt AbortSignal. There is no
    // separate request-timeout setting. If cancel cannot finish the ACP process, SIGTERM
    // then SIGKILL is the process-boundary fallback — not a Silver retry loop.
    if (ctxRef && sessionId) {
      void ctxRef.notify(methods.agent.session.cancel, { sessionId }).catch(() => {
        hardKill("SIGTERM");
      });
    } else {
      hardKill("SIGTERM");
    }
    hardKillTimer = setTimeout(() => hardKill("SIGTERM"), ACP_STOP_SIGTERM_MS);
    hardKillTimer.unref();
    sigkillTimer = setTimeout(() => hardKill("SIGKILL"), ACP_STOP_SIGKILL_MS);
    sigkillTimer.unref();
    endLifetime?.();
  };
  const sessionResult = (acpStopReason?: StopReason): OfficialDshAcpSessionResult => ({
    status: 0,
    stdout: "",
    stderr,
    resumed,
    closed,
    ...(sessionId ? { dshSessionId: sessionId } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(acpStopReason ? { acpStopReason } : {}),
  });
  const runPrompt = async (text: string | ContentBlock | ContentBlock[]): Promise<OfficialDshAcpSessionResult> => {
    if (stopReason || disposed) throw new Error("lead session is not ready");
    if (!ctxRef || !sessionId) throw new Error("lead session is not ready");
    if (prompting) throw new Error("lead_session_still_active");
    prompting = true;
    let resolvePromptSettled: (() => void) | undefined;
    activePromptSettled = new Promise<void>((resolve) => {
      resolvePromptSettled = resolve;
    });
    try {
      const response = await ctxRef.request(methods.agent.session.prompt, {
        sessionId,
        prompt: promptBlocks(text),
      });
      return sessionResult(response.stopReason);
    } catch (err) {
      promptFailed = true;
      throw err;
    } finally {
      prompting = false;
      resolvePromptSettled?.();
      activePromptSettled = undefined;
    }
  };
  const armSessionTimeout = (timeoutMs: number): void => {
    // Settled/disposed handles must not recreate referenced timers.
    if (disposed || stopReason) return;
    clearSessionTimeout();
    if (!Number.isFinite(timeoutMs)) return;
    if (timeoutMs <= 0) {
      stop("timeout");
      return;
    }
    timeout = setTimeout(() => stop("timeout"), timeoutMs);
  };
  armSessionTimeout(input.timeoutMs);
  const onAbort = () => stop("interrupted");
  if (input.signal?.aborted) onAbort();
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const finishSession = async (ctx: ClientContext): Promise<void> => {
    const shouldClose = (): boolean =>
      shouldCloseOfficialAcpSession({
        stopReason,
        preserveOnStopReasons: input.preserveOnStopReasons,
        promptFailed,
        preserveOnFailure: input.preserveOnFailure,
      });
    const terminalClose = stopReason !== undefined && shouldClose();
    if (terminalClose) clearStopTimers();
    if (sessionId && shouldClose()) {
      closed = await closeAcpSessionAfterStop(ctx, sessionId, stopReason);
    }
  };

  void (async (): Promise<void> => {
    try {
      if (!child.stdin || !child.stdout) throw new Error("official DSH ACP stdio was not opened");
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin as Writable),
        Readable.toWeb(child.stdout as Readable),
      );
      await createAcpClient({ name: "silver-live-acp" })
        .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
        .onNotification(methods.client.session.update, ({ params }) => {
          input.onSessionUpdate?.(params);
        })
        .connectWith(stream, async (ctx) => {
          ctxRef = ctx;
          await initializeAcp(ctx);
          let configOptions: readonly SessionConfigOption[] = [];
          if (input.sessionId) {
            const active = await ctx.request(methods.agent.session.resume, {
              cwd,
              sessionId: input.sessionId,
              mcpServers: [],
            });
            resumed = true;
            sessionId = input.sessionId;
            configOptions = active.configOptions ?? [];
          } else {
            const active = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
            sessionId = active.sessionId;
            configOptions = active.configOptions ?? [];
          }
          input.onSessionReady?.({ sessionId, resumed });
          if (input.modelSelection) {
            await selectOfficialAcpModel(ctx, sessionId, configOptions, input.modelSelection);
          }
          const first = await runPrompt(input.prompt);
          if (keepAlive && !stopReason) {
            publishFirst(first);
            await lifetime;
            await finishSession(ctx);
          } else {
            await finishSession(ctx);
            publishFirst(sessionResult(first.acpStopReason));
          }
        });
    } catch (err) {
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      const rpcData = err && typeof err === "object" && "data" in err ? JSON.stringify((err as { data?: unknown }).data) : "";
      const promptTransportFailure = isOfficialDshAcpPromptTransportError(err);
      publishFirst({
        status: stopReason ? 0 : 1,
        stdout: "",
        stderr: [stderr.trim(), message, rpcData].filter(Boolean).join("\n"),
        resumed,
        closed,
        ...(sessionId ? { dshSessionId: sessionId } : {}),
        ...(stopReason
          ? { stopReason }
          : promptTransportFailure
            ? { stopReason: "llm_transport_failure" as const }
            : {}),
      });
    } finally {
      disposed = true;
      endLifetime?.();
      clearSessionTimeout();
      if (hardKillTimer) {
        clearTimeout(hardKillTimer);
        hardKillTimer = undefined;
      }
      input.signal?.removeEventListener("abort", onAbort);
      hardKill("SIGTERM");
      // Keep sigkillTimer until exit is confirmed. child.exit has no timeout on
      // the Isolation/cell adapter; a bounded wait is required or SIGKILL never runs.
      let dead = acpProcessExited(child) || (await waitForAcpProcessExit(child, ACP_EXIT_WAIT_MS));
      if (!dead) hardKill("SIGKILL");
      dead = dead || acpProcessExited(child) || (await waitForAcpProcessExit(child, ACP_SIGKILL_EXIT_WAIT_MS));
      if (!dead) hardKill("SIGKILL");
      dead = dead || acpProcessExited(child) || (await waitForAcpProcessExit(child, ACP_SIGKILL_EXIT_WAIT_MS));
      clearStopTimers();
      resolveProcessSettled?.();
    }
  })();

  return {
    result: keepAlive
      ? firstResult
      : firstResult.then(async (value) => {
          await processSettled;
          return value;
        }),
    settled: processSettled,
    stop,
    /** Reschedule the whole-session wall timeout (room deadline changes). No-op after dispose. */
    setTimeoutMs: armSessionTimeout,
    /** True while the session may still receive deadline updates. */
    isActive: () => !disposed && !stopReason,
    isPrompting: () => prompting,
    cancelPrompt: cancelInFlightPrompt,
    prompt: runPrompt,
  };
}

async function selectOfficialAcpModel(
  ctx: ClientContext,
  sessionId: string,
  configOptions: readonly SessionConfigOption[],
  selection: OfficialDshAcpModelSelection,
): Promise<void> {
  const modelValue = JSON.stringify([selection.provider, selection.model]);
  let options = configOptions;
  if (!hasSelectOptionValue(options, "model", modelValue)) {
    throw new Error(`official DSH ACP model option not found: ${selection.provider}/${selection.model}`);
  }
  const afterModel = await ctx.request(methods.agent.session.setConfigOption, {
    sessionId,
    configId: "model",
    value: modelValue,
  });
  options = afterModel.configOptions;
  if (!selection.reasoningEffort || ["default", "off"].includes(selection.reasoningEffort)) return;
  if (!hasSelectOptionValue(options, "reasoning_effort", selection.reasoningEffort)) {
    throw new Error(
      `official DSH ACP reasoning option not found: ${selection.provider}/${selection.model}/${selection.reasoningEffort}`,
    );
  }
  await ctx.request(methods.agent.session.setConfigOption, {
    sessionId,
    configId: "reasoning_effort",
    value: selection.reasoningEffort,
  });
}

function hasSelectOptionValue(
  configOptions: readonly SessionConfigOption[],
  configId: string,
  value: string,
): boolean {
  const option = configOptions.find((row) => row.id === configId && row.type === "select");
  if (!option || option.type !== "select") return false;
  return option.options.some((entry) => {
    if ("value" in entry) return entry.value === value;
    return entry.options.some((nested) => nested.value === value);
  });
}

/** Recoverable stops keep the DSH session. Terminal stops and a finished prompt close it. */
export function shouldCloseOfficialAcpSession(input: {
  stopReason?: LiveRunStopReason | undefined;
  preserveOnStopReasons?: readonly LiveRunStopReason[] | undefined;
  promptFailed?: boolean | undefined;
  preserveOnFailure?: boolean | undefined;
}): boolean {
  if (input.promptFailed && input.preserveOnFailure === true) return false;
  if (input.stopReason !== undefined && input.preserveOnStopReasons?.includes(input.stopReason) === true) return false;
  return true;
}

async function closeAcpSessionAfterStop(
  ctx: ClientContext,
  sessionId: string,
  stopReason: LiveRunStopReason | undefined,
): Promise<boolean> {
  const attempt = maybeCloseAcpSession(ctx, sessionId, true).catch(() => false);
  if (stopReason === undefined) return attempt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      attempt,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ACP_STOP_SIGTERM_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function maybeCloseAcpSession(ctx: ClientContext, sessionId: string, shouldClose: boolean): Promise<boolean> {
  if (!shouldClose) return false;
  await ctx.request(methods.agent.session.close, { sessionId });
  return true;
}

async function withOfficialDshAcp<T>(
  input: {
    repoRoot: string;
    cwd?: string;
    patches?: readonly string[];
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
  op: (
    ctx: ClientContext,
    invocation: { command: string; argv: string[] },
    proc: {
      readonly pid: number | undefined;
      readonly exitCode: number | null;
      readonly signalCode: NodeJS.Signals | null;
    },
  ) => Promise<T>,
  handlers: {
    onSessionUpdate?: (notification: SessionNotification) => void;
  } = {},
): Promise<T> {
  const cwd = path.resolve(input.cwd ?? input.repoRoot);
  const invocation = officialDshHostInvocation({
    repoRoot: input.repoRoot,
    profile: "acp",
    ...(input.patches ? { patches: input.patches } : {}),
  });
  const prepared = prepareOfficialDshHostChannel(input.env ?? process.env);
  const child = spawn(invocation.command, invocation.argv, {
    cwd,
    env: prepared.env,
    stdio: prepared.privateHostChannel ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
  if (prepared.privateHostChannel) {
    const sink = child.stdio[prepared.privateHostChannel.fd];
    if (!sink || typeof (sink as NodeJS.WritableStream).end !== "function") {
      child.kill("SIGKILL");
      throw new Error("official DSH private Host channel was not opened");
    }
    (sink as NodeJS.WritableStream).end(prepared.privateHostChannel.payload);
  }
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const proc = {
    get pid() {
      return child.pid;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
  };

  const run = async (): Promise<T> => {
    if (!child.stdin || !child.stdout) throw new Error("official DSH ACP stdio was not opened");
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    return await createAcpClient({ name: "silver-acp-probe" })
      .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
      .onNotification(methods.client.session.update, ({ params }) => {
        handlers.onSessionUpdate?.(params);
      })
      .connectWith(stream, (ctx) => op(ctx, invocation, proc));
  };

  try {
    return await withTimeout(run(), input.timeoutMs ?? 20_000, () => {
      child.kill("SIGTERM");
    });
  } catch (err) {
    // Preserve Vitest/Chai assertion failures; wrap only ACP/process failures.
    if (isAssertionFailure(err)) throw err;
    const detail = stderr.trim();
    throw new Error(
      `LIVE_DSH_ACP_CLIENT_NOT_READY: ${err instanceof Error ? err.message : String(err)}${detail ? `\n${detail}` : ""}`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await waitForExit(child).catch(() => undefined);
  }
}

function isAssertionFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name ?? "";
  return name === "AssertionError" || name === "AssertionError [ERR_ASSERTION]";
}

async function initializeAcp(ctx: ClientContext) {
  return await ctx.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "Silver", version: "0.1.0" },
  });
}

function promptBlocks(prompt: string | ContentBlock | ContentBlock[]): ContentBlock[] {
  if (typeof prompt === "string") return [{ type: "text", text: prompt }];
  return Array.isArray(prompt) ? prompt : [prompt];
}

function textFromUpdate(notification: SessionNotification): string {
  const update: SessionUpdate = notification.update;
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  return update.content.type === "text" ? update.content.text : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function assertAcpSessionCapabilities(capabilities: AgentCapabilities): void {
  const session = capabilities.sessionCapabilities;
  const missing = [
    session?.list ? undefined : "session/list",
    session?.resume ? undefined : "session/resume",
    session?.close ? undefined : "session/close",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`official DSH ACP missing capabilities: ${missing.join(", ")}`);
  }
}

function acpSpawnEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_TELEMETRY_MODE: "DISABLED",
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once("exit", done);
    setTimeout(done, 1000).unref();
  });
}

function acpProcessExited(child: OfficialDshAcpProcess): boolean {
  return (child.exitCode !== undefined && child.exitCode !== null) ||
    (child.signalCode !== undefined && child.signalCode !== null);
}

function waitForAcpProcessExit(child: OfficialDshAcpProcess, timeoutMs = ACP_EXIT_WAIT_MS): Promise<boolean> {
  if (acpProcessExited(child)) return Promise.resolve(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exitSeen = child.exit
    ? child.exit.then(() => true)
    : child.once
      ? new Promise<boolean>((resolve) => {
          child.once?.("exit", () => resolve(true));
        })
      : Promise.resolve(false);
  return Promise.race([
    exitSeen,
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
