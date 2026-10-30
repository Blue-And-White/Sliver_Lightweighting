/**
 * Finding v1 — member-authored result claims with versions, evidence, and pinned intel refs.
 * Distinct from progress-derived findingLedger rows (source: "progress").
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PublicIntelEvidenceRef } from "./intel-v2.ts";
import { PublicIntelStore } from "./intel-v2.ts";
import type {
  FindingLedgerEntry,
  FindingLedgerEvidenceRef,
  FindingLedgerIntelRef,
  FindingLedgerKind,
  FindingLedgerStatus,
} from "./finding-ledger.ts";

export const FINDING_V1_SCHEMA = "silver.finding.v1" as const;
export const FINDING_READ_SCHEMA = "silver.finding-read.v1" as const;

export type FindingJudgment = "candidate" | "confirmed" | "uncertain" | "not_observed";
export type FindingKind = "flag" | "vulnerability" | "credential" | "foothold" | "observation";
export type FindingRecordStatus = "active" | "retracted";

export type FindingIntelRef = {
  intelId: string;
  /** Pinned version at citation time — never silently retargeted. */
  version: number;
};

export type FindingVersion = {
  version: number;
  title: string;
  kind: FindingKind;
  summary: string;
  conditions?: string;
  /** Member judgment only — not platform accepted. */
  judgment: FindingJudgment;
  evidence: PublicIntelEvidenceRef[];
  intelRefs: FindingIntelRef[];
  reason?: string;
  authorAttemptId: string;
  authorMemberId?: string;
  createdAt: string;
};

export type FindingRecord = {
  schema: typeof FINDING_V1_SCHEMA;
  findingId: string;
  challengeId: string;
  status: FindingRecordStatus;
  currentVersion: number;
  versions: FindingVersion[];
  authorAttemptId: string;
  authorMemberId?: string;
  createdAt: string;
  updatedAt: string;
  clientRequestId?: string;
};

type IdempotencyRow = {
  scopeKey: string;
  op: string;
  contentHash: string;
  findingId: string;
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

export function findingDir(workspace: string): string {
  return path.join(workspace, "findings");
}

export function findingRecordsPath(workspace: string): string {
  return path.join(findingDir(workspace), "records-v1.jsonl");
}

export function findingIdempotencyPath(workspace: string): string {
  return path.join(findingDir(workspace), "idempotency-v1.json");
}

export function findingPendingCommitPath(workspace: string): string {
  return path.join(findingDir(workspace), "pending-commit-v1.json");
}

function isFindingRecord(row: unknown): row is FindingRecord {
  return Boolean(row && typeof row === "object" && (row as FindingRecord).schema === FINDING_V1_SCHEMA);
}

function normalizeKind(raw: string): FindingKind {
  const v = raw.trim().toLowerCase();
  if (v === "flag" || v === "vulnerability" || v === "credential" || v === "foothold" || v === "observation") {
    return v;
  }
  return "observation";
}

function normalizeJudgment(raw: string): FindingJudgment {
  const v = raw.trim().toLowerCase();
  if (v === "confirmed" || v === "candidate" || v === "uncertain" || v === "not_observed") return v;
  return "candidate";
}

export class FindingStore {
  private records: FindingRecord[] = [];
  private idem: IdempotencyRow[] = [];
  private readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.reload();
  }

  private recordsFile(): string {
    return findingRecordsPath(this.workspace);
  }

  private idemFile(): string {
    return findingIdempotencyPath(this.workspace);
  }

  private pendingFile(): string {
    return findingPendingCommitPath(this.workspace);
  }

  private reload(): void {
    this.recoverPendingCommit();
    this.records = readJsonl<unknown>(this.recordsFile()).filter(isFindingRecord);
    this.idem = fs.existsSync(this.idemFile())
      ? (JSON.parse(fs.readFileSync(this.idemFile(), "utf8")) as IdempotencyRow[])
      : [];
  }

  private ensureDurable(): void {
    this.recoverPendingCommit();
    if (fs.existsSync(this.pendingFile())) {
      throw new Error("pending commit could not be applied");
    }
  }

  private recoverPendingCommit(): void {
    const pending = this.pendingFile();
    if (!fs.existsSync(pending)) return;
    let parsed: { records?: FindingRecord[]; idem?: IdempotencyRow[] };
    try {
      parsed = JSON.parse(fs.readFileSync(pending, "utf8")) as typeof parsed;
    } catch {
      return;
    }
    if (!Array.isArray(parsed.records) || !Array.isArray(parsed.idem)) return;
    try {
      writeJsonl(this.recordsFile(), parsed.records);
      atomicWriteJson(this.idemFile(), parsed.idem);
      try {
        fs.unlinkSync(pending);
      } catch {
        /* applied; pending may already be gone */
      }
      // Keep in-memory authority aligned with the recovered journal so same-process
      // retries hit idempotency instead of minting a second findingId.
      this.records = parsed.records.filter(isFindingRecord);
      this.idem = parsed.idem;
    } catch {
      // Leave pending for a later retry; do not brick load()/ensureDurable mid-inject.
    }
  }

  private commit(records: FindingRecord[], idem: IdempotencyRow[]): void {
    this.ensureDurable();
    const pending = this.pendingFile();
    atomicWriteJson(pending, { records, idem });
    writeJsonl(this.recordsFile(), records);
    atomicWriteJson(this.idemFile(), idem);
    try {
      fs.unlinkSync(pending);
    } catch {
      /* applied */
    }
    this.records = records;
    this.idem = idem;
  }

  private scopeKey(op: string, challengeId: string, authorAttemptId: string, clientRequestId: string): string {
    return `${op}:${challengeId}:${authorAttemptId}:${clientRequestId}`;
  }

  private idemHit(
    op: string,
    challengeId: string,
    authorAttemptId: string,
    clientRequestId: string,
    hash: string,
  ): IdempotencyRow | "conflict" | undefined {
    const key = this.scopeKey(op, challengeId, authorAttemptId, clientRequestId);
    const hit = this.idem.find((row) => row.scopeKey === key);
    if (!hit) return undefined;
    if (hit.contentHash !== hash) return "conflict";
    return hit;
  }

  private nextIdem(
    op: string,
    challengeId: string,
    authorAttemptId: string,
    clientRequestId: string,
    hash: string,
    extras: { findingId: string; version?: number },
  ): IdempotencyRow[] {
    const key = this.scopeKey(op, challengeId, authorAttemptId, clientRequestId);
    const row: IdempotencyRow = {
      scopeKey: key,
      op,
      contentHash: hash,
      findingId: extras.findingId,
      ...(extras.version !== undefined ? { version: extras.version } : {}),
    };
    return [...this.idem.filter((r) => r.scopeKey !== key), row];
  }

  private isAuthor(
    record: FindingRecord,
    authorAttemptId: string,
    authorMemberId?: string,
  ): boolean {
    if (record.authorAttemptId === authorAttemptId) return true;
    if (authorMemberId && record.authorMemberId && record.authorMemberId === authorMemberId) return true;
    return false;
  }

  get(findingId: string): FindingRecord | undefined {
    return this.records.find((row) => row.findingId === findingId);
  }

  list(challengeId: string, opts?: { includeRetracted?: boolean }): FindingRecord[] {
    return this.records.filter(
      (row) =>
        row.challengeId === challengeId &&
        (opts?.includeRetracted || row.status === "active"),
    );
  }

  record(input: {
    challengeId: string;
    authorAttemptId: string;
    authorMemberId?: string;
    title: string;
    kind?: string;
    summary: string;
    conditions?: string;
    judgment?: string;
    evidence?: PublicIntelEvidenceRef[];
    intelRefs?: FindingIntelRef[];
    clientRequestId?: string;
  }):
    | { ok: true; record: FindingRecord; duplicate: boolean }
    | { ok: false; reason: string } {
    try {
      this.ensureDurable();
    } catch {
      return { ok: false, reason: "persist_failed" };
    }
    const title = input.title.trim();
    const summary = input.summary.trim();
    if (!title || !summary) return { ok: false, reason: "title_and_summary_required" };
    const kind = normalizeKind(input.kind ?? "observation");
    const judgment = normalizeJudgment(input.judgment ?? "candidate");
    const evidence = input.evidence ?? [];
    const intelRefs = input.intelRefs ?? [];
    const hash = contentHash({
      title,
      kind,
      summary,
      conditions: input.conditions ?? "",
      judgment,
      evidence,
      intelRefs,
    });
    if (input.clientRequestId) {
      const hit = this.idemHit("record", input.challengeId, input.authorAttemptId, input.clientRequestId, hash);
      if (hit === "conflict") return { ok: false, reason: "idempotency_conflict" };
      if (hit) {
        const existing = this.get(hit.findingId);
        if (existing) return { ok: true, record: existing, duplicate: true };
      }
    }
    const now = new Date().toISOString();
    const version: FindingVersion = {
      version: 1,
      title,
      kind,
      summary,
      ...(input.conditions?.trim() ? { conditions: input.conditions.trim() } : {}),
      judgment,
      evidence,
      intelRefs,
      authorAttemptId: input.authorAttemptId,
      ...(input.authorMemberId ? { authorMemberId: input.authorMemberId } : {}),
      createdAt: now,
    };
    const record: FindingRecord = {
      schema: FINDING_V1_SCHEMA,
      findingId: randomUUID(),
      challengeId: input.challengeId,
      status: "active",
      currentVersion: 1,
      versions: [version],
      authorAttemptId: input.authorAttemptId,
      ...(input.authorMemberId ? { authorMemberId: input.authorMemberId } : {}),
      createdAt: now,
      updatedAt: now,
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    };
    const nextIdem = input.clientRequestId
      ? this.nextIdem("record", input.challengeId, input.authorAttemptId, input.clientRequestId, hash, {
          findingId: record.findingId,
          version: 1,
        })
      : this.idem;
    try {
      this.commit([...this.records, record], nextIdem);
    } catch {
      return { ok: false, reason: "persist_failed" };
    }
    return { ok: true, record, duplicate: false };
  }

  revise(input: {
    challengeId: string;
    findingId: string;
    expectedVersion: number;
    authorAttemptId: string;
    authorMemberId?: string;
    title?: string;
    kind?: string;
    summary?: string;
    conditions?: string;
    judgment?: string;
    evidence?: PublicIntelEvidenceRef[];
    intelRefs?: FindingIntelRef[];
    reason: string;
    clientRequestId?: string;
  }):
    | { ok: true; record: FindingRecord; duplicate: boolean }
    | { ok: false; reason: string; record?: FindingRecord } {
    try {
      this.ensureDurable();
    } catch {
      return { ok: false, reason: "persist_failed" };
    }
    const record = this.get(input.findingId);
    if (!record || record.challengeId !== input.challengeId) return { ok: false, reason: "not_found" };
    if (!this.isAuthor(record, input.authorAttemptId, input.authorMemberId)) {
      return { ok: false, reason: "author_only", record };
    }
    // Omitted fields resolve against the version named by expectedVersion, not whatever tip
    // exists after a prior successful revise — keeps the original request hash stable.
    const base = record.versions.find((row) => row.version === input.expectedVersion);
    if (!base) return { ok: false, reason: "version_conflict", record };
    const reason = input.reason.trim();
    if (!reason) return { ok: false, reason: "reason_required", record };
    const title = (input.title ?? base.title).trim();
    const summary = (input.summary ?? base.summary).trim();
    const kind = input.kind !== undefined ? normalizeKind(input.kind) : base.kind;
    const judgment = input.judgment !== undefined ? normalizeJudgment(input.judgment) : base.judgment;
    const conditions = input.conditions !== undefined ? input.conditions.trim() : base.conditions;
    const evidence = input.evidence ?? base.evidence;
    const intelRefs = input.intelRefs ?? base.intelRefs;
    const hash = contentHash({
      findingId: input.findingId,
      expectedVersion: input.expectedVersion,
      title,
      kind,
      summary,
      conditions: conditions ?? "",
      judgment,
      evidence,
      intelRefs,
      reason,
    });
    // Resolve same-request receipts before status/version rejection.
    if (input.clientRequestId) {
      const hit = this.idemHit("revise", input.challengeId, input.authorAttemptId, input.clientRequestId, hash);
      if (hit === "conflict") return { ok: false, reason: "idempotency_conflict", record };
      if (hit) {
        const existing = this.get(hit.findingId);
        if (existing) return { ok: true, record: existing, duplicate: true };
      }
    }
    if (record.status === "retracted") return { ok: false, reason: "already_retracted", record };
    if (input.expectedVersion !== record.currentVersion) {
      return { ok: false, reason: "version_conflict", record };
    }
    const now = new Date().toISOString();
    const nextVersion: FindingVersion = {
      version: record.currentVersion + 1,
      title,
      kind,
      summary,
      ...(conditions ? { conditions } : {}),
      judgment,
      evidence,
      intelRefs,
      reason,
      authorAttemptId: input.authorAttemptId,
      ...(input.authorMemberId ? { authorMemberId: input.authorMemberId } : {}),
      createdAt: now,
    };
    const nextRecord: FindingRecord = {
      ...record,
      currentVersion: nextVersion.version,
      versions: [...record.versions, nextVersion],
      updatedAt: now,
    };
    const nextIdem = input.clientRequestId
      ? this.nextIdem("revise", input.challengeId, input.authorAttemptId, input.clientRequestId, hash, {
          findingId: record.findingId,
          version: nextVersion.version,
        })
      : this.idem;
    try {
      this.commit(
        this.records.map((row) => (row.findingId === record.findingId ? nextRecord : row)),
        nextIdem,
      );
    } catch {
      return { ok: false, reason: "persist_failed", record };
    }
    return { ok: true, record: nextRecord, duplicate: false };
  }

  retract(input: {
    challengeId: string;
    findingId: string;
    expectedVersion: number;
    authorAttemptId: string;
    authorMemberId?: string;
    reason: string;
    clientRequestId?: string;
  }):
    | { ok: true; record: FindingRecord; duplicate: boolean }
    | { ok: false; reason: string; record?: FindingRecord } {
    try {
      this.ensureDurable();
    } catch {
      return { ok: false, reason: "persist_failed" };
    }
    const record = this.get(input.findingId);
    if (!record || record.challengeId !== input.challengeId) return { ok: false, reason: "not_found" };
    if (!this.isAuthor(record, input.authorAttemptId, input.authorMemberId)) {
      return { ok: false, reason: "author_only", record };
    }
    const reason = input.reason.trim();
    if (!reason) return { ok: false, reason: "reason_required", record };
    const hash = contentHash({
      findingId: input.findingId,
      expectedVersion: input.expectedVersion,
      reason,
    });
    // Same-key receipt / conflict before already_retracted so a different body is not masked.
    if (input.clientRequestId) {
      const hit = this.idemHit("retract", input.challengeId, input.authorAttemptId, input.clientRequestId, hash);
      if (hit === "conflict") return { ok: false, reason: "idempotency_conflict", record };
      if (hit) {
        const existing = this.get(hit.findingId);
        if (existing) return { ok: true, record: existing, duplicate: true };
      }
    }
    if (record.status === "retracted") return { ok: false, reason: "already_retracted", record };
    if (input.expectedVersion !== record.currentVersion) {
      return { ok: false, reason: "version_conflict", record };
    }
    const now = new Date().toISOString();
    const tip = record.versions.find((row) => row.version === record.currentVersion)!;
    const retractVersion: FindingVersion = {
      ...tip,
      version: record.currentVersion + 1,
      reason,
      authorAttemptId: input.authorAttemptId,
      ...(input.authorMemberId ? { authorMemberId: input.authorMemberId } : {}),
      createdAt: now,
    };
    const nextRecord: FindingRecord = {
      ...record,
      status: "retracted",
      currentVersion: retractVersion.version,
      versions: [...record.versions, retractVersion],
      updatedAt: now,
    };
    const nextIdem = input.clientRequestId
      ? this.nextIdem("retract", input.challengeId, input.authorAttemptId, input.clientRequestId, hash, {
          findingId: record.findingId,
          version: retractVersion.version,
        })
      : this.idem;
    try {
      this.commit(
        this.records.map((row) => (row.findingId === record.findingId ? nextRecord : row)),
        nextIdem,
      );
    } catch {
      return { ok: false, reason: "persist_failed", record };
    }
    return { ok: true, record: nextRecord, duplicate: false };
  }

  projectCurrent(
    record: FindingRecord,
    opts?: { intelStore?: PublicIntelStore; includeHistory?: boolean },
  ): Record<string, unknown> {
    const tip = record.versions.find((row) => row.version === record.currentVersion)!;
    const intelRefs = tip.intelRefs.map((ref) => this.projectIntelRef(ref, opts?.intelStore));
    const base: Record<string, unknown> = {
      schema: FINDING_READ_SCHEMA,
      findingId: record.findingId,
      challengeId: record.challengeId,
      status: record.status,
      currentVersion: record.currentVersion,
      title: tip.title,
      kind: tip.kind,
      summary: tip.summary,
      ...(tip.conditions ? { conditions: tip.conditions } : {}),
      judgment: tip.judgment,
      judgmentNote: "Member judgment only — not platform accepted",
      evidence: tip.evidence,
      intelRefs,
      authorAttemptId: record.authorAttemptId,
      ...(record.authorMemberId ? { authorMemberId: record.authorMemberId } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      note: "Authored Finding; does not change platform accepted, remaining, or room end-state",
    };
    if (opts?.includeHistory) {
      base.versions = record.versions.map((row) => ({
        version: row.version,
        title: row.title,
        kind: row.kind,
        summary: row.summary,
        ...(row.conditions ? { conditions: row.conditions } : {}),
        judgment: row.judgment,
        evidence: row.evidence,
        intelRefs: row.intelRefs.map((ref) => this.projectIntelRef(ref, opts?.intelStore)),
        ...(row.reason ? { reason: row.reason } : {}),
        authorAttemptId: row.authorAttemptId,
        ...(row.authorMemberId ? { authorMemberId: row.authorMemberId } : {}),
        createdAt: row.createdAt,
      }));
    }
    return base;
  }

  /** Project active authored Findings into findingLedger rows (source:"authored"). */
  toLedgerEntries(
    challengeId: string,
    opts?: { intelStore?: PublicIntelStore; includeRetracted?: boolean },
  ): FindingLedgerEntry[] {
    const listOpts = opts?.includeRetracted ? { includeRetracted: true as const } : undefined;
    return this.list(challengeId, listOpts).map((record) => {
      const tip = record.versions.find((row) => row.version === record.currentVersion)!;
      const projected = this.projectCurrent(
        record,
        opts?.intelStore ? { intelStore: opts.intelStore } : undefined,
      );
      const intelRefsRaw = (projected.intelRefs as Array<Record<string, unknown>> | undefined) ?? [];
      const intelRefs: FindingLedgerIntelRef[] = intelRefsRaw.map((ref) => {
        const out: FindingLedgerIntelRef = {
          intelId: String(ref.intelId ?? ""),
          version: Number(ref.version ?? 0),
        };
        if (typeof ref.sourceStatus === "string") out.sourceStatus = ref.sourceStatus;
        if (ref.sourceChanged === true) out.sourceChanged = true;
        if (typeof ref.sourceChange === "string") out.sourceChange = ref.sourceChange;
        if (typeof ref.sourceCurrentVersion === "number") out.sourceCurrentVersion = ref.sourceCurrentVersion;
        return out;
      });
      const directEvidence: FindingLedgerEvidenceRef[] = tip.evidence.map((row) => ({
        kind: row.kind,
        ref: row.ref,
      }));
      const summary = tip.summary.slice(0, 220);
      return {
        id: record.findingId,
        kind: tip.kind as FindingLedgerKind,
        status: tip.judgment as FindingLedgerStatus,
        title: tip.title,
        sourceKind: tip.kind,
        source: "authored" as const,
        currentVersion: record.currentVersion,
        authorAttemptId: record.authorAttemptId,
        ...(record.authorMemberId ? { authorMemberId: record.authorMemberId } : {}),
        ...(summary ? { summary, evidence: summary } : {}),
        ...(tip.conditions ? { conditions: tip.conditions.slice(0, 220) } : {}),
        ...(directEvidence.length ? { directEvidence } : {}),
        ...(intelRefs.length ? { intelRefs } : {}),
        ...(directEvidence[0]?.ref ? { artifactRef: directEvidence[0].ref } : {}),
      };
    });
  }

  private projectIntelRef(
    ref: FindingIntelRef,
    intelStore?: PublicIntelStore,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {
      intelId: ref.intelId,
      version: ref.version,
      pinned: true,
    };
    if (!intelStore) return out;
    const intel = intelStore.get(ref.intelId);
    if (!intel) {
      out.sourceStatus = "missing";
      return out;
    }
    out.sourceStatus = intel.status;
    out.sourceCurrentVersion = intel.currentVersion;
    if (intel.currentVersion !== ref.version || intel.status === "retracted") {
      out.sourceChanged = true;
      out.sourceChange =
        intel.status === "retracted"
          ? "retracted"
          : intel.currentVersion > ref.version
            ? "revised"
            : "changed";
      out.latestEntry = {
        version: intel.currentVersion,
        status: intel.status,
        observation: intel.versions.find((v) => v.version === intel.currentVersion)?.observation?.slice(0, 200),
      };
    }
    const pinned = intel.versions.find((v) => v.version === ref.version);
    if (pinned) {
      out.pinnedObservation = pinned.observation.slice(0, 200);
      out.pinnedPolarity = pinned.polarity;
    }
    return out;
  }
}
