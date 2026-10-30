/**
 * Structural DecisionEnvelope parser shared by the submit tool and C3 apply.
 * Unknown action objects are rejected. This module does not touch Room ledgers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const DECISION_ENVELOPE_SCHEMA = "silver.decision-envelope.v1" as const;

export type DecisionEvidenceRef = {
  kind: "intel" | "artifact" | "candidate" | "platform";
  ref: string;
  version?: string;
};

export type DecisionRecruitAction = {
  type: "recruit";
  role: "lead" | "worker";
  duty?: string;
  requestId: string;
};

export type DecisionRemoveAction = {
  type: "remove";
  memberId: string;
  requestId: string;
};

export type DecisionAction =
  | DecisionRecruitAction
  | DecisionRemoveAction;

export type DecisionEnvelope = {
  schema: typeof DECISION_ENVELOPE_SCHEMA;
  decisionId: string;
  expectedGeneration: number;
  roomId: string;
  challengeId: string;
  actorMemberId: string;
  rationale?: string;
  evidence: DecisionEvidenceRef[];
  actions: DecisionAction[];
  createdAt: string;
};

const ACTION_FIELDS: Record<DecisionAction["type"], readonly string[]> = {
  recruit: ["type", "role", "duty", "requestId"],
  remove: ["type", "memberId", "requestId"],
};

export function parseDecisionEnvelope(raw: unknown): DecisionEnvelope {
  if (!raw || typeof raw !== "object") throw new Error("decision envelope required");
  const row = raw as Record<string, unknown>;
  if (row.schema !== DECISION_ENVELOPE_SCHEMA) throw new Error("decision envelope schema mismatch");
  const decisionId = String(row.decisionId ?? "").trim();
  const expectedGeneration = Number(row.expectedGeneration);
  const roomId = String(row.roomId ?? "").trim();
  const challengeId = String(row.challengeId ?? "").trim();
  const actorMemberId = String(row.actorMemberId ?? "").trim();
  if (!decisionId) throw new Error("decisionId required");
  if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
    throw new Error("expectedGeneration must be a positive integer");
  }
  if (!roomId || !challengeId || !actorMemberId) {
    throw new Error("roomId, challengeId, and actorMemberId required");
  }
  if (!Array.isArray(row.actions)) {
    throw new Error("decision envelope requires an actions array");
  }
  if (!Array.isArray(row.evidence)) throw new Error("evidence array required");
  const actions = row.actions.map(parseAction);
  const evidence = row.evidence.map(parseEvidence);
  const createdAt = parseRequiredCreatedAt(row.createdAt);
  return {
    schema: DECISION_ENVELOPE_SCHEMA,
    decisionId,
    expectedGeneration,
    roomId,
    challengeId,
    actorMemberId,
    ...(typeof row.rationale === "string" ? { rationale: row.rationale } : {}),
    evidence,
    actions,
    createdAt,
  };
}

/**
 * Seal the exact convergence decision produced by one DSH session.
 * The parsed envelope has a stable field order, so proof verification is
 * independent of JSON key order and excludes the proof fields themselves.
 */
export function officialDecisionProof(
  capability: string,
  session: { sessionId: string; parentSessionId?: string },
  raw: unknown,
): string {
  const envelope = parseDecisionEnvelope(raw);
  const canonical = [
    "silver.submit_convergence_decision.v1",
    session.sessionId,
    session.parentSessionId ?? "",
    JSON.stringify(envelope),
  ].join("\n");
  return createHmac("sha256", capability).update(canonical).digest("base64url");
}

export function officialDecisionProofMatches(
  capability: string,
  session: { sessionId: string; parentSessionId?: string },
  raw: unknown,
  proof: string,
): boolean {
  try {
    const expected = officialDecisionProof(capability, session, raw);
    const left = Buffer.from(expected);
    const right = Buffer.from(proof);
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function parseRequiredCreatedAt(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("createdAt required");
  }
  const createdAt = raw.trim();
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) {
    throw new Error("createdAt must be a valid timestamp");
  }
  return createdAt;
}

function parseEvidence(raw: unknown): DecisionEvidenceRef {
  if (!raw || typeof raw !== "object") throw new Error("evidence ref required");
  const row = raw as Record<string, unknown>;
  const kind = String(row.kind ?? "").trim();
  const ref = String(row.ref ?? "").trim();
  if (
    kind !== "intel" &&
    kind !== "artifact" &&
    kind !== "candidate" &&
    kind !== "platform"
  ) {
    throw new Error(`unknown evidence kind ${kind}`);
  }
  if (!ref) throw new Error("evidence ref required");
  return {
    kind,
    ref,
    ...(typeof row.version === "string" ? { version: row.version } : {}),
  };
}

function parseAction(raw: unknown): DecisionAction {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("action required");
  const row = raw as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type.trim() : "";
  if (type !== "recruit" && type !== "remove") {
    if (typeof row.action === "string" && row.action.trim()) {
      throw new Error(
        `unknown action field action; use type="${row.action.trim()}" and that action's required fields`,
      );
    }
    throw new Error(`unknown action type ${type}`);
  }
  for (const key of Object.keys(row)) {
    if (!ACTION_FIELDS[type].includes(key)) throw new Error(`unknown action field ${key}`);
  }
  switch (type) {
    case "recruit": {
      const role = String(row.role ?? "").trim();
      const requestId = String(row.requestId ?? "").trim();
      if (role !== "lead" && role !== "worker") throw new Error("recruit role must be lead|worker");
      if (!requestId) throw new Error("recruit requires requestId");
      return {
        type: "recruit",
        role,
        requestId,
        ...(typeof row.duty === "string" ? { duty: row.duty } : {}),
      };
    }
    case "remove": {
      const memberId = String(row.memberId ?? "").trim();
      const requestId = String(row.requestId ?? "").trim();
      if (!memberId || !requestId) throw new Error("remove requires memberId and requestId");
      return { type: "remove", memberId, requestId };
    }
  }
}
