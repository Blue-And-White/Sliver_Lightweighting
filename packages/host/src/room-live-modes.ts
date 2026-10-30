/**
 * Resolve formal-member / solo / C6 swarm gates for a live Room.
 * Mission child (goalBound, no --team) with swarm.maxMembers>1 enters roomSwarmMode.
 * Official Team is an explicit experiment. It does not replace that Mission/C6 gate.
 */
import type { TeamMemberSpec } from "./room-members.ts";

export type RoomLiveModesInput = {
  explicitTeam: boolean;
  teamSpecs: readonly TeamMemberSpec[];
  maxMembers: number;
  goalBound: boolean;
  /** `--official-team`. One Lead root; teammates come from the official Agent Team. */
  officialTeam?: boolean;
};

export type RoomLiveModes = {
  roomSwarmMode: boolean;
  /** Formal multi-root or dynamic swarm Lead room (wake hub + member idle loop). */
  teamMode: boolean;
  /** C5b solo Reviewer path — mutually exclusive with teamMode/roomSwarmMode. */
  soloConvergence: boolean;
  /** When Mission enters swarm without --team, force Lead-only roster. */
  forceLeadOnlyRoster: boolean;
  /** Experimental Official Team. Never implied by Mission goalBound. */
  officialTeamMode: boolean;
  /**
   * N independent Racers in one Room. Not Lead/Worker, not C6, not Official Team.
   * Replay compat never sets this; new race runs set it from `liveFromSelection`.
   */
  raceMode: boolean;
};

export function resolveRoomLiveModes(input: RoomLiveModesInput): RoomLiveModes {
  const officialTeamMode = Boolean(input.officialTeam);
  if (officialTeamMode && input.teamSpecs.some((row) => row.role !== "lead")) {
    throw new Error("official team refuses to run beside independent roots");
  }
  const maxMembers = input.maxMembers;
  const leadOnlyExplicit =
    input.explicitTeam &&
    input.teamSpecs.length === 1 &&
    input.teamSpecs[0]?.role === "lead";
  const missionDynamicSwarm = Boolean(input.goalBound) && !input.explicitTeam && maxMembers > 1 && !officialTeamMode;
  const roomSwarmMode =
    maxMembers > 1 && (officialTeamMode || leadOnlyExplicit || missionDynamicSwarm);
  const teamMode = input.explicitTeam || roomSwarmMode || officialTeamMode;
  const soloConvergence = Boolean(input.goalBound) && !teamMode;
  return {
    roomSwarmMode,
    teamMode,
    soloConvergence,
    forceLeadOnlyRoster: missionDynamicSwarm || officialTeamMode,
    officialTeamMode,
    raceMode: false,
  };
}
