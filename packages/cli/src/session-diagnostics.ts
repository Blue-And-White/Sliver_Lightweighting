import fs from "node:fs";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import type SessionPersistence from "@deepseek-ai/dsh-session-persistence";
import type { SessionId } from "@deepseek-ai/dsh-session";

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const code = (value: unknown): string =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : "UNKNOWN";
const timestamp = (value: unknown): string | null => {
  const number = numeric(value);
  return number !== null && number <= 8.64e15 ? new Date(number).toISOString() : null;
};

/** Metadata only. Error text, model text, arguments and response bodies stay in source storage. */
export function summarizeSessionDiagnostics(events: readonly unknown[]) {
  let failedAttempts = 0;
  let retries = 0;
  let scheduledRetryDelayMs = 0;
  let retryStarts = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let compactionSummaries = 0;
  let lastAssistantAt: string | null = null;
  let lastFailure: ReturnType<typeof failureMetadata> | null = null;
  let lastTurnEnd: { seq: number | null; at: string | null; kind: string } | null = null;
  const failureCodeCounts: Record<string, number> = {};
  for (const value of events) {
    const event = row(value);
    const data = row(event.data);
    if (event.type === "assistant/attempt") {
      // One failed attempt may contain multiple stream chunks; count its finish once.
      const stream = Array.isArray(data.stream) ? data.stream : [];
      const finish = stream.map((item) => row(row(item).chunk)).findLast((chunk) =>
        chunk.type === "finish" && row(chunk.reason).kind === "error");
      if (finish) {
        failedAttempts += 1;
        const failure = row(row(finish.reason).failure);
        const failureCode = code(failure.code);
        failureCodeCounts[failureCode] = (failureCodeCounts[failureCode] ?? 0) + 1;
        lastFailure = failureMetadata(event, failure);
      }
    }
    if (event.type === "llm/retry") {
      retries += 1;
      scheduledRetryDelayMs += numeric(data.delayMs) ?? 0;
      lastFailure = failureMetadata(event, row(data.failure));
    }
    if (event.type === "llm/retry-started") retryStarts += 1;
    if (event.type === "assistant/message") {
      assistantMessages += 1;
      lastAssistantAt = timestamp(event.time);
    }
    if (event.type === "tool/call") toolCalls += 1;
    if (event.type === "tool/result") toolResults += 1;
    if (event.type === "compaction/summary") compactionSummaries += 1;
    if (event.type === "turn/end") {
      const reason = row(data.reason);
      const kind = ["completed", "error", "aborted", "blocked", "max-tokens", "interrupted"].includes(String(reason.kind)) ? String(reason.kind) : "unknown";
      lastTurnEnd = { seq: numeric(event.seq), at: timestamp(event.time), kind };
      if (kind === "error") lastFailure = failureMetadata(event, row(reason.error));
    }
  }
  return {
    events: events.length, assistantMessages, toolCalls, toolResults, compactionSummaries,
    failedAttempts, failureCodeCounts, retries, retryStarts, scheduledRetryDelayMs,
    lastAssistantAt, lastFailure, lastTurnEnd,
  };
}

function failureMetadata(event: Row, failure: Row) {
  const status = numeric(failure.status);
  return {
    seq: numeric(event.seq), at: timestamp(event.time), code: code(failure.code),
    httpStatus: status !== null && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    providerRetryAfterMs: numeric(failure.providerRetryAfterMs),
    causeRecorded: failure.cause !== undefined && failure.cause !== null,
    requestIdRecorded: typeof failure.requestId === "string" && failure.requestId.length > 0,
  };
}

/** Offline inspection: never launches ACP, loads model config, or opens a write handle. */
export async function collectSessionDiagnostics(input: string) {
  const root = path.resolve(input);
  if (!fs.lstatSync(root).isDirectory()) throw new Error("diagnose --replay requires a directory");
  const locations = new Map<string, { sessionsRoot: string; sessionId: string; source: string }>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.name === ".silver-dsh") {
        const sessionsRoot = path.join(full, "sessions");
        if (!fs.existsSync(sessionsRoot) || !fs.lstatSync(sessionsRoot).isDirectory()) continue;
        for (const project of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
          if (!project.isDirectory()) continue;
          for (const session of fs.readdirSync(path.join(sessionsRoot, project.name), { withFileTypes: true })) {
            if (!session.isDirectory() || !/^[a-zA-Z0-9-]+$/.test(session.name)) continue;
            const source = path.join(sessionsRoot, project.name, session.name);
            locations.set(source, { sessionsRoot, sessionId: session.name, source });
          }
        }
      } else if (!["node_modules", ".git", ".silver-skills", ".secrets"].includes(entry.name)) {
        walk(full);
      }
    }
  };
  walk(root);
  const sessions = [];
  for (const { sessionsRoot, sessionId, source } of [...locations.values()].sort((a, b) => a.source.localeCompare(b.source))) {
    try {
      const ctx = new Context();
      const plugin = ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot });
      try {
        await plugin.await();
        const store: SessionPersistence = ctx.sessionPersistence;
        const handle = await store.open(sessionId as SessionId, "read");
        try {
          const batch = await handle.read();
          sessions.push({ sessionId, source: path.relative(root, source), readStatus: "ok", ...summarizeSessionDiagnostics(batch.events) });
        } finally {
          await handle.close();
        }
      } finally {
        await plugin.dispose();
      }
    } catch {
      // Decoder errors can embed source bytes. Expose failure, not their raw message.
      sessions.push({ sessionId, source: path.relative(root, source), readStatus: "unreadable" });
    }
  }
  return {
    schema: "silver.session-diagnostics.v1", root, sessions,
    inspectionComplete: sessions.length > 0 && sessions.every((session) => session.readStatus === "ok"),
    notes: [
      "Historical session evidence, not process liveness or Mission success.",
      "Scheduled retry delays are not measured network latency or actual elapsed wait.",
      "Missing cause/status/requestId cannot establish a network root cause.",
      "Raw messages, tool arguments, response bodies and request IDs are not exported.",
    ],
  };
}
