import { createHash } from "node:crypto";

export type FindingLedgerStatus = "confirmed" | "candidate" | "uncertain" | "not_observed";
export type FindingLedgerKind = "flag" | "vulnerability" | "credential" | "foothold" | "observation";

export interface FindingLedgerInput {
  kind: string;
  status: FindingLedgerStatus;
  title: string;
  artifactRef?: string;
  evidence?: string;
}

export interface FindingLedgerIntelRef {
  intelId: string;
  version: number;
  sourceStatus?: string;
  sourceChanged?: boolean;
  sourceChange?: string;
  sourceCurrentVersion?: number;
}

export interface FindingLedgerEvidenceRef {
  kind: string;
  ref: string;
}

export interface FindingLedgerEntry {
  id: string;
  kind: FindingLedgerKind;
  status: FindingLedgerStatus;
  title: string;
  sourceKind: string;
  source: "progress" | "authored";
  artifactRef?: string;
  /** Bounded summary text only — not a dump of source-change semantics. */
  evidence?: string;
  currentVersion?: number;
  authorAttemptId?: string;
  authorMemberId?: string;
  summary?: string;
  conditions?: string;
  directEvidence?: FindingLedgerEvidenceRef[];
  intelRefs?: FindingLedgerIntelRef[];
}

/** Full authored identity beyond the display window — used for merge idempotency. */
export type FindingLedgerAuthoredIndex = Record<
  string,
  { status: FindingLedgerStatus; kind: FindingLedgerKind }
>;

export interface FindingLedger {
  schema: "silver.finding-ledger.v1";
  total: number;
  truncated: boolean;
  counts: Record<FindingLedgerStatus, number>;
  kindCounts: Record<FindingLedgerKind, number>;
  entries: FindingLedgerEntry[];
  /**
   * Authored id → status/kind for every authored row ever merged into this ledger.
   * Required so repeat merges do not re-count ids that scrolled out of `entries`.
   */
  authoredIndex?: FindingLedgerAuthoredIndex;
}

const ENTRY_CAP = 64;

export function emptyFindingLedger(): FindingLedger {
  return {
    schema: "silver.finding-ledger.v1",
    total: 0,
    truncated: false,
    counts: emptyStatusCounts(),
    kindCounts: emptyKindCounts(),
    entries: [],
  };
}

export function deriveFindingLedger(input: { findings: readonly FindingLedgerInput[] }): FindingLedger {
  const byId = new Map<string, FindingLedgerEntry>();
  const counts = emptyStatusCounts();
  const kindCounts = emptyKindCounts();
  for (const finding of input.findings) {
    const title = sanitizeFindingText(finding.title, finding).slice(0, 180);
    if (!title) continue;
    const kind = classifyFindingKind(finding);
    const sourceKind = (finding.kind.trim() || "observation").slice(0, 80);
    const evidence = finding.evidence ? sanitizeFindingText(finding.evidence, finding).slice(0, 220) : "";
    const entry: FindingLedgerEntry = {
      id: stableFindingId({
        kind,
        status: finding.status,
        title,
        sourceKind,
        ...(finding.artifactRef ? { artifactRef: finding.artifactRef } : {}),
        ...(evidence ? { evidence } : {}),
      }),
      kind,
      status: finding.status,
      title,
      sourceKind,
      source: "progress",
      ...(finding.artifactRef ? { artifactRef: finding.artifactRef } : {}),
      ...(evidence ? { evidence } : {}),
    };
    if (byId.has(entry.id)) continue;
    byId.set(entry.id, entry);
    counts[entry.status] += 1;
    kindCounts[entry.kind] += 1;
  }
  const entries = [...byId.values()];
  return {
    schema: "silver.finding-ledger.v1",
    total: entries.length,
    truncated: entries.length > ENTRY_CAP,
    counts,
    kindCounts,
    entries: entries.slice(-ENTRY_CAP),
  };
}

/**
 * Append member-authored Finding rows beside progress-derived rows.
 * Does not merge by title; authored ids are stable findingIds (not content hashes).
 * Stats use the ledger's authoritative total/counts (not the display window).
 * Identity for re-merge comes from `authoredIndex` (+ window), never from the cap alone.
 */
export function mergeAuthoredFindingsIntoLedger(
  ledger: FindingLedger,
  authoredEntries: readonly FindingLedgerEntry[],
): FindingLedger {
  const authored = authoredEntries.filter((raw) => raw.source === "authored" && raw.id.trim() && raw.title.trim());
  const authoredIndex: FindingLedgerAuthoredIndex = {
    ...seedAuthoredIndex(ledger),
  };
  // Empty merge must not recompute totals from the truncated entries window.
  if (authored.length === 0) {
    return {
      schema: ledger.schema,
      total: ledger.total,
      truncated: ledger.truncated,
      counts: { ...ledger.counts },
      kindCounts: { ...ledger.kindCounts },
      entries: [...ledger.entries],
      ...(Object.keys(authoredIndex).length > 0 ? { authoredIndex } : {}),
    };
  }

  const byId = new Map<string, FindingLedgerEntry>();
  for (const entry of ledger.entries) byId.set(entry.id, entry);

  const counts = { ...ledger.counts };
  const kindCounts = { ...ledger.kindCounts };
  let total = ledger.total;
  let truncated = ledger.truncated;

  for (const raw of authored) {
    const id = raw.id.trim();
    const windowRow = byId.get(id);
    // Never overwrite a progress row by id; authored and progress stay distinct.
    if (windowRow?.source === "progress") continue;

    const title = raw.title.trim().slice(0, 180);
    if (!title) continue;
    const kind = normalizeLedgerKind(raw.kind);
    const status = normalizeLedgerStatus(raw.status);
    const prior =
      authoredIndex[id] ??
      (windowRow?.source === "authored" ? { status: windowRow.status, kind: windowRow.kind } : undefined);
    const entry: FindingLedgerEntry = {
      id,
      kind,
      status,
      title,
      sourceKind: (raw.sourceKind.trim() || kind).slice(0, 80),
      source: "authored",
      ...(raw.artifactRef ? { artifactRef: raw.artifactRef } : {}),
      ...(raw.evidence ? { evidence: raw.evidence.slice(0, 220) } : {}),
      ...(raw.currentVersion !== undefined ? { currentVersion: raw.currentVersion } : {}),
      ...(raw.authorAttemptId ? { authorAttemptId: raw.authorAttemptId } : {}),
      ...(raw.authorMemberId ? { authorMemberId: raw.authorMemberId } : {}),
      ...(raw.summary ? { summary: raw.summary.slice(0, 220) } : {}),
      ...(raw.conditions ? { conditions: raw.conditions.slice(0, 220) } : {}),
      ...(raw.directEvidence?.length ? { directEvidence: raw.directEvidence } : {}),
      ...(raw.intelRefs?.length ? { intelRefs: raw.intelRefs } : {}),
    };

    if (prior) {
      counts[prior.status] = Math.max(0, counts[prior.status] - 1);
      kindCounts[prior.kind] = Math.max(0, kindCounts[prior.kind] - 1);
      counts[status] += 1;
      kindCounts[kind] += 1;
      // same id — do not increment total (even if scrolled out of entries)
    } else {
      total += 1;
      counts[status] += 1;
      kindCounts[kind] += 1;
    }
    authoredIndex[id] = { status, kind };
    byId.set(id, entry);
  }

  const entries = [...byId.values()];
  if (entries.length > ENTRY_CAP) truncated = true;
  return {
    schema: "silver.finding-ledger.v1",
    total,
    truncated,
    counts,
    kindCounts,
    entries: entries.slice(-ENTRY_CAP),
    authoredIndex,
  };
}

function seedAuthoredIndex(ledger: FindingLedger): FindingLedgerAuthoredIndex {
  const out: FindingLedgerAuthoredIndex = { ...(ledger.authoredIndex ?? {}) };
  for (const entry of ledger.entries) {
    if (entry.source !== "authored" || !entry.id.trim()) continue;
    if (out[entry.id]) continue;
    out[entry.id] = { status: entry.status, kind: entry.kind };
  }
  return out;
}

function emptyStatusCounts(): Record<FindingLedgerStatus, number> {
  return { confirmed: 0, candidate: 0, uncertain: 0, not_observed: 0 };
}

function emptyKindCounts(): Record<FindingLedgerKind, number> {
  return { flag: 0, vulnerability: 0, credential: 0, foothold: 0, observation: 0 };
}

function normalizeLedgerKind(kind: string): FindingLedgerKind {
  const v = kind.trim().toLowerCase();
  if (v === "flag" || v === "vulnerability" || v === "credential" || v === "foothold" || v === "observation") {
    return v;
  }
  return "observation";
}

function normalizeLedgerStatus(status: string): FindingLedgerStatus {
  const v = status.trim().toLowerCase();
  if (v === "confirmed" || v === "candidate" || v === "uncertain" || v === "not_observed") return v;
  return "candidate";
}

function classifyFindingKind(finding: FindingLedgerInput): FindingLedgerKind {
  const text = `${finding.kind} ${finding.title} ${finding.evidence ?? ""}`;
  if (/\b(flag|candidate|submit|oracle)\b/i.test(text)) return "flag";
  if (/\b(credential|creds?|phpsessid|jsessionid|token|session|cookie|password|passwd|secret|api[_-]?key)\b/i.test(text)) {
    return "credential";
  }
  if (/\b(foothold|shell|rce|exec|command execution|initial access|pivot)\b/i.test(text)) return "foothold";
  if (/\b(vuln|sqli|sql injection|xss|ssti|ssrf|idor|lfi|rfi|xxe|deserialization|prototype pollution|auth bypass)\b/i.test(text)) {
    return "vulnerability";
  }
  return "observation";
}

function sanitizeFindingText(value: string, finding: FindingLedgerInput): string {
  const text = value.trim();
  if (!text) return "";
  if (classifyFindingKind(finding) !== "credential") return text;
  return text
    .replace(/\b(PHPSESSID|JSESSIONID|session|token|cookie|password|passwd|secret|api[_-]?key)=\S+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

function stableFindingId(input: {
  kind: FindingLedgerKind;
  status: FindingLedgerStatus;
  title: string;
  sourceKind: string;
  artifactRef?: string;
  evidence?: string;
}): string {
  const raw = JSON.stringify({
    kind: input.kind,
    status: input.status,
    title: input.title,
    sourceKind: input.sourceKind,
    artifactRef: input.artifactRef ?? "",
    evidence: input.evidence ?? "",
  });
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
