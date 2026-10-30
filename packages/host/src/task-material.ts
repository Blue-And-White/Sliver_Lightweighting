import type { ChallengeAttachment, ChallengeHintInfo } from "./contest-platform.ts";

export type TaskMaterialSource = "mission" | "platform" | "commander" | "operator";
export type TaskMaterialCompleteness = "complete" | "partial" | "missing";

export interface TaskMaterialEnvelope {
  schema: "silver.task-material.v1";
  source: TaskMaterialSource;
  rawMaterial?: Record<string, unknown>;
  materialText: string;
  constraints?: string;
  resources: {
    addresses?: string[];
    endpoints?: string[];
    attachments?: ChallengeAttachment[];
    hint?: ChallengeHintInfo;
  };
  indexes?: {
    flagCount?: number;
    difficulty?: string;
    level?: number;
    score?: number;
    containerAddrs?: string[];
  };
  statement?: {
    title?: string;
    description?: string;
    tags?: string[];
  };
  completeness: TaskMaterialCompleteness;
  completenessReason?: string;
}

export function taskMaterialFromPlatform(input: {
  rawMaterial?: Record<string, unknown>;
  constraints?: string;
  addresses?: string[];
  endpoints?: string[];
  attachments?: ChallengeAttachment[];
  hint?: ChallengeHintInfo;
  flagCount?: number;
  difficulty?: string;
  level?: number;
  score?: number;
  source?: TaskMaterialSource;
  hasStatement?: boolean;
  title?: string;
  description?: string;
  tags?: string[];
  materialTruncated?: boolean;
}): TaskMaterialEnvelope {
  const raw = input.rawMaterial;
  const hasStatement = input.hasStatement === true || statementIn(raw);
  const hasIndex = Boolean(input.addresses?.length || input.difficulty || input.flagCount);
  const completeness: TaskMaterialCompleteness = hasStatement && !input.materialTruncated
    ? "complete"
    : hasIndex || raw
      ? "partial"
      : "missing";
  const completenessReason = input.materialTruncated
      ? "upstream task material exceeded the bounded projection and was truncated"
    : hasStatement
      ? undefined
    : hasIndex
      ? "upstream task had addresses or scores but no title, description, or tags"
      : "no upstream task material was stored";
  const envelope: TaskMaterialEnvelope = {
    schema: "silver.task-material.v1",
    source: input.source ?? "platform",
    materialText: "",
    resources: {
      ...(input.addresses?.length ? { addresses: input.addresses } : {}),
      ...(input.endpoints?.length ? { endpoints: input.endpoints } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.hint ? { hint: input.hint } : {}),
    },
    indexes: {
      ...(input.flagCount !== undefined ? { flagCount: input.flagCount } : {}),
      ...(input.difficulty ? { difficulty: input.difficulty } : {}),
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.score !== undefined ? { score: input.score } : {}),
      ...(input.addresses?.length ? { containerAddrs: input.addresses } : {}),
    },
    completeness,
    ...(completenessReason ? { completenessReason } : {}),
    ...(raw ? { rawMaterial: raw } : {}),
    ...(input.constraints?.trim() ? { constraints: input.constraints.trim() } : {}),
    ...(input.title || input.description || input.tags?.length
      ? {
          statement: {
            ...(input.title ? { title: input.title } : {}),
            ...(input.description ? { description: input.description } : {}),
            ...(input.tags?.length ? { tags: input.tags } : {}),
          },
        }
      : {}),
  };
  envelope.materialText = renderTaskMaterial(envelope);
  return envelope;
}

export function withTaskConstraints(envelope: TaskMaterialEnvelope, constraints?: string): TaskMaterialEnvelope {
  const text = constraints?.trim();
  if (!text || envelope.constraints === text) return envelope;
  const next = { ...envelope, constraints: text };
  if (envelope.source === "commander") {
    const marker = "\n\nHost Acceptance Contract\n";
    const block = `\n\nOperator constraints:\n${text}`;
    const index = envelope.materialText.lastIndexOf(marker);
    next.materialText = index >= 0
      ? `${envelope.materialText.slice(0, index)}${block}${envelope.materialText.slice(index)}`
      : `${envelope.materialText}${block}`;
    return next;
  }
  next.materialText = renderTaskMaterial(next);
  return next;
}

export function taskMaterialForHintAvailability(
  envelope: TaskMaterialEnvelope,
  hintAvailable: boolean,
): TaskMaterialEnvelope {
  if (hintAvailable || !envelope.resources.hint) return envelope;
  const { hint: _hint, ...resources } = envelope.resources;
  return {
    ...envelope,
    resources,
    materialText: envelope.materialText
      .split("\n")
      .filter((line) => line.trim() !== "hints: metadata only. Not prefetched.")
      .join("\n"),
  };
}

export function parseTaskMaterial(value: unknown): TaskMaterialEnvelope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as TaskMaterialEnvelope;
  if (row.schema !== "silver.task-material.v1") return undefined;
  if (row.completeness !== "complete" && row.completeness !== "partial" && row.completeness !== "missing") return undefined;
  if (typeof row.materialText !== "string") return undefined;
  return row;
}

const INDEX_KEYS =
  /^(unique_code|id|board_id|boardid|case_id|caseid|task_id|taskid|target_id|targetid|challenge_id|challengeid|difficulty|level|total_score|totalscore|score|flag_count|flagcount|correct_flag_count|correctflagcount|is_completed|iscompleted|container_status|containerstatus|status|container_addr|containeraddr|container_addrs|target_url|targeturl|address|addresses|endpoint|endpoints|url|urls)$/i;

/** Any non-empty non-index string is task text, whatever the platform named the field. */
function statementIn(value: unknown, key = ""): boolean {
  if (INDEX_KEYS.test(key)) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => statementIn(item, key));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([child, item]) => statementIn(item, child));
  }
  return false;
}

export function renderTaskMaterial(envelope: TaskMaterialEnvelope): string {
  const lines: string[] = [];
  if (envelope.completeness !== "complete") {
    const known = [
      envelope.resources.addresses?.length || envelope.resources.endpoints?.length ? "endpoints" : "",
      envelope.indexes?.difficulty ? "difficulty" : "",
      envelope.indexes?.score !== undefined ? "score" : "",
      envelope.statement?.title ? "title" : "",
      envelope.statement?.description ? "description" : "",
      envelope.statement?.tags?.length ? "tags" : "",
      envelope.resources.attachments?.length ? "attachments" : "",
    ].filter(Boolean);
    const missing = [
      envelope.statement?.title ? "" : "title",
      envelope.statement?.description ? "" : "description",
      envelope.statement?.tags?.length ? "" : "tags",
      envelope.resources.attachments?.length ? "" : "attachments",
    ].filter(Boolean);
    lines.push(
      "material incomplete",
      `known: ${known.join(", ") || "none"}`,
      `missing: ${missing.join(", ") || "none"}`,
    );
  }
  lines.push(
    "Task material. This is the contract for the room. The index below does not replace it.",
    `completeness: ${envelope.completeness}`,
  );
  if (envelope.completenessReason) lines.push(`reason: ${envelope.completenessReason}`);
  if (envelope.constraints) {
    lines.push("Operator constraints:", envelope.constraints);
  }
  lines.push("Upstream task material (verbatim / best-effort):");
  if (envelope.statement?.title) lines.push(`title: ${envelope.statement.title}`);
  if (envelope.statement?.description) lines.push(envelope.statement.description);
  if (envelope.statement?.tags?.length) lines.push(`tags: ${envelope.statement.tags.join(", ")}`);
  lines.push(envelope.rawMaterial ? JSON.stringify(envelope.rawMaterial, null, 2) : "(no raw platform row)");
  lines.push("---", "Structured index.");
  const addresses = envelope.resources.addresses ?? [];
  lines.push("addresses:");
  for (const addr of addresses) lines.push(`- ${addr}`);
  if (addresses.length === 0) lines.push("- none");
  if (envelope.indexes?.difficulty) lines.push(`difficulty: ${envelope.indexes.difficulty}`);
  if (envelope.indexes?.flagCount !== undefined) lines.push(`flagCount: ${envelope.indexes.flagCount}`);
  if (envelope.resources.attachments?.length) {
    lines.push("attachments:");
    for (const row of envelope.resources.attachments) {
      lines.push(row.url ? `- ${row.name} ${row.url}` : `- ${row.name}`);
    }
  }
  if (envelope.resources.hint) {
    lines.push("hints: metadata only. Not prefetched.");
  }
  return lines.join("\n");
}
