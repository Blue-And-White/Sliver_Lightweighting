import crypto from "node:crypto";
import type { HostRpcMethod, RpcCapability, RpcScope } from "@silver/protocol";

const METHOD_SCOPES: Record<HostRpcMethod, RpcScope> = {
  room_info: "challenge_info",
  challenge_info: "challenge_info",
  verify_candidate: "verify_candidate",
  submit_candidate: "submit_candidate",
  snapshot: "snapshot",
  intel_read: "intel_read",
  intel_publish: "intel_publish",
  intel_update: "intel_update",
  graph_overview: "graph_overview",
  graph_query: "graph_query",
  intel_record: "intel_record",
  exploration_update: "exploration_update",
  // Hidden legacy aliases keep an already-running pre-migration plugin recoverable.
  intel_comment: "intel_comment",
  intel_revise: "intel_revise",
  intel_retract: "intel_retract",
  ask_skeptic: "ask_skeptic",
  request_hint: "request_hint",
  restart_challenge: "restart_challenge",
  set_room_deadline: "set_room_deadline",
  submit_convergence_decision: "submit_convergence_decision",
  contest_list: "contest_list",
  contest_start: "contest_start",
  queue_target: "queue_target",
  mission_status: "mission_status",
  review_room_allocation: "review_room_allocation",
  record_target_result: "record_target_result",
  resolve_room_request: "resolve_room_request",
  mission_done: "mission_done",
  room_feed_post: "room_feed_post",
  room_feed_read: "room_feed_read",
  room_status_set: "room_status_set",
  room_status_read: "room_status_read",
};

/** Host tools stay usable a few minutes past the room clock. Not a second deadline. */
export const ROOM_CAPABILITY_GRACE_MS = 5 * 60 * 1000;

/**
 * When the room clock is known, it is the lifetime. A 60-minute token stays
 * usable until deadline plus grace. A token cannot outlive that clock.
 * A terminal room is closed immediately. Without a clock, the token exp stands.
 */
export function capabilityCoversRoom(input: {
  exp: number;
  nowMs: number;
  roomDeadlineAtMs?: number;
  roomTerminal?: boolean;
  graceMs?: number;
}): boolean {
  if (input.roomTerminal) return false;
  if (input.roomDeadlineAtMs !== undefined && Number.isFinite(input.roomDeadlineAtMs)) {
    const grace = input.graceMs ?? ROOM_CAPABILITY_GRACE_MS;
    return input.nowMs <= input.roomDeadlineAtMs + grace;
  }
  return input.exp >= input.nowMs;
}

export function capabilityTtlForRoom(input: { roomDeadlineAtMs: number; nowMs?: number; graceMs?: number }): number {
  const now = input.nowMs ?? Date.now();
  const grace = input.graceMs ?? ROOM_CAPABILITY_GRACE_MS;
  return Math.max(1_000, input.roomDeadlineAtMs + grace - now);
}

/** An unbounded room still needs a finite RPC token for the capability schema. */
export function capabilityTtlForUnboundedRoom(nowMs = Date.now()): number {
  return Math.max(1_000, Number.MAX_SAFE_INTEGER - nowMs - 60_000);
}

export class CapabilityGate {
  private readonly secret: Buffer;

  constructor(secret: Buffer) {
    this.secret = secret;
  }

  mint(claims: RpcCapability): string {
    const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const mac = crypto.createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  /** MAC check only. Expiry is decided with the room clock in inspect/authorize. */
  read(token: string): RpcCapability {
    const [body, mac] = token.split(".");
    if (!body || !mac) throw new Error("invalid capability");
    const expectedMac = crypto.createHmac("sha256", this.secret).update(body).digest("base64url");
    const left = crypto.createHash("sha256").update(mac).digest();
    const right = crypto.createHash("sha256").update(expectedMac).digest();
    if (!crypto.timingSafeEqual(left, right)) {
      throw new Error("capability mac mismatch");
    }
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RpcCapability;
  }

  inspect(
    token: string,
    opts?: { nowMs?: number; roomDeadlineAtMs?: number; roomTerminal?: boolean },
  ): RpcCapability {
    const claims = this.read(token);
    const nowMs = opts?.nowMs ?? Date.now();
    if (
      !capabilityCoversRoom({
        exp: claims.exp,
        nowMs,
        ...(opts?.roomDeadlineAtMs !== undefined ? { roomDeadlineAtMs: opts.roomDeadlineAtMs } : {}),
        ...(opts?.roomTerminal ? { roomTerminal: true } : {}),
      })
    ) {
      throw new Error("capability expired");
    }
    return claims;
  }

  authorize(
    token: string,
    method: HostRpcMethod,
    expected: { challengeId: string; containerId: string; attemptId: string; generation: number },
    opts?: { nowMs?: number; roomDeadlineAtMs?: number; roomTerminal?: boolean },
  ): RpcCapability {
    const claims = this.inspect(token, opts);
    if (claims.challengeId !== expected.challengeId) throw new Error("capability challenge scope mismatch");
    if (claims.containerId !== expected.containerId) throw new Error("capability container scope mismatch");
    if (claims.attemptId !== expected.attemptId) throw new Error("capability attempt scope mismatch");
    if (claims.generation !== expected.generation) throw new Error("capability generation mismatch");
    const needed = METHOD_SCOPES[method];
    if (!claims.scopes.includes(needed)) throw new Error(`capability missing scope ${needed}`);
    return claims;
  }
}

export function randomCapabilitySecret(): Buffer {
  return crypto.randomBytes(32);
}
