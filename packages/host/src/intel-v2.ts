/**
 * Public intel v2 — member-authored observations with versions, comments, retract.
 * Coexists with v1 auto tool-pipeline rows in the same room intel directory.
 * Host attributes author from the bound attempt/member; models never self-claim authorship.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IntelItem } from "./intel-pool.ts";

export const PUBLIC_INTEL_V2_SCHEMA = "silver.public-intel.v2" as const;
export const PUBLIC_INTEL_READ_SCHEMA = "silver.public-intel-read.v1" as const;

export type IntelPolarity = "positive" | "negative" | "uncertain";
export type IntelRecordStatus = "active" | "challenged" | "retracted";
export type PublicIntelTag = "asset" | "identity" | "access" | "capability";

const PUBLIC_INTEL_TAG_ORDER: readonly PublicIntelTag[] = ["asset", "identity", "access", "capability"];
const PUBLIC_INTEL_NOTICE_COMMENT_IDS_MAX = 8;

function canonicalIntelTags(tags: readonly PublicIntelTag[] = []): PublicIntelTag[] {
  return [...new Set(tags)].sort(
    (left, right) => PUBLIC_INTEL_TAG_ORDER.indexOf(left) - PUBLIC_INTEL_TAG_ORDER.indexOf(right),
  );
}

export type PublicIntelEvidenceRef = {
  /** Tool name, callId, artifact path, or Host-resolved locator — not a free-form claim. */
  kind: "artifact" | "tool_call" | "path";
  ref: string;
};

/** Member-authored directed edge from this fact to another room fact. */
export type PublicIntelLink = {
  intelId: string;
  /** Free-form relation such as exposed_by, enables, authenticates_to, or derived_from. */
  relation: string;
};

export type PublicIntelVersion = {
  version: number;
  observation: string;
  /** Optional member-authored retrieval labels; Host does not infer them. */
  tags?: PublicIntelTag[];
  conditions?: string;
  evidence: PublicIntelEvidenceRef[];
  links?: PublicIntelLink[];
  polarity: IntelPolarity;
  reason?: string;
  authorAttemptId: string;
  authorMemberId?: string;
  createdAt: string;
};

export type PublicIntelComment = {
  commentId: string;
  intelId: string;
  /** Version under discussion (not an edit of the body). */
  aboutVersion: number;
  body: string;
  evidence?: PublicIntelEvidenceRef[];
  authorAttemptId: string;
  authorMemberId?: string;
  createdAt: string;
  clientRequestId?: string;
  /** A cited challenge marks the record disputed without letting another member rewrite it. */
  kind?: "comment" | "challenge";
  /** Formal members that must see this comment; delivery state stays outside the comment body. */
  notifyMemberIds?: string[];
};

export type PublicIntelRecord = {
  schema: typeof PUBLIC_INTEL_V2_SCHEMA;
  intelId: string;
  challengeId: string;
  status: IntelRecordStatus;
  currentVersion: number;
  versions: PublicIntelVersion[];
  comments: PublicIntelComment[];
  /** Original publisher — revise/retract restricted to this author. */
  authorAttemptId: string;
  authorMemberId?: string;
  /** Migrated v1 auto rows keep legacy provenance without inventing a member. */
  legacy?: {
    producerAttempt: string;
    dedupeKey: string;
    kind: string;
    alsoSeenBy: string[];
  };
  createdAt: string;
  updatedAt: string;
  clientRequestId?: string;
};

export type IntelReaderKind = "member" | "group";

export type IntelReaderPrincipal = {
  kind: IntelReaderKind;
  id: string;
  attemptId: string;
};

export type PublicIntelReadReceipt = {
  schema: typeof PUBLIC_INTEL_READ_SCHEMA;
  challengeId: string;
  reader: { kind: IntelReaderKind; id: string };
  attemptId: string;
  intelId: string;
  version: number;
  readAt: string;
  /** Version 0 records a durable unread announcement, not a model read. */
  unreadSeed?: true;
  /** Present only for formal members. Independent Groups must not forge memberId=groupId. */
  memberId?: string;
  /** Comment ids observed by this reader; comments do not masquerade as record versions. */
  commentIds?: string[];
};

function resolveIntelReader(input: {
  attemptId: string;
  reader?: IntelReaderPrincipal;
  memberId?: string;
}): IntelReaderPrincipal {
  if (input.reader?.id) {
    return {
      kind: input.reader.kind,
      id: input.reader.id,
      attemptId: input.reader.attemptId || input.attemptId,
    };
  }
  return {
    kind: "member",
    id: input.memberId || input.attemptId,
    attemptId: input.attemptId,
  };
}

function receiptPrincipal(row: PublicIntelReadReceipt): { kind: IntelReaderKind; id: string } {
  if (row.reader?.kind && row.reader.id) return { kind: row.reader.kind, id: row.reader.id };
  if (row.memberId) return { kind: "member", id: row.memberId };
  return { kind: "group", id: row.attemptId };
}

function receiptReaderKey(row: PublicIntelReadReceipt): string {
  const principal = receiptPrincipal(row);
  return `${principal.kind}:${principal.id}`;
}

function readerKey(kind: IntelReaderKind, id: string): string {
  return `${kind}:${id}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export type PublicIntelChangeNotice = {
  intelId: string;
  previousVersion: number;
  currentVersion: number;
  status: IntelRecordStatus;
  kind: "published" | "revised" | "retracted" | "commented" | "challenged";
  commentIds?: string[];
  unreadCommentCount?: number;
};

type IdempotencyRow = {
  scopeKey: string;
  op: string;
  contentHash: string;
  intelId: string;
  commentId?: string;
  version?: number;
};

function contentHash(parts: unknown): string {
  return JSON.stringify(parts);
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, body ? `${body}\n` : "");
  fs.renameSync(tmp, file);
}

export function publicIntelDir(workspace: string): string {
  return path.join(workspace, "intel");
}

export function publicIntelRecordsPath(workspace: string): string {
  return path.join(publicIntelDir(workspace), "records-v2.jsonl");
}

export function publicIntelReadsPath(workspace: string): string {
  return path.join(publicIntelDir(workspace), "reads-v2.jsonl");
}

export function publicIntelIdempotencyPath(workspace: string): string {
  return path.join(publicIntelDir(workspace), "idempotency-v2.json");
}

export function publicIntelPendingCommitPath(workspace: string): string {
  return path.join(publicIntelDir(workspace), "pending-commit-v2.json");
}

function isV2Record(row: unknown): row is PublicIntelRecord {
  return Boolean(row && typeof row === "object" && (row as PublicIntelRecord).schema === PUBLIC_INTEL_V2_SCHEMA);
}

/**
 * Map a v1 auto-ingest observation into v2 without inventing an author or
 * promoting the Host-authored nextObjectiveCheck into public strategy.
 */
export function migrateV1ItemToV2(item: IntelItem): PublicIntelRecord {
  const now = item.createdAt || new Date().toISOString();
  const evidence: PublicIntelEvidenceRef[] = item.artifactRef
    ? [{ kind: "artifact", ref: item.artifactRef }]
    : [];
  return {
    schema: PUBLIC_INTEL_V2_SCHEMA,
    intelId: item.id,
    challengeId: item.challengeId,
    status: "active",
    currentVersion: 1,
    versions: [
      {
        version: 1,
        observation: item.observation,
        evidence,
        polarity: "positive",
        authorAttemptId: item.producerAttempt,
        createdAt: now,
      },
    ],
    comments: [],
    authorAttemptId: item.producerAttempt,
    legacy: {
      producerAttempt: item.producerAttempt,
      dedupeKey: item.dedupeKey,
      kind: item.kind,
      alsoSeenBy: [...item.alsoSeenBy],
    },
    createdAt: now,
    updatedAt: now,
  };
}

export class PublicIntelStore {
  private readonly recordsFile: string;
  private readonly readsFile: string;
  private readonly idemFile: string;
  private readonly pendingCommitFile: string;
  private records: PublicIntelRecord[] = [];
  private reads: PublicIntelReadReceipt[] = [];
  private idem: IdempotencyRow[] = [];
  private migrated = false;

  constructor(workspace: string) {
    const dir = publicIntelDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    this.recordsFile = publicIntelRecordsPath(workspace);
    this.readsFile = publicIntelReadsPath(workspace);
    this.idemFile = publicIntelIdempotencyPath(workspace);
    this.pendingCommitFile = publicIntelPendingCommitPath(workspace);
    this.load();
  }

  /** Import v1 pool rows; keeps IDs / artifact refs / producerAttempt. Safe to call repeatedly. */
  ensureMigratedFromV1(v1Items: IntelItem[]): void {
    this.ensureDurable();
    const known = new Set(this.records.map((row) => row.intelId));
    const additions: PublicIntelRecord[] = [];
    for (const item of v1Items) {
      if (known.has(item.id)) continue;
      additions.push(migrateV1ItemToV2(item));
      known.add(item.id);
    }
    this.migrated = true;
    if (additions.length === 0) return;
    this.commit([...this.records, ...additions], this.idem);
  }

  list(challengeId: string, opts?: { includeRetracted?: boolean }): PublicIntelRecord[] {
    return this.records.filter(
      (row) =>
        row.challengeId === challengeId &&
        (opts?.includeRetracted || row.status !== "retracted"),
    );
  }

  get(intelId: string): PublicIntelRecord | undefined {
    return this.records.find((row) => row.intelId === intelId);
  }

  summary(challengeId: string): { activeCount: number; challengedCount: number; retractedCount: number; commentCount: number } {
    const rows = this.records.filter((row) => row.challengeId === challengeId);
    return {
      activeCount: rows.filter((row) => row.status === "active").length,
      challengedCount: rows.filter((row) => row.status === "challenged").length,
      retractedCount: rows.filter((row) => row.status === "retracted").length,
      commentCount: rows.reduce((n, row) => n + row.comments.length, 0),
    };
  }

  publish(input: {
    challengeId: string;
    authorAttemptId: string;
    authorMemberId?: string;
    observation: string;
    tags?: PublicIntelTag[];
    conditions?: string;
    evidence?: PublicIntelEvidenceRef[];
    links?: PublicIntelLink[];
    polarity?: IntelPolarity;
    clientRequestId?: string;
    /** Formal members that must see this first publication at a safe boundary. */
    notifyMemberIds?: readonly string[];
  }):
    | { ok: true; record: PublicIntelRecord; duplicate: boolean }
    | { ok: false; reason: string; existing?: PublicIntelRecord } {
    try {
      this.ensureDurable();
    } catch {
      return { ok: false, reason: "persist_failed" };
    }
    const observation = input.observation.trim();
    if (!observation) return { ok: false, reason: "observation_required" };
    const polarity = input.polarity ?? "uncertain";
    const evidence = input.evidence ?? [];
    const tags = canonicalIntelTags(input.tags);
    const hash = contentHash({
      observation,
      ...(tags.length ? { tags } : {}),
      conditions: input.conditions ?? "",
      evidence,
      links: input.links ?? [],
      polarity,
    });
    if (input.clientRequestId) {
      const hit = this.idemHit("publish", input.challengeId, input.authorAttemptId, input.clientRequestId, hash);
      if (hit === "conflict") return { ok: false, reason: "idempotency_conflict" };
      if (typeof hit === "object") {
        const existing = this.get(hit.intelId);
        if (existing) return { ok: true, record: existing, duplicate: true };
        // Idem points at a missing record — treat as no hit so retry can create.
      }
    }
    const now = new Date().toISOString();
    const record: PublicIntelRecord = {
      schema: PUBLIC_INTEL_V2_SCHEMA,
      intelId: randomUUID(),
      challengeId: input.challengeId,
      status: "active",
      currentVersion: 1,
      versions: [
        {
          version: 1,
          observation,
          ...(tags.length ? { tags } : {}),
          ...(input.conditions?.trim() ? { conditions: input.conditions.trim() } : {}),
          evidence,
          ...(input.links?.length ? { links: input.links } : {}),
          polarity,
          authorAttemptId: input.authorAttemptId,
          ...(input.authorMemberId ? { authorMemberId: input.authorMemberId } : {}),
          createdAt: now,
        },
      ],
      comments: [],
      authorAttemptId: input.authorAttemptId,
      ...(input.authorMemberId ? { authorMemberId: input.authorMemberId } : {}),
      createdAt: now,
      updatedAt: now,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    };
    const nextRecords = [...this.records, record];
    const nextIdem = input.clientRequestId
      ? this.nextIdem("publish", input.challengeId, input.authorAttemptId, input.clientRequestId, hash, {
          intelId: record.intelId,
          version: 1,
        })
      : this.idem;
    const seededReads = uniqueStrings(input.notifyMemberIds ?? [])
      .filter((memberId) => memberId !== input.authorMemberId)
      .reduce<PublicIntelReadReceipt[]>((rows, memberId) => {
        const exists = rows.some(
          (row) =>
            row.challengeId === input.challengeId &&
            receiptReaderKey(row) === readerKey("member", memberId) &&
            row.intelId === record.intelId &&
            row.version === 0,
        );
        if (exists) return rows;
        return [
          ...rows,
          {
            schema: PUBLIC_INTEL_READ_SCHEMA,
            challengeId: input.challengeId,
            reader: { kind: "member", id: memberId },
            attemptId: `host:intel:${record.intelId}`,
            intelId: record.intelId,
            version: 0,
            readAt: now,
            memberId,
            unreadSeed: true,
          },
        ];
      }, this.reads);
    try {
      this.commit(nextRecords, nextIdem, seededReads);
    } catch {
      return { ok: false, reason: "persist_failed" };
    }
    return { ok: true, record, duplicate: false };
  }

  comment(input: {
    challengeId: string;
    intelId: string;
    aboutVersion?: number;
    body: string;
    evidence?: PublicIntelEvidenceRef[];
    authorAttemptId: string;
    authorMemberId?: string;
    clientRequestId?: string;
    notifyMemberIds?: readonly string[];
    markChallenged?: boolean;
  }):
    | { ok: true; record: PublicIntelRecord; comment: PublicIntelComment; duplicate: boolean }
    | { ok: false; reason: string; record?: PublicIntelRecord } {
    try {
      this.ensureDurable();
    } catch {
      return { ok: false, reason: "persist_failed" };
    }
    const record = this.get(input.intelId);
    if (!record || record.challengeId !== input.challengeId) return { ok: false, reason: "not_found" };
    const body = input.body.trim();
    if (!body) return { ok: false, reason: "body_required" };
    if (input.markChallenged && !(input.evidence?.length)) {
      return { ok: false, reason: "challenge_evidence_required", record };
    }
    const aboutVersion = input.aboutVersion ?? record.currentVersion;
    if (input.markChallenged && record.status === "retracted") {
      return { ok: false, reason: "already_retracted", record };
    }
    if (input.markChallenged && aboutVersion !== record.currentVersion) {
      return { ok: false, reason: "version_conflict", record };
    }
    const evidence = input.evidence ?? [];
    const op = input.markChallenged ? "challenge" : "comment";
    const hash = contentHash({ intelId: input.intelId, body, aboutVersion, evidence, op });
    if (input.clientRequestId) {
      const hit = this.idemHit(op, input.challengeId, input.authorAttemptId, input.clientRequestId, hash);
      if (hit === "conflict") return { ok: false, reason: "idempotency_conflict", record };
      if (typeof hit === "object") {
        const existingRecord = this.get(hit.intelId) ?? record;
        const existing = existingRecord.comments.find((row) => row.commentId === hit.commentId);
        if (existing) return { ok: true, record: existingRecord, comment: existing, duplicate: true };
        // Idem points at a missing comment — treat as no hit so retry can create.
      }
    }
    const comment: PublicIntelComment = {
      commentId: randomUUID(),
      intelId: record.intelId,
      aboutVersion,
      body,
      ...(input.evidence?.length ? { evidence: input.evidence } : {}),
      authorAttemptId: input.authorAttemptId,
      ...(input.authorMemberId ? { authorMemberId: input.authorMemberId } : {}),
      createdAt: new Date().toISOString(),
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      ...(input.markChallenged ? { kind: "challenge" as const } : {}),
      ...(input.notifyMemberIds?.length
        ? { notifyMemberIds: uniqueStrings(input.notifyMemberIds).filter((memberId) => memberId !== input.authorMemberId) }
        : {}),
    };
    const nextRecord: PublicIntelRecord = {
      ...record,
      status: input.markChallenged ? "challenged" : record.status,
      comments: [...record.comments, comment],
      updatedAt: comment.createdAt,
    };
    const nextRecords = this.records.map((row) => (row.intelId === record.intelId ? nextRecord : row));
    const nextIdem = input.clientRequestId
      ? this.nextIdem(op, input.challengeId, input.authorAttemptId, input.clientRequestId, hash, {
          intelId: record.intelId,
          commentId: comment.commentId,
        })
      : this.idem;
    try {
      this.commit(nextRecords, nextIdem);
    } catch {
      return { ok: false, reason: "persist_failed", record };
    }
    return { ok: true, record: nextRecord, comment, duplicate: false };
  }

  revise(input: {
    challengeId: string;
    intelId: string;
    expectedVersion: number;
    observation?: string;
    tags?: PublicIntelTag[];
    conditions?: string;
    evidence?: PublicIntelEvidenceRef[];
    links?: PublicIntelLink[];
    polarity?: IntelPolarity;
    reason: string;
    authorAttemptId: string;
    authorMemberId?: string;
    clientRequestId?: string;
  }):
    | { ok: true; record: PublicIntelRecord; duplicate: boolean }
    | { ok: false; reason: string; record?: PublicIntelRecord } {
    try {
      this.ensureDurable();
    } catch {
      return { ok: false, reason: "persist_failed" };
    }
    const record = this.get(input.intelId);
    if (!record || record.challengeId !== input.challengeId) return { ok: false, reason: "not_found" };
    if (!this.isAuthor(record, input.authorAttemptId, input.authorMemberId)) {
      return { ok: false, reason: "author_only", record };
    }
    if (record.status === "retracted") return { ok: false, reason: "already_retracted", record };

    const base =
      record.versions.find((row) => row.version === input.expectedVersion) ??
      record.versions.find((row) => row.version === record.currentVersion)!;
    const observation = (input.observation ?? base.observation).trim();
    const reason = input.reason.trim();
    if (!observation || !reason) return { ok: false, reason: "observation_and_reason_required", record };
    const effectiveTags = canonicalIntelTags(input.tags ?? base.tags);
    const effectiveEvidence = input.evidence?.length ? input.evidence : base.evidence;
    const hash = contentHash({
      intelId: input.intelId,
      expectedVersion: input.expectedVersion,
      observation,
      ...(effectiveTags.length ? { tags: effectiveTags } : {}),
      conditions: input.conditions ?? base.conditions ?? "",
      evidence: effectiveEvidence,
      links: input.links ?? base.links ?? [],
      polarity: input.polarity ?? base.polarity,
      reason,
    });
    const legacyHash = effectiveTags.length === 0
      ? contentHash({
          expectedVersion: input.expectedVersion,
          observation,
          conditions: input.conditions ?? base.conditions ?? "",
          evidence: effectiveEvidence,
          links: input.links ?? base.links ?? [],
          polarity: input.polarity ?? base.polarity,
          reason,
        })
      : undefined;
    if (input.clientRequestId) {
      const hit = this.idemHitTargeted(
        "revise",
        input.challengeId,
        input.authorAttemptId,
        input.clientRequestId,
        hash,
        input.intelId,
        legacyHash,
      );
      if (hit === "conflict") return { ok: false, reason: "idempotency_conflict", record };
      if (typeof hit === "object") {
        const existing = this.get(hit.intelId);
        if (existing) return { ok: true, record: existing, duplicate: true };
      }
    }
    if (record.currentVersion !== input.expectedVersion) {
      return { ok: false, reason: "version_conflict", record };
    }
    const prev = record.versions.find((row) => row.version === record.currentVersion)!;
    const now = new Date().toISOString();
    const nextVersion = record.currentVersion + 1;
    const conditions = (input.conditions ?? prev.conditions)?.trim();
    const nextRecord: PublicIntelRecord = {
      ...record,
      versions: [
        ...record.versions,
        {
          version: nextVersion,
          observation,
          ...(effectiveTags.length ? { tags: effectiveTags } : {}),
          ...(conditions ? { conditions } : {}),
          evidence: effectiveEvidence,
          ...(input.links !== undefined || prev.links?.length
            ? { links: input.links ?? prev.links ?? [] }
            : {}),
          polarity: input.polarity ?? prev.polarity,
          reason,
          authorAttemptId: input.authorAttemptId,
          ...(input.authorMemberId ? { authorMemberId: input.authorMemberId } : {}),
          createdAt: now,
        },
      ],
      currentVersion: nextVersion,
      status: "active",
      updatedAt: now,
    };
    const nextRecords = this.records.map((row) => (row.intelId === record.intelId ? nextRecord : row));
    const nextIdem = input.clientRequestId
      ? this.nextIdem("revise", input.challengeId, input.authorAttemptId, input.clientRequestId, hash, {
          intelId: record.intelId,
          version: nextVersion,
        })
      : this.idem;
    try {
      this.commit(nextRecords, nextIdem);
    } catch {
      return { ok: false, reason: "persist_failed", record };
    }
    return { ok: true, record: nextRecord, duplicate: false };
  }

  retract(input: {
    challengeId: string;
    intelId: string;
    expectedVersion: number;
    reason: string;
    authorAttemptId: string;
    authorMemberId?: string;
    clientRequestId?: string;
  }):
    | { ok: true; record: PublicIntelRecord; duplicate: boolean }
    | { ok: false; reason: string; record?: PublicIntelRecord } {
    try {
      this.ensureDurable();
    } catch {
      return { ok: false, reason: "persist_failed" };
    }
    const record = this.get(input.intelId);
    if (!record || record.challengeId !== input.challengeId) return { ok: false, reason: "not_found" };
    if (!this.isAuthor(record, input.authorAttemptId, input.authorMemberId)) {
      return { ok: false, reason: "author_only", record };
    }
    const reason = input.reason.trim();
    if (!reason) return { ok: false, reason: "reason_required", record };

    const hash = contentHash({
      intelId: input.intelId,
      expectedVersion: input.expectedVersion,
      reason,
    });
    const legacyHash = contentHash({ expectedVersion: input.expectedVersion, reason });
    if (input.clientRequestId) {
      const hit = this.idemHitTargeted(
        "retract",
        input.challengeId,
        input.authorAttemptId,
        input.clientRequestId,
        hash,
        input.intelId,
        legacyHash,
      );
      if (hit === "conflict") return { ok: false, reason: "idempotency_conflict", record };
      if (typeof hit === "object") {
        const existing = this.get(hit.intelId);
        if (existing) return { ok: true, record: existing, duplicate: true };
      }
    }
    if (record.status === "retracted" && record.currentVersion === input.expectedVersion) {
      return { ok: true, record, duplicate: true };
    }
    if (record.currentVersion !== input.expectedVersion) {
      return { ok: false, reason: "version_conflict", record };
    }
    const now = new Date().toISOString();
    const prev = record.versions.find((row) => row.version === record.currentVersion)!;
    const nextVersion = record.currentVersion + 1;
    const nextRecord: PublicIntelRecord = {
      ...record,
      versions: [
        ...record.versions,
        {
          version: nextVersion,
          observation: prev.observation,
          ...(prev.tags?.length ? { tags: prev.tags } : {}),
          ...(prev.conditions ? { conditions: prev.conditions } : {}),
          evidence: prev.evidence,
          polarity: prev.polarity,
          reason,
          authorAttemptId: input.authorAttemptId,
          ...(input.authorMemberId ? { authorMemberId: input.authorMemberId } : {}),
          createdAt: now,
        },
      ],
      currentVersion: nextVersion,
      status: "retracted",
      updatedAt: now,
    };
    const nextRecords = this.records.map((row) => (row.intelId === record.intelId ? nextRecord : row));
    const nextIdem = input.clientRequestId
      ? this.nextIdem("retract", input.challengeId, input.authorAttemptId, input.clientRequestId, hash, {
          intelId: record.intelId,
          version: nextVersion,
        })
      : this.idem;
    try {
      this.commit(nextRecords, nextIdem);
    } catch {
      return { ok: false, reason: "persist_failed", record };
    }
    return { ok: true, record: nextRecord, duplicate: false };
  }

  markRead(input: {
    challengeId: string;
    intelId: string;
    version: number;
    attemptId: string;
    reader?: IntelReaderPrincipal;
    /** Formal-member alias. Independent Groups must pass reader.kind="group" instead. */
    memberId?: string;
    commentIds?: readonly string[];
  }): void {
    const reader = resolveIntelReader(input);
    const commentIds = uniqueStrings(input.commentIds ?? []);
    const existing = this.reads.find(
      (row) =>
        row.challengeId === input.challengeId &&
        receiptReaderKey(row) === readerKey(reader.kind, reader.id) &&
        row.intelId === input.intelId &&
        row.version === input.version,
    );
    if (existing) {
      const mergedCommentIds = uniqueStrings([...(existing.commentIds ?? []), ...commentIds]);
      if (mergedCommentIds.length === (existing.commentIds ?? []).length) return;
      existing.commentIds = mergedCommentIds;
      existing.readAt = new Date().toISOString();
      writeJsonl(this.readsFile, this.reads);
      return;
    }
    this.reads.push({
      schema: PUBLIC_INTEL_READ_SCHEMA,
      challengeId: input.challengeId,
      reader: { kind: reader.kind, id: reader.id },
      attemptId: reader.attemptId,
      intelId: input.intelId,
      version: input.version,
      readAt: new Date().toISOString(),
      ...(reader.kind === "member" ? { memberId: reader.id } : {}),
      ...(commentIds.length ? { commentIds } : {}),
    });
    writeJsonl(this.readsFile, this.reads);
  }

  memberIdsNeedingCommentNotice(challengeId: string, intelId: string, commentId: string): string[] {
    const record = this.get(intelId);
    if (!record || record.challengeId !== challengeId) return [];
    const comment = record.comments.find((row) => row.commentId === commentId);
    if (!comment) return [];
    return uniqueStrings(comment.notifyMemberIds ?? []).filter((memberId) =>
      !this.reads.some(
        (read) =>
          read.challengeId === challengeId &&
          read.intelId === intelId &&
          receiptReaderKey(read) === readerKey("member", memberId) &&
          read.commentIds?.includes(commentId),
      ),
    );
  }

  /** Readers whose latest read of this intel is behind currentVersion (need a change notice). */
  readersNeedingNotice(challengeId: string, intelId: string): Array<{ kind: IntelReaderKind; id: string }> {
    const record = this.get(intelId);
    if (!record || record.challengeId !== challengeId) return [];
    const latestByReader = new Map<string, { principal: { kind: IntelReaderKind; id: string }; version: number }>();
    for (const read of this.reads) {
      if (read.challengeId !== challengeId || read.intelId !== intelId) continue;
      const principal = receiptPrincipal(read);
      const key = readerKey(principal.kind, principal.id);
      const prev = latestByReader.get(key);
      if (prev === undefined || read.version > prev.version) latestByReader.set(key, { principal, version: read.version });
    }
    const out: Array<{ kind: IntelReaderKind; id: string }> = [];
    for (const row of latestByReader.values()) {
      if (row.version < record.currentVersion) out.push(row.principal);
    }
    return out;
  }

  /** Formal-member ids only. Independent Group readers are not merged into this list. */
  memberIdsNeedingNotice(challengeId: string, intelId: string): string[] {
    return this.readersNeedingNotice(challengeId, intelId)
      .filter((row) => row.kind === "member")
      .map((row) => row.id);
  }

  /** Pending version and comment indexes for a formal member. */
  pendingNoticesForMember(challengeId: string, memberId: string): PublicIntelChangeNotice[] {
    const versionNotices = this.pendingNoticesForReader(challengeId, { kind: "member", id: memberId });
    const readCommentIds = new Set<string>();
    for (const read of this.reads) {
      if (
        read.challengeId !== challengeId ||
        receiptReaderKey(read) !== readerKey("member", memberId)
      ) {
        continue;
      }
      for (const commentId of read.commentIds ?? []) readCommentIds.add(commentId);
    }
    const commentsByIntel = new Map<string, { record: PublicIntelRecord; commentIds: string[] }>();
    for (const record of this.records) {
      if (record.challengeId !== challengeId) continue;
      const commentIds = record.comments
        .filter(
          (comment) =>
            comment.notifyMemberIds?.includes(memberId) && !readCommentIds.has(comment.commentId),
        )
        .map((comment) => comment.commentId);
      if (commentIds.length > 0) commentsByIntel.set(record.intelId, { record, commentIds });
    }
    const withComments = versionNotices.map((notice) => {
      const pending = commentsByIntel.get(notice.intelId);
      if (!pending) return notice;
      commentsByIntel.delete(notice.intelId);
      return {
        ...notice,
        commentIds: pending.commentIds.slice(0, PUBLIC_INTEL_NOTICE_COMMENT_IDS_MAX),
        unreadCommentCount: pending.commentIds.length,
      };
    });
    const commentOnly = [...commentsByIntel.values()].map(({ record, commentIds }) => ({
      intelId: record.intelId,
      previousVersion: record.currentVersion,
      currentVersion: record.currentVersion,
      status: record.status,
      kind: record.status === "challenged" && record.comments.some(
        (comment) => commentIds.includes(comment.commentId) && comment.kind === "challenge",
      )
        ? "challenged" as const
        : "commented" as const,
      commentIds: commentIds.slice(0, PUBLIC_INTEL_NOTICE_COMMENT_IDS_MAX),
      unreadCommentCount: commentIds.length,
    }));
    return [...withComments, ...commentOnly];
  }

  pendingNoticesForReader(
    challengeId: string,
    reader: { kind: IntelReaderKind; id: string },
  ): PublicIntelChangeNotice[] {
    const want = readerKey(reader.kind, reader.id);
    const latestReadByIntel = new Map<string, number>();
    for (const read of this.reads) {
      if (read.challengeId !== challengeId || receiptReaderKey(read) !== want) continue;
      const prev = latestReadByIntel.get(read.intelId);
      if (prev === undefined || read.version > prev) {
        latestReadByIntel.set(read.intelId, read.version);
      }
    }
    const notices: PublicIntelChangeNotice[] = [];
    for (const [intelId, latestReadVersion] of latestReadByIntel) {
      const record = this.get(intelId);
      if (!record || record.challengeId !== challengeId) continue;
      if (latestReadVersion >= record.currentVersion) continue;
      notices.push({
        intelId: record.intelId,
        previousVersion: latestReadVersion,
        currentVersion: record.currentVersion,
        status: record.status,
        kind:
          latestReadVersion === 0
            ? "published"
            : record.status === "retracted"
              ? "retracted"
              : record.status === "challenged"
                ? "challenged"
              : "revised",
      });
    }
    return notices;
  }

  projectCurrent(record: PublicIntelRecord): Record<string, unknown> {
    const ver = record.versions.find((row) => row.version === record.currentVersion)!;
    return {
      intelId: record.intelId,
      version: record.currentVersion,
      status: record.status,
      observation: ver.observation,
      tags: ver.tags ?? [],
      ...(ver.conditions ? { conditions: ver.conditions } : {}),
      evidence: ver.evidence,
      links: ver.links ?? [],
      authorAttemptId: record.authorAttemptId,
      ...(record.authorMemberId ? { authorMemberId: record.authorMemberId } : {}),
      ...(record.legacy ? { legacySource: true, producerAttempt: record.legacy.producerAttempt } : {}),
      commentCount: record.comments.length,
      updatedAt: record.updatedAt,
      note: "Recorded observation only — not platform accepted and not a global exclusion verdict",
    };
  }

  private isAuthor(
    record: PublicIntelRecord,
    attemptId: string,
    memberId?: string,
  ): boolean {
    if (record.authorMemberId && memberId) return record.authorMemberId === memberId;
    return record.authorAttemptId === attemptId;
  }

  private idemHit(
    op: string,
    challengeId: string,
    authorAttemptId: string,
    clientRequestId: string,
    hash: string,
  ): IdempotencyRow | "conflict" | undefined {
    const scopeKey = `${challengeId}:${authorAttemptId}:${op}:${clientRequestId}`;
    const existing = this.idem.find((row) => row.scopeKey === scopeKey);
    if (!existing) return undefined;
    if (existing.contentHash !== hash) return "conflict";
    return existing;
  }

  /**
   * Targeted ops (revise/retract/comment): different intelId under the same client key is a conflict.
   * Accepts a legacy content hash so pre-intelId rows still dedupe same-target retries.
   */
  private idemHitTargeted(
    op: string,
    challengeId: string,
    authorAttemptId: string,
    clientRequestId: string,
    hash: string,
    intelId: string,
    legacyHash?: string,
  ): IdempotencyRow | "conflict" | undefined {
    const scopeKey = `${challengeId}:${authorAttemptId}:${op}:${clientRequestId}`;
    const existing = this.idem.find((row) => row.scopeKey === scopeKey);
    if (!existing) return undefined;
    if (existing.intelId !== intelId) return "conflict";
    if (existing.contentHash === hash) return existing;
    if (legacyHash && existing.contentHash === legacyHash) return existing;
    return "conflict";
  }

  private nextIdem(
    op: string,
    challengeId: string,
    authorAttemptId: string,
    clientRequestId: string,
    hash: string,
    ids: { intelId: string; commentId?: string; version?: number },
  ): IdempotencyRow[] {
    const scopeKey = `${challengeId}:${authorAttemptId}:${op}:${clientRequestId}`;
    return [
      ...this.idem.filter((row) => row.scopeKey !== scopeKey),
      {
        scopeKey,
        op,
        contentHash: hash,
        intelId: ids.intelId,
        ...(ids.commentId ? { commentId: ids.commentId } : {}),
        ...(ids.version !== undefined ? { version: ids.version } : {}),
      },
    ];
  }

  private ensureDurable(): void {
    this.recoverPendingCommit();
    if (fs.existsSync(this.pendingCommitFile)) {
      throw new Error("pending commit could not be applied");
    }
  }

  private commit(
    nextRecords: PublicIntelRecord[],
    nextIdem: IdempotencyRow[],
    nextReads: PublicIntelReadReceipt[] = this.reads,
  ): void {
    this.ensureDurable();
    const pending = {
      schema: "silver.public-intel-pending.v1" as const,
      records: nextRecords,
      idem: nextIdem,
      reads: nextReads,
    };
    atomicWriteJson(this.pendingCommitFile, pending);
    this.applyPendingCommit(pending);
    this.records = nextRecords;
    this.idem = nextIdem;
    this.reads = nextReads;
  }

  private recoverPendingCommit(): void {
    if (!fs.existsSync(this.pendingCommitFile)) return;
    let pending: {
      schema?: string;
      records?: PublicIntelRecord[];
      idem?: IdempotencyRow[];
      reads?: PublicIntelReadReceipt[];
    };
    try {
      pending = JSON.parse(fs.readFileSync(this.pendingCommitFile, "utf8")) as typeof pending;
    } catch {
      return;
    }
    if (pending.schema !== "silver.public-intel-pending.v1") return;
    if (!Array.isArray(pending.records) || !Array.isArray(pending.idem)) return;
    try {
      this.applyPendingCommit({
        schema: "silver.public-intel-pending.v1",
        records: pending.records,
        idem: pending.idem,
        ...(Array.isArray(pending.reads) ? { reads: pending.reads } : {}),
      });
      this.records = pending.records.filter(isV2Record);
      this.idem = pending.idem;
      if (Array.isArray(pending.reads)) this.reads = pending.reads;
    } catch {
      // Leave pending for a later retry; do not brick load()/ensureDurable callers mid-inject.
    }
  }

  private applyPendingCommit(pending: {
    schema: "silver.public-intel-pending.v1";
    records: PublicIntelRecord[];
    idem: IdempotencyRow[];
    reads?: PublicIntelReadReceipt[];
  }): void {
    writeJsonl(this.recordsFile, pending.records);
    atomicWriteJson(this.idemFile, { schema: "silver.public-intel-idem.v1", rows: pending.idem });
    if (pending.reads) writeJsonl(this.readsFile, pending.reads);
    try {
      fs.unlinkSync(this.pendingCommitFile);
    } catch {
      /* applied; pending may already be gone */
    }
  }

  private load(): void {
    this.recoverPendingCommit();
    this.records = readJsonl<PublicIntelRecord>(this.recordsFile).filter(isV2Record);
    this.reads = readJsonl<PublicIntelReadReceipt>(this.readsFile);
    if (fs.existsSync(this.idemFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.idemFile, "utf8")) as { rows?: IdempotencyRow[] };
        this.idem = Array.isArray(parsed.rows) ? parsed.rows : [];
      } catch {
        this.idem = [];
      }
    }
  }
}
