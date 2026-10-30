/**
 * Experimental Official Team Room adapter.
 * One Room starts one ACP Lead. Teammates come from the official Agent Team
 * inside that process. Not the default swarm and not C6 Host recruit.
 * nativeSession stays cooperative attribution.
 */
import fs from "node:fs";
import path from "node:path";
import { requireRoomAssembly, type RoomAssembly } from "@silver/ctf-spine";
import type { TrackKind } from "@silver/protocol";
import type { ChallengeRuntime } from "./challenge-runtime.ts";
import { spawnOfficialDshAcpSession } from "./dsh-acp-client.ts";
import { livePersonaPatchYaml } from "./live-dsh.ts";
import {
  officialAgentTeamProfilePatchPath,
  officialAgentTeamServicePatchYaml,
  officialTeamMaxMembersPatchYaml,
  officialTeamReasonWorkflowPatchYaml,
} from "./dsh-agent-team.ts";
import type { LiveRunStopReason } from "./live-run-ledger.ts";
import {
  applyAwdServiceRoom,
  commitAwdServiceRoomCleanup,
  readAwdServiceRoom,
  type AwdServiceRoomNotice,
  type AwdServiceRoomState,
} from "./awd-service-room.ts";
import { applyRoomPlatformAcceptedStop } from "./room-platform-stop.ts";
import { ProjectRuntime } from "./project-runtime.ts";
import {
  resumeOrStartRoomClock,
  roomClockPath,
  roomRemainingMs,
  updateRoomDeadline,
  writeRoomClock,
  type RoomClockState,
} from "./room-clock.ts";
import { roomMembersPath } from "./room-members.ts";

export type OfficialTeamRoomLeadSpawn = typeof spawnOfficialDshAcpSession;

export function writeOfficialTeamExperimentPatches(dir: string, maxTeammates: number): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const servicePatch = path.join(dir, "team-service.patch.yml");
  const maxMembersPatch = path.join(dir, "team-max-members.patch.yml");
  const reasonWorkflowPatch = path.join(dir, "team-reason-workflow.patch.yml");
  fs.writeFileSync(servicePatch, officialAgentTeamServicePatchYaml());
  fs.writeFileSync(maxMembersPatch, officialTeamMaxMembersPatchYaml(maxTeammates));
  fs.writeFileSync(reasonWorkflowPatch, officialTeamReasonWorkflowPatchYaml());
  return [officialAgentTeamProfilePatchPath(), servicePatch, maxMembersPatch, reasonWorkflowPatch];
}

export type OfficialTeamRoomInput = {
  repoRoot: string;
  challengeId: string;
  roomId: string;
  /** Host full-roster cap, including the Lead. DSH receives a derived teammate cap. */
  maxMembers: number;
  roomClockDir: string;
  runtime: ChallengeRuntime;
  projects: ProjectRuntime;
  targetUrl: string;
  cwd: string;
  /** Explicit upstream domain/persona contract. The generic Team runtime does not choose one. */
  roomAssembly: RoomAssembly;
  /** Model and storage overlays. A ctf-spine patch in this list is applied after the Team overlays. */
  basePatches: readonly string[];
  env: NodeJS.ProcessEnv;
  prompt: string;
  budgetMs: number;
  /** Cold resume of the same Lead ACP session. */
  sessionId?: string;
  /** D2: teammates must bind a C3 recruit permit. Off for the D1 identity probe. */
  requireRecruitPermit?: boolean;
  signal?: AbortSignal;
  spawnLead?: OfficialTeamRoomLeadSpawn;
  /** Own-service AWD keeps this Room across rounds. Jeopardy rooms omit it. */
  track?: TrackKind;
};

export type OfficialTeamRoom = {
  clock: RoomClockState;
  membersFile: string;
  lead: ReturnType<OfficialTeamRoomLeadSpawn>;
  setDeadline(deadlineAtMs: number): RoomClockState;
  operatorStop(): Promise<void>;
  platformCompleted(): Promise<void>;
  close(): Promise<void>;
  /** AWD only. Stage, round, health, idle, and budget facts do not close the Room. */
  noteService(notice: AwdServiceRoomNotice): Promise<{ closed: boolean; state: AwdServiceRoomState }>;
};

export function startOfficialTeamRoom(input: OfficialTeamRoomInput): OfficialTeamRoom {
  if (!Number.isInteger(input.maxMembers) || input.maxMembers < 1) {
    throw new Error("official team maxMembers is invalid");
  }
  const rpc = input.env.SILVER_HOST_RPC?.trim();
  const capability = input.env.SILVER_HOST_CAPABILITY?.trim();
  if (!rpc || !capability) {
    throw new Error("official team room requires SILVER_HOST_RPC before the Lead starts");
  }
  const roomAssembly = requireRoomAssembly(input.roomAssembly);
  if (!roomAssembly.formalTeam) {
    throw new Error("official team room requires a formalTeam room assembly");
  }
  const awd = input.track === "awd" || input.track === "agent-awd";
  if (awd !== (roomAssembly.domain === "awd")) {
    throw new Error(`official team track does not match room assembly domain ${roomAssembly.domain}`);
  }
  const clockFile = roomClockPath(input.roomClockDir, input.roomId);
  const resumed = resumeOrStartRoomClock({
    file: clockFile,
    roomId: input.roomId,
    challengeId: input.challengeId,
    domain: roomAssembly.domain,
    formalTeam: roomAssembly.formalTeam,
    budgetMs: input.budgetMs,
  });
  if (resumed.needsRecoveryDecision) {
    throw new Error(resumed.state.migrationNote ?? "room clock recovery decision required");
  }
  let clock = resumed.state;
  writeRoomClock(clockFile, clock);
  // Jeopardy budgetMs is the room lifetime. An AWD work budget is not the match limit.
  if (!awd && roomRemainingMs(clock) <= 0) {
    throw new Error("official team room deadline already passed");
  }
  const priorAwd = awd ? readAwdServiceRoom(input.roomClockDir, input.challengeId) : undefined;
  if (priorAwd && priorAwd.roomId !== input.roomId) {
    throw new Error(`awd service room ${input.challengeId} is bound to ${priorAwd.roomId}, not ${input.roomId}`);
  }
  if (priorAwd?.phase === "closed") {
    throw new Error("awd service room is already closed");
  }
  input.projects.open({ challengeId: input.challengeId, targetUrl: input.targetUrl });
  const membersFile = roomMembersPath(input.roomClockDir, input.challengeId);
  const patchDir = path.join(input.roomClockDir, "official-team-patches");
  const teamPatches = writeOfficialTeamExperimentPatches(patchDir, Math.max(1, input.maxMembers - 1));
  const personaPatch = path.join(patchDir, "room-persona.patch.yml");
  fs.writeFileSync(personaPatch, livePersonaPatchYaml({ personaPrefix: roomAssembly.persona }));
  // Gate before the Lead process exists, so the first teammate RPC is already capped.
  input.runtime.setOfficialTeamRpcGate(input.challengeId, {
    roomId: input.roomId,
    roomClockDir: input.roomClockDir,
    maxMembers: input.maxMembers,
    ...(input.requireRecruitPermit ? { requireRecruitPermit: true } : {}),
  });
  const spawnLead = input.spawnLead ?? spawnOfficialDshAcpSession;
  const spinePatches = input.basePatches.filter((patch) => path.basename(patch).includes("ctf-spine"));
  const leadingPatches = input.basePatches.filter((patch) => !spinePatches.includes(patch));
  let lead: ReturnType<OfficialTeamRoomLeadSpawn>;
  try {
    lead = spawnLead({
      repoRoot: input.repoRoot,
      cwd: input.cwd,
      // Spine last, matching the working identity probe. Team overlays must not land after it.
      patches: [...leadingPatches, personaPatch, ...teamPatches, ...spinePatches],
      env: {
        ...input.env,
        SILVER_HOST_MODE: "",
        SILVER_TEAM_IDENTITY_PROBE: "1",
        SILVER_FORMAL_TEAM: "1",
        SILVER_ROOM_CLOCK_DIR: input.roomClockDir,
        SILVER_SWARM_ROOM: "1",
        SILVER_ROOM_DOMAIN: roomAssembly.domain,
      },
      prompt: input.prompt,
      timeoutMs: roomRemainingMs(clock),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (err) {
    input.runtime.setOfficialTeamRpcGate(input.challengeId, undefined);
    input.projects.close(input.challengeId);
    throw err;
  }
  let roomTimer: ReturnType<typeof setTimeout> | undefined;
  let settle: Promise<void> | undefined;
  let closed = false;
  /** Set only for match end or operator stop. A work-budget release leaves the room open. */
  let awdTerminal = false;
  const closeGate = (): void => {
    input.runtime.setOfficialTeamRpcGate(input.challengeId, undefined);
  };
  const releaseTimer = (): void => {
    if (!roomTimer) return;
    clearTimeout(roomTimer);
    roomTimer = undefined;
  };
  const finish = (): void => {
    if (awd && !awdTerminal) {
      releaseTimer();
      return;
    }
    closed = true;
    releaseTimer();
    closeGate();
  };
  const stopLead = (reason: LiveRunStopReason): Promise<void> => {
    if (!awd || awdTerminal) closeGate();
    if (!settle) {
      releaseTimer();
      lead.stop(reason);
      settle = lead.result.then(
        () => undefined,
        () => undefined,
      );
    }
    return settle;
  };
  const noteWorkBudget = (): void => {
    applyAwdServiceRoom({
      roomClockDir: input.roomClockDir,
      roomId: input.roomId,
      challengeId: input.challengeId,
      notice: { at: new Date().toISOString(), workBudgetExhausted: true },
    });
    if (awdTerminal || settle) return;
    void stopLead("work_budget" as LiveRunStopReason);
  };
  const armDeadline = (): void => {
    if (settle || closed || awdTerminal) return;
    if (roomTimer) clearTimeout(roomTimer);
    const remain = roomRemainingMs(clock);
    if (!Number.isFinite(remain)) {
      lead.setTimeoutMs(remain);
      return;
    }
    if (awd) {
      if (remain <= 0) {
        noteWorkBudget();
        return;
      }
      lead.setTimeoutMs(remain);
      roomTimer = setTimeout(() => {
        noteWorkBudget();
      }, remain);
      roomTimer.unref?.();
      return;
    }
    lead.setTimeoutMs(remain);
    if (remain <= 0) {
      void stopLead("timeout");
      return;
    }
    roomTimer = setTimeout(() => {
      void stopLead("timeout");
    }, remain);
    roomTimer.unref?.();
  };
  armDeadline();
  void lead.result.finally(finish);
  const cleanupAwdResources = async (): Promise<void> => {
    awdTerminal = true;
    releaseTimer();
    closeGate();
    input.projects.close(input.challengeId);
    await stopLead("host_terminal_stop");
  };
  const closeAwd = async (
    notice: AwdServiceRoomNotice,
  ): Promise<{ closed: boolean; state: AwdServiceRoomState }> => {
    const effect = applyAwdServiceRoom({
      roomClockDir: input.roomClockDir,
      roomId: input.roomId,
      challengeId: input.challengeId,
      notice,
    });
    if (!effect.close) return { closed: effect.state.phase === "closed", state: effect.state };
    await cleanupAwdResources();
    const state = commitAwdServiceRoomCleanup(input.roomClockDir, input.challengeId);
    return { closed: true, state };
  };
  return {
    clock,
    membersFile,
    lead,
    setDeadline(deadlineAtMs: number): RoomClockState {
      if (settle || closed) throw new Error("cannot change deadline on a closed official team room");
      clock = updateRoomDeadline(clock, { deadlineAtMs });
      writeRoomClock(clockFile, clock);
      armDeadline();
      return clock;
    },
    operatorStop(): Promise<void> {
      if (!awd) return stopLead("host_terminal_stop");
      return closeAwd({ at: new Date().toISOString(), operatorStop: true }).then(() => undefined);
    },
    async platformCompleted(): Promise<void> {
      if (awd) {
        applyAwdServiceRoom({
          roomClockDir: input.roomClockDir,
          roomId: input.roomId,
          challengeId: input.challengeId,
          notice: { at: new Date().toISOString(), platformStage: true },
        });
        return;
      }
      closeGate();
      await applyRoomPlatformAcceptedStop({
        roomClockDir: input.roomClockDir,
        roomId: input.roomId,
        challengeId: input.challengeId,
        projects: input.projects,
        membersFile,
        stopLiveSessions: () => stopLead("host_terminal_stop"),
      });
    },
    close(): Promise<void> {
      return stopLead("interrupted");
    },
    async noteService(notice: AwdServiceRoomNotice): Promise<{ closed: boolean; state: AwdServiceRoomState }> {
      if (input.track !== "awd" && input.track !== "agent-awd") {
        throw new Error("service notices belong to an AWD room");
      }
      if (notice.matchEnded === true || notice.operatorStop === true) return closeAwd(notice);
      const effect = applyAwdServiceRoom({
        roomClockDir: input.roomClockDir,
        roomId: input.roomId,
        challengeId: input.challengeId,
        notice,
      });
      return { closed: effect.state.phase === "closed", state: effect.state };
    },
  };
}
