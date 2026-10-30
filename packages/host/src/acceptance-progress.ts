/**
 * Shared room view of platform acceptance.
 * Platform counts and fingerprints Silver has actually submitted stay separate.
 * A higher platform count does not identify a missing flag.
 */
export const ACCEPTANCE_PROGRESS_NOTE =
  "Platform counts and known fingerprints are separate. Host does not map a missing fingerprint to a flag type.";

export type AcceptanceLatestVerdict = {
  fingerprint: string;
  status: "accepted" | "rejected";
  observedAt: string;
  submittedByMemberId?: string;
};

export type AcceptanceProgress = {
  expectedFlagCount: number;
  knownAcceptedFingerprints: string[];
  knownRejectedFingerprints: string[];
  note: string;
  latestVerdict?: AcceptanceLatestVerdict;
  platformAcceptedCount?: number;
  platformTotalCount?: number;
  remainingCount?: number;
  completed?: boolean;
  observedAt?: string;
};

export type AcceptanceReviewFact = {
  fingerprint: string;
  status: string;
  reviewedAt: string;
  submittedByMemberId?: string;
  correctFlagCount?: number;
  totalFlagCount?: number;
  /** Persisted terminal fact from an adapter verdict or platform-board observation. */
  platformCompleted?: boolean;
};

export function acceptanceProgressFromReviews(
  expectedFlagCount: number,
  reviews: readonly AcceptanceReviewFact[],
): AcceptanceProgress {
  const ordered = reviews.map((row, index) => ({ row, index }));
  const verdicts = ordered.filter((item) => isVerdictStatus(item.row.status) && item.row.fingerprint.trim());
  const latest = verdicts.reduce<(typeof verdicts)[number] | undefined>((best, item) => {
    if (!best || laterReview(item, best)) return item;
    return best;
  }, undefined);
  const progress: AcceptanceProgress = {
    expectedFlagCount: normalizeCount(expectedFlagCount),
    knownAcceptedFingerprints: fingerprintsWithStatus(verdicts, "accepted"),
    knownRejectedFingerprints: fingerprintsWithStatus(verdicts, "rejected"),
    note: ACCEPTANCE_PROGRESS_NOTE,
  };
  if (latest && isVerdictStatus(latest.row.status)) {
    progress.latestVerdict = {
      fingerprint: latest.row.fingerprint.trim(),
      status: latest.row.status,
      observedAt: latest.row.reviewedAt,
      ...(latest.row.submittedByMemberId
        ? { submittedByMemberId: latest.row.submittedByMemberId }
        : {}),
    };
  }
  const platform = mergePlatformAcceptanceSnapshots(
    ordered.map((item) => ({
      ...item.row,
      ...(item.row.platformCompleted !== undefined ? { completed: item.row.platformCompleted } : {}),
      observedAt: item.row.reviewedAt,
    })),
  );
  const terminalFacts = ordered.filter((item) => item.row.platformCompleted !== undefined);
  const explicitlyCompleted = terminalFacts.some((item) => item.row.platformCompleted === true);
  if (platform) {
    progress.platformAcceptedCount = platform.accepted;
    progress.platformTotalCount = platform.total;
    progress.remainingCount = platform.total - platform.accepted;
    progress.completed = terminalFacts.length > 0 ? explicitlyCompleted : platform.completed;
    if (platform.observedAt) progress.observedAt = platform.observedAt;
    return progress;
  }
  const latestTerminalFact = terminalFacts
    .reduce<(typeof ordered)[number] | undefined>((best, item) => {
      if (!best || laterReview(item, best)) return item;
      return best;
    }, undefined);
  if (latestTerminalFact) {
    progress.completed = explicitlyCompleted;
    progress.observedAt = latestTerminalFact.row.reviewedAt;
  }
  return progress;
}

/**
 * Valid platform snapshots only. acceptedCount never moves backward, and a true
 * completed flag is not cleared by a later stale response. The same accepted
 * count keeps the newer observation time.
 */
function fingerprintsWithStatus(
  verdicts: Array<{ row: AcceptanceReviewFact; index: number }>,
  status: "accepted" | "rejected",
): string[] {
  const latest = new Map<string, { row: AcceptanceReviewFact; index: number }>();
  for (const item of verdicts) {
    const fingerprint = item.row.fingerprint.trim();
    const prior = latest.get(fingerprint);
    if (!prior || laterReview(item, prior)) latest.set(fingerprint, item);
  }
  return [...latest.values()]
    .filter((item) => item.row.status === status)
    .sort(byReviewTime)
    .map((item) => item.row.fingerprint.trim());
}

function isVerdictStatus(status: string): status is "accepted" | "rejected" {
  return status === "accepted" || status === "rejected";
}

/**
 * The only platform-count check. Display, platformCompleted, and recovery all use it.
 * 0/0, 5/4, negatives, and non-integers are unknown and are not completion.
 */
export function authoritativePlatformCount(input: {
  correctFlagCount?: number;
  totalFlagCount?: number;
}): { accepted: number; total: number; completed: boolean } | undefined {
  const accepted = input.correctFlagCount;
  const total = input.totalFlagCount;
  if (typeof accepted !== "number" || typeof total !== "number") return undefined;
  if (!Number.isInteger(accepted) || !Number.isInteger(total)) return undefined;
  if (total <= 0 || accepted < 0 || accepted > total) return undefined;
  return { accepted, total, completed: accepted >= total };
}

/** Fold valid platform snapshots without letting a stale response move progress backward. */
export function mergePlatformAcceptanceSnapshots(
  snapshots: readonly {
    correctFlagCount?: number;
    totalFlagCount?: number;
    completed?: boolean;
    cumulativeScore?: number;
    observedAt?: string;
  }[],
): {
  accepted: number;
  total: number;
  completed: boolean;
  cumulativeScore?: number;
  observedAt?: string;
} | undefined {
  let best: {
    accepted: number;
    total: number;
    completed: boolean;
    cumulativeScore?: number;
    observedAt?: string;
    index: number;
  } | undefined;
  let completed = false;
  for (const [index, snapshot] of snapshots.entries()) {
    completed = completed || platformRoomCompleted(snapshot);
    const count = authoritativePlatformCount(snapshot);
    if (!count) continue;
    const newerSameCount = best !== undefined
      && count.accepted === best.accepted
      && (snapshot.observedAt !== undefined && best.observedAt !== undefined
        ? snapshot.observedAt > best.observedAt
        : index > best.index);
    if (!best || count.accepted > best.accepted || newerSameCount) {
      best = {
        ...count,
        ...(typeof snapshot.cumulativeScore === "number" ? { cumulativeScore: snapshot.cumulativeScore } : {}),
        ...(snapshot.observedAt ? { observedAt: snapshot.observedAt } : {}),
        index,
      };
    }
  }
  if (!best) return undefined;
  return {
    accepted: best.accepted,
    total: best.total,
    completed: completed || best.completed,
    ...(best.cumulativeScore !== undefined ? { cumulativeScore: best.cumulativeScore } : {}),
    ...(best.observedAt ? { observedAt: best.observedAt } : {}),
  };
}

/**
 * Legacy/platform-board completion. Valid counts use N/N only. Mounted contest
 * adapter terminal state is handled from its explicit completed boolean.
 * Missing or illegal counts are unknown and are not success or failure.
 */
export function platformRoomCompleted(input: {
  correctFlagCount?: number;
  totalFlagCount?: number;
  completed?: boolean;
}): boolean {
  const count = authoritativePlatformCount(input);
  if (count) return count.completed;
  const accepted = input.correctFlagCount;
  const total = input.totalFlagCount;
  const zeroFilled = accepted === 0 && total === 0;
  const missing = accepted === undefined && total === undefined;
  if (!zeroFilled && !missing) return false;
  return input.completed === true;
}

export function readLocalRemainingSlots(
  result: { localRemainingSlots?: unknown; remainingFlags?: unknown } | undefined,
): number | undefined {
  if (!result) return undefined;
  const value = result.localRemainingSlots ?? result.remainingFlags;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function laterReview(
  item: { row: AcceptanceReviewFact; index: number },
  best: { row: AcceptanceReviewFact; index: number },
): boolean {
  if (item.row.reviewedAt !== best.row.reviewedAt) return item.row.reviewedAt > best.row.reviewedAt;
  return item.index > best.index;
}

function byReviewTime(
  a: { row: AcceptanceReviewFact; index: number },
  b: { row: AcceptanceReviewFact; index: number },
): number {
  if (a.row.reviewedAt !== b.row.reviewedAt) return a.row.reviewedAt < b.row.reviewedAt ? -1 : 1;
  return a.index - b.index;
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}
