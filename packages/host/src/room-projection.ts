/**
 * Deterministic Room Projection (Slice C1).
 * Rebuilds a bounded Room Map from already-keyed Host facts (roster, Intel,
 * candidates, platform/deadline snapshots). Not a state machine,
 * Reviewer, Lead decision loop, or convergence generation.
 *
 * Product key is stable memberId; attemptId/sessionId are runtime bindings only.
 * foldRoomProjectionFacts merges keyed snapshots by updatedAt/createdAt — it is
 * not an event-log last-write-wins reducer.
 */
import { createHash } from "node:crypto";
import { artifactRefEscapeGuidance } from "@silver/oracle";

export const ROOM_PROJECTION_SCHEMA = "silver.room-projection.v1" as const;
const ROOM_PROJECTION_HANDOFF_EVIDENCE_MAX = 12;

export type RoomPlatformStatus =
  | "active"
  | "reviewing"
  | "pending"
  | "completed"
  | "closed"
  | "interrupted"
  | "stalled"
  | "ended";

export type RoomProjectionMemberInput = {
  memberId: string;
  role: "lead" | "worker";
  /** Runtime binding only — never the product identity. */
  attemptId?: string;
  sessionId?: string;
  status: string;
  approach?: string;
  lastTool?: string;
  updatedAt?: string;
};

export type RoomProjectionEvidenceInput = {
  intelId: string;
  kind: string;
  artifactRef: string;
  producerMemberId: string;
  createdAt: string;
  updatedAt?: string;
};

export type RoomProjectionCandidateInput = {
  fingerprint: string;
  oracle: string;
  submission?: string;
  evidenceRef?: string | null;
};

/** Platform verdict row. Statuses are never merged; rejected is only verdict.correct===false. */
export type RoomProjectionReviewStatus = "pending" | "accepted" | "rejected" | "duplicate" | "unknown";

export type RoomProjectionReviewInput = {
  fingerprint: string;
  status: RoomProjectionReviewStatus;
  reviewedAt: string;
  submittedByMemberId?: string;
  candidateId?: string;
  awarded?: number;
  correctFlagCount?: number;
  totalFlagCount?: number;
  platformCompleted?: boolean;
  artifactRef?: string;
  /** Duplicate rows point at the prior platformVerdicts result; they are not a new reject. */
  priorStatus?: RoomProjectionReviewStatus;
  /** Host-authored; set for rejected (and priorStatus=rejected duplicates). */
  guidance?: string;
};

export type RoomProjectionInput = {
  roomId: string;
  challengeId: string;
  objective?: string;
  /** Per-attempt write location for verify/submit evidence. Not part of the version hash. */
  attemptArtifactsRoot?: string;
  deadline?: {
    startedAt: string;
    deadlineAt: string;
    budgetMs: number;
    remainingMs: number;
    expired: boolean;
    unbounded?: true;
  };
  platform: {
    status: RoomPlatformStatus;
    reason?: string;
  };
  members: RoomProjectionMemberInput[];
  evidence?: RoomProjectionEvidenceInput[];
  candidates?: RoomProjectionCandidateInput[];
  reviews?: RoomProjectionReviewInput[];
  /** Latest Feed checkpoint. Not part of the version hash and not a route ledger. */
  latestCheckpoint?: RoomCheckpointProjection;
  /** Optional prior version for change index (delivery UX only, not authoritative). */
  priorVersion?: string;
  /** Optional prior section digests — when absent, changes are coarse (non-empty index). */
  priorSectionDigests?: Partial<Record<RoomProjectionChangeSection, string>>;
  nowMs?: number;
};

export type RoomProjectionChangeSection = keyof RoomMap | "platform" | "deadline" | "members";

export type RoomMapEvidence = {
  intelId: string;
  kind: string;
  artifactRef: string;
  producerMemberId: string;
  createdAt: string;
  updatedAt?: string;
};

export type RoomMapActive = {
  memberId: string;
  role: "lead" | "worker";
  status: string;
  attemptId?: string;
  sessionId?: string;
  approach?: string;
  lastTool?: string;
  updatedAt?: string;
};

export type RoomMapCandidate = {
  fingerprint: string;
  oracle: string;
  submission?: string;
  evidenceRef?: string;
};

export type RoomMapReview = {
  fingerprint: string;
  status: RoomProjectionReviewStatus;
  reviewedAt: string;
  submittedByMemberId?: string;
  candidateId?: string;
  awarded?: number;
  correctFlagCount?: number;
  totalFlagCount?: number;
  platformCompleted?: boolean;
  artifactRef?: string;
  priorStatus?: RoomProjectionReviewStatus;
  guidance?: string;
};

/** Objective rejected-fingerprint fact. Never inferred from Status or route similarity. */
export type RoomMapTension = {
  fingerprint: string;
  verdict: "rejected";
  priorStatus?: RoomProjectionReviewStatus;
  reviewedAt: string;
  guidance: string;
};

/** Mechanical platform fact on rejected REVIEW/TENSIONS rows. */
export const PLATFORM_REJECTED_FINGERPRINT_GUIDANCE =
  "platform rejected this exact candidate value; Host records the verdict but does not decide whether the room may submit it again";

export function shortCandidateFingerprint(fingerprint: string): string {
  const trimmed = fingerprint.trim();
  return trimmed.length <= 12 ? trimmed : trimmed.slice(0, 12);
}

export function platformRejectedFingerprintGuidance(fingerprint: string): string {
  return `${PLATFORM_REJECTED_FINGERPRINT_GUIDANCE} (rejected ${shortCandidateFingerprint(fingerprint)})`;
}

export type RoomMap = {
  EVIDENCE: RoomMapEvidence[];
  ACTIVE: RoomMapActive[];
  TENSIONS: RoomMapTension[];
  REVIEW: RoomMapReview[];
  CANDIDATES: RoomMapCandidate[];
  /** Empty in C1 — convergence decisions arrive in C3. */
  DECISIONS: [];
};

export type RoomCheckpointProjection = {
  confirmedFacts: string;
  triedScope: string;
  failedHypothesis: string;
  likelyRoute: string;
  nextVariables: string[];
  messageId: string;
  createdAt: string;
};

export type RoomProjectionSummary = {
  evidenceCount: number;
  activeMemberCount: number;
  candidateCount: number;
  tensionCount: number;
  reviewCount: number;
  decisionCount: number;
  platformStatus: RoomPlatformStatus;
};

export type RoomProjection = {
  schema: typeof ROOM_PROJECTION_SCHEMA;
  roomId: string;
  challengeId: string;
  version: string;
  updatedAt: string;
  attemptArtifactsRoot?: string;
  objective?: string;
  deadline?: RoomProjectionInput["deadline"];
  platform: RoomProjectionInput["platform"];
  /** Roster keyed conceptually by memberId (array, stable sort). */
  members: RoomMapActive[];
  map: RoomMap;
  summary: RoomProjectionSummary;
  changes: {
    sinceVersion: string | null;
    sections: RoomProjectionChangeSection[];
  };
  /** Digests for the next room_info change index (not a state machine). */
  sectionDigests: Partial<Record<RoomProjectionChangeSection, string>>;
  /** High-priority handoff. History stays in the Feed. */
  latestCheckpoint?: RoomCheckpointProjection;
};

export type RoomProjectionChallengeInfo = {
  schema: typeof ROOM_PROJECTION_SCHEMA;
  version: string;
  summary: RoomProjectionSummary;
  changes: RoomProjection["changes"];
  /** Bounded factual indexes. Bodies remain available through their owning tools. */
  EVIDENCE: RoomMap["EVIDENCE"];
  REVIEW: RoomMap["REVIEW"];
  TENSIONS: RoomMap["TENSIONS"];
  attemptArtifactsRoot?: string;
  evidenceHint?: string;
  latestCheckpoint?: RoomCheckpointProjection;
};

/**
 * Keyed Host facts that merge into a projection input.
 * Conflict resolution is by updatedAt/createdAt (then stable stringify), never array order.
 */
export type RoomProjectionFact =
  | ({ kind: "member" } & RoomProjectionMemberInput)
  | {
      kind: "evidence";
      intelId: string;
      evidenceKind: string;
      artifactRef: string;
      producerMemberId: string;
      createdAt: string;
      updatedAt?: string;
    }
  | ({ kind: "candidate" } & RoomProjectionCandidateInput)
  | ({ kind: "review" } & RoomProjectionReviewInput)
  | {
      kind: "platform";
      status: RoomPlatformStatus;
      reason?: string;
      updatedAt?: string;
    }
  | {
      kind: "deadline";
      startedAt: string;
      deadlineAt: string;
      budgetMs: number;
      remainingMs: number;
      expired: boolean;
      unbounded?: true;
      updatedAt?: string;
    }
  | {
      kind: "meta";
      roomId: string;
      challengeId: string;
      objective?: string;
      attemptArtifactsRoot?: string;
    };

function clipText(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Strip common secret-shaped tokens; never keep raw flag-like payloads in projection. */
export function sanitizeProjectionText(text: string, max = 160): string {
  const redacted = text
    .replace(/\b(PHPSESSID|JSESSIONID|session|token|cookie|password|passwd|secret|api[_-]?key)=\S+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk-|xai-|gsk_|Bearer\s+)\S+/gi, "[REDACTED]")
    .replace(/\bflag\{[^}]*\}/gi, "flag{[REDACTED]}")
    .replace(/\bCTF\{[^}]*\}/gi, "CTF{[REDACTED]}");
  return clipText(redacted, max);
}

function sanitizeCheckpoint(row: RoomCheckpointProjection): RoomCheckpointProjection {
  return {
    confirmedFacts: sanitizeProjectionText(row.confirmedFacts, 400),
    triedScope: sanitizeProjectionText(row.triedScope, 400),
    failedHypothesis: sanitizeProjectionText(row.failedHypothesis, 240),
    likelyRoute: sanitizeProjectionText(row.likelyRoute, 240),
    nextVariables: row.nextVariables.map((value) => sanitizeProjectionText(value, 120)),
    messageId: sanitizeProjectionText(row.messageId, 80),
    createdAt: row.createdAt,
  };
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function contentVersion(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex").slice(0, 16);
}

/** Deadline identity + discrete expiry only — remainingMs is live UX, not version authority. */
export function deadlineIdentityForVersion(
  deadline: RoomProjectionInput["deadline"] | undefined,
): { startedAt: string; deadlineAt: string; budgetMs: number; expired: boolean; unbounded?: true } | undefined {
  if (!deadline) return undefined;
  return {
    startedAt: deadline.startedAt,
    deadlineAt: deadline.deadlineAt,
    budgetMs: deadline.budgetMs,
    expired: deadline.expired,
    ...(deadline.unbounded ? { unbounded: true as const } : {}),
  };
}

function stampMs(stamp: string | undefined): number {
  if (!stamp) return Number.NaN;
  return Date.parse(stamp);
}

/**
 * Prefer the newer stamped row; on missing/equal stamps pick the lexicographically
 * greater stable serialization so reverse input order cannot change the winner.
 */
export function preferKeyedFact<T>(prior: T | undefined, next: T, stampOf: (row: T) => string | undefined): T {
  if (!prior) return next;
  const a = stampMs(stampOf(prior));
  const b = stampMs(stampOf(next));
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b > a ? next : prior;
  if (Number.isFinite(b) && !Number.isFinite(a)) return next;
  if (Number.isFinite(a) && !Number.isFinite(b)) return prior;
  return stableStringify(next) > stableStringify(prior) ? next : prior;
}

function rejectedFingerprintGuidance(row: {
  fingerprint: string;
  status: RoomProjectionReviewStatus;
  priorStatus?: RoomProjectionReviewStatus;
}): string | undefined {
  if (row.status === "rejected" || row.priorStatus === "rejected") {
    return platformRejectedFingerprintGuidance(row.fingerprint);
  }
  return undefined;
}

function sanitizeReview(row: RoomProjectionReviewInput): RoomProjectionReviewInput {
  const guidance = rejectedFingerprintGuidance(row);
  return {
    fingerprint: row.fingerprint,
    status: row.status,
    reviewedAt: row.reviewedAt,
    ...(row.submittedByMemberId
      ? { submittedByMemberId: sanitizeProjectionText(row.submittedByMemberId, 80) }
      : {}),
    ...(row.candidateId ? { candidateId: sanitizeProjectionText(row.candidateId, 80) } : {}),
    ...(row.awarded !== undefined ? { awarded: row.awarded } : {}),
    ...(row.correctFlagCount !== undefined ? { correctFlagCount: row.correctFlagCount } : {}),
    ...(row.totalFlagCount !== undefined ? { totalFlagCount: row.totalFlagCount } : {}),
    ...(row.platformCompleted !== undefined ? { platformCompleted: row.platformCompleted } : {}),
    ...(row.artifactRef ? { artifactRef: sanitizeProjectionText(row.artifactRef, 240) } : {}),
    ...(row.priorStatus ? { priorStatus: row.priorStatus } : {}),
    ...(guidance ? { guidance } : {}),
  };
}

function sanitizeMember(row: RoomProjectionMemberInput): RoomProjectionMemberInput {
  return {
    memberId: row.memberId,
    role: row.role,
    status: row.status,
    ...(row.attemptId ? { attemptId: row.attemptId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.approach ? { approach: sanitizeProjectionText(row.approach) } : {}),
    ...(row.lastTool ? { lastTool: sanitizeProjectionText(row.lastTool, 80) } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
  };
}

export function foldRoomProjectionFacts(
  facts: readonly RoomProjectionFact[],
  base?: Partial<RoomProjectionInput>,
): RoomProjectionInput {
  let roomId = base?.roomId ?? "";
  let challengeId = base?.challengeId ?? "";
  let objective = base?.objective;
  let attemptArtifactsRoot = base?.attemptArtifactsRoot;
  let deadline = base?.deadline;
  let platform: RoomProjectionInput["platform"] | undefined = base?.platform;
  let platformStamp: string | undefined;
  let deadlineStamp: string | undefined;
  const members = new Map<string, RoomProjectionMemberInput>();
  const evidence = new Map<string, RoomProjectionEvidenceInput>();
  const candidates = new Map<string, RoomProjectionCandidateInput>();
  const reviews = new Map<string, RoomProjectionReviewInput>();

  for (const row of base?.members ?? []) members.set(row.memberId, sanitizeMember(row));
  for (const row of base?.evidence ?? []) {
    evidence.set(row.intelId, {
      ...row,
      artifactRef: sanitizeProjectionText(row.artifactRef, 240),
    });
  }
  for (const row of base?.candidates ?? []) {
    candidates.set(row.fingerprint, {
      ...row,
      ...(row.evidenceRef ? { evidenceRef: sanitizeProjectionText(row.evidenceRef, 240) } : {}),
    });
  }
  for (const row of base?.reviews ?? []) {
    reviews.set(row.fingerprint, sanitizeReview(row));
  }

  for (const fact of facts) {
    switch (fact.kind) {
      case "meta":
        roomId = fact.roomId;
        challengeId = fact.challengeId;
        if (fact.objective !== undefined) objective = sanitizeProjectionText(fact.objective, 200);
        if (fact.attemptArtifactsRoot !== undefined) {
          attemptArtifactsRoot = sanitizeProjectionText(fact.attemptArtifactsRoot, 240);
        }
        break;
      case "deadline": {
        const next = {
          startedAt: fact.startedAt,
          deadlineAt: fact.deadlineAt,
          budgetMs: fact.budgetMs,
          remainingMs: fact.remainingMs,
          expired: fact.expired,
        };
        if (!deadline) {
          deadline = next;
          deadlineStamp = fact.updatedAt;
          break;
        }
        const stamped = { value: next, updatedAt: fact.updatedAt };
        const prior = { value: deadline, updatedAt: deadlineStamp };
        const chosen = preferKeyedFact(prior, stamped, (row) => row.updatedAt);
        deadline = chosen.value;
        deadlineStamp = chosen.updatedAt;
        break;
      }
      case "platform": {
        const next = {
          status: fact.status,
          ...(fact.reason ? { reason: sanitizeProjectionText(fact.reason, 200) } : {}),
        };
        if (!platform) {
          platform = next;
          platformStamp = fact.updatedAt;
          break;
        }
        const stamped = { value: next, updatedAt: fact.updatedAt };
        const prior = { value: platform, updatedAt: platformStamp };
        const chosen = preferKeyedFact(prior, stamped, (row) => row.updatedAt);
        platform = chosen.value;
        platformStamp = chosen.updatedAt;
        break;
      }
      case "member": {
        const next = sanitizeMember({
          memberId: fact.memberId,
          role: fact.role,
          status: fact.status,
          ...(fact.attemptId !== undefined ? { attemptId: fact.attemptId } : {}),
          ...(fact.sessionId !== undefined ? { sessionId: fact.sessionId } : {}),
          ...(fact.approach !== undefined ? { approach: fact.approach } : {}),
          ...(fact.lastTool !== undefined ? { lastTool: fact.lastTool } : {}),
          ...(fact.updatedAt !== undefined ? { updatedAt: fact.updatedAt } : {}),
        });
        members.set(fact.memberId, preferKeyedFact(members.get(fact.memberId), next, (row) => row.updatedAt));
        break;
      }
      case "evidence": {
        const next: RoomProjectionEvidenceInput = {
          intelId: fact.intelId,
          kind: fact.evidenceKind,
          artifactRef: sanitizeProjectionText(fact.artifactRef, 240),
          producerMemberId: fact.producerMemberId,
          createdAt: fact.createdAt,
          ...(fact.updatedAt ? { updatedAt: fact.updatedAt } : {}),
        };
        evidence.set(
          fact.intelId,
          preferKeyedFact(evidence.get(fact.intelId), next, (row) => row.updatedAt ?? row.createdAt),
        );
        break;
      }
      case "candidate": {
        const next: RoomProjectionCandidateInput = {
          fingerprint: fact.fingerprint,
          oracle: fact.oracle,
          ...(fact.submission ? { submission: fact.submission } : {}),
          ...(fact.evidenceRef
            ? { evidenceRef: sanitizeProjectionText(fact.evidenceRef, 240) }
            : fact.evidenceRef === null
              ? { evidenceRef: null }
              : {}),
        };
        // Candidates have no revision stamp — deterministic stringify tie-break only.
        candidates.set(
          fact.fingerprint,
          preferKeyedFact(candidates.get(fact.fingerprint), next, () => undefined),
        );
        break;
      }
      case "review": {
        const next = sanitizeReview({
          fingerprint: fact.fingerprint,
          status: fact.status,
          reviewedAt: fact.reviewedAt,
          ...(fact.submittedByMemberId !== undefined
            ? { submittedByMemberId: fact.submittedByMemberId }
            : {}),
          ...(fact.candidateId !== undefined ? { candidateId: fact.candidateId } : {}),
          ...(fact.awarded !== undefined ? { awarded: fact.awarded } : {}),
          ...(fact.correctFlagCount !== undefined ? { correctFlagCount: fact.correctFlagCount } : {}),
          ...(fact.totalFlagCount !== undefined ? { totalFlagCount: fact.totalFlagCount } : {}),
          ...(fact.platformCompleted !== undefined ? { platformCompleted: fact.platformCompleted } : {}),
          ...(fact.artifactRef !== undefined ? { artifactRef: fact.artifactRef } : {}),
          ...(fact.priorStatus !== undefined ? { priorStatus: fact.priorStatus } : {}),
          ...(fact.guidance !== undefined ? { guidance: fact.guidance } : {}),
        });
        reviews.set(fact.fingerprint, preferKeyedFact(reviews.get(fact.fingerprint), next, (row) => row.reviewedAt));
        break;
      }
      default:
        break;
    }
  }

  if (!roomId || !challengeId) {
    throw new Error("room projection requires roomId and challengeId");
  }

  return {
    roomId,
    challengeId,
    ...(objective ? { objective } : {}),
    ...(attemptArtifactsRoot ? { attemptArtifactsRoot } : {}),
    ...(deadline ? { deadline } : {}),
    platform: platform ?? { status: "active" },
    members: [...members.values()],
    evidence: [...evidence.values()],
    candidates: [...candidates.values()],
    reviews: [...reviews.values()],
    ...(base?.priorVersion ? { priorVersion: base.priorVersion } : {}),
    ...(base?.priorSectionDigests ? { priorSectionDigests: base.priorSectionDigests } : {}),
    ...(base?.nowMs !== undefined ? { nowMs: base.nowMs } : {}),
  };
}

function sortMembers(rows: RoomProjectionMemberInput[]): RoomProjectionMemberInput[] {
  return [...rows].sort((a, b) => a.memberId.localeCompare(b.memberId));
}

function buildMap(input: RoomProjectionInput): RoomMap {
  const members = sortMembers(input.members).map((row) => sanitizeMember(row));

  const evidence = [...(input.evidence ?? [])]
    .sort((a, b) => a.intelId.localeCompare(b.intelId))
    .map((row) => ({
      intelId: row.intelId,
      kind: row.kind,
      artifactRef: sanitizeProjectionText(row.artifactRef, 240),
      producerMemberId: row.producerMemberId,
      createdAt: row.createdAt,
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    }));

  const candidates = [...(input.candidates ?? [])]
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
    .map((row) => ({
      fingerprint: row.fingerprint,
      oracle: row.oracle,
      ...(row.submission ? { submission: row.submission } : {}),
      ...(row.evidenceRef ? { evidenceRef: sanitizeProjectionText(row.evidenceRef, 240) } : {}),
    }));

  const reviews = [...(input.reviews ?? [])]
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.reviewedAt.localeCompare(b.reviewedAt))
    .map((row) => sanitizeReview(row));

  const tensions: RoomMapTension[] = reviews
    .filter((row) => row.status === "rejected")
    .map((row) => ({
      fingerprint: row.fingerprint,
      verdict: "rejected" as const,
      reviewedAt: row.reviewedAt,
      guidance: row.guidance ?? platformRejectedFingerprintGuidance(row.fingerprint),
      ...(row.priorStatus ? { priorStatus: row.priorStatus } : {}),
    }));

  return {
    EVIDENCE: evidence,
    ACTIVE: members,
    TENSIONS: tensions,
    REVIEW: reviews,
    CANDIDATES: candidates,
    DECISIONS: [],
  };
}

function summarize(map: RoomMap, platform: RoomProjectionInput["platform"]): RoomProjectionSummary {
  return {
    evidenceCount: map.EVIDENCE.length,
    activeMemberCount: map.ACTIVE.filter(
      (row) => row.status === "active" || row.status === "idle" || row.status === "pending",
    ).length,
    candidateCount: map.CANDIDATES.length,
    tensionCount: map.TENSIONS.length,
    reviewCount: map.REVIEW.length,
    decisionCount: 0,
    platformStatus: platform.status,
  };
}

function sectionDigestsOf(
  map: RoomMap,
  platform: RoomProjectionInput["platform"],
  deadline: RoomProjectionInput["deadline"] | undefined,
): Partial<Record<RoomProjectionChangeSection, string>> {
  return {
    EVIDENCE: contentVersion(map.EVIDENCE),
    ACTIVE: contentVersion(map.ACTIVE),
    TENSIONS: contentVersion(map.TENSIONS),
    REVIEW: contentVersion(map.REVIEW),
    CANDIDATES: contentVersion(map.CANDIDATES),
    DECISIONS: contentVersion(map.DECISIONS),
    platform: contentVersion(platform),
    deadline: contentVersion(deadlineIdentityForVersion(deadline)),
    members: contentVersion(map.ACTIVE),
  };
}

function diffSections(
  prior: Partial<Record<RoomProjectionChangeSection, string>> | undefined,
  next: Partial<Record<RoomProjectionChangeSection, string>>,
): RoomProjectionChangeSection[] {
  if (!prior) {
    return ["EVIDENCE", "ACTIVE", "TENSIONS", "REVIEW", "CANDIDATES", "DECISIONS", "platform", "deadline", "members"];
  }
  const sections: RoomProjectionChangeSection[] = [];
  for (const key of Object.keys(next) as RoomProjectionChangeSection[]) {
    if (prior[key] !== next[key]) sections.push(key);
  }
  return sections;
}

export function buildRoomProjection(input: RoomProjectionInput): RoomProjection {
  const map = buildMap(input);
  const summary = summarize(map, input.platform);
  const updatedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const versionBody = {
    roomId: input.roomId,
    challengeId: input.challengeId,
    objective: input.objective ? sanitizeProjectionText(input.objective, 200) : undefined,
    deadline: deadlineIdentityForVersion(input.deadline),
    platform: input.platform,
    map,
  };
  const version = contentVersion(versionBody);
  const sectionDigests = sectionDigestsOf(map, input.platform, input.deadline);

  let changes: RoomProjection["changes"];
  if (input.priorVersion && input.priorVersion === version) {
    changes = { sinceVersion: input.priorVersion, sections: [] };
  } else if (input.priorSectionDigests) {
    changes = {
      sinceVersion: input.priorVersion ?? null,
      sections: diffSections(input.priorSectionDigests, sectionDigests),
    };
  } else if (!input.priorVersion) {
    changes = {
      sinceVersion: null,
      sections: diffSections(undefined, sectionDigests),
    };
  } else {
    // priorVersion present but no prior digests — coarse non-empty change index only.
    // C2 must not treat this alone as a synthesis trigger.
    const sections: RoomProjectionChangeSection[] = ["platform", "members"];
    for (const key of ["EVIDENCE", "ACTIVE", "CANDIDATES", "REVIEW", "TENSIONS"] as const) {
      if (map[key].length > 0) sections.push(key);
    }
    if (input.deadline) sections.push("deadline");
    changes = { sinceVersion: input.priorVersion, sections: [...new Set(sections)] };
  }

  const projection: RoomProjection = {
    schema: ROOM_PROJECTION_SCHEMA,
    roomId: input.roomId,
    challengeId: input.challengeId,
    version,
    updatedAt,
    ...(input.attemptArtifactsRoot
      ? { attemptArtifactsRoot: sanitizeProjectionText(input.attemptArtifactsRoot, 240) }
      : {}),
    ...(input.objective ? { objective: sanitizeProjectionText(input.objective, 200) } : {}),
    ...(input.deadline ? { deadline: input.deadline } : {}),
    platform: input.platform,
    members: map.ACTIVE,
    map,
    summary,
    changes,
    sectionDigests,
    ...(input.latestCheckpoint ? { latestCheckpoint: sanitizeCheckpoint(input.latestCheckpoint) } : {}),
  };

  if (projectionHasRawSecretLeak(projection)) {
    throw new Error("room projection refused to emit raw secret-shaped payload");
  }

  return projection;
}

/** Thin room_info slice with bounded factual handoff indexes. */
export function roomProjectionChallengeInfo(projection: RoomProjection): RoomProjectionChallengeInfo {
  const recentEvidence = [...projection.map.EVIDENCE]
    .sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt) ||
      a.intelId.localeCompare(b.intelId),
    )
    .slice(0, ROOM_PROJECTION_HANDOFF_EVIDENCE_MAX);
  return {
    schema: ROOM_PROJECTION_SCHEMA,
    version: projection.version,
    summary: projection.summary,
    changes: projection.changes,
    EVIDENCE: recentEvidence,
    REVIEW: projection.map.REVIEW,
    TENSIONS: projection.map.TENSIONS,
    ...(projection.attemptArtifactsRoot
      ? {
          attemptArtifactsRoot: projection.attemptArtifactsRoot,
          evidenceHint: artifactRefEscapeGuidance(projection.attemptArtifactsRoot),
        }
      : {}),
    ...(projection.latestCheckpoint ? { latestCheckpoint: projection.latestCheckpoint } : {}),
  };
}

export function projectionHasRawSecretLeak(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return false;
  if (/\bflag\{(?!\[REDACTED\])[^}]+\}/i.test(text)) return true;
  if (/\b(?:sk-|xai-|gsk_)[A-Za-z0-9._-]{8,}/.test(text)) return true;
  if (/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/i.test(text)) return true;
  return false;
}

/** Map ProjectRuntime / room-control snapshot into projection platform status. */
export function mapProjectRuntimeStatusToPlatform(
  status: string,
): RoomPlatformStatus {
  switch (status) {
    case "active":
    case "reviewing":
    case "pending":
    case "completed":
    case "closed":
    case "interrupted":
    case "stalled":
    case "ended":
      return status;
    default:
      return "active";
  }
}
