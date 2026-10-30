import type { FlagPolicy, TrackKind } from "@silver/protocol";
import type { CookieJar } from "./cookie-jar.ts";

export type Presentation = "native" | "code" | "both";
export type ToolPreset = "solver" | "commander" | "internal";
export type { TrackKind };

export interface HttpBaseline {
  locator: string;
  status: number;
  length: number;
  hash: string;
  headers: Record<string, string>;
}

export interface ToolResult {
  ok: boolean;
  data: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
  challengeId: string;
  attemptId: string;
  host: HostBridge;
  presentation: Presentation;
  httpBaseline: Map<string, HttpBaseline>;
  terminals: import("./terminal.ts").TerminalHub;
  session?: { append(type: string, payload: Record<string, unknown>): void; events(): SessionEvent[] };
  flagPolicy: FlagPolicy;
  cookies: CookieJar;
  track: TrackKind;
  toolsPreset?: ToolPreset;
  targetUrl?: string;
  inScopeUrls?: string[];
  inScopeAgentUrls?: string[];
  onToolResult?: (name: string, args: Record<string, unknown>, result: ToolResult) => void;
}

export interface HostBridge {
  invoke(
    method:
      | "room_info"
      | "challenge_info"
      | "verify_candidate"
      | "submit_candidate"
      | "intel_read"
      | "intel_publish"
      | "intel_update"
      | "graph_overview"
      | "graph_query"
      | "intel_record"
      | "exploration_update"
      // Hidden legacy RPC aliases for an already-running pre-migration plugin.
      | "intel_comment"
      | "intel_revise"
      | "intel_retract"
      | "ask_skeptic"
      | "request_hint"
      | "restart_challenge"
      | "contest_list"
      | "contest_start"
      | "queue_target"
      | "mission_status"
      | "review_room_allocation"
      | "record_target_result"
      | "resolve_room_request"
      | "mission_done"
      | "room_feed_post"
      | "room_feed_read"
      | "room_status_set"
      | "room_status_read",
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  /** Exact-one union. At least two branches. Nested objects stay closed when they set additionalProperties false. */
  oneOf?: JsonSchema[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface SessionEvent {
  ts: string;
  type: string;
  payload: Record<string, unknown>;
}
