/**
 * Durable platform admission.
 * sample-size counts reserved, started, and queued ids.
 * A contest POST happens only after reserved is committed, and never for a
 * target the SlotPool already has active or queued.
 */
import {
  challengeBundleFromPlatform,
  contestTargetUrl,
  parseChallengeBundle,
  requireCommanderChildMission,
  type ChallengeBundle,
} from "@silver/host";
import { missionSampleAdmission } from "./mission-admission.ts";

export type PlatformAdmissionPhase = "reserved" | "started" | "queued";

export type PlatformAdmissionRecord = {
  targetId: string;
  phase: PlatformAdmissionPhase;
  flagCount: number;
  targetUrl?: string;
  bundle?: ChallengeBundle;
};

export function parsePlatformAdmissions(value: unknown): PlatformAdmissionRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: PlatformAdmissionRecord[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    const item = row as Record<string, unknown>;
    const targetId = item.targetId;
    const phase = item.phase;
    const flagCount = item.flagCount;
    if (typeof targetId !== "string" || !/^[A-Za-z0-9._-]+$/.test(targetId) || seen.has(targetId)) return undefined;
    if (phase !== "reserved" && phase !== "started" && phase !== "queued") return undefined;
    if (typeof flagCount !== "number" || !Number.isInteger(flagCount) || flagCount < 1 || flagCount > 128) {
      return undefined;
    }
    if (item.targetUrl !== undefined && typeof item.targetUrl !== "string") return undefined;
    if ((phase === "started" || phase === "queued") && !item.targetUrl) return undefined;
    seen.add(targetId);
    const parsedBundle = parseChallengeBundle(item.bundle);
    const bundle = parsedBundle?.challengeId === targetId ? parsedBundle : undefined;
    records.push({
      targetId,
      phase,
      flagCount: bundle?.flagCount ?? flagCount,
      ...(typeof item.targetUrl === "string" ? { targetUrl: item.targetUrl } : {}),
      ...(bundle ? { bundle } : {}),
    });
  }
  return records;
}

/** Started or queued rows that still need a Room if the process died before the worker opened. */
export function durableAdmissionsToQueue(
  records: readonly PlatformAdmissionRecord[],
): Array<{ targetId: string; targetUrl: string; flagCount: number; bundle: ChallengeBundle }> {
  const queued: Array<{ targetId: string; targetUrl: string; flagCount: number; bundle: ChallengeBundle }> = [];
  for (const row of records) {
    if ((row.phase !== "started" && row.phase !== "queued") || !row.targetUrl) continue;
    if (!row.bundle) {
      throw new Error(`cannot recover ${row.targetId}: durable Commander childMission is missing`);
    }
    try {
      requireCommanderChildMission(row.bundle.childMission);
    } catch {
      throw new Error(`cannot recover ${row.targetId}: durable Commander childMission is missing`);
    }
    queued.push({
      targetId: row.targetId,
      targetUrl: row.targetUrl,
      flagCount: row.bundle.flagCount,
      bundle: row.bundle,
    });
  }
  return queued;
}


export async function advancePlatformAdmission<T extends { accepted: boolean }>(input: {
  records: PlatformAdmissionRecord[];
  admittedTargetIds: Set<string>;
  /** Targets whose contest POST is in flight in this process. */
  starting: Set<string>;
  sampleSize: number | undefined;
  targetId: string;
  retry: boolean;
  start: boolean;
  targetUrl?: string;
  /** A new attempt may use a newly provisioned endpoint instead of the prior attempt's URL. */
  replaceStoredTarget?: boolean;
  flagCount: number;
  poolBusy: boolean;
  /** Targets whose settled outcome is already solved. */
  solvedTargetIds?: ReadonlySet<string>;
  /** Targets whose platform board was explicitly completed. Unknown reads stay out. */
  platformCompletedTargetIds?: ReadonlySet<string>;
  commit: () => void;
  rememberFlagCount: (targetId: string, flagCount: number) => void;
  startBoard: (
    boardId: string,
    onStarted: (started: { containerAddr: string[]; bundle?: ChallengeBundle }) => void,
  ) => Promise<{ containerAddr: string[]; bundle?: ChallengeBundle }>;
  /** List/start materials when a retry has a URL but no stored bundle. */
  hydrateBoard?: (boardId: string, targetUrl: string) => Promise<ChallengeBundle | undefined>;
  enqueue: (row: { targetId: string; targetUrl: string; bundle?: ChallengeBundle }, opts: { retry: boolean }) => T;
}): Promise<
  | { outcome: "refused"; reason: "sample_size_reached"; sampleSize: number; admitted: number }
  | { outcome: "refused"; reason: "target_already_active" }
  | { outcome: "refused"; reason: "target_already_solved" }
  | { outcome: "done"; targetUrl: string; started: boolean; result: T }
> {
  if (input.solvedTargetIds?.has(input.targetId) || input.platformCompletedTargetIds?.has(input.targetId)) {
    return { outcome: "refused", reason: "target_already_solved" };
  }
  if (input.start && (input.poolBusy || input.starting.has(input.targetId))) {
    return { outcome: "refused", reason: "target_already_active" };
  }
  const existing = input.records.find((row) => row.targetId === input.targetId);
  const admission = missionSampleAdmission({
    sampleSize: input.sampleSize,
    admittedTargetIds: input.admittedTargetIds,
    targetId: input.targetId,
    retry: input.retry || Boolean(existing),
  });
  if (!admission.accepted) {
    return {
      outcome: "refused",
      reason: "sample_size_reached",
      sampleSize: admission.sampleSize,
      admitted: admission.admitted,
    };
  }

  const fresh = !existing && !input.admittedTargetIds.has(input.targetId);
  let record = existing;
  if (!record) {
    record = { targetId: input.targetId, phase: "reserved", flagCount: input.flagCount };
    input.records.push(record);
    input.admittedTargetIds.add(input.targetId);
    input.commit();
  }
  const storedUrl =
    record.phase === "started" || record.phase === "queued" ? record.targetUrl : undefined;
  let posted = false;
  let hydratedBeforeStartedCheckpoint = false;
  try {
    let targetUrl = storedUrl ?? "";
    if (input.start && !storedUrl) {
      input.starting.add(input.targetId);
      try {
        const checkpointStarted = (startedRow: { containerAddr: string[]; bundle?: ChallengeBundle }) => {
          const addr = startedRow.bundle?.targetUrl ?? startedRow.containerAddr.find((row) => row.trim());
          if (!addr) throw new Error(`platform start returned no container address for ${input.targetId}`);
          targetUrl = startedRow.bundle?.targetUrl ?? contestTargetUrl(addr);
          if (startedRow.bundle) {
            record.bundle = preserveDurableCommanderTask(record.bundle, startedRow.bundle);
          }
          requireDurableAdmissionBundle(record);
          record.phase = "started";
          record.targetUrl = targetUrl;
          record.flagCount = record.bundle?.flagCount ?? record.flagCount;
          posted = true;
          input.commit();
        };
        let startedRow: { containerAddr: string[]; bundle?: ChallengeBundle };
        try {
          startedRow = await input.startBoard(input.targetId, checkpointStarted);
        } catch (err) {
          if (!posted) throw err;
          const fallback = challengeBundleFromPlatform({
            challengeId: input.targetId,
            flagCount: record.flagCount,
            containerAddr: [targetUrl],
            platformFields: { material: "unavailable" },
          });
          const unavailable = fallback
            ? preserveDurableCommanderTask(record.bundle, fallback)
            : record.bundle;
          startedRow = { containerAddr: [targetUrl], ...(unavailable ? { bundle: unavailable } : {}) };
        }
        if (!posted) checkpointStarted(startedRow);
        if (startedRow.bundle && startedRow.bundle !== record.bundle) {
          const nextBundle = preserveDurableCommanderTask(record.bundle, startedRow.bundle);
          targetUrl = nextBundle.targetUrl;
          record.targetUrl = targetUrl;
          record.bundle = nextBundle;
          record.flagCount = nextBundle.flagCount;
          commitRecoverableAdmission(record, input.commit);
        }
      } finally {
        input.starting.delete(input.targetId);
      }
    } else if (!storedUrl) {
      targetUrl = input.targetUrl?.trim() ?? "";
      if (!targetUrl) throw new Error("queue_target requires start:true or a nonempty targetUrl");
      if (input.hydrateBoard && bundleNeedsHydration(record.bundle)) {
        await hydrateAdmissionBundle(record, input.hydrateBoard, input.targetId, targetUrl);
        hydratedBeforeStartedCheckpoint = true;
      }
      requireDurableAdmissionBundle(record);
      record.phase = "started";
      record.targetUrl = targetUrl;
    } else if (input.replaceStoredTarget && input.targetUrl?.trim() && input.targetUrl.trim() !== storedUrl) {
      targetUrl = input.targetUrl.trim();
      record.targetUrl = targetUrl;
      if (input.hydrateBoard) {
        try {
          const refreshed = await input.hydrateBoard(input.targetId, targetUrl);
          if (refreshed) record.bundle = refreshed;
        } catch {
          // The Commander task and current endpoint still remain sufficient to open the fresh attempt.
        }
      }
    } else {
      targetUrl = storedUrl;
    }
    if (!hydratedBeforeStartedCheckpoint && input.hydrateBoard && bundleNeedsHydration(record.bundle)) {
      await hydrateAdmissionBundle(record, input.hydrateBoard, input.targetId, targetUrl);
    }
    commitRecoverableAdmission(record, input.commit);
    record.flagCount = record.bundle?.flagCount ?? record.flagCount;
    input.rememberFlagCount(input.targetId, record.flagCount);
    const result = input.enqueue(
      { targetId: input.targetId, targetUrl, ...(record.bundle ? { bundle: record.bundle } : {}) },
      { retry: input.retry || record.phase === "queued" },
    );
    if (result.accepted) {
      record.phase = "queued";
      record.targetUrl = targetUrl;
      commitRecoverableAdmission(record, input.commit);
    } else if (fresh && !posted) {
      rollback(input, input.targetId);
      input.commit();
    }
    return { outcome: "done", targetUrl, started: posted || Boolean(storedUrl), result };
  } catch (err) {
    if (fresh && !posted) {
      rollback(input, input.targetId);
      input.commit();
    }
    throw err;
  }
}

async function hydrateAdmissionBundle(
  record: PlatformAdmissionRecord,
  hydrateBoard: (boardId: string, targetUrl: string) => Promise<ChallengeBundle | undefined>,
  targetId: string,
  targetUrl: string,
): Promise<void> {
  let hydrated: ChallengeBundle | undefined;
  try {
    hydrated = await hydrateBoard(targetId, targetUrl);
  } catch {
    hydrated = undefined;
  }
  if (!hydrated) return;
  record.bundle = preserveDurableCommanderTask(record.bundle, hydrated);
  record.flagCount = record.bundle.flagCount;
}

function requireDurableAdmissionBundle(record: PlatformAdmissionRecord): ChallengeBundle {
  if (!record.bundle) {
    throw new Error(`cannot recover ${record.targetId}: durable Commander childMission is missing`);
  }
  try {
    requireCommanderChildMission(record.bundle.childMission);
  } catch {
    throw new Error(`cannot recover ${record.targetId}: durable Commander childMission is missing`);
  }
  return record.bundle;
}

function commitRecoverableAdmission(record: PlatformAdmissionRecord, commit: () => void): void {
  requireDurableAdmissionBundle(record);
  commit();
}

function bundleNeedsHydration(bundle: ChallengeBundle | undefined): boolean {
  if (!bundle) return true;
  if (bundle.task?.completeness !== "complete") return true;
  return Object.values(bundle.platformFields ?? {}).some(
    (value) => value.trim().toLowerCase() === "unavailable",
  );
}

/** Optional post-start hydration may enrich a bundle, but cannot erase its durable room contract. */
function preserveDurableCommanderTask(
  durable: ChallengeBundle | undefined,
  incoming: ChallengeBundle,
): ChallengeBundle {
  const priorPlatformFields = Object.fromEntries(
    Object.entries(durable?.platformFields ?? {}).filter(
      ([, value]) => value.trim().toLowerCase() !== "unavailable",
    ),
  );
  const platformFields = { ...priorPlatformFields, ...incoming.platformFields };
  const merged: ChallengeBundle = {
    ...incoming,
    ...(Object.keys(platformFields).length > 0 ? { platformFields } : {}),
  };
  if (!durable?.childMission || incoming.childMission) return merged;
  return {
    ...merged,
    childMission: durable.childMission,
    ...(durable.task ? { task: durable.task } : {}),
  };
}

function rollback(
  input: { records: PlatformAdmissionRecord[]; admittedTargetIds: Set<string> },
  targetId: string,
): void {
  const index = input.records.findIndex((row) => row.targetId === targetId);
  if (index >= 0) input.records.splice(index, 1);
  input.admittedTargetIds.delete(targetId);
}
