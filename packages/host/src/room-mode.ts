/**
 * The only Room mode choice for a new run: solo, race, swarm, or three-graph.
 * Adapters name that choice. They do not isolate Room runtime.
 * Removed CLI entries throw unless the caller passes `compat: "replay"`.
 */
import type { ResolvedModelCall, SilverConfig } from "./silver-config.ts";
import { DEFAULT_SILVER_CONFIG } from "./silver-config.ts";
import {
  compatTeamSpecsForPlan,
  raceRacerSpecs,
  singleLeadTeamSpec,
  type TeamMemberSpec,
} from "./room-members.ts";
import { resolveRoomLiveModes, type RoomLiveModes } from "./room-live-modes.ts";

/** Explicit test/replay opt-in. Production `openLiveRoom` does not read this. */
export const ROOM_ENTRY_REPLAY_COMPAT = "replay" as const;

export interface RoomModeSelection {
  mode: SilverConfig["room"]["mode"];
  deprecations: string[];
  maxConcurrentRooms: number;
  race: { workers: number; models: readonly string[] };
  swarm: {
    initialWorkers: number;
    maxWorkers: number;
    /** Lead plus workers. The official-team gate counts every roster row. */
    rosterCap: number;
    modelPolicy: "homogeneous";
    chatEnabled: boolean;
    chatDelivery: SilverConfig["swarm"]["chat"]["delivery"];
    workerRoles: readonly string[];
  };
  nativeAssistants: SilverConfig["nativeAssistants"];
  /**
   * Config may say enabled, but assistants stay off until the lifecycle probe is green.
   */
  nativeAssistantsAdmitted: boolean;
  maxModelLoops: number;
  officialTeamAlias: boolean;
  legacy: boolean;
}

export interface OpenedRoom {
  selection: RoomModeSelection;
  live: RoomLiveModes;
  plan: ResolvedModelCall[];
  teamSpecs: TeamMemberSpec[];
  deprecations: string[];
  legacy: boolean;
}

/** Probe owns admission. Config `enabled: true` is not enough. */
export const NATIVE_ASSISTANT_PROBE_GREEN = false;

const REMOVED_PROFILES = new Set(["cheap-swarm", "swarm", "heterogeneous-3"]);

export function resolveRoomMode(input: {
  config?: SilverConfig;
  profile?: string;
  officialTeam?: boolean;
  team?: string;
  env?: NodeJS.ProcessEnv;
}): RoomModeSelection {
  const config = input.config ?? DEFAULT_SILVER_CONFIG;
  const removed = removedRoomEntry(input);
  if (removed) throw new Error(removed);
  if (config.swarm.modelPolicy === "heterogeneous") {
    throw new Error("swarm.modelPolicy=heterogeneous is not available; fail closed");
  }
  if (config.race.models.length > 0) {
    throw new Error("race.models is not wired; fail closed");
  }
  const deprecations: string[] = [];
  let mode = config.room.mode;
  if (input.officialTeam && input.profile === "groups-3") {
    throw new Error("--official-team cannot be combined with profile groups-3");
  }
  if (input.officialTeam) {
    if (mode !== "solo" && mode !== "swarm") {
      throw new Error("--official-team aliases room.mode swarm and refuses a different room.mode");
    }
    deprecations.push("--official-team is a temporary alias for room.mode swarm");
    mode = "swarm";
  } else if (input.profile === "groups-3") {
    deprecations.push("profile groups-3 is deprecated; use room.mode race");
    mode = "race";
  }
  const maxWorkers = config.swarm.maxWorkers;
  return {
    mode,
    deprecations,
    maxConcurrentRooms: config.competition.maxConcurrentRooms,
    race: { workers: config.race.workers, models: config.race.models },
    swarm: {
      initialWorkers: config.swarm.initialWorkers,
      maxWorkers,
      rosterCap: maxWorkers + 1,
      modelPolicy: "homogeneous",
      chatEnabled: mode === "swarm" && config.swarm.chat.enabled,
      chatDelivery: config.swarm.chat.delivery,
      workerRoles: config.swarm.workerRoles,
    },
    nativeAssistants: config.nativeAssistants,
    nativeAssistantsAdmitted: config.nativeAssistants.enabled && NATIVE_ASSISTANT_PROBE_GREEN,
    maxModelLoops: config.runtime.maxModelLoops,
    officialTeamAlias: Boolean(input.officialTeam),
    legacy: false,
  };
}

export function openLiveRoom(input: {
  config?: SilverConfig;
  profile?: string;
  officialTeam?: boolean;
  team?: string;
  goalBound?: boolean;
  explicitTeam?: boolean;
  teamSpecs: readonly TeamMemberSpec[];
  basePlan: readonly ResolvedModelCall[];
  env?: NodeJS.ProcessEnv;
  /** Old tests and replay recovery. Omitted on a new run. */
  compat?: typeof ROOM_ENTRY_REPLAY_COMPAT;
}): OpenedRoom {
  const config = input.config ?? DEFAULT_SILVER_CONFIG;
  if (input.team && input.officialTeam) {
    throw new Error("official team refuses to run beside independent roots");
  }
  const removed = removedRoomEntry(input);
  if (removed) {
    if (input.compat !== ROOM_ENTRY_REPLAY_COMPAT) throw new Error(removed);
    const maxMembers = config.legacySwarm?.maxMembers ?? config.swarm.maxWorkers + 1;
    const live = resolveRoomLiveModes({
      explicitTeam: Boolean(input.explicitTeam ?? input.team),
      teamSpecs: input.teamSpecs,
      maxMembers,
      goalBound: Boolean(input.goalBound),
      officialTeam: false,
    });
    const selection = selectionFromConfig(config, true);
    return finish(selection, live, input.basePlan, input.teamSpecs, [removed], true);
  }
  const selection = resolveRoomMode(input);
  const live = liveFromSelection(selection);
  return finish(selection, live, input.basePlan, input.teamSpecs, selection.deprecations, false);
}

export class SoloRoomAdapter {
  readonly mode = "solo" as const;
  readonly selection: RoomModeSelection;
  constructor(selection: RoomModeSelection) {
    this.selection = selection;
  }
}

export class RaceRoomAdapter {
  readonly mode = "race" as const;
  readonly selection: RoomModeSelection;
  constructor(selection: RoomModeSelection) {
    this.selection = selection;
  }
}

export class OfficialTeamRoomAdapter {
  readonly mode = "swarm" as const;
  readonly selection: RoomModeSelection;
  constructor(selection: RoomModeSelection) {
    this.selection = selection;
  }
}

export class ThreeGraphRoomAdapter {
  readonly mode = "three-graph" as const;
  readonly selection: RoomModeSelection;
  constructor(selection: RoomModeSelection) {
    this.selection = selection;
  }
}

export type RoomAdapter = SoloRoomAdapter | RaceRoomAdapter | OfficialTeamRoomAdapter | ThreeGraphRoomAdapter;

export function createRoomAdapter(selection: RoomModeSelection): RoomAdapter {
  if (selection.mode === "solo") return new SoloRoomAdapter(selection);
  if (selection.mode === "race") return new RaceRoomAdapter(selection);
  if (selection.mode === "three-graph") return new ThreeGraphRoomAdapter(selection);
  return new OfficialTeamRoomAdapter(selection);
}

/** Formal rooms always mount the durable Feed/Status channel used by the team. */
export function officialTeamChatMounted(selection: Pick<RoomModeSelection, "mode" | "legacy">): boolean {
  return selection.mode === "swarm" && !selection.legacy;
}

function finish(
  selection: RoomModeSelection,
  live: RoomLiveModes,
  basePlan: readonly ResolvedModelCall[],
  teamSpecs: readonly TeamMemberSpec[],
  deprecations: string[],
  legacy: boolean,
): OpenedRoom {
  const shaped = shapeRoots(selection, live, basePlan, teamSpecs, legacy);
  return {
    selection: { ...selection, legacy },
    live,
    plan: shaped.plan,
    teamSpecs: shaped.teamSpecs,
    deprecations,
    legacy,
  };
}

function shapeRoots(
  selection: RoomModeSelection,
  live: RoomLiveModes,
  basePlan: readonly ResolvedModelCall[],
  teamSpecs: readonly TeamMemberSpec[],
  legacy: boolean,
): { plan: ResolvedModelCall[]; teamSpecs: TeamMemberSpec[] } {
  const template = basePlan[0];
  if (!template) throw new Error("attempt plan is empty");
  if (legacy) {
    const specs = live.forceLeadOnlyRoster ? singleLeadTeamSpec() : [...teamSpecs];
    return { plan: expandPlan(basePlan, specs, Boolean(live.teamMode)), teamSpecs: specs };
  }
  if (selection.mode === "swarm") {
    const specs = singleLeadTeamSpec();
    return { plan: expandPlan(basePlan, specs, true), teamSpecs: specs };
  }
  if (selection.mode === "race") {
    const specs = raceRacerSpecs(selection.race.workers);
    return { plan: expandPlan(basePlan, specs, true), teamSpecs: specs };
  }
  const specs = compatTeamSpecsForPlan(1);
  return { plan: [template], teamSpecs: specs };
}

function expandPlan(
  basePlan: readonly ResolvedModelCall[],
  teamSpecs: readonly TeamMemberSpec[],
  matchRoster: boolean,
): ResolvedModelCall[] {
  if (!matchRoster) return [...basePlan];
  if (basePlan.length >= teamSpecs.length) return basePlan.slice(0, teamSpecs.length);
  const template = basePlan[0];
  if (!template) throw new Error("attempt plan is empty");
  return teamSpecs.map((_, index) => basePlan[index] ?? { ...template });
}

function liveFromSelection(selection: RoomModeSelection): RoomLiveModes {
  if (selection.mode === "swarm") {
    return {
      roomSwarmMode: true,
      teamMode: true,
      soloConvergence: false,
      forceLeadOnlyRoster: true,
      officialTeamMode: true,
      raceMode: false,
    };
  }
  if (selection.mode === "race") {
    return {
      roomSwarmMode: false,
      teamMode: false,
      soloConvergence: false,
      forceLeadOnlyRoster: false,
      officialTeamMode: false,
      raceMode: true,
    };
  }
  return {
    roomSwarmMode: false,
    teamMode: false,
    soloConvergence: false,
    forceLeadOnlyRoster: false,
    officialTeamMode: false,
    raceMode: false,
  };
}

function selectionFromConfig(config: SilverConfig, legacy: boolean): RoomModeSelection {
  const maxWorkers = config.swarm.maxWorkers;
  return {
    mode: config.room.mode,
    deprecations: [],
    maxConcurrentRooms: config.competition.maxConcurrentRooms,
    race: { workers: config.race.workers, models: config.race.models },
    swarm: {
      initialWorkers: config.swarm.initialWorkers,
      maxWorkers,
      rosterCap: config.legacySwarm?.maxMembers ?? maxWorkers + 1,
      modelPolicy: "homogeneous",
      chatEnabled: false,
      chatDelivery: config.swarm.chat.delivery,
      workerRoles: config.swarm.workerRoles,
    },
    nativeAssistants: config.nativeAssistants,
    nativeAssistantsAdmitted: false,
    maxModelLoops: config.runtime.maxModelLoops,
    officialTeamAlias: false,
    legacy,
  };
}

function removedRoomEntry(input: {
  profile?: string;
  team?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (input.team) return "--team is removed; set room.mode solo, race, swarm, or three-graph";
  if (input.profile && REMOVED_PROFILES.has(input.profile)) {
    return `profile ${input.profile} is removed; set room.mode solo, race, swarm, or three-graph`;
  }
  if (input.env?.SILVER_SWARM_ROOM === "1" || input.env?.SILVER_ROOM_SWARM === "1") {
    return "SILVER_SWARM_ROOM and SILVER_ROOM_SWARM are removed; set room.mode";
  }
  return undefined;
}
