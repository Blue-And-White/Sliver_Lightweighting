/**
 * Silver Project Room communication on independent Host-started roots.
 * Not official DSH Agent Team. No Lead spawn, mailbox, task board, or Agent loop.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PROJECT_ROOM_SCHEMA = "silver.project-room.v1" as const;
export const ROOM_FEED_TYPES = [
  "observation",
  "hypothesis",
  "request",
  "challenge",
  "status",
  "checkpoint",
  "defer_unavailable",
  "task_complete",
] as const;
export type RoomFeedType = (typeof ROOM_FEED_TYPES)[number];
export const ROOM_FEED_DELIVERIES = ["index-only", "recent-delta", "pull-only"] as const;
export type RoomFeedDelivery = (typeof ROOM_FEED_DELIVERIES)[number];

export const ROOM_FEED_TEXT_MAX = 8_192;
export const ROOM_FEED_PREVIEW_MAX = 80;
export const ROOM_CHECKPOINT_FIELD_MAX = 160;
export const ROOM_CHECKPOINT_VARIABLE_MAX = 80;
export const ROOM_APPROACH_MAX = 160;
export const ROOM_UNREAD_WINDOW = 10;

/** Short handoff summary. Host does not judge whether the route is right. */
export type RoomCheckpoint = {
  confirmedFacts: string;
  triedScope: string;
  failedHypothesis: string;
  likelyRoute: string;
  nextVariables: string[];
};

export type RoomFeedMessage = {
  messageId: string;
  seq: number;
  challengeId: string;
  authorAttemptId: string;
  type: RoomFeedType;
  text: string;
  intelId?: string;
  checkpoint?: RoomCheckpoint;
  createdAt: string;
};

export type RoomStatusCard = {
  attemptId: string;
  approach: string;
  lastTool?: string;
  updatedAt: string;
};

export type RoomFeedIndexItem = {
  messageId: string;
  seq: number;
  authorAttemptId: string;
  type: RoomFeedType;
  preview: string;
  createdAt: string;
};

type RoomState = {
  schema: typeof PROJECT_ROOM_SCHEMA;
  challengeId: string;
  messages: RoomFeedMessage[];
  statuses: Record<string, RoomStatusCard>;
  lastSeenSeq: Record<string, number>;
  pointReadSeqs: Record<string, number[]>;
  nextSeq: number;
};

function roomDir(workspace: string): string {
  return path.join(workspace, "room");
}

function roomStatePath(workspace: string): string {
  return path.join(roomDir(workspace), "state.json");
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function isFeedType(value: unknown): value is RoomFeedType {
  return typeof value === "string" && (ROOM_FEED_TYPES as readonly string[]).includes(value);
}

function checkpointField(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const clipped = clip(value, max);
  return clipped || undefined;
}

/** Shape check only. A failed hypothesis stays here and is not an Intel record. */
export function parseRoomCheckpoint(value: unknown): RoomCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const confirmedFacts = checkpointField(row.confirmedFacts, ROOM_CHECKPOINT_FIELD_MAX);
  const triedScope = checkpointField(row.triedScope, ROOM_CHECKPOINT_FIELD_MAX);
  const failedHypothesis = checkpointField(row.failedHypothesis, ROOM_CHECKPOINT_FIELD_MAX);
  const likelyRoute = checkpointField(row.likelyRoute, ROOM_CHECKPOINT_FIELD_MAX);
  if (!confirmedFacts || !triedScope || !failedHypothesis || !likelyRoute) return undefined;
  if (!Array.isArray(row.nextVariables) || row.nextVariables.length < 1 || row.nextVariables.length > 3) return undefined;
  const nextVariables: string[] = [];
  for (const item of row.nextVariables) {
    const variable = checkpointField(item, ROOM_CHECKPOINT_VARIABLE_MAX);
    if (!variable) return undefined;
    nextVariables.push(variable);
  }
  return { confirmedFacts, triedScope, failedHypothesis, likelyRoute, nextVariables };
}

export function isRoomFeedDelivery(value: unknown): value is RoomFeedDelivery {
  return typeof value === "string" && (ROOM_FEED_DELIVERIES as readonly string[]).includes(value);
}

export class ProjectRoomStore {
  private readonly file: string;
  private state: RoomState;

  constructor(workspace: string, challengeId: string) {
    fs.mkdirSync(roomDir(workspace), { recursive: true });
    this.file = roomStatePath(workspace);
    this.state = this.load(challengeId);
  }

  validatePost(input: {
    type: unknown;
    text: unknown;
    checkpoint?: unknown;
  }): { ok: true } | { ok: false; reason: string } {
    const checkpoint = parseRoomCheckpoint(input.checkpoint);
    if (input.checkpoint !== undefined && !checkpoint) return { ok: false, reason: "checkpoint_invalid" };
    const type = checkpoint ? "checkpoint" : input.type;
    if (!isFeedType(type)) return { ok: false, reason: "type_required" };
    const rawText =
      typeof input.text === "string" && input.text.trim()
        ? input.text
        : checkpoint
          ? checkpoint.likelyRoute
          : "";
    if (!rawText.trim()) return { ok: false, reason: "text_required" };
    if (rawText.trim().length > ROOM_FEED_TEXT_MAX) return { ok: false, reason: "text_too_long" };
    return { ok: true };
  }

  post(input: {
    challengeId: string;
    authorAttemptId: string;
    type: unknown;
    text: unknown;
    intelId?: unknown;
    checkpoint?: unknown;
  }): { ok: true; message: RoomFeedMessage } | { ok: false; reason: string } {
    const valid = this.validatePost(input);
    if (!valid.ok) return valid;
    const checkpoint = parseRoomCheckpoint(input.checkpoint);
    const type = checkpoint ? "checkpoint" : input.type;
    if (!isFeedType(type)) throw new Error("validated room feed type became invalid");
    const rawText =
      typeof input.text === "string" && input.text.trim()
        ? input.text
        : checkpoint
          ? checkpoint.likelyRoute
          : "";
    const text = rawText.trim();
    if (!text) throw new Error("validated room feed text became empty");
    const intelId = typeof input.intelId === "string" && input.intelId.trim() ? input.intelId.trim() : undefined;
    const now = new Date().toISOString();
    const message: RoomFeedMessage = {
      messageId: randomUUID(),
      seq: this.state.nextSeq,
      challengeId: input.challengeId,
      authorAttemptId: input.authorAttemptId,
      type,
      text,
      ...(intelId ? { intelId } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      createdAt: now,
    };
    this.state.messages.push(message);
    this.state.nextSeq += 1;
    this.save();
    return { ok: true, message };
  }

  setApproach(attemptId: string, approach: unknown): { ok: true; status: RoomStatusCard } | { ok: false; reason: string } {
    if (typeof approach !== "string" || !approach.trim()) return { ok: false, reason: "approach_required" };
    const status: RoomStatusCard = {
      attemptId,
      approach: clip(approach, ROOM_APPROACH_MAX),
      ...(this.state.statuses[attemptId]?.lastTool ? { lastTool: this.state.statuses[attemptId]!.lastTool } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.state.statuses[attemptId] = status;
    this.save();
    return { ok: true, status };
  }

  noteTool(attemptId: string, toolName: string): void {
    const prev = this.state.statuses[attemptId];
    this.state.statuses[attemptId] = {
      attemptId,
      approach: prev?.approach ?? "",
      lastTool: toolName,
      updatedAt: prev?.updatedAt ?? "",
    };
    this.save();
  }

  statusCards(attemptIds: string[]): RoomStatusCard[] {
    return attemptIds.map((attemptId) => {
      const row = this.state.statuses[attemptId];
      return row ?? { attemptId, approach: "", updatedAt: "" };
    });
  }

  unread(attemptId: string): RoomFeedMessage[] {
    const seen = this.state.lastSeenSeq[attemptId] ?? 0;
    const pointReads = new Set(this.state.pointReadSeqs[attemptId] ?? []);
    return this.state.messages.filter(
      (row) => row.seq > seen && !pointReads.has(row.seq) && row.authorAttemptId !== attemptId,
    );
  }

  consumeUnread(
    attemptId: string,
    delivery: RoomFeedDelivery,
  ): {
    unreadCount: number;
    items: RoomFeedIndexItem[];
    recent?: Array<{ messageId: string; authorAttemptId: string; type: RoomFeedType; text: string; createdAt: string }>;
  } {
    const unread = this.unread(attemptId);
    const window = unread.slice(0, ROOM_UNREAD_WINDOW);
    const items = window.map((row) => ({
      messageId: row.messageId,
      seq: row.seq,
      authorAttemptId: row.authorAttemptId,
      type: row.type,
      preview: clip(row.text, ROOM_FEED_PREVIEW_MAX),
      createdAt: row.createdAt,
    }));
    if (delivery === "recent-delta" && window.length > 0) {
      const maxSeq = window[window.length - 1]!.seq;
      this.markRead(attemptId, maxSeq);
    }
    return {
      unreadCount: unread.length,
      items: delivery === "pull-only" ? [] : items,
      ...(delivery === "recent-delta"
        ? {
            recent: window.map((row) => ({
              messageId: row.messageId,
              authorAttemptId: row.authorAttemptId,
              type: row.type,
              text: row.text,
              createdAt: row.createdAt,
            })),
          }
        : {}),
    };
  }

  read(input: { messageId?: string; query?: string; afterSeq?: number; limit?: number }): {
    messages: RoomFeedMessage[];
  } {
    let rows = this.state.messages;
    if (input.messageId) {
      rows = rows.filter((row) => row.messageId === input.messageId);
    } else {
      if (typeof input.afterSeq === "number") rows = rows.filter((row) => row.seq > input.afterSeq!);
      const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      if (query) {
        rows = rows.filter(
          (row) =>
            row.text.toLowerCase().includes(query) ||
            row.type.includes(query) ||
            row.authorAttemptId.toLowerCase().includes(query),
        );
      }
    }
    const limit = Number.isInteger(input.limit) ? Math.min(50, Math.max(1, input.limit!)) : 20;
    const sequential = typeof input.afterSeq === "number" && !input.messageId && !input.query;
    return { messages: sequential ? rows.slice(0, limit) : rows.slice(-limit) };
  }

  markRead(attemptId: string, seq: number): void {
    const prev = this.state.lastSeenSeq[attemptId] ?? 0;
    if (seq <= prev) return;
    this.state.lastSeenSeq[attemptId] = seq;
    this.state.pointReadSeqs[attemptId] = (this.state.pointReadSeqs[attemptId] ?? []).filter(
      (readSeq) => readSeq > seq,
    );
    this.collapsePointReads(attemptId);
    this.save();
  }

  markMessageRead(attemptId: string, seq: number): void {
    if (seq <= (this.state.lastSeenSeq[attemptId] ?? 0)) return;
    const pointReads = new Set(this.state.pointReadSeqs[attemptId] ?? []);
    pointReads.add(seq);
    this.state.pointReadSeqs[attemptId] = [...pointReads].sort((left, right) => left - right);
    this.collapsePointReads(attemptId);
    this.save();
  }

  seenSeq(attemptId: string): number {
    return this.state.lastSeenSeq[attemptId] ?? 0;
  }

  private collapsePointReads(attemptId: string): void {
    let seen = this.state.lastSeenSeq[attemptId] ?? 0;
    const pointReads = new Set(this.state.pointReadSeqs[attemptId] ?? []);
    while (true) {
      const next = this.state.messages[seen];
      if (
        !next ||
        next.seq !== seen + 1 ||
        (next.authorAttemptId !== attemptId && !pointReads.has(next.seq))
      ) {
        break;
      }
      pointReads.delete(next.seq);
      seen = next.seq;
    }
    this.state.lastSeenSeq[attemptId] = seen;
    this.state.pointReadSeqs[attemptId] = [...pointReads].sort((left, right) => left - right);
  }

  /** Latest checkpoint only. Earlier checkpoint posts stay in the feed. */
  latestCheckpoint(): (RoomCheckpoint & { messageId: string; seq: number; authorAttemptId: string; createdAt: string }) | undefined {
    for (let i = this.state.messages.length - 1; i >= 0; i -= 1) {
      const row = this.state.messages[i]!;
      if (!row.checkpoint) continue;
      return {
        ...row.checkpoint,
        messageId: row.messageId,
        seq: row.seq,
        authorAttemptId: row.authorAttemptId,
        createdAt: row.createdAt,
      };
    }
    return undefined;
  }

  private load(challengeId: string): RoomState {
    if (!fs.existsSync(this.file)) {
      return {
        schema: PROJECT_ROOM_SCHEMA,
        challengeId,
        messages: [],
        statuses: {},
        lastSeenSeq: {},
        pointReadSeqs: {},
        nextSeq: 1,
      };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as RoomState;
      if (raw.schema !== PROJECT_ROOM_SCHEMA) {
        return {
          schema: PROJECT_ROOM_SCHEMA,
          challengeId,
          messages: [],
          statuses: {},
          lastSeenSeq: {},
          pointReadSeqs: {},
          nextSeq: 1,
        };
      }
      return {
        schema: PROJECT_ROOM_SCHEMA,
        challengeId,
        messages: Array.isArray(raw.messages) ? raw.messages : [],
        statuses: raw.statuses && typeof raw.statuses === "object" ? raw.statuses : {},
        lastSeenSeq: raw.lastSeenSeq && typeof raw.lastSeenSeq === "object" ? raw.lastSeenSeq : {},
        pointReadSeqs: raw.pointReadSeqs && typeof raw.pointReadSeqs === "object" ? raw.pointReadSeqs : {},
        nextSeq: Number.isInteger(raw.nextSeq) && raw.nextSeq > 0 ? raw.nextSeq : 1,
      };
    } catch {
      return {
        schema: PROJECT_ROOM_SCHEMA,
        challengeId,
        messages: [],
        statuses: {},
        lastSeenSeq: {},
        pointReadSeqs: {},
        nextSeq: 1,
      };
    }
  }

  private save(): void {
    atomicWriteJson(this.file, this.state);
  }
}
