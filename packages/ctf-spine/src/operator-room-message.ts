import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { queueHostSubagentPrompt, steerHostSubagentPrompt } from "@deepseek-ai/dsh-subagent/internal";

export const OPERATOR_ROOM_MESSAGE_REQUEST_SCHEMA = "silver.operator-room-message.v1" as const;
export const OPERATOR_ROOM_MESSAGE_RESULT_SCHEMA = "silver.operator-room-message-result.v1" as const;
export const OPERATOR_ROOM_MESSAGE_MAX_BYTES = 16 * 1024;
export const OPERATOR_ROOM_MESSAGE_TTL_MS = 15_000;
export const DIRECT_SESSION_NOTICE_DIR_ENV = "SILVER_DIRECT_SESSION_NOTICE_DIR";
const OPERATOR_ROOM_MEMBER_DELIVERY_TIMEOUT_MS = 3_000;

export type OperatorRoomMessageRequest = {
  schema: typeof OPERATOR_ROOM_MESSAGE_REQUEST_SCHEMA;
  requestId: string;
  message: string;
  target?: string;
  mode?: "queue" | "steer" | "interrupt";
  requestedAt: string;
  expiresAt: string;
};

export type OperatorRoomMessageResult = {
  schema: typeof OPERATOR_ROOM_MESSAGE_RESULT_SCHEMA;
  requestId: string;
  ok: boolean;
  deliveredTo: number;
  recipients?: string[];
  mode?: "queue" | "steer" | "interrupt";
  error?: string;
  appliedAt: string;
};

type SteerableAgent = {
  id: string;
  steer(message: ReturnType<typeof createUserMessage>): void;
  followup?(message: ReturnType<typeof createUserMessage>): void;
  cancel?(cause: { kind: "user" }, options: { keepInbox: true }): void;
};

function requestPath(dir: string): string {
  return path.join(dir, "operator-message-request.json");
}

function resultPath(dir: string, requestId?: string): string {
  return path.join(dir, requestId ? `operator-message-result-${requestId}.json` : "operator-message-result.json");
}

export function writeOperatorRoomMessage(
  dir: string,
  input: {
    message: string;
    target?: string;
    mode?: "queue" | "steer" | "interrupt";
    requestId?: string;
    replacePendingRequestId?: string;
    nowMs?: number;
    ttlMs?: number;
  },
): { file: string; request: OperatorRoomMessageRequest } {
  const message = input.message.trim();
  if (!message) throw new Error("operator room message must not be empty");
  if (Buffer.byteLength(message, "utf8") > OPERATOR_ROOM_MESSAGE_MAX_BYTES) {
    throw new Error(`operator room message exceeds ${OPERATOR_ROOM_MESSAGE_MAX_BYTES} bytes`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = requestPath(dir);
  const existing = readRequest(file);
  const nowMs = input.nowMs ?? Date.now();
  if (existing && Date.parse(existing.expiresAt) > nowMs && existing.requestId !== input.replacePendingRequestId) {
    throw new Error(`operator room message ${existing.requestId} is still pending`);
  }
  if (existing) fs.rmSync(file, { force: true });
  const request: OperatorRoomMessageRequest = {
    schema: OPERATOR_ROOM_MESSAGE_REQUEST_SCHEMA,
    requestId: input.requestId ?? randomUUID(),
    message,
    ...(input.target ? { target: input.target } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    requestedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + (input.ttlMs ?? OPERATOR_ROOM_MESSAGE_TTL_MS)).toISOString(),
  };
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(request, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return { file, request };
}

export function withdrawOperatorRoomMessage(dir: string, requestId: string): boolean {
  const file = requestPath(dir);
  const pending = readRequest(file);
  if (!pending || pending.requestId !== requestId) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function consumeOperatorRoomMessage(
  dir: string,
  nowMs = Date.now(),
): { kind: "request" | "expired"; request: OperatorRoomMessageRequest } | undefined {
  const file = requestPath(dir);
  const request = readRequest(file);
  if (!request) return undefined;
  fs.rmSync(file, { force: true });
  return {
    kind: Date.parse(request.expiresAt) <= nowMs ? "expired" : "request",
    request,
  };
}

export function deliverOperatorRoomMessage(
  dir: string,
  request: OperatorRoomMessageRequest,
  agents: readonly SteerableAgent[],
): OperatorRoomMessageResult {
  const message = operatorMessage(request);
  let deliveredTo = 0;
  const errors: string[] = [];
  const selected = request.target ? agents.filter((agent) => agent.id === request.target) : agents;
  const recipients: string[] = [];
  for (const agent of selected) {
    try {
      if (request.mode === "interrupt") {
        if (!agent.cancel) throw new Error("agent does not support cancel");
        agent.cancel({ kind: "user" }, { keepInbox: true });
        agent.steer(message);
      } else if (request.mode === "queue") {
        if (!agent.followup) throw new Error("agent does not support followup");
        agent.followup(message);
      } else {
        agent.steer(message);
      }
      deliveredTo += 1;
      recipients.push(agent.id);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const ok = deliveredTo === selected.length && deliveredTo > 0;
  const result: OperatorRoomMessageResult = {
    schema: OPERATOR_ROOM_MESSAGE_RESULT_SCHEMA,
    requestId: request.requestId,
    ok,
    deliveredTo,
    recipients,
    mode: request.mode ?? "steer",
    ...(!ok
      ? { error: selected.length === 0 ? "target is not a live Team member" : `delivery failed for ${errors.length} member(s)` }
      : {}),
    appliedAt: new Date().toISOString(),
  };
  writeResult(dir, result);
  return result;
}

/** Deliver to persistent Team children through DSH's host continuation adapter. */
export async function deliverOperatorRoomMessageToTeam(
  dir: string,
  request: OperatorRoomMessageRequest,
  lead: SteerableAgent,
  teams: {
    listMembers(agent: unknown): Array<{ id: string; name: string; role: string; status: string }>;
    interrupt(agent: unknown, name: string): unknown;
  },
  subagents: Parameters<typeof queueHostSubagentPrompt>[0],
  signal: AbortSignal = new AbortController().signal,
): Promise<OperatorRoomMessageResult> {
  const members = teams.listMembers(lead);
  const selected = request.target ? members.filter((member) => member.id === request.target) : members;
  const message = operatorMessage(request);
  const remainingMs = Math.max(0, Date.parse(request.expiresAt) - Date.now());
  const deliveryTimeoutMs = Math.min(OPERATOR_ROOM_MEMBER_DELIVERY_TIMEOUT_MS, remainingMs);
  const deliveries = await Promise.all(selected.map(async (member) => {
    try {
      if (member.id === lead.id) {
        if (request.mode === "interrupt") {
          if (!lead.cancel) throw new Error("Lead does not support cancel");
          lead.cancel({ kind: "user" }, { keepInbox: true });
        }
        if (request.mode === "queue") {
          if (!lead.followup) throw new Error("Lead does not support followup");
          lead.followup(message);
        } else lead.steer(message);
      } else {
        const parent = lead as Agent;
        const childId = member.id as Parameters<typeof queueHostSubagentPrompt>[2];
        if (request.mode === "interrupt") teams.interrupt(lead, member.name);
        const deliver = request.mode === "queue" ? queueHostSubagentPrompt : steerHostSubagentPrompt;
        await deliverWithDeadline(
          (memberSignal) => deliver(subagents, parent, childId, [...message.content], message.source, memberSignal),
          signal,
          deliveryTimeoutMs,
        );
      }
      return member.id;
    } catch {
      return undefined;
    }
  }));
  const recipients = deliveries.filter((memberId): memberId is string => memberId !== undefined);
  const failures = selected.length - recipients.length;
  const result: OperatorRoomMessageResult = {
    schema: OPERATOR_ROOM_MESSAGE_RESULT_SCHEMA,
    requestId: request.requestId,
    ok: recipients.length > 0 && failures === 0,
    deliveredTo: recipients.length,
    recipients,
    mode: request.mode ?? "steer",
    ...(recipients.length === 0 || failures > 0
      ? { error: selected.length === 0 ? "target is not a Team member" : `delivery failed for ${failures} member(s)` }
      : {}),
    appliedAt: new Date().toISOString(),
  };
  writeResult(dir, result);
  return result;
}

async function deliverWithDeadline(
  deliver: (signal: AbortSignal) => Promise<unknown>,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("operator room member delivery timed out")), timeoutMs);
  timer.unref?.();
  try {
    await Promise.race([
      deliver(controller.signal),
      new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(controller.signal.reason ?? new Error("operator room member delivery aborted"));
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener("abort", rejectAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

function operatorMessage(request: OperatorRoomMessageRequest): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: "text" as const, text: `Operator room message:\n${request.message}` }],
    source: {
      kind: "plugin:silver-ctf-spine" as const,
      form: "notice" as const,
      summary: boundContextSummary("operator room message"),
    },
  });
}

export function writeExpiredOperatorRoomMessageResult(
  dir: string,
  request: OperatorRoomMessageRequest,
): OperatorRoomMessageResult {
  const result: OperatorRoomMessageResult = {
    schema: OPERATOR_ROOM_MESSAGE_RESULT_SCHEMA,
    requestId: request.requestId,
    ok: false,
    deliveredTo: 0,
    error: `operator room message expired at ${request.expiresAt}`,
    appliedAt: new Date().toISOString(),
  };
  writeResult(dir, result);
  return result;
}

export function readOperatorRoomMessageResult(
  dir: string,
  requestId?: string,
): OperatorRoomMessageResult | undefined {
  const scoped = requestId ? readResult(resultPath(dir, requestId)) : undefined;
  if (scoped) return scoped;
  const shared = readResult(resultPath(dir));
  if (requestId && shared?.requestId !== requestId) return undefined;
  return shared;
}

function readRequest(file: string): OperatorRoomMessageRequest | undefined {
  try {
    const row = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OperatorRoomMessageRequest>;
    if (row.schema !== OPERATOR_ROOM_MESSAGE_REQUEST_SCHEMA) return undefined;
    if (typeof row.requestId !== "string" || !row.requestId) return undefined;
    if (typeof row.message !== "string" || !row.message.trim()) return undefined;
    if (row.target !== undefined && (typeof row.target !== "string" || !row.target)) return undefined;
    if (row.mode !== undefined && row.mode !== "queue" && row.mode !== "steer" && row.mode !== "interrupt") return undefined;
    if (typeof row.requestedAt !== "string" || typeof row.expiresAt !== "string") return undefined;
    return row as OperatorRoomMessageRequest;
  } catch {
    return undefined;
  }
}

function writeResult(dir: string, result: OperatorRoomMessageResult): void {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  for (const file of [resultPath(dir, result.requestId), resultPath(dir)]) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

function readResult(file: string): OperatorRoomMessageResult | undefined {
  try {
    const row = JSON.parse(fs.readFileSync(file, "utf8")) as OperatorRoomMessageResult;
    if (row.schema !== OPERATOR_ROOM_MESSAGE_RESULT_SCHEMA || typeof row.requestId !== "string") return undefined;
    return row;
  } catch {
    return undefined;
  }
}
