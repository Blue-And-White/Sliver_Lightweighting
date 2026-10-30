import type { JsonSchema } from "./types.ts";

function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

function openObj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  const schema: JsonSchema = { type: "object", properties, additionalProperties: true };
  if (required.length > 0) schema.required = required;
  return schema;
}

function str(description?: string): JsonSchema {
  const schema: JsonSchema = { type: "string" };
  if (description) schema.description = description;
  return schema;
}

function bool(description?: string, fallback?: boolean): JsonSchema {
  const schema: JsonSchema = { type: "boolean" };
  if (description) schema.description = description;
  if (fallback !== undefined) schema.default = fallback;
  return schema;
}

function integer(description: string, fallback: number, min: number, max: number): JsonSchema {
  return { type: "integer", description, default: fallback, minimum: min, maximum: max };
}

const empty = obj({});

const actionType = (name: string): JsonSchema => ({
  type: "string",
  enum: [name],
  description: `Must be "${name}". Use type, not action.`,
});

const recruitAction = obj(
  {
    type: actionType("recruit"),
    role: { type: "string", enum: ["lead", "worker"], description: "Recruit role. Swarm Lead must use worker." },
    requestId: str("Stable request id. Host binds the permit to this id, not a model-chosen memberId."),
    duty: str("Optional duty."),
  },
  ["type", "role", "requestId"],
);

const removeAction = obj(
  {
    type: actionType("remove"),
    memberId: str("Bound memberId to remove."),
    requestId: str("Stable request id for this remove."),
  },
  ["type", "memberId", "requestId"],
);

const candidateProperties = {
  candidateId: str("Optional opaque candidate id for this attempt, e.g. C001."),
  fingerprint: str("Host-authoritative fingerprint. Prefer omitting; Host derives it from raw."),
  artifactRef: str("Optional locator of the artifact that contains the candidate."),
  shape: str("Expected shape, e.g. flag{}."),
  raw: str("Candidate bytes. Never write this to protocol files."),
};

const candidateVerify = obj(candidateProperties, ["candidateId", "artifactRef", "raw"]);
const candidateSubmit = obj({ raw: candidateProperties.raw }, ["raw"]);

function intelTags(description: string, maxItems = 3): JsonSchema {
  return {
    type: "array",
    maxItems,
    items: { type: "string", enum: ["asset", "identity", "access", "capability"] },
    description,
  };
}

export const TOOL_SCHEMAS: Record<string, JsonSchema> = {
  contest_list: empty,
  contest_start: obj(
    {
      targetId: str("Exact challenge id returned by contest_list."),
    },
    ["targetId"],
  ),
  restart_challenge: empty,
  queue_target: obj(
    {
      targetId: str("Stable challenge, service, or work id from the Mission."),
      targetUrl: str("Primary endpoint obtained by Commander through the Mission's platform procedure."),
      flagCount: {
        type: "integer",
        description: "Expected result count when the Mission defines one. Omit when unknown.",
        minimum: 1,
        maximum: 128,
      },
      retry: bool("Set true only to re-enter a target this Mission already admitted, including a Host start retry."),
      childMission: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description:
          "Complete natural-language task for the Room: preserve source material, all relevant addresses and attachments, constraints, completion rules, and all task-scoped status, progress, hint, submission, reporting, authentication instructions, identities, and credentials exactly as provided, including operator-provided per-task credentials. Exclude only global allocation, list, start, restart, and close lifecycle control and the credentials used for that global lifecycle; Commander owns those global actions.",
      },
    },
    ["targetId", "targetUrl", "childMission"],
  ),
  mission_status: empty,
  review_room_allocation: obj(
    {
      targetId: str("Active Room target id from a soft allocation checkpoint."),
      decision: { type: "string", enum: ["continue", "defer"] },
      reason: str("Factual scheduling reason based on remaining score, accepted progress, and available challenges. No technical instructions."),
    },
    ["targetId", "decision", "reason"],
  ),
  record_target_result: obj(
    {
      targetId: str("Stable challenge id previously assigned to a Worker room."),
      status: { type: "string", enum: ["completed", "pending"] },
      reason: str("Factual conclusion from the Commander's latest platform observation."),
      reviewGenerationId: {
        type: "integer",
        minimum: 1,
        description:
          "Echo the reviewGenerationId from the candidate report wake that triggered this check. Required when the wake included one.",
      },
    },
    ["targetId", "status", "reason"],
  ),
  resolve_room_request: obj(
    {
      targetId: str("Active Room target id that raised the request."),
      decision: {
        type: "string",
        enum: ["continue", "defer"],
        description:
          "Mechanical lifecycle choice only. continue keeps the live attempt and its deadline; defer ends that attempt so another target may use the slot.",
      },
      reason: str("External facts observed and authorized external actions performed. Do not include technical direction. Host forwards this text to the live Room on continue."),
    },
    ["targetId", "decision", "reason"],
  ),
  mission_done: obj(
    {
      terminalKind: {
        type: "string",
        enum: ["all_completed", "platform_ended", "invalid_mission", "deadline", "operator_stop", "failed"],
      },
      reason: str("Factual terminal reason from the latest platform state."),
    },
    ["terminalKind", "reason"],
  ),
  room_info: obj({
    permitId: str("Official Team recruit permit for this session's first Host RPC. Not an identity."),
    includeTaskMaterial: bool(
      "Re-read the full immutable task contract. Default false after this member's first room_info; use materialsRef instead when possible.",
      false,
    ),
  }),
  request_hint: empty,
  http_request: obj(
    {
      url: str("Absolute URL. Redirects are not followed."),
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], default: "GET" },
      headers: {
        type: "object",
        additionalProperties: str(),
        description: "Request headers for the challenge target. The HTTP exchange artifact preserves them.",
      },
      body: str("Request body for non-GET/HEAD."),
      timeoutMs: integer("Abort after this many ms.", 15_000, 1, 60_000),
      maxBytes: integer(
        "Max bytes of text preview returned to the model. Artifact still stores the full request/response exchange.",
        2048,
        1,
        64 * 1024,
      ),
    },
    ["url"],
  ),
  read_artifact: obj(
    {
      locator: str("Artifact path returned by a prior tool."),
      offset: integer("Byte offset", 0, 0, 64 * 1024),
      maxBytes: integer("Max bytes to return", 8192, 1, 64 * 1024),
    },
    ["locator"],
  ),
  grep_artifacts: obj({ pattern: str("Literal substring, not a regex.") }, ["pattern"]),
  terminal_open: obj(
    {
      argv: {
        type: "array",
        description: "argv array. No shell.",
        items: str(),
        minItems: 1,
      },
      cwd: str("Directory under the attempt root. Default: attempt root."),
      pty: bool("Wrap in python3 pty.spawn for gdb/REPL.", false),
    },
    ["argv"],
  ),
  terminal_send: obj(
    {
      id: str("Session id from terminal_open."),
      data: str("Bytes to write to stdin."),
      newline: bool("Append a newline. Default true.", true),
    },
    ["id", "data"],
  ),
  terminal_read: obj(
    {
      id: str("Session id from terminal_open."),
      waitMs: integer("Wait up to this many ms for output.", 200, 0, 10_000),
      idleMs: integer("Quiet window after output before returning.", 100, 0, 2000),
      expect: str("Keep reading until this substring appears."),
      until: str("Alias for expect."),
      maxBytes: integer("Bounded tail size.", 4096, 1, 64 * 1024),
    },
    ["id"],
  ),
  terminal_close: obj({ id: str("Session id from terminal_open.") }, ["id"]),
  terminal_list: empty,
  fs_read: obj(
    {
      path: str("Path under the attempt cwd."),
      offset: integer("Byte offset", 0, 0, 1024 * 1024),
      maxBytes: integer("Max bytes to return", 8192, 1, 64 * 1024),
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
    },
    ["path"],
  ),
  fs_write: obj(
    {
      path: str("Path under the attempt cwd."),
      body: str("File contents."),
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
    },
    ["path", "body"],
  ),
  fs_list: obj({ path: str("Directory under the attempt cwd. Default: cwd.") }),
  fs_grep: obj(
    {
      pattern: str("Literal substring, not a regex."),
      path: str("Start directory under the attempt cwd. Default: cwd."),
      maxMatches: integer("Max hits", 50, 1, 200),
    },
    ["pattern"],
  ),
  notebook_write: obj(
    {
      zone: { type: "string", enum: ["facts", "local_prune", "narrative"], default: "narrative" },
      text: str("Note body."),
      polarity: { type: "string", enum: ["positive", "negative", "neutral"] },
      artifactRef: str("Required for facts unless toolCallId is set."),
      toolCallId: str("Tool event that backs a facts note."),
    },
    ["text"],
  ),
  notebook_read: empty,
  room_feed_post: obj(
    {
      type: {
        type: "string",
        enum: ["hypothesis", "request", "challenge", "checkpoint", "defer_unavailable", "task_complete"],
        description:
          "Shared pull-first forum message type. Use request/challenge/checkpoint for help, questions, decisions, or handoffs; publish reusable observations with Intel and current focus with Status. defer_unavailable is the legacy transport name for a Lead-only natural-language request for an authorized external control or query action; its name makes no claim about resource state. task_complete is a Lead-only completion request.",
      },
      text: str("Concise public message. Messages above the Room transport limit are rejected rather than truncated."),
      intelId: str("Optional intelId this message refers to."),
    },
    ["type", "text"],
  ),
  room_feed_read: obj(
    {
      messageId: str("Read and acknowledge one message by id without skipping other unread posts."),
      query: str("Case-insensitive substring over text/type/author. Does not ack unread."),
      afterSeq: {
        type: "integer",
        description:
          "Sequential pull: return messages with seq greater than this and ack through the last returned message. Start with 0, then use the last returned seq. Omit for peek/search or to browse recent history. This remains available when unreadCount is 0.",
        minimum: 0,
        maximum: 1_000_000,
      },
      limit: integer("Max messages to return.", 20, 1, 50),
    },
    [],
  ),
  room_status_set: obj(
    {
      approach: str("One-line current approach for the status card."),
    },
    ["approach"],
  ),
  room_status_read: obj({}, []),
  intel_publish: obj(
    {
      observation: str(
        "A cited reusable fact, resource, capability, dependency, identity, or event observed to exist or happen. Put misses, absence claims, failed hypotheses, route exclusions, and discussion in private todo_write or Feed instead.",
      ),
      tags: intelTags(
        "Optional broad retrieval labels authored by the member. Use up to 3 that fit: asset (input/resource), identity (actor/role), access (path/session/reachability), capability (verified behavior). Host does not infer labels.",
      ),
      conditions: str("Optional applicability details for the observed fact (inputs, path, cookie, build, range, round, or resource instance)."),
      evidence: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["artifact", "tool_call", "path"] },
            ref: { type: "string" },
          },
          required: ["kind", "ref"],
          additionalProperties: false,
        },
        description: "Evidence refs another room member can re-read (artifact/tool_call/path).",
      },
      links: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            intelId: str("Existing Intel fact this observation points to."),
            relation: str("Short free-form directed relation, for example reachable_via, runs_on, authenticates_to, enables, exposed_by, or derived_from."),
          },
          required: ["intelId", "relation"],
          additionalProperties: false,
        },
        description:
          "Optional directed links that connect related facts across assets. Read current Intel first and link or update an existing fact instead of publishing a duplicate.",
      },
      clientRequestId: str("Optional idempotency key for this publish."),
    },
    ["observation", "evidence"],
  ),
  intel_update: obj(
    {
      action: {
        type: "string",
        enum: ["comment", "challenge", "revise", "retract"],
        description:
          "comment adds clarification; challenge attaches cited counter-evidence and marks a record disputed without rewriting it; revise updates your own observation and clears a challenge; retract withdraws your own record. Use private todo_write or Feed for hypotheses, misses, absence claims, and route judgments.",
      },
      intelId: str("Target intelId."),
      aboutVersion: {
        type: "integer",
        description: "comment/challenge: version under discussion; defaults to current. A challenge must target the current version.",
      },
      body: str("comment/challenge only (required): a clarification, question, or explanation of cited counter-evidence; does not edit the observation body. Use Feed for hypotheses, misses, absence claims, and route judgments."),
      expectedVersion: {
        type: "integer",
        description: "revise/retract only (required): must match current version.",
      },
      observation: str("revise only: optional replacement fact, asset, capability, or event observed to exist or happen. Retract a record that evidence no longer supports; do not replace it with an absence claim or route exclusion."),
      tags: intelTags("revise only: optional replacement retrieval labels; pass [] to clear them."),
      conditions: str("revise only: optional applicability details for the replacement observation."),
      evidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["artifact", "tool_call", "path"] },
            ref: { type: "string" },
          },
          required: ["kind", "ref"],
          additionalProperties: false,
        },
        description: "comment/revise: evidence refs another member can re-read. challenge requires at least one ref.",
      },
      links: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: {
            intelId: str("Existing Intel fact this observation points to."),
            relation: str("Short free-form directed relation."),
          },
          required: ["intelId", "relation"],
          additionalProperties: false,
        },
        description: "revise only: replacement directed links to existing Intel facts.",
      },
      reason: str("revise/retract only (required): why this change is needed."),
      clientRequestId: str("Optional idempotency key."),
    },
    ["action", "intelId"],
  ),
  intel_read: obj(
    {
      intelId: str("Optional intelId to read current + history; omit to list active summaries."),
      query: str("Optional case-insensitive substring filter when listing summaries; use it before publishing to avoid duplicate facts."),
      tags: intelTags("Optional exact-match label filter when listing; multiple labels use OR semantics.", 4),
      limit: {
        type: "integer",
        description: "Optional maximum summaries to return; the most recently updated matches are retained.",
        minimum: 1,
        maximum: 50,
      },
      includeRetracted: bool("Include retracted rows when listing.", true),
      includeHistory: bool("When reading one intelId, include prior versions. Default false; request history only when needed.", false),
    },
    [],
  ),
  graph_overview: openObj({}),
  graph_query: openObj({
    graph: { type: "string", enum: ["intel", "exploration"] },
    nodeId: str("Read one node by id."),
    nodeIds: { type: "array", items: str("Node id.") },
    kind: str("Filter by one model-authored node kind."),
    kinds: { type: "array", items: str("Model-authored node kind.") },
    state: str("Filter by one node state."),
    states: { type: "array", items: str("Node state.") },
    turnId: str("Filter by Worker turn id."),
    query: str("Case-insensitive text search over kind, summary, and detail."),
    limit: integer("Maximum nodes to return.", 50, 1, 200),
    offset: {
      type: "integer",
      description: "Zero-based pagination offset. Use total and hasMore from the previous response to continue.",
      minimum: 0,
    },
  }),
  intel_record: openObj({
    nodeId: str("Existing Intel node to revise; omit to append a node."),
    kind: str("Concise semantic kind such as asset, identity, dependency, hint, capability, artifact, constraint, or observation."),
    state: str("Model-authored state such as observed, corroborated, inferred, disputed, stale, or retracted."),
    summary: str("Concise reusable fact another Worker can act on."),
    detail: str("Optional conditions, location, reproduction context, or artifact locator."),
    evidence: {
      description: "Optional evidence text or object authored by the Agent.",
      oneOf: [str(), openObj({})],
    },
    authority: str("Optional source or authority, for example observed, platform_hint, or tool_output."),
    notifyRoom: bool("Set true only for a new, evidence-backed positive finding that may change active teammates' decisions. Routine observations, negative results, and wording updates do not need a notice."),
    turnId: str("Optional Worker turn id."),
    links: {
      type: "array",
      items: openObj({
        nodeId: str("Existing Intel or Exploration node id."),
        relation: str("Short directed relation such as runs_on, enables, derived_from, yields, or proves."),
        direction: {
          type: "string",
          enum: ["from", "to"],
          description: "Default from means this node -> nodeId. Use to for nodeId -> this node.",
        },
      }, ["nodeId", "relation"]),
    },
  }),
  exploration_update: openObj({
    nodeId: str("Existing Exploration node to update; omit to append a node."),
    kind: str("Concise semantic kind such as goal, intent, result, receipt, checkpoint, or notice."),
    state: str("Model-authored state such as open, exploring, completed, blocked, accepted, or rejected."),
    summary: str("Concise objective, plan, result, or platform receipt."),
    detail: str("Optional reason, tested conditions, return condition, or artifact locator."),
    evidence: {
      description: "Optional evidence text or object authored by the Agent.",
      oneOf: [str(), openObj({})],
    },
    authority: str("Optional source or authority, for example mission, worker, or platform."),
    turnId: str("Optional Worker turn id; required by the room contract for rotating intent nodes."),
    links: {
      type: "array",
      items: openObj({
        nodeId: str("Existing Intel or Exploration node id."),
        relation: str("Short directed relation such as spawns, continues, supersedes, derived_from, yields, confirms, or proves."),
        direction: {
          type: "string",
          enum: ["from", "to"],
          description: "Default from means this node -> nodeId. Use to for nodeId -> this node.",
        },
      }, ["nodeId", "relation"]),
    },
  }),
  ask_skeptic: empty,
  run_code: obj(
    {
      source: str("JS source. tools.http_request / fs_* / grep_artifacts / room_info / … are in scope. Only the return value and console.log enter context."),
    },
    ["source"],
  ),
  verify_candidate: candidateVerify,
  submit_candidate: candidateSubmit,
  submit_convergence_decision: obj(
    {
      schema: str('Must be "silver.decision-envelope.v1".'),
      decisionId: str("Stable decision id for this generation."),
      expectedGeneration: {
        type: "integer",
        description: "Must match the active convergence generationId.",
        minimum: 1,
      },
      roomId: str("Room id from the Reviewer prompt."),
      challengeId: str("Challenge id from the Reviewer prompt."),
      actorMemberId: str(
        'Solo Reviewer: "system:convergence-reviewer". Room Swarm Lead: "lead".',
      ),
      evidence: {
        type: "array",
        description: "Optional evidence refs; may be empty. Do not invent intel.",
        items: { type: "object", additionalProperties: true },
      },
      rationale: str("Short Host-facing rationale for the recruit/remove decision, or why this turn is a no-op."),
      actions: {
        type: "array",
        minItems: 0,
        description:
          "Strict union of recruit | remove. Empty array is a legal no-op: this turn makes no roster change. Use type, never action, and do not send an open object. recruit requires type, role (lead|worker), requestId. remove requires type, memberId, requestId.",
        items: {
          description: "Exactly one action branch.",
          oneOf: [recruitAction, removeAction],
        },
      },
      createdAt: str("ISO timestamp for this decision."),
    },
    [
      "schema",
      "decisionId",
      "expectedGeneration",
      "roomId",
      "challengeId",
      "actorMemberId",
      "evidence",
      "rationale",
      "actions",
      "createdAt",
    ],
  ),
};
