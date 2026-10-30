import type { ChallengeBundle } from "./challenge-bundle.ts";

/** Generic solver slots. Host capacity only — no platform protocol. */

export interface SlotJob {
  targetId: string;
  targetUrl: string;
  inScope?: string[];
  bundle?: ChallengeBundle;
  /** Previous attempt ended. Start a new clock and a new session. */
  freshAttempt?: boolean;
}

export interface SlotResult {
  targetId: string;
  targetUrl: string;
  /** Authoritative external-platform progress. Local solver counters never populate this. */
  platformProgress?: {
    acceptedCount: number;
    totalCount: number;
    remainingCount: number;
    completed: boolean;
  };
  /** Stable room-clock identity. Process restarts inside one room budget share this key. */
  logicalAttemptKey?: string;
  outcome?: string;
  wallTimeMs?: number;
  turns?: number;
  toolCalls?: number;
  noToolTurns?: number;
  maxNoToolStreak?: number;
  lengthStops?: number;
  assistantTextBytes?: number;
  maxAssistantTextBytes?: number;
  promptSkillGestures?: string[];
  promptSkillGestureCount?: number;
  skillCalls?: number;
  todoCalls?: number;
  lastTodoTurn?: number | null;
  turnsSinceTodo?: number | null;
  fingerprintCount?: number;
  stopReason?: string;
  controlRequest?: {
    type: "defer_unavailable";
    text: string;
  };
  reason?: string;
  error?: string;
}

export interface SlotStatus {
  maxConcurrent: number;
  active: number;
  queued: number;
  free: number;
  /** Finished jobs, including those already consumed by waitSlot. Not the wait buffer. */
  settledCount: number;
  activeIds: string[];
  queuedIds: string[];
}

export interface SlotEnqueueOptions {
  /** Explicitly allow a new attempt after this target previously settled. */
  retry?: boolean;
}

export class SlotPool {
  private readonly queue: SlotJob[] = [];
  private readonly active = new Map<string, Promise<void>>();
  private readonly seen = new Set<string>();
  private readonly done: SlotResult[] = [];
  private readonly settled: SlotResult[] = [];
  private settledCountValue = 0;
  private halted = false;
  private waiters: Array<(row: SlotResult | { idle: true }) => void> = [];

  readonly maxConcurrent: number;
  private readonly run: (job: SlotJob) => Promise<SlotResult>;

  constructor(
    maxConcurrent: number,
    run: (job: SlotJob) => Promise<SlotResult>,
    initialSettled: readonly SlotResult[] = [],
  ) {
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
    this.maxConcurrent = maxConcurrent;
    this.run = run;
    for (const result of initialSettled) {
      this.seen.add(result.targetId);
      this.settled.push({ ...result });
      this.settledCountValue += 1;
    }
  }

  status(): SlotStatus {
    return {
      maxConcurrent: this.maxConcurrent,
      active: this.active.size,
      queued: this.queue.length,
      free: Math.max(0, this.maxConcurrent - this.active.size),
      settledCount: this.settledCountValue,
      activeIds: [...this.active.keys()],
      queuedIds: this.queue.map((job) => job.targetId),
    };
  }

  enqueue(job: SlotJob, options: SlotEnqueueOptions = {}): SlotStatus & { accepted: boolean; reason?: string } {
    const targetId = job.targetId.trim();
    const targetUrl = job.targetUrl.trim();
    if (!targetId || !/^[A-Za-z0-9._-]+$/.test(targetId)) {
      return { ...this.status(), accepted: false, reason: "targetId must be [A-Za-z0-9._-]+" };
    }
    if (!/^https?:\/\//i.test(targetUrl) && !/^[A-Za-z0-9._:-]+$/.test(targetUrl)) {
      return { ...this.status(), accepted: false, reason: "targetUrl must be http(s) or a bare host:port" };
    }
    if (this.queue.some((row) => row.targetId === targetId) || this.active.has(targetId)) {
      return { ...this.status(), accepted: false, reason: "targetId already queued or running" };
    }
    if (this.seen.has(targetId) && options.retry !== true) {
      return { ...this.status(), accepted: false, reason: "targetId already settled; set retry=true for another attempt" };
    }
    if (this.halted) return { ...this.status(), accepted: false, reason: "pool halted" };
    if (this.queue.length >= 1024) return { ...this.status(), accepted: false, reason: "queue full" };
    this.queue.push({ ...job, targetId, targetUrl });
    this.pump();
    return { ...this.status(), accepted: true };
  }

  waitSlot(): Promise<SlotResult | { idle: true }> {
    const ready = this.done.shift();
    if (ready) return Promise.resolve(ready);
    if (this.active.size === 0 && this.queue.length === 0) return Promise.resolve({ idle: true as const });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  halt(): void {
    this.halted = true;
    this.queue.length = 0;
  }

  async drain(timeoutMs?: number): Promise<SlotResult[]> {
    const work = (async () => {
      while (this.active.size > 0 || (!this.halted && this.queue.length > 0)) {
        await Promise.all([...this.active.values()]);
      }
      return [...this.settled];
    })();
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs < 0) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<SlotResult[]>((resolve) => {
          timer = setTimeout(() => resolve([...this.settled]), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private pump(): void {
    if (this.halted) return;
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.seen.add(job.targetId);
      const ran = this.run(job)
        .catch((err): SlotResult => ({
          targetId: job.targetId,
          targetUrl: job.targetUrl,
          error: err instanceof Error ? err.message : String(err),
        }))
        .then((result) => {
          this.active.delete(job.targetId);
          this.pushResult(result);
          this.pump();
        });
      this.active.set(job.targetId, ran);
    }
  }

  private pushResult(result: SlotResult): void {
    this.settledCountValue += 1;
    this.settled.push(result);
    const waiter = this.waiters.shift();
    if (waiter) waiter(result);
    else this.done.push(result);
  }
}
