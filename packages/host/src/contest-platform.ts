/**
 * Current contest-contract adapter for list, start, submit, close, and material reads.
 * The protocol comes from this mission's brief. It is not a universal platform.
 * submit records one candidate. The room is complete only when the platform's
 * correct flag count reaches the total flag count.
 */

export class ContestSlotFullError extends Error {
  constructor(message = "contest platform slot full") {
    super(message);
    this.name = "ContestSlotFullError";
  }
}

export class ContestEndedError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message = "contest platform ended", code = "invalid_state", status = 0) {
    super(message);
    this.name = "ContestEndedError";
    this.code = code;
    this.status = status;
  }
}

export class ContestDuplicateError extends Error {
  constructor(message = "contest platform duplicate") {
    super(message);
    this.name = "ContestDuplicateError";
  }
}

export interface ChallengeAttachment {
  name: string;
  url?: string;
}

/** Platform hint metadata. The hint text itself is not fetched until request_hint. */
export interface ChallengeHintInfo {
  available?: number;
  cost?: string;
}

export interface ContestChallengeContent {
  title?: string;
  description?: string;
  tags?: string[];
  difficulty?: string;
  level?: number;
  totalScore?: number;
  attachments?: ChallengeAttachment[];
  hint?: ChallengeHintInfo;
  /** Other non-secret string fields from the platform row, kept verbatim. */
  platformFields?: Record<string, string>;
  /** Redacted original platform row. The task text. Structured fields do not replace it. */
  rawMaterial?: Record<string, unknown>;
  /** The redacted raw row exceeded the bounded task-material projection. */
  materialTruncated?: boolean;
  /** True when the platform row had addresses but no title, description, or tags. */
  materialIncomplete?: boolean;
}

export interface ContestBoardRow extends ContestChallengeContent {
  boardId: string;
  flagCount: number;
  correctFlagCount: number;
  isCompleted: boolean;
  containerStatus: string;
  containerAddr: string[];
}

export interface ContestSubmitVerdict {
  /** Normalized facts are optional; the contest adapter may expose only its native response. */
  correct?: boolean;
  awarded?: number;
  cumulativeScore?: number;
  correctFlagCount?: number;
  totalFlagCount?: number;
  duplicate?: boolean;
  /**
   * The adapter's explicit platform completion fact. Mounted adapter terminal
   * state follows this boolean and is not inferred from flag counts.
   */
  completed?: boolean;
  /** Exact response value returned by the contest-specific adapter. */
  platformResponse?: unknown;
  httpStatus?: number;
}

export interface ContestPlatform {
  list(): Promise<ContestBoardRow[]>;
  start(boardId: string): Promise<{ boardId: string; containerAddr: string[] } & ContestChallengeContent>;
  submit(boardId: string, flag: string): Promise<ContestSubmitVerdict>;
  close(boardId: string): Promise<void>;
}

/**
 * Mission-level contest adapter mounted by the operator in the Host process.
 * The required lifecycle methods preserve the existing admission and recovery
 * contract. Material and hint reads are optional capabilities; their absence
 * must not be guessed from Mission prose.
 */
export interface MissionContestAdapter extends ContestPlatform {
  readMaterial?(boardId: string): Promise<ContestChallengeContent[]>;
  requestHint?(boardId: string): Promise<{ ok: true; hint: string } | { ok: false; error: string }>;
}

export interface HttpContestEndpoints {
  baseUrl: string;
  token: string;
  tokenHeader: string;
  listPath: string;
  startPath: string;
  hintPath?: string;
  submitPath: string;
  closePath: string;
  boardIdField?: string;
  /** Optional material GETs declared by the mission. Hint bodies are not fetched here. */
  materialPaths?: { detail?: string; attachments?: string; download?: string };
}

export function contestTargetUrl(addr: string): string {
  const trimmed = addr.trim();
  if (!trimmed) throw new Error("container_addr is empty");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}/`;
}

export class HttpContestPlatform implements ContestPlatform {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly tokenHeader: string;
  private readonly listPath: string;
  private readonly startPath: string;
  private readonly hintPath: string | undefined;
  private readonly submitPath: string;
  private readonly closePath: string;
  private readonly boardIdField: string;
  private readonly materialPaths: { detail?: string; attachments?: string; download?: string };

  constructor(endpoints: HttpContestEndpoints) {
    this.baseUrl = endpoints.baseUrl.replace(/\/+$/, "");
    this.token = endpoints.token;
    this.tokenHeader = endpoints.tokenHeader;
    this.listPath = endpoints.listPath;
    this.startPath = endpoints.startPath;
    this.hintPath = endpoints.hintPath;
    this.submitPath = endpoints.submitPath;
    this.closePath = endpoints.closePath;
    this.boardIdField = endpoints.boardIdField ?? "id";
    this.materialPaths = endpoints.materialPaths ?? {};
  }

  /** Fetch declared detail/attachment/download metadata. A failed GET does not drop start. */
  async readMaterial(boardId: string): Promise<ContestChallengeContent[]> {
    const named = [
      ["detail", this.materialPaths.detail],
      ["attachments", this.materialPaths.attachments],
      ["download", this.materialPaths.download],
    ] as const;
    const layers: ContestChallengeContent[] = [];
    for (const [source, path] of named) {
      if (!path) continue;
      try {
        const payload = await this.requestJson(
          "GET",
          withQuery(path, { [this.boardIdField]: boardId }),
          undefined,
          "material",
        );
        layers.push(contentFromPayload(payload));
      } catch {
        layers.push({ platformFields: { [source]: "unavailable" } });
      }
    }
    return layers;
  }

  async list(): Promise<ContestBoardRow[]> {
    const payload = await this.requestJson("GET", this.listPath, undefined, "list");
    const rows = boardRowsFromPayload(payload);
    return rows.map(parseBoardRow);
  }

  async start(boardId: string): Promise<{ boardId: string; containerAddr: string[] } & ContestChallengeContent> {
    const path = withQuery(this.startPath, { [this.boardIdField]: boardId });
    const payload = await this.requestJson("POST", path, undefined, "start");
    const obj = objectPayload(payload);
    const addr = targetAddressesFromObject(obj);
    const rawMaterial = redactPlatformMaterial(obj);
    return {
      boardId: boardIdFromObject(obj) || boardId,
      containerAddr: typeof addr === "string" ? [addr] : stringList(addr),
      ...challengeContentFromObject(obj),
      ...(rawMaterial ? { rawMaterial } : {}),
      ...(platformMaterialWasTruncated(obj) ? { materialTruncated: true } : {}),
    };
  }

  async requestHint(boardId: string): Promise<{ ok: true; hint: string } | { ok: false; error: "no_hints" }> {
    if (!this.hintPath) return { ok: false, error: "no_hints" };
    const payload = await this.requestJson(
      "GET",
      withQuery(this.hintPath, { [this.boardIdField]: boardId }),
      undefined,
      "hint",
    );
    const hint = objectPayload(payload).hint;
    return typeof hint === "string" && hint.trim()
      ? { ok: true, hint: hint.trim() }
      : { ok: false, error: "no_hints" };
  }

  async submit(boardId: string, flag: string): Promise<ContestSubmitVerdict> {
    try {
      const payload = await this.requestJson(
        "POST",
        this.submitPath,
        { [this.boardIdField]: boardId, flag },
        "submit",
      );
      const obj = objectPayload(payload);
      const explicitCompleted = obj.is_completed ?? obj.isCompleted ?? obj.completed;
      const correct = submitCorrect(obj);
      if (correct === undefined) {
        throw new Error("contest submit response did not include an explicit correctness verdict");
      }
      const correctFlagCount = numberOrUndefined(
        obj.correct_flag_count ?? obj.correctFlagCount ?? obj.accepted_count ?? obj.acceptedCount ?? obj.solved_count ?? obj.solvedCount,
      );
      const totalFlagCount = numberOrUndefined(
        obj.total_flag_count ?? obj.totalFlagCount ?? obj.flag_count ?? obj.flagCount,
      );
      const countCompleted =
        correctFlagCount !== undefined &&
        totalFlagCount !== undefined &&
        totalFlagCount > 0 &&
        correctFlagCount >= totalFlagCount;
      return {
        correct,
        awarded: numberOrZero(obj.awarded ?? obj.award ?? obj.points ?? obj.score_delta ?? obj.scoreDelta),
        cumulativeScore: numberOrZero(obj.cumulative_score ?? obj.cumulativeScore ?? obj.total_score ?? obj.totalScore),
        ...(correctFlagCount !== undefined ? { correctFlagCount } : {}),
        ...(totalFlagCount !== undefined ? { totalFlagCount } : {}),
        ...(typeof explicitCompleted === "boolean"
          ? { completed: explicitCompleted || countCompleted }
          : countCompleted
            ? { completed: true }
            : {}),
      };
    } catch (err) {
      // A platform saying only "duplicate" does not prove the earlier value was
      // accepted. Let the room record an unknown verdict and reconcile by list().
      throw err;
    }
  }

  /** Contest release adapter. Frees this target's platform resource. Not every task has a release. */
  async close(boardId: string): Promise<void> {
    const path = withQuery(this.closePath, { [this.boardIdField]: boardId });
    await this.requestJson("POST", path, undefined, "close");
  }

  private async requestJson(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    kind: "list" | "start" | "submit" | "close" | "material" | "hint",
  ): Promise<unknown> {
    const url = new URL(path, `${this.baseUrl}/`);
    const headers: Record<string, string> = {
      [this.tokenHeader]: this.token,
      "User-Agent": "silver-contest/0",
    };
    if (body) headers["Content-Type"] = "application/json";
    const init: RequestInit = { method, headers };
    if (body) init.body = JSON.stringify(body);
    const response = await fetch(url, init);
    const text = await response.text();
    if (!response.ok) throw mappedContestError(response.status, kind, text);
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ContestHttpError(response.status, kind, "");
    }
  }
}

class ContestHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, kind: string, body: string, code = "") {
    super(messageForHttp(status, kind, body));
    this.name = "ContestHttpError";
    this.status = status;
    this.code = code;
  }
}

function mappedContestError(status: number, kind: string, body: string): Error {
  const code = errorCode(body);
  const message = errorMessage(body);
  if (code === "resource_unavailable" || status === 503 || isCapacityError(message)) {
    return new ContestSlotFullError(`contest platform ${kind} resource_unavailable`);
  }
  if (code === "invalid_state") {
    return new ContestEndedError(messageForHttp(status, kind, body), code, status);
  }
  if (code === "duplicate") {
    return new ContestDuplicateError(`contest platform ${kind} duplicate`);
  }
  return new ContestHttpError(status, kind, body, code);
}

function errorCode(body: string): string {
  try {
    const obj = JSON.parse(body) as { code?: unknown };
    return typeof obj.code === "string" ? obj.code : "";
  } catch {
    return "";
  }
}

function errorMessage(body: string): string {
  try {
    const obj = JSON.parse(body) as { message?: unknown };
    return typeof obj.message === "string" ? obj.message : "";
  } catch {
    return "";
  }
}

function isCapacityError(message: string): boolean {
  return /\b(max active|active challenge|slot|capacity|resource|unavailable|busy)\b/i.test(message);
}

function messageForHttp(status: number, kind: string, body: string): string {
  if (kind === "submit") return `contest platform submit HTTP ${status}`;
  try {
    const obj = JSON.parse(body) as { code?: unknown; message?: unknown };
    const code = typeof obj.code === "string" ? obj.code : "";
    const message = typeof obj.message === "string" ? obj.message : "";
    return `contest platform ${kind} HTTP ${status} ${code} ${message}`.trim();
  } catch {
    return `contest platform ${kind} HTTP ${status}`;
  }
}

export function preflightContestBoard(rows: ContestBoardRow[]): void {
  if (!Array.isArray(rows)) throw new Error("contest list is not an array");
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.boardId.trim()) throw new Error("contest list row missing id");
    if (seen.has(row.boardId)) throw new Error(`contest list duplicate id ${row.boardId}`);
    seen.add(row.boardId);
    if (!Number.isFinite(row.flagCount) || row.flagCount < 1) {
      throw new Error(`contest list ${row.boardId} missing flagCount`);
    }
  }
}

function parseBoardRow(row: unknown): ContestBoardRow {
  const obj = asObject(row);
  const boardId = boardIdFromObject(obj);
  if (!boardId) throw new Error("contest board row missing id");
  const addr = targetAddressesFromObject(obj);
  const rawMaterial = redactPlatformMaterial(obj);
  return {
    boardId,
    flagCount: numberOrZero(obj.flag_count ?? obj.flagCount),
    correctFlagCount: numberOrZero(obj.correct_flag_count ?? obj.correctFlagCount ?? obj.solved_count ?? obj.solvedCount),
    isCompleted: truthy(obj.is_completed ?? obj.isCompleted ?? obj.solved ?? obj.completed ?? obj.done),
    containerStatus: String(obj.container_status ?? obj.containerStatus ?? obj.status ?? "stopped"),
    containerAddr: typeof addr === "string" ? [addr] : stringList(addr),
    ...challengeContentFromObject(obj),
    ...(rawMaterial ? { rawMaterial } : {}),
    ...(platformMaterialWasTruncated(obj) ? { materialTruncated: true } : {}),
  };
}

function contentFromPayload(payload: unknown): ContestChallengeContent {
  const rows = arrayMaterial(payload);
  if (rows) {
    const attachments = attachmentsFrom(rows);
    const items = rows.slice(0, 40).map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) return redactPlatformMaterial(item) ?? {};
      return redactPlatformValue(item, 1);
    });
    return {
      ...(attachments ? { attachments } : {}),
      rawMaterial: { items },
      ...(rows.length > 40 || rows.some((item) => platformMaterialWasTruncated(item))
        ? { materialTruncated: true }
        : {}),
    };
  }
  const obj = objectPayload(payload);
  const rawMaterial = redactPlatformMaterial(obj);
  return {
    ...challengeContentFromObject(obj),
    ...(rawMaterial ? { rawMaterial } : {}),
    ...(platformMaterialWasTruncated(obj) ? { materialTruncated: true } : {}),
  };
}

function arrayMaterial(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return undefined;
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data : undefined;
}

function challengeContentFromObject(obj: Record<string, unknown>): ContestChallengeContent {
  const content: ContestChallengeContent = {};
  const title = collectText(obj.title ?? obj.name ?? obj.challenge_name ?? obj.challengeName);
  if (title) content.title = title;
  const description = collectText(obj.description ?? obj.desc ?? obj.brief ?? obj.summary ?? obj.detail ?? obj.details);
  if (description) content.description = description;
  const tags = stringTags(
    obj.tags ?? obj.tag ?? obj.categories ?? obj.category ?? obj.labels ?? obj.label ?? obj.vuln_type ?? obj.vulnType ?? obj.vulnerability ?? obj.type,
  );
  if (tags) content.tags = tags;
  const platformFields = leftoverPlatformText(obj);
  if (platformFields) content.platformFields = platformFields;
  const difficulty = textField(obj.difficulty);
  if (difficulty) content.difficulty = difficulty;
  const level = finiteNumber(obj.level);
  if (level !== undefined) content.level = level;
  const totalScore = finiteNumber(obj.total_score ?? obj.totalScore);
  if (totalScore !== undefined) content.totalScore = totalScore;
  const attachments = attachmentsFrom(obj.attachments ?? obj.files ?? obj.attachment_list ?? obj.attachmentList);
  if (attachments) content.attachments = attachments;
  const hint = hintFrom(obj);
  if (hint) content.hint = hint;
  return content;
}

function redactPlatformMaterial(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PLATFORM_FIELD_SKIP.test(key) || /^hints?$/i.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    const redacted = redactPlatformValue(item, depth + 1);
    if (redacted !== undefined) out[key] = redacted;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function redactPlatformValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    return trimmed.length > 8000 ? `${trimmed.slice(0, 8000)}…` : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => redactPlatformValue(item, depth + 1)).filter((item) => item !== undefined);
    return items.length > 0 ? items.slice(0, 40) : undefined;
  }
  if (value && typeof value === "object") return redactPlatformMaterial(value, depth);
  return undefined;
}

function platformMaterialWasTruncated(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.trim().length > 8000;
  if (Array.isArray(value)) {
    return value.length > 40 || value.some((item) => platformMaterialWasTruncated(item, depth + 1));
  }
  if (!value || typeof value !== "object") return false;
  if (depth > 4) return Object.keys(value as Record<string, unknown>).length > 0;
  return Object.values(value as Record<string, unknown>).some((item) => platformMaterialWasTruncated(item, depth + 1));
}

function stringTags(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,/|]/) : [];
  const tags = raw
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        return textField(obj.name ?? obj.tag ?? obj.label ?? obj.value) ?? "";
      }
      return "";
    })
    .filter(Boolean);
  return tags.length > 0 ? [...new Set(tags)] : undefined;
}

const PLATFORM_FIELD_SKIP =
  /^(flag|flags|answer|answers|token|password|secret|authorization|api[-_]?key|credential|credentials)$/i;

function leftoverPlatformText(obj: Record<string, unknown>): Record<string, string> | undefined {
  const consumed = new Set([
    "title",
    "name",
    "challenge_name",
    "challengeName",
    "description",
    "desc",
    "brief",
    "summary",
    "detail",
    "details",
    "tags",
    "tag",
    "categories",
    "category",
    "labels",
    "label",
    "vuln_type",
    "vulnType",
    "vulnerability",
    "type",
    "difficulty",
    "level",
    "total_score",
    "totalScore",
    "attachments",
    "files",
    "attachment_list",
    "attachmentList",
    "hint",
    "hints",
    "hint_count",
    "hintCount",
    "hints_remaining",
    "hintsRemaining",
    "hint_cost",
    "hintCost",
    "hint_penalty",
    "hintPenalty",
    "board_id",
    "boardId",
    "case_id",
    "caseId",
    "task_id",
    "taskId",
    "target_id",
    "targetId",
    "unique_code",
    "challenge_id",
    "challengeId",
    "id",
    "flag_count",
    "flagCount",
    "correct_flag_count",
    "correctFlagCount",
    "solved_count",
    "solvedCount",
    "is_completed",
    "isCompleted",
    "solved",
    "completed",
    "done",
    "container_status",
    "containerStatus",
    "status",
    "container_addr",
    "containerAddr",
    "target_url",
    "targetUrl",
    "access_url",
    "accessUrl",
    "endpoint",
    "endpoints",
    "address",
    "addresses",
    "target",
    "targets",
    "url",
    "urls",
  ]);
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (consumed.has(key) || PLATFORM_FIELD_SKIP.test(key)) continue;
    const text = collectText(value);
    if (!text || text.length > 4000) continue;
    fields[key] = text;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function collectText(value: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (typeof value === "string") return textField(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => collectText(item, depth + 1)).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["text", "content", "value", "markdown", "zh", "en", "description", "name"]) {
      const found = collectText(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function textField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function attachmentsFrom(value: unknown): ChallengeAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: ChallengeAttachment[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      rows.push({ name: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = textField(obj.name ?? obj.filename ?? obj.file ?? obj.path);
    if (!name) continue;
    const url = textField(obj.url ?? obj.download_url ?? obj.downloadUrl ?? obj.href);
    rows.push(url ? { name, url } : { name });
  }
  return rows.length > 0 ? rows : undefined;
}

function hintFrom(obj: Record<string, unknown>): ChallengeHintInfo | undefined {
  const nested = obj.hint ?? obj.hints;
  let available = finiteNumber(obj.hint_count ?? obj.hintCount ?? obj.hints_remaining ?? obj.hintsRemaining);
  let cost = textField(obj.hint_cost ?? obj.hintCost ?? obj.hint_penalty ?? obj.hintPenalty);
  if (!cost) {
    const numericCost = finiteNumber(obj.hint_cost ?? obj.hintCost ?? obj.hint_penalty ?? obj.hintPenalty);
    if (numericCost !== undefined) cost = String(numericCost);
  }
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const hint = nested as Record<string, unknown>;
    available = available ?? finiteNumber(hint.available ?? hint.remaining ?? hint.count ?? hint.hint_count);
    cost = cost ?? textField(hint.cost ?? hint.price ?? hint.penalty);
    if (!cost) {
      const numericCost = finiteNumber(hint.cost ?? hint.price ?? hint.penalty);
      if (numericCost !== undefined) cost = String(numericCost);
    }
  } else if (available === undefined) {
    available = finiteNumber(nested);
  }
  if (available === undefined && !cost) return undefined;
  return { ...(available !== undefined ? { available } : {}), ...(cost ? { cost } : {}) };
}

function boardRowsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const obj = asObject(payload);
  const data = obj.data;
  if (Array.isArray(data)) return data;
  const nested = asObject(data);
  for (const key of ["list", "items", "rows", "results", "challenges", "tasks", "cases", "targets"]) {
    const value = obj[key] ?? nested[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function objectPayload(payload: unknown): Record<string, unknown> {
  const obj = asObject(payload);
  const data = asObject(obj.data);
  return Object.keys(data).length > 0 ? data : obj;
}

function targetAddressesFromObject(obj: Record<string, unknown>): unknown {
  return (
    obj.container_addr ??
    obj.containerAddr ??
    obj.target_url ??
    obj.targetUrl ??
    obj.access_url ??
    obj.accessUrl ??
    obj.endpoint ??
    obj.endpoints ??
    obj.address ??
    obj.addresses ??
    obj.target ??
    obj.targets ??
    obj.url ??
    obj.urls
  );
}

function boardIdFromObject(obj: Record<string, unknown>): string {
  return String(
    obj.board_id ??
      obj.boardId ??
      obj.case_id ??
      obj.caseId ??
      obj.task_id ??
      obj.taskId ??
      obj.target_id ??
      obj.targetId ??
      obj.unique_code ??
      obj.challenge_id ??
      obj.challengeId ??
      obj.id ??
      "",
  ).trim();
}

function submitCorrect(obj: Record<string, unknown>): boolean | undefined {
  const status = String(obj.status ?? obj.verdict ?? obj.result ?? "").toLowerCase();
  if (/^(accepted|correct|solved|passed)$/.test(status)) return true;
  if (/^(rejected|wrong|failed|incorrect|error)$/.test(status)) return false;
  const explicit = obj.correct ?? obj.accepted ?? obj.is_correct ?? obj.isCorrect ?? obj.solved;
  if (typeof explicit === "boolean") return explicit;
  if (typeof explicit === "number" && (explicit === 0 || explicit === 1)) return explicit === 1;
  if (typeof explicit === "string" && /^(true|false|yes|no|1|0)$/i.test(explicit.trim())) {
    return /^(true|yes|1)$/i.test(explicit.trim());
  }
  return undefined;
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") return /^(true|yes|y|1|accepted|correct|ok|success|solved|completed|done)$/i.test(value.trim());
  return false;
}

function withQuery(path: string, query: Record<string, string>): string {
  const url = new URL(path, "http://silver.invalid");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => String(row).trim()).filter(Boolean);
}

function numberOrZero(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}
