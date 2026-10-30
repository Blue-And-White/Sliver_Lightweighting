/**
 * Host-side Project/Group pulse. Facts only: no payloads, flags, or Worker transcripts.
 * Commander reads this on event wakes. It is not a secretary model and is not injected
 * into solver sessions.
 */
export const PROJECT_PULSE_SCHEMA = "silver.project-pulse.v1" as const;

export type GroupPulseStatus = "running" | "idle" | "stalled" | "terminal";
/** broker-turns: Host LLM broker chat turns. session-tool-events: one tool_call per event (Grok/direct). */
export type GroupPulseActivitySource = "broker-turns" | "session-tool-events";

/** Native roster member under one Room / execution root. Not a separate Room. */
export interface RoomMemberPulse {
  memberId: string;
  role: "lead" | "worker";
  status: GroupPulseStatus;
  /** True only for the Host-started execution root (Lead). Native teammates are false. */
  executionRoot: boolean;
}

export interface GroupPulse {
  groupId: string;
  provider?: string;
  model?: string;
  status: GroupPulseStatus;
  /** Observed activity rows. Not a cross-model comparable "LLM turn" count. */
  activityEvents: number;
  activitySource: GroupPulseActivitySource;
  toolCalls: number;
  skillCalls: number;
  /** submit_candidate invocations from this Group's activity log. Not unique candidates. */
  candidateReportCalls: number;
  hostWakeCount: number;
  lastActivityAt?: string;
  /** Official Team: Lead + Workers listed under this Room. Absent for independent Groups. */
  members?: RoomMemberPulse[];
}

export interface ProjectPulse {
  schema: typeof PROJECT_PULSE_SCHEMA;
  challengeId: string;
  remainingMs: number;
  deadlineAt: string;
  candidateCount: number;
  pendingReview: boolean;
  groups: GroupPulse[];
  allGroupsStalled?: boolean;
  awaitingResourceDecision?: boolean;
}

export function projectPulse(input: {
  challengeId: string;
  remainingMs: number;
  deadlineAt: string;
  candidateCount: number;
  pendingReview: boolean;
  groups: GroupPulse[];
  allGroupsStalled?: boolean;
  awaitingResourceDecision?: boolean;
}): ProjectPulse {
  return {
    schema: PROJECT_PULSE_SCHEMA,
    challengeId: input.challengeId,
    remainingMs: Math.max(0, input.remainingMs),
    deadlineAt: input.deadlineAt,
    candidateCount: input.candidateCount,
    pendingReview: input.pendingReview,
    groups: input.groups,
    ...(input.allGroupsStalled ? { allGroupsStalled: true } : {}),
    ...(input.awaitingResourceDecision ? { awaitingResourceDecision: true } : {}),
  };
}

export function groupPulse(input: GroupPulse): GroupPulse {
  return {
    groupId: input.groupId,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    status: input.status,
    activityEvents: input.activityEvents,
    activitySource: input.activitySource,
    toolCalls: input.toolCalls,
    skillCalls: input.skillCalls,
    candidateReportCalls: input.candidateReportCalls,
    hostWakeCount: input.hostWakeCount,
    ...(input.lastActivityAt ? { lastActivityAt: input.lastActivityAt } : {}),
    ...(input.members && input.members.length > 0 ? { members: input.members } : {}),
  };
}

export function groupPulseFromObserved(input: {
  groupId: string;
  provider?: string;
  model?: string;
  status: GroupPulseStatus;
  hostWakeCount?: number;
  activitySource?: GroupPulseActivitySource;
  turns: Array<{ at?: string; actions: string[] }>;
  members?: RoomMemberPulse[];
}): GroupPulse {
  const turns = input.turns;
  let toolCalls = 0;
  let skillCalls = 0;
  let candidateReportCalls = 0;
  for (const turn of turns) {
    for (const action of turn.actions) {
      toolCalls += 1;
      if (action === "skill") skillCalls += 1;
      if (action === "submit_candidate") candidateReportCalls += 1;
    }
  }
  const lastAt = [...turns].reverse().find((row) => row.at)?.at;
  return groupPulse({
    groupId: input.groupId,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    status: input.status,
    activityEvents: turns.length,
    activitySource: input.activitySource ?? "broker-turns",
    toolCalls,
    skillCalls,
    candidateReportCalls,
    hostWakeCount: input.hostWakeCount ?? 0,
    ...(lastAt ? { lastActivityAt: lastAt } : {}),
    ...(input.members && input.members.length > 0 ? { members: input.members } : {}),
  });
}
