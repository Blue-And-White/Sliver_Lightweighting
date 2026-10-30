import { grepArtifacts, readBoundedArtifact } from "./artifacts.ts";
import { hostChannel } from "./host-channel.ts";
import { currentNativeSessionRpc } from "./native-session.ts";
import { fsGrep, fsList, fsRead, fsWrite } from "./fs-workspace.ts";
import { httpRequest } from "./http.ts";
import { notebookRead, notebookWrite } from "./notebook.ts";
import { runCode } from "./run-code.ts";
import { terminalClose, terminalList, terminalOpen, terminalRead, terminalSend } from "./terminal.ts";
import { TOOL_SCHEMAS } from "./tool-schemas.ts";
import { officialDecisionProof, parseDecisionEnvelope, type TrackKind } from "@silver/protocol";
import { isRoomDomain, type RoomDomain } from "./persona.ts";
import type { JsonSchema, Presentation, ToolContext, ToolDefinition, ToolPreset, ToolResult } from "./types.ts";
import fs from "node:fs";
import path from "node:path";

/** Silver-owned room kernel. Domain work stays on official DSH tools. */
export const SILVER_ROOM_CORE_TOOLS = [
  "room_info",
  "read_artifact",
  "grep_artifacts",
] as const;

/** Convergence Reviewer — structured decision only. Enabled when SILVER_CONVERGENCE_REVIEWER=1. */
export const SILVER_CONVERGENCE_REVIEWER_TOOLS = ["submit_convergence_decision"] as const;

/** C6 Room Swarm Lead — same submit tool alongside member tools when SILVER_ROOM_SWARM=1. */
export const SILVER_ROOM_SWARM_LEAD_TOOLS = ["submit_convergence_decision"] as const;

/** Shared asynchronous Room Feed/Status surfaces. */
export const SILVER_SWARM_ROOM_TOOLS = [
  "room_feed_post",
  "room_feed_read",
  "room_status_set",
] as const;

/** Public intel v2 — default Solver surface (not internal-only). */
export const SILVER_PUBLIC_INTEL_TOOLS = [
  "intel_publish",
  "intel_read",
  "intel_update",
] as const;

/** Dual-graph room surface used by the Three-Graph collaboration runtime. */
export const SILVER_ROOM_GRAPH_TOOLS = [
  "graph_overview",
  "graph_query",
  "intel_record",
  "exploration_update",
] as const;

/** Silver-owned Mission Commander control tools. */
export const SILVER_COMMANDER_TOOLS = [
  "contest_list",
  "contest_start",
  "queue_target",
  "mission_status",
  "review_room_allocation",
  "record_target_result",
  "resolve_room_request",
  "mission_done",
] as const;

/** Native assistants may investigate, but the parent owns shared state and platform actions. */
export const SILVER_ASSISTANT_DENY_TOOLS = [
  "subagent",
  "intel_publish",
  "intel_update",
  "intel_record",
  "exploration_update",
  "room_feed_post",
  "room_status_set",
  "submit_convergence_decision",
  "request_hint",
  "restart_challenge",
  "verify_candidate",
  "submit_candidate",
  ...SILVER_COMMANDER_TOOLS,
] as const;

/** Generic DSH tools admitted for Commander Mission and platform work. */
export const COMMANDER_GENERIC_DISCOVERY_TOOLS = [
  "bash",
  "read",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
] as const;

/** Complete model-visible Commander surface: Host control plus generic discovery. */
export const COMMANDER_TOOL_ALLOWLIST = [
  ...SILVER_COMMANDER_TOOLS,
  ...COMMANDER_GENERIC_DISCOVERY_TOOLS,
] as const;

export interface RoomAcceptanceContract {
  kind: RoomDomain;
  success: string;
}

/** Pure-data room contract selected by the upstream entry. */
export interface RoomAssembly {
  domain: RoomDomain;
  /** True only when the upstream entry selected the official Team runtime. */
  formalTeam: boolean;
  persona: string;
  acceptanceContract: RoomAcceptanceContract;
}

/** Host-side structural validation. It does not choose a domain or persona. */
export function requireRoomAssembly(value: unknown): RoomAssembly {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("room assembly is required");
  }
  const row = value as Partial<RoomAssembly>;
  if (!isRoomDomain(row.domain)) {
    throw new Error("room assembly domain is invalid");
  }
  if (typeof row.formalTeam !== "boolean") {
    throw new Error("room assembly formalTeam must be explicit");
  }
  if (typeof row.persona !== "string" || !row.persona.trim()) {
    throw new Error("room assembly persona is required");
  }
  const acceptance = row.acceptanceContract as Partial<RoomAcceptanceContract> | undefined;
  if (
    !acceptance ||
    acceptance.kind !== row.domain ||
    typeof acceptance.success !== "string" ||
    !acceptance.success.trim()
  ) {
    throw new Error("room assembly acceptance contract is required");
  }
  return {
    domain: row.domain,
    formalTeam: row.formalTeam,
    persona: row.persona,
    acceptanceContract: {
      kind: acceptance.kind,
      success: acceptance.success,
    },
  };
}

export function solverDomain(track?: TrackKind, domain?: RoomDomain): RoomDomain {
  if (isRoomDomain(domain)) return domain;
  if (isAwdTrack(track)) return "awd";
  if (track === "pentest" || track === "koh" || track === "vuln") return track;
  return "ctf";
}

/** Compatibility/internal HTTP capture. Default live solver uses official DSH bash/curl. */
export const SILVER_HTTP_LEAVES = ["http_request"] as const;

/**
 * Persistent IAT leftover. Not on the HostFs solver (DSH bash is the shell).
 * Internal compatibility tests can opt in with `SILVER_ENABLE_IAT=1`.
 * Solver presets never expose these through official DSH.
 */
export const SILVER_IAT_LEAVES = [
  "terminal_open",
  "terminal_send",
  "terminal_read",
  "terminal_close",
  "terminal_list",
] as const;

/** Implemented leftover. Not DSH-registered for the default solver; use DSH read/write/edit/grep/glob. */
export const SILVER_FS_LEAVES = ["fs_read", "fs_write", "fs_list", "fs_grep"] as const;

export const SILVER_GENERIC_LEAVES = [...SILVER_FS_LEAVES, ...SILVER_IAT_LEAVES] as const;

export function iatLeavesEnabled(opts?: { iat?: boolean }): boolean {
  if (opts?.iat !== undefined) return opts.iat;
  return process.env.SILVER_ENABLE_IAT === "1";
}

export function hintLeavesEnabled(opts?: { hint?: boolean }): boolean {
  if (opts?.hint !== undefined) return opts.hint;
  return process.env.SILVER_HINT_POLICY === "open" || process.env.SILVER_HINTS_ENABLED === "1";
}

export function contestSubmitEnabled(opts?: { contestSubmit?: boolean }): boolean {
  if (opts?.contestSubmit !== undefined) return opts.contestSubmit;
  return process.env.SILVER_CONTEST_SUBMIT === "1";
}

export function contestVerifyEnabled(opts?: { contestVerify?: boolean }): boolean {
  if (opts?.contestVerify !== undefined) return opts.contestVerify;
  return process.env.SILVER_CONTEST_VERIFY === "1";
}

export function contestRestartEnabled(opts?: { contestRestart?: boolean }): boolean {
  if (opts?.contestRestart !== undefined) return opts.contestRestart;
  return process.env.SILVER_CONTEST_RESTART === "1";
}

const INTERNAL_TOOLS = new Set([
  "notebook_write",
  "notebook_read",
  "ask_skeptic",
]);

export function isAwdTrack(track?: TrackKind): boolean {
  return track === "awd" || track === "agent-awd";
}

export function swarmRoomToolsEnabled(opts?: { swarmRoom?: boolean }): boolean {
  if (opts?.swarmRoom !== undefined) return opts.swarmRoom;
  return process.env.SILVER_SWARM_ROOM === "1";
}

export function convergenceReviewerToolsEnabled(opts?: { convergenceReviewer?: boolean }): boolean {
  if (opts?.convergenceReviewer !== undefined) return opts.convergenceReviewer;
  return process.env.SILVER_CONVERGENCE_REVIEWER === "1";
}

export function roomSwarmLeadToolsEnabled(opts?: { roomSwarm?: boolean }): boolean {
  if (opts?.roomSwarm !== undefined) return opts.roomSwarm;
  return process.env.SILVER_ROOM_SWARM === "1";
}

export function roomGraphToolsEnabled(opts?: { roomGraph?: boolean }): boolean {
  if (opts?.roomGraph !== undefined) return opts.roomGraph;
  return process.env.SILVER_ROOM_GRAPH === "1";
}

export function toolsVisible(
  _presentation: Presentation,
  track: TrackKind = "jeopardy",
  preset: ToolPreset = "solver",
  opts?: {
    iat?: boolean;
    hint?: boolean;
    swarmRoom?: boolean;
    roomSwarm?: boolean;
    convergenceReviewer?: boolean;
    roomGraph?: boolean;
    domain?: RoomDomain;
    contestSubmit?: boolean;
    contestVerify?: boolean;
    contestRestart?: boolean;
  },
): Set<string> {
  if (convergenceReviewerToolsEnabled(opts)) {
    return new Set(SILVER_CONVERGENCE_REVIEWER_TOOLS);
  }
  if (preset === "commander") return new Set(SILVER_COMMANDER_TOOLS);
  const exposeIat = preset === "internal" && iatLeavesEnabled(opts);
  const roomGraph = roomGraphToolsEnabled(opts);
  const native = new Set<string>([
    ...SILVER_ROOM_CORE_TOOLS,
    ...(roomGraph ? SILVER_ROOM_GRAPH_TOOLS : SILVER_PUBLIC_INTEL_TOOLS),
    ...(solverDomain(track, opts?.domain) === "ctf" && contestVerifyEnabled(opts)
      ? ["verify_candidate"]
      : []),
    ...(solverDomain(track, opts?.domain) === "ctf" && contestSubmitEnabled(opts)
      ? ["submit_candidate"]
      : []),
    ...(solverDomain(track, opts?.domain) === "ctf" && hintLeavesEnabled(opts)
      ? ["request_hint"]
      : []),
    ...(solverDomain(track, opts?.domain) === "ctf" && contestRestartEnabled(opts)
      ? ["restart_challenge"]
      : []),
    ...(swarmRoomToolsEnabled(opts) ? SILVER_SWARM_ROOM_TOOLS : []),
    ...(roomSwarmLeadToolsEnabled(opts) ? SILVER_ROOM_SWARM_LEAD_TOOLS : []),
    ...(exposeIat ? SILVER_IAT_LEAVES : []),
  ]);
  const solver = native;
  const base = preset === "internal" ? new Set([...solver, ...SILVER_HTTP_LEAVES, ...INTERNAL_TOOLS]) : solver;
  return new Set(base);
}

async function readArtifact(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const read = readBoundedArtifact(
    ctx,
    String(args.locator ?? ""),
    Number(args.offset ?? 0),
    Number(args.maxBytes ?? 8192),
  );
  if (!read.ok) return { ok: false, data: { error: read.error } };
  return { ok: true, data: read };
}

/** Structured convergence submit — Reviewer (solo) or Room Swarm Lead; Host-owned path only. */
function submitConvergenceDecision(args: Record<string, unknown>, _ctx: ToolContext): ToolResult {
  const reviewer = process.env.SILVER_CONVERGENCE_REVIEWER === "1";
  const swarmLead = process.env.SILVER_ROOM_SWARM === "1";
  if (!reviewer && !swarmLead) {
    return {
      ok: false,
      data: { error: "submit_convergence_decision is only available to Convergence Reviewer or Room Swarm Lead" },
    };
  }
  const dest = hostChannel().submitPath?.trim();
  if (!dest) {
    return { ok: false, data: { error: "SILVER_CONVERGENCE_SUBMIT_PATH is not configured" } };
  }
  if (args.schema !== "silver.decision-envelope.v1") {
    return { ok: false, data: { error: 'schema must be "silver.decision-envelope.v1"' } };
  }
  if (typeof args.decisionId !== "string" || !args.decisionId.trim()) {
    return { ok: false, data: { error: "decisionId is required" } };
  }
  const session = currentNativeSessionRpc();
  const actor = typeof args.actorMemberId === "string" ? args.actorMemberId : "";
  const probe = process.env.SILVER_TEAM_IDENTITY_PROBE === "1";
  const envelope: Record<string, unknown> = { ...args };
  if (reviewer) {
    if (actor !== "system:convergence-reviewer") {
      return { ok: false, data: { error: 'actorMemberId must be "system:convergence-reviewer"' } };
    }
  } else if (probe || session) {
    if (!session || session.parentSessionId) {
      return {
        ok: false,
        data: { error: "Only the Lead session can submit a convergence decision. A worker cannot supply actorMemberId." },
      };
    }
    envelope.actorMemberId = "lead";
    if (probe) {
      const capability = hostChannel().capability;
      if (!capability) {
        return { ok: false, data: { error: "official team lead principal is not available" } };
      }
      envelope.principalSessionId = session.sessionId;
      try {
        envelope.principalProof = officialDecisionProof(capability, { sessionId: session.sessionId }, envelope);
      } catch (err) {
        return { ok: false, data: { error: err instanceof Error ? err.message : String(err) } };
      }
    }
  } else if (actor !== "lead") {
    return { ok: false, data: { error: 'actorMemberId must be "lead" for Room Swarm Lead decisions' } };
  }
  if (!Array.isArray(envelope.actions)) {
    return { ok: false, data: { error: "actions must be an array" } };
  }
  try {
    parseDecisionEnvelope(envelope);
  } catch (err) {
    return { ok: false, data: { error: err instanceof Error ? err.message : String(err) } };
  }
  const abs = path.resolve(dest);
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.submit-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(envelope)}\n`, "utf8");
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return { ok: false, data: { error: err instanceof Error ? err.message : String(err) } };
  }
  return {
    ok: true,
    data: {
      submitted: true,
      decisionId: args.decisionId,
      note: "Host will apply this envelope; end your turn.",
    },
  };
}

async function grep(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { ok: false, data: { error: "pattern required" } };
  return { ok: true, data: grepArtifacts(ctx, pattern) };
}

function schema(name: string): JsonSchema {
  const found = TOOL_SCHEMAS[name];
  if (!found) throw new Error(`missing JSON schema for tool ${name}`);
  return found;
}

export const tools: ToolDefinition[] = [
  {
    name: "contest_list",
    description:
      "Commander-only: read the contest platform's authoritative challenge list, completion counts, container state, and current target addresses.",
    parameters: schema("contest_list"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("contest_list", args) };
    },
  },
  {
    name: "contest_start",
    description:
      "Commander-only: start one exact challenge returned by contest_list and obtain its current target address. Use queue_target separately to create its Room.",
    parameters: schema("contest_start"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("contest_start", args) };
    },
  },
  {
    name: "queue_target",
    description:
      "Commander-only: create one Room from the current challenge endpoint. A previously closed challenge must be reopened with contest_start first. Pass a complete childMission. This tool does not call an external platform.",
    parameters: schema("queue_target"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("queue_target", args) };
    },
  },
  {
    name: "mission_status",
    description: "Commander-only: read Host-authoritative active, queued, and settled room work.",
    parameters: schema("mission_status"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("mission_status", args) };
    },
  },
  {
    name: "review_room_allocation",
    description:
      "Commander-only: at a Host soft checkpoint, continue the active Room or defer its current allocation and release its platform slot. The Room keeps its durable graphs for a later retry. This does not choose a technical route.",
    parameters: schema("review_room_allocation"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("review_room_allocation", args) };
    },
  },
  {
    name: "record_target_result",
    description:
      "Commander-only: reconcile the latest active candidate report or finished Worker attempt with a fresh platform observation. completed closes an active room; pending continues the same room. This never submits a candidate.",
    parameters: schema("record_target_result"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("record_target_result", args) };
    },
  },
  {
    name: "resolve_room_request",
    description:
      "Commander-only: answer a live Room Lead's natural-language request after observing or performing an authorized external control or query action. Return external facts and actions only. continue keeps the same attempt and deadline; defer ends that attempt so another target can use the slot.",
    parameters: schema("resolve_room_request"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("resolve_room_request", args) };
    },
  },
  {
    name: "mission_done",
    description:
      "Commander-only: after a fresh Mission-defined platform reconciliation and no active work, declare the factual terminal outcome. An open platform with any incomplete eligible target is not terminal.",
    parameters: schema("mission_done"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("mission_done", args) };
    },
  },
  {
    name: "room_info",
    description:
      "Read the current child task and material contract, authorized endpoints, member state, unread shared-state indexes, and mounted capabilities.",
    parameters: schema("room_info"),
    async execute(args, ctx) {
      const permitId = typeof args.permitId === "string" ? args.permitId.trim() : "";
      const payload: Record<string, unknown> = {};
      if (permitId) payload.permitId = permitId;
      if (args.includeTaskMaterial === true) payload.includeTaskMaterial = true;
      return { ok: true, data: await ctx.host.invoke("room_info", payload) };
    },
  },
  {
    name: "submit_convergence_decision",
    description:
      "Convergence Reviewer or Room Swarm Lead: submit exactly one DecisionEnvelope for the claimed generation. Do not invent evidence.",
    parameters: schema("submit_convergence_decision"),
    execute: async (args, ctx) => submitConvergenceDecision(args, ctx),
  },
  {
    name: "http_request",
    description:
      "Compatibility/internal HTTP capture. Default live solver should use official DSH bash with curl/httpie/wget. This leaf stores the full HTTP exchange and returns status, headers, length, hash, timing, locator, diff, and bounded preview.",
    parameters: schema("http_request"),
    execute: httpRequest,
  },
  {
    name: "read_artifact",
    description: "Read a spilled artifact by locator. Default maxBytes=8192. Prefer grep_artifacts.",
    parameters: schema("read_artifact"),
    execute: readArtifact,
  },
  {
    name: "grep_artifacts",
    description: "Literal substring search over this attempt's artifacts. Returns locator+line hits, not whole files.",
    parameters: schema("grep_artifacts"),
    execute: grep,
  },
  {
    name: "terminal_open",
    description:
      "Open a persistent IAT session (gdb, nc, python, ./vuln). argv is a string array, no shell. cwd jailed to the attempt. Output spills to an artifact.",
    parameters: schema("terminal_open"),
    execute: terminalOpen,
  },
  {
    name: "terminal_send",
    description: "Write to a live IAT session stdin. newline defaults true.",
    parameters: schema("terminal_send"),
    execute: terminalSend,
  },
  {
    name: "terminal_read",
    description:
      "Drain IAT output. Default: wait waitMs, then keep collecting until idleMs quiet (100ms) or exit. expect/until keeps reading until that substring. PTY echo is not the program reply. Bounded tail plus locator.",
    parameters: schema("terminal_read"),
    execute: terminalRead,
  },
  {
    name: "terminal_close",
    description: "SIGTERM then SIGKILL a session.",
    parameters: schema("terminal_close"),
    execute: terminalClose,
  },
  {
    name: "terminal_list",
    description: "List IAT sessions for this attempt.",
    parameters: schema("terminal_list"),
    execute: terminalList,
  },
  {
    name: "fs_read",
    description: "Read a file under the attempt cwd. Symlinks rejected.",
    parameters: schema("fs_read"),
    async execute(args, ctx) {
      return fsRead(args, ctx);
    },
  },
  {
    name: "fs_write",
    description: "Write a file under the attempt cwd.",
    parameters: schema("fs_write"),
    async execute(args, ctx) {
      return fsWrite(args, ctx);
    },
  },
  {
    name: "fs_list",
    description: "List a directory under the attempt cwd.",
    parameters: schema("fs_list"),
    async execute(args, ctx) {
      return fsList(args, ctx);
    },
  },
  {
    name: "fs_grep",
    description: "Literal substring search under the attempt cwd. Symlinks skipped. Not a shell grep.",
    parameters: schema("fs_grep"),
    async execute(args, ctx) {
      return fsGrep(args, ctx);
    },
  },
  {
    name: "notebook_write",
    description:
      "Private Attempt Notebook. facts requires artifact_ref. local_prune may record misses for THIS attempt only. Not a global nogood and not a promote channel.",
    parameters: schema("notebook_write"),
    async execute(args, ctx) {
      return notebookWrite(args, ctx);
    },
  },
  {
    name: "notebook_read",
    description: "Read this attempt's private notebook. Sibling notebooks are invisible.",
    parameters: schema("notebook_read"),
    async execute(args, ctx) {
      return notebookRead(args, ctx);
    },
  },
  {
    name: "intel_publish",
    description:
      "Publish one cited, reviewable fact, asset, capability, or event observed to exist or happen. Include evidence another member can re-read (artifact, tool call, or path). It remains unread for the whole Room; resident members get a no-wake marker for their next normal step and decide relevance themselves. Use official DSH send_message only for prompt coordination with a directly affected peer. Put misses, absence claims, failed hypotheses, route exclusions, and discussion in private todo_write or Feed. Host records author/version. Success means saved — not a platform verdict.",
    parameters: schema("intel_publish"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("intel_publish", args) };
    },
  },
  {
    name: "intel_update",
    description:
      "Update one public Intel record. action=comment adds clarification; action=challenge attaches cited counter-evidence and marks it disputed without rewriting it; action=revise updates your own fact and clears a challenge; action=retract withdraws your own record. Do not replace it with an absence claim or route exclusion. Host stores authorship, versions, evidence, and status but does not decide which interpretation is true.",
    parameters: schema("intel_update"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("intel_update", args) };
    },
  },
  {
    name: "room_feed_post",
    description:
      "Post a question, challenge, help request, decision, or handoff to the Room's pull-first Feed. Posting does not wake recipients; use official DSH send_message for urgent or relevant targeted coordination. Publish reusable observations with intel_publish and current focus with room_status_set. Feed is not a platform verdict or a route ban.",
    parameters: schema("room_feed_post"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("room_feed_post", args) };
    },
  },
  {
    name: "room_feed_read",
    description:
      "Pull Project Room Feed history on demand, including when room_info.projectRoom.feed.unreadCount is 0. Reading by messageId acknowledges only that post. Query or unfiltered history browsing does not change unread state. For sequential pull and ack, start with afterSeq=0, then use the last returned seq.",
    parameters: schema("room_feed_read"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("room_feed_read", args) };
    },
  },
  {
    name: "room_status_set",
    description:
      "Set this member's one-line approach on the Room status cards. Does not assign work or lock a route.",
    parameters: schema("room_status_set"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("room_status_set", args) };
    },
  },
  {
    name: "room_status_read",
    description:
      "Read Project status cards (one-line approach per independent Group). Host facts plus optional self-report.",
    parameters: schema("room_status_read"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("room_status_read", args) };
    },
  },
  {
    name: "intel_read",
    description:
      "On-demand read of room public intel. Omit intelId to list active summaries; pass intelId for current/history. Marks your read receipt for change notices. Weak prior only — re-check before use.",
    parameters: schema("intel_read"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("intel_read", args) };
    },
  },
  {
    name: "graph_overview",
    description:
      "Read the room-wide mechanical index of the Intel and Exploration graphs: complete counts, Mission goals, platform receipts, high-signal Intel, every current active intent, recent views, and their links. Then choose focused or paged graph_query reads yourself; Runtime does not summarize or judge technical meaning.",
    parameters: schema("graph_overview"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("graph_overview", args) };
    },
  },
  {
    name: "graph_query",
    description:
      "Read any focused slice or page through the Intel/Exploration graphs by graph, kind, state, turn, id, or text. Responses include total, offset, limit, and hasMore so you may inspect a focused route or page the complete history when your decision requires it.",
    parameters: schema("graph_query"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("graph_query", args) };
    },
  },
  {
    name: "intel_record",
    description:
      "Append or revise one concise reusable Intel node authored from your judgment: inputs, resources, identities, dependencies, constraints, capabilities, artifacts, or observations. Link new Intel to the Exploration result or Intent that produced it. Host stores what you write and does not infer facts from output.",
    parameters: schema("intel_record"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("intel_record", args) };
    },
  },
  {
    name: "exploration_update",
    description:
      "Append or revise one concise Exploration node authored from your judgment: goal, intent, result, receipt, checkpoint, or notice. Use links for spawns/continues/supersedes/derived_from/yields/proves relationships. Host stores state and relationships without judging the route.",
    parameters: schema("exploration_update"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("exploration_update", args) };
    },
  },
  {
    name: "ask_skeptic",
    description:
      "Ask a short-lived skeptic for untrusted questions (missing surfaces, chain gaps, cheap checks). It cannot submit, promote, or declare a path dead.",
    parameters: schema("ask_skeptic"),
    async execute(_args, ctx) {
      return { ok: true, data: await ctx.host.invoke("ask_skeptic", {}) };
    },
  },
  {
    name: "run_code",
    description:
      "Code-mode SDK. tools.http_request/read_artifact/grep_artifacts/fs_*/room_info/terminal_*. Only the return value and console.log enter context. Bodies stay in artifacts/variables.",
    parameters: schema("run_code"),
    execute: runCode,
  },
  {
    name: "request_hint",
    description:
      "Contest hint adapter. Mounted only when this contest contract declares a hint capability. Host holds the platform credential and returns the hint. The child mission states when to call it. Not a submit and not a universal hint protocol.",
    parameters: schema("request_hint"),
    async execute(_args, ctx) {
      return { ok: true, data: await ctx.host.invoke("request_hint", {}) };
    },
  },
  {
    name: "restart_challenge",
    description:
      "Emergency lifecycle control for this assigned challenge. A timeout on a discovered non-entry service alone does not prove the challenge environment is broken. Retry a bounded check and confirm the platform entry is unavailable or the environment is materially corrupted before requesting a restart. Host may reject stale or repeated requests; when it restarts a three-graph Room, Host records and broadcasts the reset. Stop old bulk jobs on an affected service, revalidate stale relays, then check health there at low rate before new bulk traffic. Keep one bulk-probe owner there while unstable; normal targeted tests and work on other healthy services continue at normal pace. If the same symptom persists, stop bulk traffic there instead of repeating the restart cycle. This tool does not complete the Room or choose an attack route.",
    parameters: schema("restart_challenge"),
    async execute(_args, ctx) {
      return { ok: true, data: await ctx.host.invoke("restart_challenge", {}) };
    },
  },
  {
    name: "verify_candidate",
    description:
      "Optional contest verification adapter. Mounted only when this contest adapter explicitly provides verify(). Pass the exact raw candidate; candidate_id and artifact_ref remain compatibility metadata for local test modes.",
    parameters: schema("verify_candidate"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("verify_candidate", args) };
    },
  },
  {
    name: "submit_candidate",
    description:
      "CTF acceptance adapter for this contest contract. Send the exact raw candidate immediately. If verify_candidate is mounted, it is a separate optional adapter capability; submission does not depend on it. New candidates reach the platform adapter. For the same candidate already accepted by this challenge, Host returns the prior accepted verdict with alreadyAccepted=true, submittedNow=false, and newlyAccepted=false; duplicate here does not mean an incorrect flag or a failed route. One newly accepted flag is progress. The room ends only when the platform marks the task completed. In candidate-report compatibility mode Host may still require a verified record.",
    parameters: schema("submit_candidate"),
    async execute(args, ctx) {
      return { ok: true, data: await ctx.host.invoke("submit_candidate", args) };
    },
  },
];

export function llmToolSpecs(
  presentation: Presentation,
  track: TrackKind = "jeopardy",
  preset: ToolPreset = "solver",
  opts?: {
    iat?: boolean;
    hint?: boolean;
    contestSubmit?: boolean;
    contestVerify?: boolean;
    contestRestart?: boolean;
    roomGraph?: boolean;
    domain?: RoomDomain;
  },
): Array<{
  name: string;
  description: string;
  parameters: JsonSchema;
}> {
  const visible = toolsVisible(presentation, track, preset, opts);
  return tools
    .filter((tool) => visible.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

export function getTool(
  name: string,
  presentation: Presentation = "both",
  track: TrackKind = "jeopardy",
  preset: ToolPreset = "solver",
): ToolDefinition | undefined {
  // Leftover http_request / fs_* / IAT stay callable from direct compatibility
  // paths without entering the live DSH surface.
  // Official DSH apply() only registers Host contract tools on live solvers;
  // DSH bash/read/write/edit/grep/glob provide the generic surface.
  const leftover = new Set<string>([
    ...SILVER_FS_LEAVES,
    // Direct fixture/runtime compatibility only. apply() never registers these
    // on a live Commander or Room model surface.
    "verify_candidate",
    "submit_candidate",
    "request_hint",
    "restart_challenge",
  ]);
  if (presentation !== "code") {
    for (const leaf of SILVER_HTTP_LEAVES) leftover.add(leaf);
    for (const leaf of SILVER_IAT_LEAVES) leftover.add(leaf);
  }
  if (presentation === "code") leftover.add("run_code");
  if (!toolsVisible(presentation, track, preset).has(name) && !leftover.has(name)) {
    return undefined;
  }
  return tools.find((t) => t.name === name);
}
