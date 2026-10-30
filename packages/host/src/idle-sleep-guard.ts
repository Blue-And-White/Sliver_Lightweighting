/**
 * Host capability: keep a long Mission from losing wall-clock to host idle sleep.
 * macOS uses `caffeinate -i -w <pid>` bound to the Mission process.
 * Failure is projected; it never fails the Mission.
 * Does not extend Room clocks and is not a DSH plugin.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const IDLE_SLEEP_GUARD_SCHEMA = "silver.idle-sleep-guard.v1" as const;

export type IdleSleepGuardStatus = "active" | "unavailable" | "failed" | "stopped";

export type IdleSleepGuardProjection = {
  schema: typeof IDLE_SLEEP_GUARD_SCHEMA;
  status: IdleSleepGuardStatus;
  platform: string;
  targetPid: number;
  backend?: "caffeinate";
  helperPid?: number;
  reason?: string;
  startedAt?: string;
  stoppedAt?: string;
};

export type SuspendClockAnchor = {
  wallStartedAtMs: number;
  monoStartedNs: bigint;
};

export type IdleSleepGuard = {
  projection(): IdleSleepGuardProjection;
  stop(): void;
};

type HelperChild = {
  pid: number | undefined;
  unref(): void;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): void;
};

export type IdleSleepGuardOptions = {
  targetPid: number;
  platform?: NodeJS.Platform;
  enabled?: boolean;
  now?: () => Date;
  /** Fired after any status transition (including async helper failure). Never throws into Mission. */
  onStateChange?: (projection: IdleSleepGuardProjection) => void;
  spawnHelper?: (command: string, args: string[]) => HelperChild;
  resolveCommand?: (command: string) => string | undefined;
};

export function createSuspendClockAnchor(
  wallStartedAtMs = Date.now(),
  monoStartedNs = process.hrtime.bigint(),
): SuspendClockAnchor {
  return { wallStartedAtMs, monoStartedNs };
}

/** Wall elapsed minus monotonic elapsed; positive after host suspend. Observational only. */
export function measureSuspendGapMs(
  anchor: SuspendClockAnchor,
  wallNowMs = Date.now(),
  monoNowNs = process.hrtime.bigint(),
): number {
  const wallElapsed = wallNowMs - anchor.wallStartedAtMs;
  const monoElapsedMs = Number(monoNowNs - anchor.monoStartedNs) / 1e6;
  if (!Number.isFinite(wallElapsed) || !Number.isFinite(monoElapsedMs)) return 0;
  return Math.max(0, Math.round(wallElapsed - monoElapsedMs));
}

function resolveCommandOnPath(command: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

function safeNotify(
  onStateChange: ((projection: IdleSleepGuardProjection) => void) | undefined,
  projection: IdleSleepGuardProjection,
): void {
  if (!onStateChange) return;
  try {
    onStateChange(projection);
  } catch {
    /* projection side effects must not take down the Mission */
  }
}

export function startIdleSleepGuard(input: IdleSleepGuardOptions): IdleSleepGuard {
  const platform = input.platform ?? process.platform;
  const now = input.now ?? (() => new Date());
  const enabled = input.enabled ?? process.env.SILVER_IDLE_SLEEP_GUARD !== "0";
  const targetPid = input.targetPid;
  const onStateChange = input.onStateChange;
  let state: IdleSleepGuardProjection = {
    schema: IDLE_SLEEP_GUARD_SCHEMA,
    status: "unavailable",
    platform,
    targetPid,
    reason: "idle sleep guard not started",
  };
  let helper: HelperChild | undefined;
  let stopped = false;

  const setState = (next: IdleSleepGuardProjection, notify: boolean): void => {
    state = next;
    if (notify) safeNotify(onStateChange, { ...state });
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    const wasActive = state.status === "active";
    if (helper && wasActive) {
      try {
        helper.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }
    helper = undefined;
    if (wasActive) {
      // Intentional stop is persisted by the Mission caller; do not re-enter onStateChange.
      setState(
        {
          ...state,
          status: "stopped",
          stoppedAt: now().toISOString(),
          reason: "guard stopped",
        },
        false,
      );
    }
  };

  if (!enabled) {
    setState(
      {
        schema: IDLE_SLEEP_GUARD_SCHEMA,
        status: "unavailable",
        platform,
        targetPid,
        reason: "disabled by SILVER_IDLE_SLEEP_GUARD=0",
      },
      false,
    );
    return { projection: () => ({ ...state }), stop };
  }

  if (platform !== "darwin") {
    setState(
      {
        schema: IDLE_SLEEP_GUARD_SCHEMA,
        status: "unavailable",
        platform,
        targetPid,
        reason: `idle sleep guard not implemented for platform ${platform}`,
      },
      false,
    );
    return { projection: () => ({ ...state }), stop };
  }

  const resolve = input.resolveCommand ?? resolveCommandOnPath;
  const caffeinate = resolve("caffeinate");
  if (!caffeinate) {
    setState(
      {
        schema: IDLE_SLEEP_GUARD_SCHEMA,
        status: "unavailable",
        platform,
        targetPid,
        backend: "caffeinate",
        reason: "caffeinate not found on PATH",
      },
      false,
    );
    return { projection: () => ({ ...state }), stop };
  }

  const spawnHelper =
    input.spawnHelper ??
    ((command: string, args: string[]): HelperChild => {
      const child: ChildProcess = spawn(command, args, {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      // Copy pid so HelperChild stays compatible under exactOptionalPropertyTypes.
      return {
        pid: child.pid,
        unref: () => {
          child.unref();
        },
        kill: (signal) => child.kill(signal),
        once: (event, listener) => {
          child.once(event, listener as (...args: unknown[]) => void);
        },
      };
    });

  try {
    helper = spawnHelper(caffeinate, ["-i", "-w", String(targetPid)]);
    const startedAt = now().toISOString();

    // Register error before pid/unref so async spawn failure cannot become unhandled.
    helper.once("error", (err) => {
      if (stopped) return;
      helper = undefined;
      setState(
        {
          schema: IDLE_SLEEP_GUARD_SCHEMA,
          status: "failed",
          platform,
          targetPid,
          backend: "caffeinate",
          reason: err instanceof Error ? err.message : String(err),
          startedAt,
          stoppedAt: now().toISOString(),
        },
        true,
      );
    });

    helper.once("exit", (code, signal) => {
      if (stopped) return;
      if (state.status !== "active") return;
      helper = undefined;
      setState(
        {
          ...state,
          status: "failed",
          reason: `caffeinate exited early code=${String(code)} signal=${String(signal)}`,
          stoppedAt: now().toISOString(),
        },
        true,
      );
    });

    if (helper.pid === undefined) {
      setState(
        {
          schema: IDLE_SLEEP_GUARD_SCHEMA,
          status: "failed",
          platform,
          targetPid,
          backend: "caffeinate",
          reason: "caffeinate spawned without pid",
          startedAt,
        },
        false,
      );
      // Keep error listener; async spawn failure must not crash the Mission.
      return { projection: () => ({ ...state }), stop };
    }

    helper.unref();
    setState(
      {
        schema: IDLE_SLEEP_GUARD_SCHEMA,
        status: "active",
        platform,
        targetPid,
        backend: "caffeinate",
        helperPid: helper.pid,
        startedAt,
      },
      false,
    );
  } catch (err) {
    helper = undefined;
    setState(
      {
        schema: IDLE_SLEEP_GUARD_SCHEMA,
        status: "failed",
        platform,
        targetPid,
        backend: "caffeinate",
        reason: err instanceof Error ? err.message : String(err),
        startedAt: now().toISOString(),
      },
      false,
    );
  }

  return { projection: () => ({ ...state }), stop };
}
