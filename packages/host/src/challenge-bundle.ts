import { contestTargetUrl, type ContestBoardRow, type ContestChallengeContent } from "./contest-platform.ts";
import {
  parseTaskMaterial,
  renderTaskMaterial,
  taskMaterialFromPlatform,
  type TaskMaterialEnvelope,
} from "./task-material.ts";

function filled(value?: string): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** List, start, and declared detail/attachment rows. Non-empty statement text wins over a later empty field. */
export function mergePlatformLayers(input: {
  list?: ContestChallengeContent;
  start?: ContestChallengeContent;
  detail?: ContestChallengeContent;
  extra?: ContestChallengeContent[];
}): ContestChallengeContent {
  const extras = input.extra ?? [];
  const statement = [input.detail, ...extras, input.list, input.start];
  const title = statement.map((row) => filled(row?.title)).find((row): row is string => Boolean(row));
  const description = statement.map((row) => filled(row?.description)).find((row): row is string => Boolean(row));
  const tags = statement.map((row) => row?.tags).find((row) => row && row.length > 0);
  const difficulty = statement.map((row) => filled(row?.difficulty)).find((row): row is string => Boolean(row));
  const level = statement.map((row) => row?.level).find((row) => row !== undefined);
  const totalScore = statement.map((row) => row?.totalScore).find((row) => row !== undefined);
  const attachments = statement
    .flatMap((row) => row?.attachments ?? [])
    .filter((row, index, rows) =>
      rows.findIndex((candidate) => candidate.name === row.name && candidate.url === row.url) === index,
    );
  const hint = statement.map((row) => row?.hint).find((row) => row);
  const platformFields: Record<string, string> = {};
  for (const row of statement) {
    if (!row?.platformFields) continue;
    for (const [key, value] of Object.entries(row.platformFields)) {
      if (value.trim() && platformFields[key] === undefined) platformFields[key] = value;
    }
  }
  const rawMaterial: Record<string, unknown> = {};
  if (input.list?.rawMaterial) rawMaterial.list = input.list.rawMaterial;
  if (input.start?.rawMaterial) rawMaterial.start = input.start.rawMaterial;
  if (input.detail?.rawMaterial) rawMaterial.detail = input.detail.rawMaterial;
  extras.forEach((row, index) => {
    if (row.rawMaterial) rawMaterial[`source${index + 1}`] = row.rawMaterial;
  });
  const content: ContestChallengeContent = {};
  if (title) content.title = title;
  if (description) content.description = description;
  if (tags && tags.length > 0) content.tags = tags;
  if (difficulty) content.difficulty = difficulty;
  if (level !== undefined) content.level = level;
  if (totalScore !== undefined) content.totalScore = totalScore;
  if (attachments.length > 0) content.attachments = attachments;
  if (hint) content.hint = hint;
  if (Object.keys(platformFields).length > 0) content.platformFields = platformFields;
  if (Object.keys(rawMaterial).length > 0) content.rawMaterial = rawMaterial;
  if (statement.some((row) => row?.materialTruncated)) content.materialTruncated = true;
  return content;
}

export function mergeChallengeContent(
  primary: ContestChallengeContent,
  fallback: ContestChallengeContent = {},
): ContestChallengeContent {
  const content: ContestChallengeContent = {};
  const title = primary.title ?? fallback.title;
  const description = primary.description ?? fallback.description;
  const tags = primary.tags ?? fallback.tags;
  const difficulty = primary.difficulty ?? fallback.difficulty;
  const level = primary.level ?? fallback.level;
  const totalScore = primary.totalScore ?? fallback.totalScore;
  const attachments = primary.attachments ?? fallback.attachments;
  const hint = primary.hint ?? fallback.hint;
  const platformFields = primary.platformFields ?? fallback.platformFields;
  const rawMaterial = primary.rawMaterial ?? fallback.rawMaterial;
  if (title) content.title = title;
  if (description) content.description = description;
  if (tags && tags.length > 0) content.tags = tags;
  if (difficulty) content.difficulty = difficulty;
  if (level !== undefined) content.level = level;
  if (totalScore !== undefined) content.totalScore = totalScore;
  if (attachments && attachments.length > 0) content.attachments = attachments;
  if (hint) content.hint = hint;
  if (platformFields && Object.keys(platformFields).length > 0) content.platformFields = platformFields;
  if (rawMaterial && Object.keys(rawMaterial).length > 0) content.rawMaterial = rawMaterial;
  if (primary.materialTruncated || fallback.materialTruncated) content.materialTruncated = true;
  return content;
}

/**
 * Platform materials for one challenge.
 * containerAddrs are the platform strings, unchanged.
 * targetEndpoints are only addresses with a clear HTTP(S) form.
 * targetUrl is the compatibility primary: the first clear HTTP(S) form when
 * the first address has one, otherwise the first raw address.
 */
export interface ChallengeBundle extends ContestChallengeContent {
  challengeId: string;
  flagCount: number;
  containerAddrs: string[];
  targetUrl: string;
  targetEndpoints: string[];
  /** Task contract. The fields above are only an index. */
  task?: TaskMaterialEnvelope;
  /** Commander-written child mission. When set, it is the task text. */
  childMission?: string;
}

export function challengeBundleFromPlatform(input: {
  challengeId: string;
  flagCount?: number;
  containerAddr: readonly string[];
} & ContestChallengeContent): ChallengeBundle | undefined {
  const containerAddrs = input.containerAddr.map((addr) => addr.trim()).filter(Boolean);
  const targetEndpoints = clearHttpEndpoints(containerAddrs);
  const title = input.title?.trim() ?? "";
  const description = input.description?.trim() ?? "";
  const tags = input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [];
  const platformFields = input.platformFields;
  const attachments = input.attachments ?? [];
  const targetUrl = primaryTarget(containerAddrs);
  if (!targetUrl) return undefined;
  const bundle: ChallengeBundle = {
    challengeId: input.challengeId,
    // The ledger still needs a positive compatibility capacity. Whether the
    // Mission actually declared a count is carried by the task index below.
    flagCount: input.flagCount ?? 1,
    containerAddrs,
    targetUrl,
    targetEndpoints,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
    ...(input.level !== undefined ? { level: input.level } : {}),
    ...(input.totalScore !== undefined ? { totalScore: input.totalScore } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(input.hint ? { hint: input.hint } : {}),
    ...(platformFields && Object.keys(platformFields).length > 0 ? { platformFields } : {}),
    ...(input.rawMaterial && Object.keys(input.rawMaterial).length > 0 ? { rawMaterial: input.rawMaterial } : {}),
    ...(input.materialTruncated ? { materialTruncated: true } : {}),
    ...(!title && !description && tags.length === 0 ? { materialIncomplete: true } : {}),
  };
  bundle.task = taskMaterialFromPlatform({
    hasStatement: Boolean(title || description || tags.length),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(bundle.rawMaterial ? { rawMaterial: bundle.rawMaterial } : {}),
    ...(bundle.materialTruncated ? { materialTruncated: true } : {}),
    addresses: bundle.containerAddrs,
    endpoints: bundle.targetEndpoints,
    ...(bundle.attachments ? { attachments: bundle.attachments } : {}),
    ...(bundle.hint ? { hint: bundle.hint } : {}),
    ...(input.flagCount !== undefined ? { flagCount: bundle.flagCount } : {}),
    ...(bundle.difficulty ? { difficulty: bundle.difficulty } : {}),
    ...(bundle.level !== undefined ? { level: bundle.level } : {}),
    ...(bundle.totalScore !== undefined ? { score: bundle.totalScore } : {}),
  });
  return bundle;
}

/** Structured fields stay an index. The redacted row is the material Commander reads. */
export function projectContestBoard(row: ContestBoardRow): Record<string, unknown> {
  return {
    boardId: row.boardId,
    flagCount: row.flagCount,
    isCompleted: row.isCompleted,
    containerStatus: row.containerStatus,
    containerAddr: row.containerAddr,
    ...(row.title ? { title: row.title } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.tags?.length ? { tags: row.tags } : {}),
    ...(row.platformFields ? { platformFields: row.platformFields } : {}),
    ...(row.difficulty ? { difficulty: row.difficulty } : {}),
    ...(row.level !== undefined ? { level: row.level } : {}),
    ...(row.totalScore !== undefined ? { totalScore: row.totalScore } : {}),
    ...(row.attachments ? { attachments: row.attachments } : {}),
    ...(row.hint ? { hint: row.hint } : {}),
    ...(row.rawMaterial ? { rawMaterial: row.rawMaterial } : {}),
    ...(row.materialTruncated ? { materialTruncated: true } : {}),
  };
}

/** Commander text leads the room contract; Host appends acceptance and the address index. */
export function requireCommanderChildMission(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("queue_target childMission must be nonempty natural-language task text");
  }
  return value;
}

export function withCommanderChildMission(
  bundle: ChallengeBundle,
  childMission: string,
  acceptance?: string,
): ChallengeBundle {
  const text = requireCommanderChildMission(childMission);
  const acceptanceBlock = acceptance?.trim()
    ? acceptance.trim()
    : "Completion is defined by the Commander Task. Follow its external procedure and report completion with evidence.";
  const canonicalTask = bundle.task ?? taskMaterialFromPlatform({
    ...(bundle.rawMaterial ? { rawMaterial: bundle.rawMaterial } : {}),
    addresses: bundle.containerAddrs,
    endpoints: bundle.targetEndpoints,
    ...(bundle.attachments ? { attachments: bundle.attachments } : {}),
    ...(bundle.hint ? { hint: bundle.hint } : {}),
    flagCount: bundle.flagCount,
    ...(bundle.difficulty ? { difficulty: bundle.difficulty } : {}),
    ...(bundle.level !== undefined ? { level: bundle.level } : {}),
    ...(bundle.totalScore !== undefined ? { score: bundle.totalScore } : {}),
    ...(bundle.title ? { title: bundle.title } : {}),
    ...(bundle.description ? { description: bundle.description } : {}),
    ...(bundle.tags?.length ? { tags: bundle.tags } : {}),
  });
  const index = ["addresses:", ...bundle.containerAddrs.map((addr) => `- ${addr}`)].join("\n");
  const materialText = [
    `Platform Challenge Material`,
    renderTaskMaterial(canonicalTask),
    ``,
    `Commander Task`,
    text,
    ``,
    `Room Completion Contract`,
    acceptanceBlock,
    ``,
    `Host Control Index`,
    index,
  ].join("\n");
  const task: TaskMaterialEnvelope = { ...canonicalTask, source: "commander", materialText };
  return { ...bundle, childMission: text, task };
}

export function challengeBundleFromBoard(row: ContestBoardRow, containerAddr?: readonly string[]): ChallengeBundle | undefined {
  return challengeBundleFromPlatform({
    challengeId: row.boardId,
    flagCount: row.flagCount,
    containerAddr: containerAddr ?? row.containerAddr,
    ...(row.title ? { title: row.title } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.tags?.length ? { tags: row.tags } : {}),
    ...(row.platformFields ? { platformFields: row.platformFields } : {}),
    ...(row.rawMaterial ? { rawMaterial: row.rawMaterial } : {}),
    ...(row.materialTruncated ? { materialTruncated: true } : {}),
    ...(row.materialIncomplete ? { materialIncomplete: true } : {}),
    ...(row.difficulty ? { difficulty: row.difficulty } : {}),
    ...(row.level !== undefined ? { level: row.level } : {}),
    ...(row.totalScore !== undefined ? { totalScore: row.totalScore } : {}),
    ...(row.attachments ? { attachments: row.attachments } : {}),
    ...(row.hint ? { hint: row.hint } : {}),
  });
}

export function endpointOrigins(endpoints: readonly string[]): string[] {
  const origins: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const origin = new URL(endpoint).origin;
      if (!origins.includes(origin)) origins.push(origin);
    } catch {
      /* skip a malformed endpoint */
    }
  }
  return origins;
}

export function formatChallengeBundle(bundle: ChallengeBundle): string {
  if (bundle.task?.materialText) return bundle.task.materialText;
  const lines = [
    "Platform challenge material (verbatim / best-effort). This is the task. The index below does not replace it.",
  ];
  if (bundle.materialIncomplete) {
    lines.push("material incomplete: the platform row had no title, description, or tags. Do not treat the address list as the whole task.");
  }
  if (bundle.rawMaterial) {
    lines.push(JSON.stringify(bundle.rawMaterial, null, 2));
  } else if (!bundle.description && !bundle.title) {
    lines.push("material incomplete: no platform statement text was stored.");
  }
  lines.push("---", "Structured index. Use it to find addresses. It is not a substitute for the material above.");
  if (bundle.title) lines.push(`title: ${bundle.title}`);
  if (bundle.description) {
    lines.push("description:", bundle.description);
  }
  if (bundle.tags && bundle.tags.length > 0) lines.push(`tags: ${bundle.tags.join(", ")}`);
  if (bundle.platformFields) {
    for (const [key, value] of Object.entries(bundle.platformFields)) lines.push(`${key}: ${value}`);
  }
  if (bundle.difficulty) lines.push(`difficulty: ${bundle.difficulty}`);
  if (bundle.level !== undefined) lines.push(`level: ${bundle.level}`);
  if (bundle.totalScore !== undefined) lines.push(`totalScore: ${bundle.totalScore}`);
  lines.push(`flagCount: ${bundle.flagCount}`);
  lines.push("containerAddrs:");
  for (const addr of bundle.containerAddrs) lines.push(`- ${addr}`);
  lines.push("targetEndpoints:");
  if (bundle.targetEndpoints.length === 0) lines.push("- none with a clear HTTP(S) form");
  for (const endpoint of bundle.targetEndpoints) lines.push(`- ${endpoint}`);
  lines.push(`targetUrl: ${bundle.targetUrl}`);
  if (bundle.attachments && bundle.attachments.length > 0) {
    lines.push("attachments:");
    for (const row of bundle.attachments) {
      lines.push(row.url ? `- ${row.name} ${row.url}` : `- ${row.name}`);
    }
  }
  if (bundle.hint) {
    const parts = [
      bundle.hint.available !== undefined ? `${bundle.hint.available} available` : "",
      bundle.hint.cost ? `cost ${bundle.hint.cost}` : "",
    ].filter(Boolean);
    lines.push(
      `hints: ${parts.join(", ") || "metadata present"}. Not prefetched. Host keeps the platform credential.`,
    );
  }
  return lines.join("\n");
}

export function parseChallengeBundle(value: unknown): ChallengeBundle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const challengeId = row.challengeId;
  const targetUrl = row.targetUrl;
  const flagCount = row.flagCount;
  if (typeof challengeId !== "string" || !challengeId.trim()) return undefined;
  if (typeof targetUrl !== "string" || !targetUrl.trim()) return undefined;
  if (typeof flagCount !== "number" || !Number.isInteger(flagCount) || flagCount < 1) return undefined;
  if (!Array.isArray(row.containerAddrs) || !Array.isArray(row.targetEndpoints)) return undefined;
  const containerAddrs = row.containerAddrs.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  const targetEndpoints = row.targetEndpoints.filter((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item));
  if (containerAddrs.length === 0 || !containerAddrs.includes(targetUrl) && !targetEndpoints.includes(targetUrl)) return undefined;
  const bundle: ChallengeBundle = { challengeId, flagCount, containerAddrs, targetUrl, targetEndpoints };
  if (typeof row.title === "string" && row.title.trim()) bundle.title = row.title.trim();
  if (typeof row.description === "string" && row.description.trim()) bundle.description = row.description;
  if (Array.isArray(row.tags)) {
    const tags = row.tags.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    if (tags.length > 0) bundle.tags = tags;
  }
  if (row.platformFields && typeof row.platformFields === "object" && !Array.isArray(row.platformFields)) {
    const platformFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.platformFields as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) platformFields[key] = value;
    }
    if (Object.keys(platformFields).length > 0) bundle.platformFields = platformFields;
  }
  if (row.rawMaterial && typeof row.rawMaterial === "object" && !Array.isArray(row.rawMaterial)) {
    bundle.rawMaterial = row.rawMaterial as Record<string, unknown>;
  }
  if (row.materialIncomplete === true) bundle.materialIncomplete = true;
  if (row.materialTruncated === true) bundle.materialTruncated = true;
  const task = parseTaskMaterial(row.task);
  if (task) bundle.task = task;
  if (typeof row.childMission === "string" && row.childMission.trim()) bundle.childMission = row.childMission;
  if (typeof row.difficulty === "string" && row.difficulty.trim()) bundle.difficulty = row.difficulty.trim();
  if (typeof row.level === "number" && Number.isFinite(row.level)) bundle.level = row.level;
  if (typeof row.totalScore === "number" && Number.isFinite(row.totalScore)) bundle.totalScore = row.totalScore;
  if (Array.isArray(row.attachments)) {
    const attachments = row.attachments.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const name = (item as { name?: unknown }).name;
      const url = (item as { url?: unknown }).url;
      if (typeof name !== "string" || !name.trim()) return [];
      return [typeof url === "string" && url.trim() ? { name: name.trim(), url: url.trim() } : { name: name.trim() }];
    });
    if (attachments.length > 0) bundle.attachments = attachments;
  }
  if (row.hint && typeof row.hint === "object" && !Array.isArray(row.hint)) {
    const hint = row.hint as { available?: unknown; cost?: unknown };
    const available = typeof hint.available === "number" && Number.isFinite(hint.available) ? hint.available : undefined;
    const cost = typeof hint.cost === "string" && hint.cost.trim() ? hint.cost.trim() : undefined;
    if (available !== undefined || cost) bundle.hint = { ...(available !== undefined ? { available } : {}), ...(cost ? { cost } : {}) };
  }
  return bundle;
}

/** Explicit http(s), port 80, or port 443. Other bare host:port values stay raw. */
export function clearHttpEndpoint(addr: string): string | undefined {
  const trimmed = addr.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return contestTargetUrl(trimmed);
  const match = /^(?<host>\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._-]+)(?::(?<port>\d+))?$/.exec(trimmed);
  if (!match?.groups?.host) return undefined;
  const port = match.groups.port;
  if (port === "443") return `https://${match.groups.host}:${port}/`;
  if (port === undefined || port === "80") return contestTargetUrl(trimmed);
  return undefined;
}

function clearHttpEndpoints(addrs: readonly string[]): string[] {
  const endpoints: string[] = [];
  for (const addr of addrs) {
    const endpoint = clearHttpEndpoint(addr);
    if (endpoint && !endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  return endpoints;
}

function primaryTarget(containerAddrs: readonly string[]): string | undefined {
  const first = containerAddrs[0];
  if (!first) return undefined;
  return clearHttpEndpoint(first) ?? first;
}
