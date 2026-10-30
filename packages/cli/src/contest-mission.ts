import {
  formatFreshRootProgressBrief,
  type ContestSolveJob,
} from "@silver/host";
import {
  assembleRoomPersona,
  requireRoomAssembly,
  type RoomAssembly,
} from "@silver/ctf-spine";

export type RoomAcceptanceKind = "ctf" | "awd" | "pentest" | "koh" | "vuln" | "report";

export function roomAcceptanceKind(track: string | undefined, contestSubmit: boolean): RoomAcceptanceKind {
  if (track === "awd" || track === "agent-awd") return "awd";
  if (track === "pentest" || track === "koh" || track === "vuln") return track;
  if (contestSubmit || track === "jeopardy" || track === "ctf") return "ctf";
  return "report";
}

/** Acceptance actions for one child room. Declared by the Mission, not assumed by the room. */
export function childRoomAcceptance(
  _kind: RoomAcceptanceKind,
  opts?: { hint?: boolean; submit?: boolean },
): string {
  if (opts?.submit) {
    return "Completion for this Room is defined by the Commander Task and its external acceptance authority. Any member with an exact result uses the configured completion adapter immediately; this does not wait for Lead approval. Host records the returned verdict and exposes accepted progress to the Room. Work continues until the external authority reports the assigned outcome complete.";
  }
  return "Completion for this Room is defined by the Commander Task. Share externally confirmed progress as evidence. When the external completion condition is satisfied, the Lead posts task_complete with evidence so Commander can reconcile and close the Room. A bounded Worker turn ending is not task completion.";
}

/** Upstream entry assembly. The Host validates and installs this data without choosing a domain. */
export function roomAssembly(
  kind: RoomAcceptanceKind,
  opts?: { formalTeam?: boolean; hint?: boolean; submit?: boolean },
): RoomAssembly {
  return requireRoomAssembly({
    domain: kind,
    formalTeam: opts?.formalTeam === true,
    persona: assembleRoomPersona({
      domain: kind,
      compact: true,
      ...(opts?.formalTeam ? { formalTeam: true } : {}),
    }),
    acceptanceContract: {
      kind,
      success: childRoomAcceptance(kind, opts),
    },
  });
}

export function roomAssemblyAcceptanceText(assembly: RoomAssembly): string {
  return assembly.acceptanceContract.success;
}

export function contestChildMissionBody(job: ContestSolveJob): string {
  const base =
    `Complete the assigned work at ${job.targetUrl}. One work item, one Session. ` +
    "Use room_info, then perform one concrete task action. " +
    "Let evidence, current Intel, and the DSH Team task board guide whether to continue, revise, or change a route. " +
    "Bash starts in the attempt workspace; omit workdir by default and write evidence under relative scratch/ paths. " +
    `${childRoomAcceptance("ctf")}`;
  if (!job.previousStopReason) return base;
  const brief = formatFreshRootProgressBrief({
    previousStopReason: job.previousStopReason,
    ...(job.previousDiagnostics?.length ? { previousDiagnostics: job.previousDiagnostics } : {}),
    ...(job.previousProgress ? { previousProgress: job.previousProgress } : {}),
  });
  return `${base}\n\n${brief}`;
}
