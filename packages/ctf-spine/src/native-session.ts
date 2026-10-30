/**
 * ToolExecution reader for official Team calls.
 * agent.id, session.id, and header.id must be the same non-empty string.
 * Prompt text, teammate names, and model tool arguments are not this attribution.
 * The Host authorizes the RPC only when the plugin seals this session with the
 * capability it removed from the process environment.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeSessionRpcMeta } from "@silver/protocol";

export type NativeSessionIdentity = {
  sessionId: string;
  parentSessionId?: string;
};

type IdentityExec = {
  agent?: {
    id?: unknown;
    session?: {
      id?: unknown;
      header?: { id?: unknown; parentSession?: unknown };
    };
  };
};

const nativeSessionRpc = new AsyncLocalStorage<NativeSessionRpcMeta>();

const OFFICIAL_TEAM_HOST_TOOLS = new Set([
  "room_info",
  "challenge_info",
  "intel_publish",
  "intel_read",
  "intel_update",
  "graph_overview",
  "graph_query",
  "intel_record",
  "exploration_update",
  "restart_challenge",
  "room_feed_post",
  "room_feed_read",
  "room_status_set",
  "room_status_read",
]);

export function isOfficialTeamHostTool(name: string): boolean {
  return OFFICIAL_TEAM_HOST_TOOLS.has(name);
}

/** Attribution attached by a normal ctf-spine tool call. Absent on the production swarm path. */
export function currentNativeSessionRpc(): NativeSessionRpcMeta | undefined {
  return nativeSessionRpc.getStore();
}

export function runWithNativeSession<T>(identity: NativeSessionIdentity, fn: () => Promise<T>): Promise<T> {
  return nativeSessionRpc.run(nativeSessionRpcMeta(identity), fn);
}

export function nativeSessionRpcMeta(identity: NativeSessionIdentity): NativeSessionRpcMeta {
  return {
    sessionId: identity.sessionId,
    ...(identity.parentSessionId ? { parentSessionId: identity.parentSessionId } : {}),
  };
}

export function readNativeSessionIdentity(
  exec: unknown,
): { ok: true; identity: NativeSessionIdentity } | { ok: false; evidence: string } {
  const evidence = describeNativeSession(exec);
  const agent = (exec as IdentityExec | null)?.agent;
  const agentId = stringId(agent?.id);
  const sessionId = stringId(agent?.session?.id);
  const headerId = stringId(agent?.session?.header?.id);
  if (!agentId || !sessionId || !headerId) {
    return { ok: false, evidence: `native session identity missing (${evidence})` };
  }
  if (agentId !== sessionId || sessionId !== headerId) {
    return { ok: false, evidence: `native session identity disagreed (${evidence})` };
  }
  const parent = agent?.session?.header?.parentSession;
  if (parent != null && parent !== "" && typeof parent !== "string") {
    return { ok: false, evidence: `native session identity disagreed (${evidence})` };
  }
  const parentSessionId = typeof parent === "string" && parent.trim() ? parent.trim() : undefined;
  if (parentSessionId === agentId) {
    return { ok: false, evidence: `native session identity disagreed (${evidence})` };
  }
  return {
    ok: true,
    identity: {
      sessionId: agentId,
      ...(parentSessionId ? { parentSessionId } : {}),
    },
  };
}

function stringId(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function describeNativeSession(exec: unknown): string {
  if (!exec || typeof exec !== "object") return "exec missing";
  const agent = (exec as IdentityExec).agent;
  if (!agent || typeof agent !== "object") return "exec.agent missing";
  const session = agent.session;
  const header = session?.header;
  return [
    `agent.id=${shown(agent.id)}`,
    `session.id=${shown(session?.id)}`,
    `header.id=${shown(header?.id)}`,
    `header.parentSession=${shown(header?.parentSession)}`,
  ].join(" ");
}

function shown(value: unknown): string {
  if (typeof value === "string") return value.trim() ? JSON.stringify(value) : "empty";
  if (value == null) return "missing";
  return typeof value;
}
