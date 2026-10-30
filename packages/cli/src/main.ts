#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { COMMANDER_REVIEW_UNACKNOWLEDGED, commanderReviewPrompt } from "./commander-review-gate.ts";
import { dispatchUntilHostTerminal, hostTerminalForLive, liveAcceptanceMode } from "./host-terminal-dispatch.ts";
import { createLeadControlDispatch } from "./lead-control-dispatch.ts";
import { acknowledgeOperatorCommanderMessage, consumeOperatorCommanderMessage } from "./operator-commander-message.ts";
import { nextLeadResultStep, officialTeamLeadCanTakeSerialPrompt } from "./lead-result-dispatch.ts";
import { nextThreeGraphSlotEvent, THREE_GRAPH_WORKER_COUNT } from "./three-graph-scheduler.ts";
import {
  advancePlatformAdmission,
  durableAdmissionsToQueue,
  parsePlatformAdmissions,
  type PlatformAdmissionRecord,
} from "./platform-admission.ts";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { runRoomOperatorUi } from "./room-operator-ui.ts";
import { roomCommandClockDir } from "./room-command-path.ts";
import {
  OPERATOR_ROOM_MESSAGE_TTL_MS,
  DIRECT_SESSION_NOTICE_DIR_ENV,
  readOperatorRoomMessageResult,
  requireRoomAssembly,
  withdrawOperatorRoomMessage,
  writeOperatorRoomMessage,
  loadCommanderRolePrompt,
  loadBreadthReconRolePrompt,
  loadWholeRacerRolePrompt,
  loadRoundAuditorRolePrompt,
  loadRotatingWorkerRolePrompt,
  type RoomAssembly,
  type RoomDomain,
  type RolePromptMode,
} from "@silver/ctf-spine";
import {
  ChallengeRuntime,
  RoomGraphStore,
  type RoomGraphNode,
  HostFsSandbox,
  IsolationSandbox,
  isolationCellDir,
  linkHostFsCtfSpinePackage,
  HOSTFS_CONTAINER_ID,
  assertLiveDshRoute,
  assertLiveDshRuntimeReady,
  assertLiveHostAccepted,
  assertCaseSolvedByHostCas,
  assertMissionCandidateReport,
  buildLiveCandidateReport,
  candidateReportPaths,
  buildLiveRunLedger,
  collectLiveRunReplayRows,
  collectSilverMigrationStatus,
  countNamedCalls,
  countToolCalls,
  formatSilverMigrationStatus,
  formatReplaySummary,
  liveMissionReport,
  mirrorLiveEvidence,
  mirrorLiveSkillRoots,
  promptSkillGesturesFromText,
  readLiveTurns,
  readCtfSessionToolTurns,
  readObservedLiveTurns,
  replayOutputPath,
  resolveLiveBudget,
  summarizeLiveRun,
  summarizeLiveRunWithReport,
  mergeLiveWireSummaries,
  summarizeLiveWireFile,
  writeLiveCandidateReport,
  writeLiveRunLedger,
  liveSessionStatePath,
  liveSessionIdForAttempt,
  readResumableLiveSessionState,
  writeLiveSessionState,
  hasLiveSessionResumeBudget,
  LLM_CAPABILITY_ENV,
  DEFAULT_DEEPSEEK_BASE_URL,
  cellBrokerBind,
  liveCellEnv,
  listenHostRpc,
  listenLlmBroker,
  liveHostRpcBind,
  loadSilverConfig,
  isSwarmProfile,
  officialTeamChatMounted,
  describeOfficialDshRuntime,
  assertAcpDshRuntimeReady,
  isOfficialDshAcpPromptTransportError,
  spawnOfficialDshAcpSession,
  writeCtfSpinePatch,
  writeLiveDshHome,
  commanderLlmRequestPolicy,
  workerLlmRequestPolicy,
  reviewerLlmRequestPolicy,
  testOnlyFsSearchRawOutputMaxBytes,
  testOnlyLocalWebEnabled,
  adjacentMaterialsDir,
  liveSessionPrompt,
  persistSeededMaterials,
  seedAdjacentMaterials,
  liveRouteAcceptsImages,
  liveLlmWireApi,
  livePiAiRoutePatchYaml,
  writeHostFsToolShims,
  liveSkillMountFromConfig,
  listVisibleSkillCatalog,
  hostSpawnEnv,
  liveContestScope,
  randomCapabilitySecret,
  randomLlmCapability,
  requireLiveApiKey,
  resolveApiKey,
  liveNeedsApiKey,
  resolveAttemptPlan,
  contestSolverBudget,
  CONTEST_SOLVER_MAX_ROOT_SESSIONS,
  mergePlatformAcceptanceSnapshots,
  DSH_BUILTIN_GENERIC_TOOLS,
  frozenSilverSolverLeaves,
  silverOwnedSolverTools,
  unregisteredSilverFsLeaves,
  liveTurnCapReached,
  capabilityTtlForRoom,
  capabilityTtlForUnboundedRoom,
  SlotPool,
  ProjectRuntime,
  applyRoomPlatformAcceptedStop,
  roomTerminalRecovery,
  isRoomPlatformStopApplied,
  isRoomPlatformStopPresent,
  noteRoomConvergenceTrigger,
  cancelRoomConvergenceFlight,
  activeRoomConvergenceFlight,
  createOfficialDshConvergenceReviewer,
  convergenceReviewerPersonaPatchYaml,
  runSoloConvergenceEpisodeSingleFlight,
  SOLO_MEMBER_ID,
  runSwarmConvergenceEpisodeSingleFlight,
  createLeadSessionSwarmSynthesizer,
  openLiveRoom,
  resolveRoomMode,
  ROOM_SWARM_ENV,
  CONVERGENCE_SUBMIT_PATH_ENV,
  readRoomDeferUnavailable,
  clearRoomDeferUnavailable,
  consumeRoomTaskComplete,
  retireExpiredOfficialTeamChannel,
  officialTeamRoomPhase,
  readNativeSessionBinding,
  writeOfficialTeamExperimentPatches,
  parseDecisionEnvelope,
  type ConvergenceReviewer,
  type ResumeLeadDecisionTurn,
  createCandidateReviewHold,
  candidateReviewLeaseMsFromEnv,
  readCandidateReviewHoldSnapshot,
  writeCandidateReviewHoldSnapshot,
  shouldResumeSessionsInReviewHold,
  createMissionCandidateReviewTracker,
  parseMissionCandidateReviewSnapshot,
  projectPulse,
  groupPulseFromObserved,
  createWaitBroadcast,
  type ProjectPulse,
  type ProjectSnapshot,
  type GroupPulse,
  roomClockPath,
  liveRoomClockDir,
  liveTaskIdentity,
  collectLegacyRoomClockCandidates,
  migrateLegacyRoomClock,
  beginFreshAttemptClock,
  resumeOrStartRoomClock,
  writeRoomClock,
  beginRoomDeadlineStop,
  roomRemainingMs,
  roomExpired,
  updateRoomDeadline,
  readRoomClock,
  snapshotPriorRoomEvidence,
  consumeRoomDeadlineRequest,
  resolveRoomDeadlineRequest,
  writeRoomDeadlineRequest,
  writeRoomDeadlineResult,
  readRoomDeadlineResult,
  withdrawRoomDeadlineRequest,
  parseTeamMemberSpecs,
  compatTeamSpecsForPlan,
  raceRosterPath,
  readRaceRoster,
  writeRaceRoster,
  assertSameRaceRoster,
  resumeOrCreateRoomMembers,
  emptyRoomMembers,
  roomMembersPath,
  upsertRoomMember,
  resolveRoomMemberId,
  projectInterruptedRoomMembers,
  writeRoomMembers,
  projectRoomStatus,
  readRoomMembers,
  writeMemberCollaborationPatch,
  alignMembersByStableId,
  type RoomClockState,
  type RoomMembersState,
  type TeamMemberSpec,
  type AttemptSlice,
  type ChallengeSandbox,
  type ChallengePreviousRoot,
  type HostRpcHandle,
  type DshRuntimeFingerprint,
  type LiveBudget,
  type LlmBrokerHandle,
  type LiveRunStopReason,
  type OfficialDshAcpSessionResult,
  type ResolvedModelCall,
  type SilverConfig,
  type LiveDshHomeOptions,
  challengeBundleFromPlatform,
  challengeBundleFromBoard,
  mergePlatformLayers,
  projectContestBoard,
  requireCommanderChildMission,
  withCommanderChildMission,
  formatChallengeBundle,
  type ChallengeBundle,
  type ContestSolveResult,
  type ContestBoardRow,
  type ContestSubmitVerdict,
  ContestDuplicateError,
  contestTargetUrl,
  type ContestHintHook,
  type ContestRestartHook,
  type ContestSubmitHook,
  type ContestVerifyHook,
  type SlotJob,
  type SlotResult,
  authorizePiAiProvider,
  inspectPiAiAuthorization,
  resolvePiAiCredentialHome,
  createSuspendClockAnchor,
  measureSuspendGapMs,
  startIdleSleepGuard,
  type IdleSleepGuard,
  type IdleSleepGuardProjection,
} from "@silver/host";
import { IsolationHost, ProcessDocker, resolveCellImage } from "@silver/isolation";
import { REPO_MOUNT, WORKDIR, type HostRpcRequest, type HostRpcResponse, type TrackKind } from "@silver/protocol";
import { Ledger } from "@silver/ledger";
import { MockPlatform } from "@silver/platform-mock";
import { parseCliArgs } from "./args.ts";
import {
  LIVE_ONLY_CASE_IDS,
  seedCaseWorkspace,
  selectCases,
  selectLiveCases,
  WEB_FLAG_HUNT,
  type CaseSpec,
} from "./fixture.ts";
import {
  missionFromTarget,
  readCommanderMissionFile,
  type MissionBrief,
} from "./mission.ts";
import { dockerAvailable, requireLiveIsolation } from "./live-guard.ts";
import { technicalProgressForLiveRun } from "./live-progress-policy.ts";
import {
  roomAcceptanceKind,
  roomAssembly as buildRoomAssembly,
  roomAssemblyAcceptanceText,
} from "./contest-mission.ts";
import {
  contestAdapterIdentity,
  loadContestAdapter,
  type ContestAdapterIdentity,
} from "./contest-adapter-loader.ts";
import { discoverSilverConfigPath, loadProductSilverConfig } from "./product-config.ts";
import { applyMissionCandidateReported } from "./mission-on-candidate-reported.ts";
import { ackPendingRoomThenMission } from "./mission-pending-ack.ts";
import {
  freshAttemptRetryDecision,
  logicalAttemptCounts,
  missionAdmissibleTerminal,
  missionOnlyBoardAdmission,
  readMissionReplayCheckpoint,
  updateMissionFirstPassTargets,
} from "./mission-admission.ts";
import {
  annotateMissionResultsWithPlatform,
  collapseTerminalSolvedResults,
  commanderStoredTargetStatus,
  observeContestBoard,
  latestMissionTargetReviews,
  unresolvedMissionTargetIds,
  officialContestCompletedReview,
  officialContestRoomTerminal,
  slotOutcomeAfterContestBoard,
  type MissionTargetReviewRow,
} from "./mission-result-annotation.ts";
import {
  sampleSizeSettledTargetIds,
  sampleSizeTerminal,
  terminalReleasesContestTargets,
} from "./mission-sample-exhaustion.ts";
import { waitForCommanderTransportBackoff } from "./commander-transport-backoff.ts";
import { runDshWebUi } from "./dsh-web-ui.ts";
import {
  liveLeadControlResumePrompt,
  liveMemberResumePrompt,
  liveSessionRecoveryAction,
  shouldResumeLiveSession,
} from "./live-member-resume.ts";
import { fileURLToPath } from "node:url";

const LIVE_LLM_MAX_CONSECUTIVE_FAILED_TURNS = 8;
const MISSION_COMMANDER_TRANSPORT_RECOVERY_WINDOW_MS = 5 * 60_000;
const MISSION_COMMANDER_TRANSPORT_BACKOFF_MS = 30_000;
const MISSION_DRAIN_TIMEOUT_MS = 8_000;
const MISSION_CONTEST_CLOSE_TIMEOUT_MS = 15_000;
type MissionAllocationProgress = { observedAt: string; accepted: number; expected: number };
type MissionAllocationState = {
  targetId: string;
  startedAtMs: number;
  nextCheckpointMinute?: 30 | 60;
  previousPlatformProgress?: MissionAllocationProgress;
};
type MissionAllocationCheckpoint = {
  targetId: string;
  elapsedMs: number;
  checkpointMinute: 30 | 60;
  previousPlatformProgress?: MissionAllocationProgress;
  currentPlatformProgress?: MissionAllocationProgress;
};

function waitForContestClose(
  close: Promise<void>,
  targetId: string,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        onTimeout();
        reject(new Error(`contest close timed out for ${targetId}`));
      },
      timeoutMs,
    );
    close.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function commanderTransportDurationMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const DETACHED_MISSION_STATE_ENV = "SILVER_DETACHED_MISSION_STATE";

interface DetachedMissionProcessState {
  schema: "silver.detached-mission-process.v1";
  pid: number;
  status: "launched" | "running" | "terminal" | "interrupted" | "failed";
  replayPath: string;
  logPath: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
  /** Host idle-sleep prevention projection; observational; never fails the Mission. */
  idleSleepGuard?: IdleSleepGuardProjection;
  /** Wall elapsed minus monotonic elapsed (ms). Observational suspend gap; does not extend Room clocks. */
  suspendGapMs?: number;
}

function writeDetachedMissionProcessState(file: string, state: DetachedMissionProcessState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function updateDetachedMissionProcessStatus(status: DetachedMissionProcessState["status"]): void {
  const file = process.env[DETACHED_MISSION_STATE_ENV];
  if (!file || !fs.existsSync(file)) return;
  try {
    const prior = JSON.parse(fs.readFileSync(file, "utf8")) as DetachedMissionProcessState;
    writeDetachedMissionProcessState(file, { ...prior, pid: process.pid, status, updatedAt: new Date().toISOString() });
  } catch {
    // Mission state and console log remain authoritative if this optional projection is damaged.
  }
}

function launchDetachedMission(args: ReturnType<typeof parseCliArgs>): void {
  if (!args.mission || args.target || args.caseName) {
    throw new Error("--detach requires a full-auto Mission: silver run mission.md --detach");
  }
  const repoRoot = repoRootFromCli();
  const requestedReplay = args.replayPath ? path.resolve(args.replayPath) : undefined;
  const replayPath = requestedReplay
    ? requestedReplay.endsWith(path.sep) || !requestedReplay.endsWith(".json")
      ? requestedReplay
      : path.dirname(requestedReplay)
    : path.join(repoRoot, ".silver-tmp", "missions", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(replayPath, { recursive: true });
  const logPath = path.join(replayPath, "mission-console.log");
  const statePath = path.join(replayPath, "mission-process.json");
  const supervisorPath = path.join(replayPath, "mission-supervisor.json");
  if (fs.existsSync(supervisorPath)) {
    const previous = JSON.parse(fs.readFileSync(supervisorPath, "utf8")) as { pid?: number; status?: string };
    if (previous.pid && ["starting", "running", "restarting"].includes(previous.status ?? "")) {
      try {
        process.kill(previous.pid, 0);
        throw new Error(`Mission replay already has a live supervisor (pid ${previous.pid})`);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
  }
  const childArgs = process.argv.slice(2).filter((token) => token !== "--detach");
  const discoveredConfigPath = discoverSilverConfigPath(args.configPath, process.cwd(), repoRoot);
  const hasConfigArg = childArgs.some((token) => token === "--config" || token.startsWith("--config="));
  if (discoveredConfigPath && !hasConfigArg) childArgs.push("--config", discoveredConfigPath);
  if (!args.replayPath) childArgs.push("--replay", replayPath);
  const entry = process.argv[1];
  if (!entry) throw new Error("cannot resolve the Silver CLI entrypoint for --detach");
  const supervisorEntry = path.join(repoRoot, "packages", "cli", "src", "mission-supervisor.mjs");
  const logFd = fs.openSync(logPath, "a", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [...process.execArgv, supervisorEntry, replayPath, entry, ...childArgs], {
      cwd: process.cwd(),
      env: { ...process.env, [DETACHED_MISSION_STATE_ENV]: statePath },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }
  if (!child.pid) throw new Error("failed to launch detached Mission process");
  const now = new Date().toISOString();
  writeDetachedMissionProcessState(statePath, {
    schema: "silver.detached-mission-process.v1",
    pid: child.pid,
    status: "launched",
    replayPath,
    logPath,
    startedAt: now,
    updatedAt: now,
  });
  child.unref();
  process.stdout.write(`${JSON.stringify({ detached: true, pid: child.pid, replayPath, logPath, statePath, supervisorPath }, null, 2)}\n`);
}

function commanderRolePromptMode(track: TrackKind): RolePromptMode {
  if (track === "awd" || track === "agent-awd") return "awd";
  if (track === "koh" || track === "pentest" || track === "vuln") return track;
  return "ctf";
}

function missionCommanderPersona(
  contestAdapterMounted = false,
  track: TrackKind = "jeopardy",
  autonomy: "autonomous" | "human_assisted" = "autonomous",
  hintPolicy: "open" | "off" = "off",
): string {
  const mode = commanderRolePromptMode(track);
  const runtimeFacts = [
    "Runtime facts for this Mission:",
    `- mode: ${mode}`,
    `- autonomy: ${autonomy}`,
    `- contest adapter mounted: ${contestAdapterMounted ? "yes" : "no"}`,
    "The natural-language Mission and tools mounted for this run are authoritative.",
    ...(hintPolicy === "off"
      ? ["Platform hints are forbidden. Do not request them or include a hint procedure in any childMission, even if a platform endpoint is known."]
      : []),
  ].join("\n");
  return `${loadCommanderRolePrompt(mode)}\n\n${runtimeFacts}`;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  updateDetachedMissionProcessStatus("running");
  if (args.command === "help") {
    process.stdout.write(
      "silver run mission.md                     # start a long-running collaboration room\n" +
        "silver run --live --timeout-ms 900000    # wall-clock budget\n" +
        "silver run --live --max-turns 300        # turn cap; pass 0 only for explicit no-cap runs\n" +
        "silver run mission.md --detach            # natural-language Mission; Commander operates the platform\n" +
        "silver run --no-skills mission.md          # disable configured external skill roots\n" +
        "silver run --mission brief.md              # equivalent long form\n" +
        "silver run --replay live-run-ledger.json # print a live-run replay summary\n" +
        "silver diagnose --replay DIR             # offline official session error/activity metadata\n" +
        "silver run --migration-status           # print DSH migration readiness\n" +
        "silver room set-deadline --replay PATH --challenge ID --extend-ms N  (signed; --extend-ms -60000 and --extend-ms=-60000)\n" +
        "silver room set-deadline --replay PATH --challenge ID --deadline-at ISO\n" +
        "silver room status --replay PATH --challenge ID\n" +
        "silver room message --replay PATH --challenge ID --message TEXT\n" +
        "silver room message --replay PATH --challenge ID --message-file PATH\n" +
        "silver room message --replay PATH --challenge ID --target SESSION_ID --mode queue|steer|interrupt --message TEXT\n" +
        "silver room ui --replay PATH --challenge ID [--no-open] [--port 0]\n" +
        "silver mission ui [--no-open] [--port 0] # open Silver tasks inside official DSH UI\n" +
        "silver run mission.md --config CFG          # select the collaboration configuration\n" +
        "                                             # swarm = Lead + native official DSH teammates\n" +
        "silver auth login xai                    # official SuperGrok/X OAuth device login\n" +
        "silver auth status xai                   # credential presence; never prints tokens\n" +
        "silver ui [--no-open] [--port 0]          # official DSH browser GUI\n",
    );
    return;
  }
  if (args.command === "auth") {
    await runAuth(args);
    return;
  }
  if (args.command === "diagnose") {
    if (!args.replayPath) throw new Error("use silver diagnose --replay DIR");
    const { collectSessionDiagnostics } = await import("./session-diagnostics.ts");
    const report = await collectSessionDiagnostics(args.replayPath);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.inspectionComplete) process.exitCode = 1;
    return;
  }
  if (args.command === "room") {
    await runRoomCommand(args);
    return;
  }
  if (args.command === "mission") {
    await runDshWebUi(repoRootFromCli(), {
      ...(args.uiPort !== undefined ? { port: args.uiPort } : {}),
      ...(args.uiNoOpen ? { noOpen: true } : {}),
    });
    return;
  }
  if (args.command === "ui") {
    await runDshWebUi(repoRootFromCli(), {
      ...(args.uiNoOpen ? { noOpen: true } : {}),
      ...(args.uiHost ? { host: args.uiHost } : {}),
      ...(args.uiPort !== undefined ? { port: args.uiPort } : {}),
      ...(args.uiTrustedHosts?.length ? { trustedHosts: args.uiTrustedHosts } : {}),
    });
    return;
  }
  if (args.command !== "run") {
    throw new Error(`unknown command ${args.command}; use silver run | silver room | silver mission | silver auth | silver ui`);
  }

  if (args.detach) {
    launchDetachedMission(args);
    return;
  }

  const discoveredConfigPath = discoverSilverConfigPath(args.configPath, process.cwd(), repoRootFromCli());
  if (discoveredConfigPath) args.configPath = discoveredConfigPath;

  const profile = args.profile ?? "single-fast";
  if (args.migrationStatus) {
    process.stdout.write(formatSilverMigrationStatus(collectSilverMigrationStatus(repoRootFromCli())));
    return;
  }
  if (args.replayPath && !args.live && !args.mission && !args.target) {
    const rows = collectLiveRunReplayRows(args.replayPath);
    process.stdout.write(formatReplaySummary(rows));
    return;
  }
  if (args.mission && args.target) throw new Error("pass --mission or --target, not both");
  const mission = args.mission
    ? readCommanderMissionFile(args.mission)
    : args.target
      ? missionFromTarget(args.target)
      : undefined;
  if (!mission) {
    throw new Error("silver run requires a mission file: silver run mission.md");
  }
  if (args.live && args.mission && mission) {
    if (args.isolate) throw new Error("Mission Commander currently uses HostFs live; --isolate is not supported");
    const config = loadCliSilverConfig(args.configPath);
    if (config.competition.track !== "jeopardy") {
      throw new Error("the public collaboration build supports only the generic mission track");
    }
    const plan = resolveAttemptPlan({
      config,
      profile,
      agent: "ctf-solver",
      challengeId: mission.challengeId,
    });
    if (plan.length === 0) throw new Error(`attempt profile ${profile} has no live slices`);
    for (const resolved of plan) {
      assertLiveDshRoute(resolved);
      if (liveNeedsApiKey(resolved)) requireLiveApiKey(resolved);
    }
    const summary = await runMissionCommander(args, mission, repoRootFromCli(), plan, config);
    updateDetachedMissionProcessStatus(summary.missionDone ? "terminal" : "interrupted");
    if (!summary.missionDone) process.exitCode = 1;
    return;
  }
  const cases = mission
    ? [{ challenge: missionChallenge(mission), contamination: "public-cutoff" as const }]
    : args.live
      ? selectLiveCases(args.caseName)
      : selectCases(args.caseName);
  const config = loadCliSilverConfig(args.configPath);
  const plan = resolveAttemptPlan({
    config,
    profile,
    agent: "ctf-solver",
    challengeId: cases[0]?.challenge.id ?? WEB_FLAG_HUNT.id,
  });
  const firstResolved = plan[0];
  if (!firstResolved) throw new Error(`attempt profile ${profile} has no slices`);
  const livePlan = plan;
  if (args.live) {
    for (const resolved of livePlan) {
      assertLiveDshRoute(resolved);
      if (liveNeedsApiKey(resolved)) requireLiveApiKey(resolved);
    }
  }
  if (args.live && args.isolate && cases.length !== 1) {
    throw new Error(
      "silver run --live --isolate currently supports one challenge, one DSH session; use HostFs live for --case all",
    );
  }
  if (args.live && args.isolate && args.unsafeHostfs) {
    throw new Error("silver run --live --isolate cannot be combined with --unsafe-hostfs");
  }
  if (args.live && args.isolate) requireLiveIsolation(true, dockerAvailable());
  if (args.live) {
    await runLiveOfficialDsh(args, cases, repoRootFromCli(), livePlan, config, mission);
    return;
  }

  const liveOnly = cases.find((row) => LIVE_ONLY_CASE_IDS.has(row.challenge.id));
  if (liveOnly) {
    throw new Error(
      `${liveOnly.challenge.id} requires silver run --live --case ${liveOnly.challenge.id}; the CI fixture runner cannot win it`,
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "silver-run-"));
  const execDir = path.join(root, "exec-A");
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const sandbox: ChallengeSandbox = new HostFsSandbox();
  const ledger = new Ledger(path.join(root, "runtime.db"));
  const platform = new MockPlatform(cases.map((row) => row.challenge));
  await platform.listen();
  ledger.createMission("mission-mini", "autonomous");
  const runtime = new ChallengeRuntime(ledger, platform, randomCapabilitySecret(), sandbox);
  const reports: Record<string, unknown>[] = [];

  try {
    for (const row of cases) {
      reports.push(await runCase({ args, config, profile, runtime, platform, row, root, execDir }));
    }
    process.stdout.write(`${JSON.stringify({ reports }, null, 2)}\n`);
  } finally {
    await runtime.stopAllAttempts();
    await platform.close();
    ledger.close();
  }
}

function liveAvailableSkillsForChallenge(
  config: SilverConfig,
  args: ReturnType<typeof parseCliArgs>,
): { name: string; description: string }[] | undefined {
  const mount = liveSkillMountFromConfig(config, liveSkillsEnabled(args));
  if (!mount || mount === true) return undefined;
  const roots = [
    ...(mount.skillRoots ?? []),
    ...(mount.skillRoot ? [mount.skillRoot] : []),
  ];
  if (roots.length === 0) return undefined;
  const catalog = listVisibleSkillCatalog(roots)
    .slice(0, 12)
    .map((row) => ({ name: row.name, description: row.description }));
  return catalog.length ? catalog : undefined;
}

function materializeLiveSkillMount(
  mount: ReturnType<typeof liveSkillMountFromConfig>,
  cwd: string,
): Exclude<ReturnType<typeof liveSkillMountFromConfig>, boolean | undefined> | undefined {
  if (!mount || mount === true) return undefined;
  const roots = [
    ...(mount.skillRoots ?? []),
    ...(mount.skillRoot ? [mount.skillRoot] : []),
  ];
  if (roots.length === 0) return undefined;
  const mirrored = mirrorLiveSkillRoots(roots, path.join(cwd, ".silver-skills"));
  if (mirrored.length === 0) return undefined;
  return {
    skillRoots: mirrored,
    ...(mount.catalogDescriptionMaxLength !== undefined
      ? { catalogDescriptionMaxLength: mount.catalogDescriptionMaxLength }
      : {}),
  };
}

function liveCredentialDshHome(): string | undefined {
  return resolvePiAiCredentialHome();
}

/**
 * Host/operator room control. Writes deadline-request.json into the room identity
 * directory that a live Host is polling — no Solver capability or HMAC minting.
 */
async function runRoomCommand(args: ReturnType<typeof parseCliArgs>): Promise<void> {
  if (args.roomAction === "status") {
    runRoomStatus(args);
    return;
  }
  const challengeId = args.challengeId ?? args.caseName;
  if (!challengeId) throw new Error(`silver room ${args.roomAction ?? "command"} requires --challenge <id> (or --case)`);
  if (!args.replayPath && !args.roomWorkDir) {
    throw new Error(`silver room ${args.roomAction ?? "command"} requires --replay <path> or --room-work-dir <slot>`);
  }
  const roomClockDir = roomCommandClockDir({
    challengeId,
    ...(args.roomWorkDir ? { roomWorkDir: args.roomWorkDir } : {}),
    ...(args.replayPath ? { replayPath: args.replayPath } : {}),
  });
  if (args.roomAction === "ui") {
    await runRoomOperatorUi({
      roomClockDir,
      challengeId,
      ...(args.uiPort !== undefined ? { port: args.uiPort } : {}),
      ...(args.uiNoOpen ? { noOpen: true } : {}),
    });
    return;
  }
  if (args.roomAction === "message") {
    if (args.operatorMessage !== undefined && args.operatorMessageFile !== undefined) {
      throw new Error("pass --message or --message-file, not both");
    }
    const message = args.operatorMessageFile
      ? fs.readFileSync(path.resolve(args.operatorMessageFile), "utf8")
      : args.operatorMessage;
    if (!message?.trim()) throw new Error("silver room message requires --message TEXT or --message-file PATH");
    const { request } = writeOperatorRoomMessage(roomClockDir, {
      message,
      ...(args.target ? { target: args.target } : {}),
      ...(args.operatorMode ? { mode: args.operatorMode } : {}),
      ttlMs: OPERATOR_ROOM_MESSAGE_TTL_MS,
    });
    const deadline = Date.now() + OPERATOR_ROOM_MESSAGE_TTL_MS;
    while (Date.now() < deadline) {
      const result = readOperatorRoomMessageResult(roomClockDir, request.requestId);
      if (result) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    withdrawOperatorRoomMessage(roomClockDir, request.requestId);
    throw new Error(
      `timed out waiting for the live DSH Team to accept operator room message ${request.requestId}`,
    );
  }
  if (args.roomAction !== "set-deadline") throw new Error("use silver room set-deadline|status|message|ui");
  if (args.deadlineAt !== undefined && args.extendMs !== undefined) {
    throw new Error("pass --deadline-at or --extend-ms, not both");
  }
  if (args.deadlineAt === undefined && args.extendMs === undefined) {
    throw new Error("silver room set-deadline requires --deadline-at <iso|ms> or --extend-ms <n>");
  }
  let deadlineAtMs: number | undefined;
  if (args.deadlineAt !== undefined) {
    const raw = args.deadlineAt.trim();
    const asNumber = Number(raw);
    deadlineAtMs = Number.isFinite(asNumber) && /^\d+(\.\d+)?$/.test(raw) ? Math.floor(asNumber) : Date.parse(raw);
    if (!Number.isFinite(deadlineAtMs)) throw new Error(`invalid --deadline-at ${args.deadlineAt}`);
  }
  const { request } = writeRoomDeadlineRequest(roomClockDir, {
    ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
    ...(args.extendMs !== undefined ? { extendMs: args.extendMs } : {}),
    ttlMs: 5_000,
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = readRoomDeadlineResult(roomClockDir, request.requestId);
    if (result && result.requestId === request.requestId) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Withdraw only this requestId — never unlink a newer publisher's pending request.
  withdrawRoomDeadlineRequest(roomClockDir, request.requestId);
  writeRoomDeadlineResult(roomClockDir, {
    requestId: request.requestId,
    ok: false,
    error: `timed out waiting for live Host to apply deadline request ${request.requestId}; request withdrawn`,
    appliedAt: new Date().toISOString(),
  });
  throw new Error(
    `timed out waiting for live Host to apply deadline request ${request.requestId} in ${roomClockDir}; is a room running for this identity?`,
  );
}

function runRoomStatus(args: ReturnType<typeof parseCliArgs>): void {
  const challengeId = args.challengeId ?? args.caseName;
  if (!challengeId) throw new Error("silver room status requires --challenge <id> (or --case)");
  if (!args.replayPath && !args.roomWorkDir) {
    throw new Error("silver room status requires --replay <path> or --room-work-dir <slot>");
  }
  const roomClockDir = roomCommandClockDir({
    challengeId,
    ...(args.roomWorkDir ? { roomWorkDir: args.roomWorkDir } : {}),
    ...(args.replayPath ? { replayPath: args.replayPath } : {}),
  });
  const clock = readRoomClock(roomClockPath(roomClockDir, challengeId));
  const members = readRoomMembers(roomMembersPath(roomClockDir, challengeId));
  if (!members) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schema: "silver.room-status.v1",
          roomId: challengeId,
          challengeId,
          ...(clock
            ? {
                deadline: {
                  startedAt: clock.startedAt,
                  deadlineAt: clock.deadlineAt,
                  budgetMs: clock.budgetMs,
                  remainingMs: roomRemainingMs(clock),
                  expired: roomExpired(clock),
                },
              }
            : {}),
          members: [],
          updatedAt: new Date().toISOString(),
          note: clock
            ? "room clock exists but no room-members roster yet"
            : "no room has been created yet for this replay/challenge",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const projection = projectRoomStatus({
    members,
    ...(clock ? { clock } : {}),
  });
  process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
}

async function runAuth(args: ReturnType<typeof parseCliArgs>): Promise<void> {
  const provider = args.authProvider;
  const action = args.authAction;
  if (!provider || !action) throw new Error("use silver auth login|status <provider>");
  const dshHome = resolvePiAiCredentialHome();
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(await inspectPiAiAuthorization(provider, dshHome), null, 2)}\n`);
    return;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const status = await authorizePiAiProvider({
      provider,
      dshHome,
      signal: controller.signal,
      interaction: {
        notify(notice) {
          process.stdout.write(`${notice.message}\n`);
          if (notice.url) process.stdout.write(`Open: ${notice.url}\n`);
          if (notice.code) process.stdout.write(`Code: ${notice.code}\n`);
        },
        async prompt(prompt) {
          if (prompt.kind === "secret") {
            throw new Error("this terminal login entry accepts OAuth only, not API-key prompts");
          }
          if (prompt.kind === "select") {
            for (const option of prompt.options) process.stdout.write(`${option.id}: ${option.label}\n`);
          }
          return terminal.question(`${prompt.message} `, { signal: prompt.signal });
        },
      },
    });
    process.stdout.write(`${provider} subscription authorized in ${status.dshHome}\n`);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    terminal.close();
  }
}

function liveDshHomeOptions(input: {
  skills?: Exclude<ReturnType<typeof liveSkillMountFromConfig>, boolean | undefined>;
  dshHomeForPatch?: string;
  pluginModuleRepoRoot?: string;
  personaPrefix?: string;
  swarmRoom?: boolean;
  llmRequest?: LiveDshHomeOptions["llmRequest"];
  commanderSurface?: boolean;
  externalSearch?: false;
  hint?: boolean;
  domain?: LiveDshHomeOptions["domain"];
  role?: LiveDshHomeOptions["role"];
  formalTeam?: boolean;
  roomCompaction?: boolean;
}): LiveDshHomeOptions | undefined {
  const opts: LiveDshHomeOptions = {};
  if (input.skills) opts.skills = input.skills;
  if (input.dshHomeForPatch) opts.dshHomeForPatch = input.dshHomeForPatch;
  if (input.pluginModuleRepoRoot) opts.pluginModuleRepoRoot = input.pluginModuleRepoRoot;
  if (input.personaPrefix) opts.personaPrefix = input.personaPrefix;
  if (input.swarmRoom) opts.swarmRoom = true;
  if (input.llmRequest) opts.llmRequest = input.llmRequest;
  if (input.commanderSurface) opts.commanderSurface = true;
  if (input.externalSearch === false) opts.externalSearch = false;
  if (input.hint) opts.hint = true;
  if (input.domain) opts.domain = input.domain;
  if (input.role) opts.role = input.role;
  if (input.formalTeam) opts.formalTeam = true;
  if (input.roomCompaction) opts.roomCompaction = true;
  const credentialDshHome = liveCredentialDshHome();
  if (credentialDshHome) opts.credentialDshHome = credentialDshHome;
  const testOnlyRaw = testOnlyFsSearchRawOutputMaxBytes(process.env);
  if (testOnlyRaw !== undefined) opts.testOnlyFsSearchRawOutputMaxBytes = testOnlyRaw;
  if (testOnlyLocalWebEnabled(process.env)) opts.testOnlyLocalWeb = true;
  return Object.keys(opts).length ? opts : undefined;
}

function ctfRoomAssemblyForRun(
  config: ReturnType<typeof loadSilverConfig>,
  args: ReturnType<typeof parseCliArgs>,
  hint: boolean,
): RoomAssembly {
  const formalTeam =
    resolveRoomMode({
      config,
      ...(args.profile !== undefined ? { profile: args.profile } : {}),
      ...(args.officialTeam ? { officialTeam: true } : {}),
      ...(args.team !== undefined ? { team: args.team } : {}),
    }).mode === "swarm";
  return buildRoomAssembly("ctf", { formalTeam, hint });
}

async function runCase(input: {
  args: ReturnType<typeof parseCliArgs>;
  config: ReturnType<typeof loadSilverConfig>;
  profile: string;
  runtime: ChallengeRuntime;
  platform: MockPlatform;
  row: CaseSpec;
  root: string;
  execDir: string;
}): Promise<Record<string, unknown>> {
  const { config, profile, runtime, platform, row, root } = input;
  const challenge = row.challenge;
  const plan = resolveAttemptPlan({
    config,
    profile,
    agent: "ctf-solver",
    challengeId: challenge.id,
  });
  const slices = plan.map(toAttemptSlice);
  const trailing = challenge.id === "web-flag-holdout" ? "/" : "";
  runtime.startChallenge(
    {
      missionId: "mission-mini",
      challengeId: challenge.id,
      flagCount: challenge.flagCount,
      autonomy: "autonomous",
      targetUrl: `${platform.origin()}/challenge/${challenge.id}${trailing}`,
      workspace: path.join(root, "challenges", challenge.id),
      track: "jeopardy",
      flagPattern: config.competition.flagPattern,
      hintPolicy: config.competition.hintPolicy,
      ...(config.competition.inScope.length > 0 ? { inScopeUrls: config.competition.inScope } : {}),
    },
    {
      policy: profile === "cheap-swarm" ? "cheap-swarm" : "single-fast",
      attemptSlices: slices,
      // The local deterministic fixture exercises legacy Host CAS directly.
      // Live solver rooms never receive this internal tool surface.
      toolsPreset: "internal",
    },
  );
  const ids = runtime.bootstrapAttempts(challenge.id, { containerId: "c".repeat(64) });
  const first = ids[0];
  if (!first) throw new Error("no attempts bootstrapped");
  const outcomes =
    challenge.id === "web-flag-holdout"
      ? await runtime.runFixtureHoldoutSolve(first)
      : await runtime.runFixtureWebSolve(first);
  return {
    caseId: challenge.id,
    contamination: row.contamination,
    model: plan.map(publicModel),
    outcomes,
    snapshot: runtime.snapshot(challenge.id),
  };
}

function toAttemptSlice(resolved: ResolvedModelCall): AttemptSlice {
  const slice: AttemptSlice = {
    presentation: resolved.presentation,
    model: resolved.model,
    effort: resolved.effort,
    provider: resolved.provider,
  };
  if (resolved.baseUrl) slice.baseUrl = resolved.baseUrl;
  if (resolved.apiKeyRef) slice.apiKeyRef = resolved.apiKeyRef;
  if (resolved.profile) slice.profile = resolved.profile;
  if (resolved.seed) slice.seed = resolved.seed;
  return slice;
}

function publicModel(resolved: ResolvedModelCall): Record<string, string> {
  const row: Record<string, string> = {
    agent: resolved.agent,
    provider: resolved.provider,
    model: resolved.model,
    effort: resolved.effort,
    presentation: resolved.presentation,
  };
  if (resolved.profile) row.profile = resolved.profile;
  return row;
}

function repoRootFromCli(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function loadCliSilverConfig(explicitPath?: string): SilverConfig {
  return loadProductSilverConfig(explicitPath, process.cwd(), repoRootFromCli());
}

function liveSkillsEnabled(args: ReturnType<typeof parseCliArgs>): boolean {
  return args.skills !== false;
}

function missionChallenge(mission: MissionBrief): import("@silver/platform-mock").MockChallenge {
  return {
    id: mission.challengeId,
    flagCount: 1,
    // Empty flags: --mission/--target records verified candidates, no platform accept.
    flags: [],
    html: `<!doctype html><p>${mission.title}</p>\n`,
  };
}

function seedLiveMaterials(dest: string, args: ReturnType<typeof parseCliArgs>): string[] {
  return seedAdjacentMaterials(dest, [adjacentMaterialsDir(args.configPath), adjacentMaterialsDir(args.mission)]);
}

function commanderMaterialsNotice(materials: readonly string[]): string {
  if (materials.length === 0) return "";
  return [
    "Mission-adjacent files are available through ordinary DSH tools:",
    ...materials.map((ref) => `- ${ref}`),
    "Inspect them as needed and name the files relevant to each target in that Room's childMission. A Room may see the shared material pool; its childMission defines which files belong to its task.",
  ].join("\n");
}

function liveSolveTask(targetUrl: string, assembly: RoomAssembly, mission?: MissionBrief): string {
  const acceptanceLine = roomAssemblyAcceptanceText(assembly);
  if (mission) {
    return [
      "You are running a long-running task from an operator Mission.",
      "Read the task brief and acceptance contract, then use room_info and begin the responsibilities of your assigned room role.",
      "Do not wait for an operator to begin your assigned room task.",
      "The Commander-authored childMission is the complete task contract for this Room.",
      "Files under materials/ are a shared Mission material pool. Only files named by the childMission are authoritative task material for this Room.",
      acceptanceLine,
      "Bash starts in the attempt workspace; omit workdir by default and write evidence under relative scratch/ paths.",
      `Initial entry: ${targetUrl}`,
      "",
      mission.body,
    ].join("\n");
  }
  const objective = `Work on the task at ${targetUrl}.`;
  return `${objective} Use room_info, then begin the responsibilities of your assigned room role. Let evidence, current Intel, and the DSH Team task board guide whether to continue, revise, or change a route. Bash starts in the attempt workspace; omit workdir by default and write evidence under relative scratch/ paths. ${acceptanceLine}`;
}

function liveMemberSolveTask(input: {
  baseTask: string;
  memberId: string;
  role: "lead" | "worker";
  duty: string;
  teamSpecs: TeamMemberSpec[];
  challengeId: string;
  teamMode: boolean;
  officialTeam?: boolean;
  freshAttempt?: boolean;
  domain?: RoomDomain;
}): string {
  if (!input.teamMode) return input.baseTask;
  const identity = [
    `Formal room member identity: roomId=${input.challengeId} memberId=${input.memberId} role=${input.role} duty=${input.duty}.`,
    "Process/session/member ids are distinct; keep using this memberId across resumes.",
    "The shared room goal and acceptance contract apply to every member. Your role defines your responsibility and mounted tool permissions.",
  ];
  if (input.officialTeam) {
    const handoff = input.freshAttempt && input.role === "lead"
      ? [
          "Fresh-attempt handoff: this is a new DSH Team root, so the prior roster, private messages, Status, and Team tasks are not mounted. Read durable Feed, Intel, platform facts, and acceptance progress. If this attempt has no prior-state summary in Feed, post exactly one concise public summary, then rebuild current Team tasks and owners before coordinating unresolved work.",
        ]
      : [];
    return [...identity, ...handoff, "", input.baseTask].join("\n");
  }
  const roster = input.teamSpecs
    .map((row) => `- ${row.memberId} (${row.role}, attempt ${row.attemptId}, duty=${row.duty ?? row.role})`)
    .join("\n");
  return [...identity, "Room members:", roster, "", input.baseTask].join("\n");
}

function liveRaceRacerTask(input: {
  memberId: string;
  attemptId: string;
  workers: number;
  baseTask: string;
}): string {
  return [
    `You are Racer ${input.memberId} (attempt ${input.attemptId}) of ${input.workers} in this Room.`,
    "This is your own session, context, and work directory. Host does not deliver Chat, Status, or Intel from other Racers.",
    "A candidate you report is not the challenge being finished. Only a platform-accepted result stops every Racer.",
    "",
    input.baseTask,
  ].join("\n");
}

function liveGoalBoundWorkerReviewPrompt(challengeId: string, reason: string): string {
  return [
    `Commander reconciliation for room ${challengeId}: the external platform still reports pending.`,
    reason,
    "Continue this same challenge in this same DSH session and original room deadline.",
    "Do not list, start, or select other challenges.",
  ].join("\n");
}

function whenAborted(signal?: AbortSignal): Promise<void> {
  return whenAbortedCancelable(signal).promise;
}

function whenAbortedCancelable(signal?: AbortSignal): { promise: Promise<void>; cancel: () => void } {
  if (!signal) return { promise: new Promise(() => undefined), cancel() {} };
  if (signal.aborted) return { promise: Promise.resolve(), cancel() {} };
  let onAbort: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cancel() {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function isNaturalLiveIdle(result: {
  status: number;
  closed?: boolean;
  stopReason?: LiveRunStopReason;
  acpStopReason?: string;
}): boolean {
  return (
    result.status === 0 &&
    result.stopReason === undefined &&
    (result.closed === true || result.acpStopReason === "end_turn")
  );
}

function commanderCandidateReportWakePrompt(wake: {
  targetId: string;
  status: "reported" | "duplicate";
  reviewGenerationId?: number;
}): string {
  return `An active Worker candidate report is ready: ${JSON.stringify({
    targetId: wake.targetId,
    reportStatus: wake.status,
    ...(wake.reviewGenerationId !== undefined ? { reviewGenerationId: wake.reviewGenerationId } : {}),
  })}. Refresh that target's external platform state now, then call record_target_result with completed or pending and the same reviewGenerationId from this wake. completed closes the Project and every Group root.`;
}

function liveMemberWakeIntelPrompt(
  memberId: string,
  notices: Array<{
    intelId: string;
    previousVersion: number;
    currentVersion: number;
    status: string;
    kind: string;
    commentIds?: string[];
    unreadCommentCount?: number;
  }>,
): string {
  const lines = notices.slice(0, 8).map((row) => {
    const commentIds = row.commentIds?.join(",");
    const comments = row.unreadCommentCount
      ? `; ${row.unreadCommentCount} unread comment(s)${commentIds ? ` (${commentIds})` : ""}`
      : "";
    if (row.kind === "commented") {
      return `- intelId=${row.intelId} has new comment(s) about v${row.currentVersion} status=${row.status}${comments}; call intel_read with this intelId (includeHistory) then continue.`;
    }
    return `- intelId=${row.intelId} ${row.kind}: was v${row.previousVersion}, now v${row.currentVersion} status=${row.status}${comments}; call intel_read with this intelId (includeHistory) then continue.`;
  });
  return [
    `Host wake for formal member ${memberId}: public Intel updates are pending.`,
    "Bounded notices (not full history):",
    ...lines,
    "Read only the listed intelIds. Do not busy-poll. Do not treat intel as platform accepted.",
  ].join("\n");
}

type MemberWakeEvent =
  | { kind: "intel" }
  | { kind: "host_control" }
  | { kind: "convergence" }
  | { kind: "stop" };

/** Bounded Host wake: queue while busy; one waiter while idle; stop on room close. */
class FormalMemberWakeHub {
  private readonly waiters = new Map<string, (event: MemberWakeEvent) => void>();
  private readonly queued = new Map<string, Exclude<MemberWakeEvent, { kind: "stop" }>>();
  private readonly busy = new Set<string>();
  /** Members that have entered this hub via markBusy, markIdle, or wait. */
  private readonly owned = new Set<string>();
  private stopped = false;

  markBusy(memberId: string): void {
    this.owned.add(memberId);
    this.busy.add(memberId);
  }

  markIdle(memberId: string): void {
    this.owned.add(memberId);
    this.busy.delete(memberId);
  }

  /** Drop busy/waiter/queue ownership so other members can quiesce after this member exits. */
  release(memberId: string): void {
    this.owned.delete(memberId);
    this.busy.delete(memberId);
    this.waiters.delete(memberId);
    this.queued.delete(memberId);
  }

  signal(memberId: string, event: Exclude<MemberWakeEvent, { kind: "stop" }>): void {
    if (this.stopped || !this.owned.has(memberId)) return;
    type WakeWork = Exclude<MemberWakeEvent, { kind: "stop" }>;
    // Intel wakes carry only a reason; notices are resolved from the store at prompt time.
    const incoming: WakeWork = event.kind === "intel" ? { kind: "intel" } : event;
    const prefer = (a: WakeWork, b: WakeWork): WakeWork => {
      const rank = (row: WakeWork): number => {
        // Host control outranks room work. Social delivery is owned by DSH Team.
        if (row.kind === "convergence" || row.kind === "host_control") return 4;
        if (row.kind === "intel") return 1;
        return 0;
      };
      if (rank(b) > rank(a)) return b;
      if (rank(a) > rank(b)) return a;
      return a;
    };
    const enqueue = (): void => {
      const existing = this.queued.get(memberId);
      const next = existing ? prefer(existing, incoming) : incoming;
      this.queued.set(memberId, next);
    };
    if (this.busy.has(memberId)) {
      enqueue();
      return;
    }
    const waiter = this.waiters.get(memberId);
    if (waiter) {
      this.waiters.delete(memberId);
      this.busy.add(memberId);
      waiter(incoming);
      return;
    }
    enqueue();
  }

  hasQueued(): boolean {
    return this.queued.size > 0;
  }

  hasWaiters(): boolean {
    return this.waiters.size > 0;
  }

  isBusyAny(): boolean {
    return this.busy.size > 0;
  }

  wait(memberId: string): Promise<MemberWakeEvent> {
    this.owned.add(memberId);
    if (this.stopped) return Promise.resolve({ kind: "stop" });
    const queued = this.queued.get(memberId);
    if (queued) {
      this.queued.delete(memberId);
      this.busy.add(memberId);
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.waiters.set(memberId, (event) => {
        if (event.kind !== "stop") this.busy.add(memberId);
        resolve(event);
      });
    });
  }

  stopAll(): void {
    this.stopped = true;
    for (const [memberId, waiter] of this.waiters) {
      this.waiters.delete(memberId);
      waiter({ kind: "stop" });
    }
    this.queued.clear();
  }
}

function liveModelRouteFingerprint(row: ResolvedModelCall): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider: row.provider,
        model: row.model,
        llmPlugin: row.llmPlugin,
        auth: row.auth,
        baseUrl: row.baseUrl ?? null,
        apiKeyRef: row.apiKeyRef ?? null,
        api: row.api ?? null,
        effort: row.effort,
        presentation: row.presentation,
        reasoningEfforts: row.reasoningEfforts ?? null,
        contextWindow: row.contextWindow ?? null,
        maxTokens: row.maxTokens ?? null,
        compat: row.compat ?? null,
      }),
    )
    .digest("hex");
}

function liveHostFsRuntimeRoot(input: {
  replayPath?: string;
  challengeId: string;
  targetUrl: string;
  plan: ResolvedModelCall[];
  rootSession?: number;
  roomWorkDir?: string;
}): { root: string; persistent: boolean; taskKey: string } {
  if (!input.replayPath && !input.roomWorkDir) {
    return {
      root: fs.mkdtempSync(path.join(os.tmpdir(), "silver-live-hostfs-")),
      persistent: false,
      taskKey: `ephemeral:${Date.now()}`,
    };
  }
  const task = liveTaskIdentity({
    challengeId: input.challengeId,
    ...(input.roomWorkDir ? { roomWorkDir: input.roomWorkDir } : {}),
    ...(input.replayPath ? { replayPath: input.replayPath } : {}),
  });
  // Runtime root includes rootSession + model so parallel roots don't clash on disk,
  // but taskKey (without those) ties the shared room clock and recovery identity.
  const identity = JSON.stringify({
    taskKey: task.key,
    rootSession: input.rootSession ?? 0,
    plan: input.plan.map(liveModelRouteFingerprint),
  });
  const id = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const root = path.join(task.storageBase, ".silver-runtime", id);
  fs.mkdirSync(root, { recursive: true });
  return { root, persistent: true, taskKey: task.key };
}

function liveEntry(args: ReturnType<typeof parseCliArgs>): "case" | "mission" | "target" {
  if (args.mission) return "mission";
  if (args.target) return "target";
  return "case";
}

function liveRunLedger(input: {
  args: ReturnType<typeof parseCliArgs>;
  mission: MissionBrief | undefined;
  contestSubmit?: boolean;
  challengeId: string;
  startedAt: Date;
  dshStatus: number;
  dshSessionId?: string;
  dshProcessRestarts?: number;
  dshSessionResumes?: number;
  dshHostWakes?: number;
  turnsPath: string;
  promptSkillGestures?: string[];
  wirePath?: string;
  runtime: ChallengeRuntime;
  stopReason?: LiveRunStopReason;
  acpStopReason?: string;
  dshRuntime?: DshRuntimeFingerprint;
  dshHome?: string;
}): ReturnType<typeof buildLiveRunLedger> {
  return buildLiveRunLedger({
    caseId: input.challengeId,
    entry: liveEntry(input.args),
    acceptanceMode: liveAcceptanceMode(Boolean(input.mission), Boolean(input.contestSubmit)),
    startedAt: input.startedAt,
    dshStatus: input.dshStatus,
    ...(input.dshSessionId ? { dshSessionId: input.dshSessionId } : {}),
    ...(input.dshProcessRestarts ? { dshProcessRestarts: input.dshProcessRestarts } : {}),
    ...(input.dshSessionResumes ? { dshSessionResumes: input.dshSessionResumes } : {}),
    turns: observedLiveTurns(input.turnsPath, input.dshHome),
    ...(input.promptSkillGestures ? { promptSkillGestures: input.promptSkillGestures } : {}),
    snapshot: input.runtime.snapshot(input.challengeId),
    candidates: input.runtime.candidateRecords(input.challengeId),
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    ...(input.acpStopReason ? { acpStopReason: input.acpStopReason } : {}),
    ...(input.wirePath ? { wirePath: input.wirePath } : {}),
    ...(input.dshRuntime ? { dshRuntime: input.dshRuntime } : {}),
    ...(input.dshHome ? { dshHome: input.dshHome } : {}),
  });
}

function observedLiveTurns(turnsPath: string, dshHome: string | undefined) {
  return readObservedLiveTurns({
    brokerFile: turnsPath,
    ...(dshHome ? { sessionFile: path.join(path.dirname(dshHome), "session.jsonl") } : {}),
  });
}

function observedLiveActivity(turnsPath: string, dshHome: string | undefined): {
  turns: ReturnType<typeof readLiveTurns>;
  source: "broker-turns" | "session-tool-events";
} {
  const brokerTurns = readLiveTurns(turnsPath);
  if (brokerTurns.length > 0 || !dshHome) return { turns: brokerTurns, source: "broker-turns" };
  return {
    turns: readCtfSessionToolTurns(path.join(path.dirname(dshHome), "session.jsonl")),
    source: "session-tool-events",
  };
}

function finishLiveRun(input: {
  mission: MissionBrief | undefined;
  contestSubmit?: boolean;
  runtime: ChallengeRuntime;
  technicalProgress?: ReturnType<ChallengeRuntime["progressFor"]>;
  challengeId: string;
  attemptId?: string;
  dshStatus: number;
  stdout: string;
  stderr: string;
  ledger: ReturnType<typeof buildLiveRunLedger>;
  ledgerPath: string;
  evidenceRoot?: string;
  budget: LiveBudget;
  silent?: boolean;
}): void {
  writeLiveRunLedger(input.ledgerPath, input.ledger);
  const evidence = input.evidenceRoot ? mirrorLiveEvidence(input.evidenceRoot, input.ledgerPath) : undefined;
  const reports = writeLiveCandidateReport(
    input.ledgerPath,
    buildLiveCandidateReport({
      ledger: input.ledger,
      ...(input.technicalProgress ? { progress: input.technicalProgress } : {}),
      candidates: input.runtime.candidateRecords(input.challengeId),
      timeoutMs: input.budget.timeoutMs,
      maxTurns: input.budget.maxTurns,
      ...(evidence ? { evidence } : {}),
    }),
  );
  const row = summarizeLiveRunWithReport(input.ledger, reports.json);
  if (!input.silent) {
    process.stdout.write(`silver-live-replay ${JSON.stringify(row)}\n`);
    process.stdout.write(`silver-live-report ${reports.json}\n`);
    process.stdout.write(formatReplaySummary([row]));
  }
  const stopped = isBudgetOrTerminalStop(input.ledger.stopReason);
  if (input.dshStatus !== 0 && !stopped) {
    throw new Error(input.stderr || input.stdout || `official dsh exited ${String(input.dshStatus)}`);
  }
  // firstTool / skillFirst / skillCalls stay observational on the ledger.
  // Production success is Host CAS / candidate-report only — not tool order.
  const snapshot = input.runtime.snapshot(input.challengeId);
  if (input.mission && !input.contestSubmit) {
    if (!input.silent) {
      process.stdout.write(
        `${JSON.stringify(
          liveMissionReport({
            snapshot,
            dshStatus: input.dshStatus,
            ...(input.technicalProgress ? { progress: input.technicalProgress } : {}),
            candidates: input.runtime.candidateRecords(input.challengeId),
          }),
          null,
          2,
        )}\n`,
      );
    }
    assertMissionCandidateReport(input.ledger);
    return;
  }
  if (!input.contestSubmit) {
    assertLiveHostAccepted(snapshot);
    assertCaseSolvedByHostCas(input.ledger);
  }
}

function isBudgetOrTerminalStop(reason: LiveRunStopReason | undefined): boolean {
  return (
    reason === "host_terminal_stop" ||
    reason === "timeout" ||
    reason === "max_turns" ||
    reason === "stagnation_checkpoint" ||
    reason === "candidate_checkpoint" ||
    reason === "llm_transport_failure" ||
    reason === "coordination_failure" ||
    reason === "interrupted" ||
    reason === "bootstrap_degraded" ||
    reason === "defer_unavailable"
  );
}

/** Product-test hook: count platform POSTs without hardcoding a contest vendor. */
function testContestSubmitHook(): ContestSubmitHook | undefined {
  const url = process.env.SILVER_TEST_CONTEST_SUBMIT_URL?.trim();
  if (!url) return undefined;
  return async ({ challengeId, fingerprint, raw }) => {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, fingerprint, raw }),
      });
    } catch {
      /* test hook is observational */
    }
    return {
      correct: false,
      awarded: 0,
      cumulativeScore: 0,
      correctFlagCount: 0,
      totalFlagCount: 1,
    };
  };
}

function liveBudgetFromArgs(
  config: ReturnType<typeof loadSilverConfig>,
  args: ReturnType<typeof parseCliArgs>,
): LiveBudget {
  const override: { timeoutMs?: number; maxTurns?: number } = {};
  if (args.timeoutMs !== undefined) override.timeoutMs = args.timeoutMs;
  if (args.maxTurns !== undefined) override.maxTurns = args.maxTurns;
  return resolveLiveBudget(config, override);
}

function liveWireDebugPath(replayPath: string | undefined, fallbackDir: string): string {
  if (!replayPath) return path.join(fallbackDir, "llm-wire.jsonl");
  if (replayPath.endsWith(path.sep)) return path.join(replayPath, "llm-wire.jsonl");
  try {
    if (fs.existsSync(replayPath) && fs.statSync(replayPath).isDirectory()) {
      return path.join(replayPath, "llm-wire.jsonl");
    }
  } catch {
    /* use dirname */
  }
  return path.join(path.dirname(replayPath), "llm-wire.jsonl");
}

function liveCaseReplayPath(replayPath: string | undefined, caseId: string): string | undefined {
  if (!replayPath) return undefined;
  const safeId = caseId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (replayPath.endsWith(path.sep)) return path.join(replayPath, safeId, "live-run-ledger.json");
  try {
    if (fs.existsSync(replayPath) && fs.statSync(replayPath).isDirectory()) {
      return path.join(replayPath, safeId, "live-run-ledger.json");
    }
  } catch {
    /* use file stem */
  }
  const ext = path.extname(replayPath);
  if (ext.toLowerCase() !== ".json") {
    return path.join(replayPath, safeId, "live-run-ledger.json");
  }
  const dir = path.dirname(replayPath);
  const base = path.basename(replayPath, ext);
  return path.join(dir, `${base}-${safeId}${ext}`);
}

function liveCaseAllSummary(results: ContestSolveResult[]): Record<string, unknown> {
  const cases = results.map((result) => {
    const row: Record<string, unknown> = {
      case: result.targetId,
      outcome: result.outcome ?? "failed",
      wallTimeMs: result.wallTimeMs ?? 0,
      turns: result.turns ?? 0,
      toolCalls: result.toolCalls ?? 0,
    };
    if (result.stopReason) row.stopReason = result.stopReason;
    if (result.replayPath) row.replayPath = result.replayPath;
    if (result.reportPath) row.reportPath = result.reportPath;
    if (result.error) row.error = result.error;
    return row;
  });
  return {
    schema: "silver.live-case-all.v1",
    n: results.length,
    solved: results.filter((result) => result.outcome === "solved").length,
    reported: results.filter((result) => result.outcome === "reported").length,
    failed: results.filter((result) => result.outcome !== "solved" && result.outcome !== "reported").length,
    cases,
  };
}

function materialsPrefix(bundle?: ChallengeBundle, _hintOpen = false): string {
  return bundle ? `${formatChallengeBundle(bundle)}\n\n` : "";
}

function scopeForChallenge(targetUrl: string, bundle?: ChallengeBundle): string[] {
  if (bundle) return [...new Set(bundle.targetEndpoints.map((endpoint) => endpoint.trim()).filter(Boolean))];
  return /^https?:\/\//i.test(targetUrl) ? [targetUrl] : [];
}

function liveSolveUrls(
  origin: string,
  challengeId: string,
  config: ReturnType<typeof loadSilverConfig>,
  mission: MissionBrief | undefined,
  agent = false,
): { targetUrl: string; inScope: string; agentUrl?: string } {
  if (mission) {
    return { targetUrl: mission.target, inScope: mission.inScope.join(",") };
  }
  const trailing = challengeId === "web-flag-holdout" ? "/" : "";
  const targetUrl = `${origin}/challenge/${challengeId}${trailing}`;
  const extra = [...config.competition.inScope];
  const agentUrl = agent ? `${origin}/agent/${challengeId}` : undefined;
  if (agentUrl) extra.push(agentUrl);
  const out: { targetUrl: string; inScope: string; agentUrl?: string } = {
    targetUrl,
    inScope: liveContestScope(origin, extra),
  };
  if (agentUrl) out.agentUrl = agentUrl;
  return out;
}

function searchOffOption(config: SilverConfig): { externalSearch: false } | Record<string, never> {
  return config.runtime.externalSearch ? {} : { externalSearch: false };
}

function writeMissionBriefFile(dir: string, mission?: MissionBrief, opts?: { room?: boolean }): void {
  const body = mission?.body;
  if (!body) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mission-brief.md"), opts?.room ? `${body.trim()}\n` : body);
}

function writeChallengeMaterialsFile(dir: string, mission?: MissionBrief, hintOpen = false): string | undefined {
  if (!mission?.challengeBundle) return undefined;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "challenge-materials.txt");
  fs.writeFileSync(file, materialsPrefix(mission.challengeBundle, hintOpen));
  return file;
}

function seededRandom(seed: string): () => number {
  let state = 0x811c9dc5;
  for (const ch of seed) {
    state ^= ch.charCodeAt(0);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MissionCommanderSummary {
  schema: "silver.mission-commander-summary.v1";
  missionDone: boolean;
  terminalKind?: string;
  reason?: string;
  configured: boolean;
  maxConcurrent?: number;
  queued: number;
  settled: number;
  commanderSessionId?: string;
  commanderHostWakes: number;
  commanderTransportResumes: number;
  wallTimeMs: number;
  results: SlotResult[];
  targetReviews: MissionTargetReview[];
  unresolvedTargetIds: string[];
}

type MissionTargetReview = MissionTargetReviewRow;

interface MissionCommanderState {
  schema: "silver.mission-commander-state.v1";
  missionFingerprint: string;
  status: "active" | "interrupted" | "terminal";
  missionDone: boolean;
  terminalKind?: string;
  reason?: string;
  /** True only when the terminal result came from a fully settled --sample-size slice. */
  sampleSizeSettled?: boolean;
  maxConcurrent?: number;
  /** New-run room capacity. Legacy checkpoints may only have maxConcurrent. */
  maxConcurrentRooms?: number;
  commanderSessionId?: string;
  commanderHostWakes: number;
  commanderTransportResumes: number;
  startedAt: string;
  /**
   * Legacy read-only. Written by old mission_configure checkpoints.
   * New runs must not write this field.
   */
  missionConfiguredAt?: string;
  /** First successful Commander control tool. mission_status and prose do not set it. */
  commanderControlProgressAt?: string;
  updatedAt: string;
  results: SlotResult[];
  targetReviews?: MissionTargetReview[];
  projects?: ProjectSnapshot[];
  pendingCandidateTargetIds?: string[];
  /** Durable latest/acked review generations per pending candidate target. */
  candidateReviewGenerations?: {
    targets: Record<string, { latestReviewGeneration: number; ackedReviewGeneration: number; unackedReprompts?: number }>;
  };
  /** sample-size admissions that survive a crash between reserve, platform start, and queue. */
  platformAdmissions?: PlatformAdmissionRecord[];
  /** Target ids the Commander has discovered from the Mission's platform. */
  discoveredTargetIds?: string[];
  /** Contest targets whose current admitted platform resource was released successfully. */
  closedContestTargetIds?: string[];
  /** In-flight room allocation clocks and last observed platform counts survive a Host restart. */
  allocationStates?: MissionAllocationState[];
}

/** Existing room clock only. Does not create directories or gift a fresh budget. */
function readExpiredMissionRoomClock(contestDir: string, targetId: string): { deadlineAt: string } | undefined {
  if (!targetId || !/^[A-Za-z0-9._-]+$/.test(targetId)) return undefined;
  const targetDir = path.join(contestDir, "targets", targetId);
  const identity = liveTaskIdentity({ challengeId: targetId, roomWorkDir: targetDir, replayPath: targetDir });
  const clock = readRoomClock(roomClockPath(path.join(identity.storageBase, ".silver-room", identity.shortId), targetId));
  return clock && roomExpired(clock) ? { deadlineAt: clock.deadlineAt } : undefined;
}

function missionCommanderFingerprint(
  mission: MissionBrief,
  resolved: ResolvedModelCall,
  contestAdapter?: ContestAdapterIdentity,
  track: TrackKind = "jeopardy",
  autonomy: "autonomous" | "human_assisted" = "autonomous",
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: mission.title,
        target: mission.target,
        inScope: mission.inScope,
        challengeId: mission.challengeId,
        body: mission.body,
        flagPattern: mission.flagPattern ?? null,
        hintPolicy: mission.hintPolicy ?? null,
        track,
        autonomy,
        routeFingerprint: liveModelRouteFingerprint(resolved),
        ...(contestAdapter ? { contestAdapter } : {}),
      }),
    )
    .digest("hex");
}

function readMissionCommanderState(file: string, missionFingerprint: string): MissionCommanderState | undefined {
  if (!fs.existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Mission Commander recovery state is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Mission Commander recovery state is invalid");
  }
  const row = parsed as Record<string, unknown>;
  if (row.missionFingerprint !== missionFingerprint) {
    throw new Error("replay 属于另一份 Mission");
  }
  if (
    row.schema !== "silver.mission-commander-state.v1" ||
    !["active", "interrupted", "terminal"].includes(String(row.status)) ||
    typeof row.missionDone !== "boolean" ||
    (row.sampleSizeSettled !== undefined && typeof row.sampleSizeSettled !== "boolean") ||
    typeof row.commanderHostWakes !== "number" ||
    typeof row.commanderTransportResumes !== "number" ||
    typeof row.startedAt !== "string" ||
    !Number.isFinite(Date.parse(row.startedAt)) ||
    !Array.isArray(row.results) ||
    (row.targetReviews !== undefined && !Array.isArray(row.targetReviews)) ||
    (row.projects !== undefined && !Array.isArray(row.projects)) ||
    (row.pendingCandidateTargetIds !== undefined &&
      (!Array.isArray(row.pendingCandidateTargetIds) ||
        row.pendingCandidateTargetIds.some((id) => typeof id !== "string"))) ||
    (row.candidateReviewGenerations !== undefined &&
      parseMissionCandidateReviewSnapshot(row.candidateReviewGenerations) === undefined) ||
    (row.platformAdmissions !== undefined && parsePlatformAdmissions(row.platformAdmissions) === undefined) ||
    (row.discoveredTargetIds !== undefined &&
      (!Array.isArray(row.discoveredTargetIds) ||
        row.discoveredTargetIds.some((id) => typeof id !== "string"))) ||
    (row.closedContestTargetIds !== undefined &&
      (!Array.isArray(row.closedContestTargetIds) ||
        row.closedContestTargetIds.some((id) => typeof id !== "string"))) ||
    (row.allocationStates !== undefined &&
      (!Array.isArray(row.allocationStates) ||
        row.allocationStates.some((state: MissionAllocationState) =>
          !state ||
          typeof state !== "object" ||
          Array.isArray(state) ||
          typeof state.targetId !== "string" ||
          !Number.isFinite(state.startedAtMs) ||
          (state.nextCheckpointMinute !== undefined && ![30, 60].includes(state.nextCheckpointMinute)) ||
          (state.previousPlatformProgress !== undefined &&
            (!state.previousPlatformProgress ||
              typeof state.previousPlatformProgress.observedAt !== "string" ||
              !Number.isFinite(state.previousPlatformProgress.accepted) ||
              !Number.isFinite(state.previousPlatformProgress.expected))),
        ))) ||
    (row.maxConcurrent !== undefined && !validPersistedRoomCapacity(row.maxConcurrent)) ||
    (row.maxConcurrentRooms !== undefined && !validPersistedRoomCapacity(row.maxConcurrentRooms)) ||
    (row.maxConcurrent !== undefined &&
      row.maxConcurrentRooms !== undefined &&
      row.maxConcurrent !== row.maxConcurrentRooms) ||
    (row.missionConfiguredAt !== undefined &&
      (typeof row.missionConfiguredAt !== "string" || !Number.isFinite(Date.parse(row.missionConfiguredAt)))) ||
    (row.commanderControlProgressAt !== undefined &&
      (typeof row.commanderControlProgressAt !== "string" || !Number.isFinite(Date.parse(row.commanderControlProgressAt))))
  ) {
    throw new Error("Mission Commander recovery state does not match this Mission");
  }
  return parsed as MissionCommanderState;
}

function validPersistedRoomCapacity(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 32;
}

function persistedRoomCapacity(recovered: MissionCommanderState | undefined): number | undefined {
  if (!recovered) return undefined;
  return recovered.maxConcurrentRooms ?? recovered.maxConcurrent;
}

function writeMissionCommanderState(file: string, state: MissionCommanderState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Natural-language Mission entry. Official DSH owns the Commander model loop;
 * Silver only binds mission lifecycle tools and launches independent worker roots.
 */
async function runMissionCommander(
  args: ReturnType<typeof parseCliArgs>,
  mission: MissionBrief,
  repoRoot: string,
  plan: ResolvedModelCall[],
  config: ReturnType<typeof loadSilverConfig>,
): Promise<MissionCommanderSummary> {
  const resolved = plan[0];
  if (!resolved) throw new Error("Mission Commander requires one resolved model route");
  const contestDir = path.resolve(
    args.replayPath && (args.replayPath.endsWith(path.sep) || !args.replayPath.endsWith(".json"))
      ? args.replayPath
      : args.replayPath
        ? path.dirname(args.replayPath)
        : path.join(repoRoot, ".silver-tmp", "missions", new Date().toISOString().replace(/[:.]/g, "-")),
  );
  const statePath = path.join(contestDir, "mission-session-state.json");
  const adapterIdentity = args.contestAdapter ? contestAdapterIdentity(args.contestAdapter) : undefined;
  if (
    adapterIdentity &&
    (config.competition.track === "awd" || config.competition.track === "agent-awd")
  ) {
    throw new Error(
      "--contest-adapter currently exposes the CTF submit/hint/close contract and cannot be mounted on an AWD Mission",
    );
  }
  const missionFingerprint = missionCommanderFingerprint(
    mission,
    resolved,
    adapterIdentity,
    config.competition.track,
    config.competition.autonomy,
  );
  readMissionReplayCheckpoint(contestDir, missionFingerprint);
  const contestAdapter = adapterIdentity
    ? await loadContestAdapter({ modulePath: adapterIdentity.modulePath, mission })
    : undefined;
  const roomKind = roomAcceptanceKind(config.competition.track, typeof contestAdapter?.submit === "function");
  const submitAvailable = roomKind === "ctf" && typeof contestAdapter?.submit === "function";
  const verifyAvailable = roomKind === "ctf" && typeof contestAdapter?.verify === "function";
  fs.mkdirSync(contestDir, { recursive: true });
  const eventLogPath = path.join(contestDir, "mission-events.jsonl");
  const summaryPath = path.join(contestDir, "mission-summary.json");
  const processStatePath = path.join(contestDir, "mission-process.json");
  const recovered = readMissionCommanderState(statePath, missionFingerprint);
  const reopenLegacyHostDeadline = Boolean(
    recovered?.status === "terminal" &&
      recovered.missionDone &&
      recovered.terminalKind === "deadline" &&
      recovered.reason === "Mission wall clock expired" &&
      (!fs.existsSync(eventLogPath) || !fs.readFileSync(eventLogPath, "utf8").includes('"type":"mission-done"')),
  );
  const reopenSupervisedFailure = Boolean(
    process.env.SILVER_MISSION_SUPERVISED === "1" &&
      recovered?.status === "terminal" &&
      recovered.missionDone &&
      !["all_completed", "sample_completed"].includes(
        recovered.terminalKind ?? "",
      ),
  );
  const reopenTerminal = reopenLegacyHostDeadline || reopenSupervisedFailure;
  const startedAt = recovered ? Date.parse(recovered.startedAt) : Date.now();
  const processStartedAt = recovered?.startedAt ?? new Date(startedAt).toISOString();
  const suspendAnchor = createSuspendClockAnchor();
  let idleSleepGuard: IdleSleepGuard | undefined;
  const persistProcessProjection = (
    status: DetachedMissionProcessState["status"],
    extra?: { signal?: NodeJS.Signals | string; reason?: string; exitCode?: number | null },
  ): void => {
    const now = new Date().toISOString();
    const ended = status === "interrupted" || status === "terminal" || status === "failed";
    let prior: Partial<DetachedMissionProcessState> = {};
    try {
      if (fs.existsSync(processStatePath)) {
        prior = JSON.parse(fs.readFileSync(processStatePath, "utf8")) as DetachedMissionProcessState;
      }
    } catch {
      prior = {};
    }
    const sameProcess = prior.pid === process.pid;
    if (ended) idleSleepGuard?.stop();
    const guardProjection = idleSleepGuard?.projection();
    writeDetachedMissionProcessState(processStatePath, {
      schema: "silver.detached-mission-process.v1",
      pid: process.pid,
      status,
      replayPath: contestDir,
      logPath: path.join(contestDir, "mission-console.log"),
      startedAt: processStartedAt,
      updatedAt: now,
      ...(guardProjection ? { idleSleepGuard: guardProjection } : {}),
      suspendGapMs: measureSuspendGapMs(suspendAnchor),
      ...(ended
        ? {
            endedAt: (sameProcess ? prior.endedAt : undefined) ?? now,
            ...(extra?.signal || (sameProcess && prior.signal)
              ? { signal: extra?.signal ?? prior.signal ?? null }
              : {}),
            ...(extra && "exitCode" in extra
              ? { exitCode: extra.exitCode ?? null }
              : sameProcess && prior.exitCode !== undefined
                ? { exitCode: prior.exitCode }
                : {}),
            ...(extra?.reason || (sameProcess && prior.reason) ? { reason: extra?.reason ?? prior.reason } : {}),
          }
        : {}),
    });
    updateDetachedMissionProcessStatus(status);
  };
  persistProcessProjection("running");
  const commanderRoot = path.join(contestDir, ".commander-runtime");
  fs.mkdirSync(commanderRoot, { recursive: true });
  const emit = (event: Record<string, unknown>): void => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(eventLogPath, `${line}\n`);
    process.stdout.write(`silver-mission ${line}\n`);
  };
  const projectIdleSleepGuardChange = (guard: IdleSleepGuardProjection): void => {
    try {
      persistProcessProjection(
        (JSON.parse(fs.readFileSync(processStatePath, "utf8")) as DetachedMissionProcessState).status ??
          "running",
      );
    } catch {
      persistProcessProjection("running");
    }
    emit({ type: "idle-sleep-guard", ...guard });
    if (guard.status !== "active" && guard.status !== "stopped") {
      process.stderr.write(
        `silver-mission idle-sleep-guard ${guard.status}: ${guard.reason ?? "unavailable"}\n`,
      );
    }
  };
  try {
    idleSleepGuard = startIdleSleepGuard({
      targetPid: process.pid,
      onStateChange: projectIdleSleepGuardChange,
    });
  } catch (err) {
    idleSleepGuard = {
      projection: () => ({
        schema: "silver.idle-sleep-guard.v1",
        status: "failed",
        platform: process.platform,
        targetPid: process.pid,
        reason: err instanceof Error ? err.message : String(err),
      }),
      stop() {},
    };
  }
  const guard = idleSleepGuard.projection();
  emit({ type: "idle-sleep-guard", ...guard });
  if (guard.status !== "active") {
    process.stderr.write(
      `silver-mission idle-sleep-guard ${guard.status}: ${guard.reason ?? "unavailable"}\n`,
    );
  }
  persistProcessProjection("running");
  if (recovered) {
    emit({
      type: "mission-resume",
      commanderSessionId: recovered.commanderSessionId ?? null,
      priorStatus: recovered.status,
      settled: recovered.results.length,
      ...(reopenLegacyHostDeadline ? { reopenedLegacyHostDeadline: true } : {}),
      ...(reopenSupervisedFailure ? { reopenedSupervisedFailure: true } : {}),
    });
  }

  const aborter = new AbortController();
  let pool: SlotPool | undefined;
  let missionDone = reopenTerminal ? false : recovered?.missionDone ?? false;
  let terminalKind = missionDone ? recovered?.terminalKind : undefined;
  let terminalReason = missionDone ? recovered?.reason : undefined;
  let sampleSizeSettled = recovered?.sampleSizeSettled ?? false;
  let commanderControlProgressAt = recovered?.commanderControlProgressAt;
  let commanderSessionId = recovered?.commanderSessionId;
  let commanderHostWakes = recovered?.commanderHostWakes ?? 0;
  let reviewUnacknowledged = false;
  let commanderTransportResumes = recovered?.commanderTransportResumes ?? 0;
  let commanderTransportRecoveryStartedAt: number | undefined;
  const settled: SlotResult[] = recovered?.results.map((row) => ({ ...row })) ?? [];
  const targetReviews: MissionTargetReview[] = recovered?.targetReviews?.map((row) => ({ ...row })) ?? [];
  const workerFlagCounts = new Map<string, number>();
  type MissionWake =
    | {
        kind: "candidate_report";
        targetId: string;
        status: "reported" | "duplicate";
        reviewGenerationId: number;
      }
    | { kind: "worker_end"; result: SlotResult }
    | {
        kind: "room_control_request";
        request: { targetId: string; type: "defer_unavailable"; text: string };
      }
    | { kind: "compat_group_stalled"; targetId: string; groupId: string }
    | { kind: "allocation_checkpoint"; review: MissionAllocationCheckpoint }
    | { kind: "operator_message"; message: string }
    | { kind: "stop" };
  const missionWakes: MissionWake[] = [];
  const pendingRoomControlRequests = new Map<
    string,
    { targetId: string; type: "defer_unavailable"; text: string }
  >();
  const pendingAllocationReviews = new Map<string, MissionAllocationCheckpoint>();
  const allocationStates = new Map((recovered?.allocationStates ?? []).map((state) => [state.targetId, state]));
  const activeAllocationContinuations = new Map<string, () => void>();
  const activeRoomAborters = new Map<string, AbortController>();
  const scheduledDeferTargetIds = new Set<string>();
  let resolveMissionWake: ((wake: MissionWake) => void) | undefined;
  const projectRuntime = new ProjectRuntime();
  if (recovered?.projects) projectRuntime.restore(recovered.projects);
  const candidateReviewTracker = createMissionCandidateReviewTracker(
    parseMissionCandidateReviewSnapshot(recovered?.candidateReviewGenerations) ?? { targets: {} },
  );
  // Seed pending ids from durable generation watermarks (source of truth), then
  // merge any legacy pendingCandidateTargetIds that lack generation rows.
  const pendingCandidateTargets = new Set([
    ...candidateReviewTracker.pendingTargetIds(),
    ...(recovered?.pendingCandidateTargetIds ?? []),
  ]);
  for (const targetId of recovered?.pendingCandidateTargetIds ?? []) {
    if (!candidateReviewTracker.stateFor(targetId)) {
      // Legacy checkpoint: treat as generation 1 owed until Commander acks.
      candidateReviewTracker.noteCandidateWake({
        targetId,
        status: "reported",
        reviewGenerationId: 1,
      });
      candidateReviewTracker.takeNextWake(); // don't leave a stale queued wake from seed
    }
  }
  let reviewFocusTargetId: string | undefined =
    recovered && commanderSessionId ? candidateReviewTracker.pendingTargetIds()[0] : undefined;
  /** Structured operator gates only. Natural Mission prose remains Commander context. */
  const missionSampleSize = args.sampleSize;
  const missionOnlyBoardIds = args.onlyBoardIds?.length ? args.onlyBoardIds : undefined;
  const platformAdmissions: PlatformAdmissionRecord[] = parsePlatformAdmissions(recovered?.platformAdmissions) ?? [];
  const commanderPlatformRows = new Map<string, ContestBoardRow>();
  const commanderStartedBundles = new Map<string, ChallengeBundle>();
  const closedContestTargets = new Set(recovered?.closedContestTargetIds ?? []);
  const nonRelaunchableTargetIds = (): Set<string> =>
    new Set([
      ...settled
        .filter((row) => row.outcome === "solved" || row.platformProgress?.completed === true)
        .map((row) => row.targetId),
      ...latestMissionTargetReviews(targetReviews)
        .filter((row) => row.status === "completed")
        .map((row) => row.targetId),
      ...projectRuntime
        .snapshot()
        .filter((row) => row.status === "closed")
        .map((row) => row.challengeId),
    ]);
  const contestCloseInFlight = new Map<
    string,
    { attempt: Promise<void>; controller: AbortController; deadlineAt: number; timeoutReported: boolean }
  >();
  const contestRestartInFlight = new Map<string, Promise<Record<string, unknown>>>();
  const contestReleaseInFlight = new Map<string, Promise<void>>();
  const closeContestTarget = async (targetId: string): Promise<void> => {
    if (roomKind !== "ctf" || !contestAdapter?.close || closedContestTargets.has(targetId)) return;
    let flight = contestCloseInFlight.get(targetId);
    if (!flight) {
      const controller = new AbortController();
      const attempt = Promise.resolve()
        .then(() => contestAdapter.close!(targetId, { signal: controller.signal }))
        .then(() => {
          closedContestTargets.add(targetId);
          emit({ type: "close", targetId, closed: true });
          persistCheckpoint(checkpointStatus);
        })
        .finally(() => {
          contestCloseInFlight.delete(targetId);
        });
      flight = {
        attempt,
        controller,
        deadlineAt: Date.now() + MISSION_CONTEST_CLOSE_TIMEOUT_MS,
        timeoutReported: false,
      };
      contestCloseInFlight.set(targetId, flight);
      void attempt.catch(() => undefined);
    }
    if (flight.timeoutReported) return;
    const timeoutMs = Math.max(0, flight.deadlineAt - Date.now());
    if (timeoutMs === 0) {
      flight.timeoutReported = true;
      flight.controller.abort();
      emit({ type: "close", targetId, closed: false, reason: `contest close timed out for ${targetId}` });
      return;
    }
    try {
      await waitForContestClose(flight.attempt, targetId, timeoutMs, () => flight.controller.abort());
    } catch (error) {
      if (Date.now() >= flight.deadlineAt) {
        if (flight.timeoutReported) return;
        flight.timeoutReported = true;
      }
      emit({ type: "close", targetId, closed: false, reason: missionCommanderFailureReason(error) });
    }
  };
  const closeAdmittedContestTargets = async (): Promise<void> => {
    await Promise.all(
      platformAdmissions
        .filter((row) => row.phase === "started" || row.phase === "queued")
        .map((row) => closeContestTarget(row.targetId)),
    );
  };
  const releaseContestTarget = async (targetId: string): Promise<void> => {
    if (roomKind !== "ctf" || !contestAdapter?.close) return;
    let flight = contestReleaseInFlight.get(targetId);
    if (!flight) {
      const controller = new AbortController();
      flight = waitForContestClose(
        Promise.resolve().then(() => contestAdapter.close!(targetId, { signal: controller.signal })),
        targetId,
        MISSION_CONTEST_CLOSE_TIMEOUT_MS,
        () => controller.abort(),
      )
        .then(() => {
          closedContestTargets.add(targetId);
          emit({ type: "close", targetId, closed: true, terminal: false, reason: "room_budget_expired" });
          persistCheckpoint(checkpointStatus);
        })
        .catch((error) => {
          emit({
            type: "close",
            targetId,
            closed: false,
            terminal: false,
            reason: missionCommanderFailureReason(error),
          });
        })
        .finally(() => {
          contestReleaseInFlight.delete(targetId);
        });
      contestReleaseInFlight.set(targetId, flight);
    }
    await flight;
  };
  const discoveredTargetIds = new Set(
    (recovered?.discoveredTargetIds ?? []).filter(
      (targetId) => !missionOnlyBoardIds || missionOnlyBoardIds.includes(targetId),
    ),
  );
  const admissionStarts = new Set<string>();
  const admittedTargetIds = new Set<string>([
    ...settled.map((row) => row.targetId),
    ...projectRuntime.inFlight().map((row) => row.challengeId),
    ...pendingCandidateTargets,
    ...platformAdmissions.map((row) => row.targetId),
  ]);
  const reviewReleaseWaits = createWaitBroadcast<{ targetId: string }>();
  const signalReviewReleased = (targetId: string): void => {
    reviewReleaseWaits.signal({ targetId });
  };
  const waitWhileProjectReviewing = async (targetId: string): Promise<void> => {
    const stillReviewing = (): boolean => {
      if (aborter.signal.aborted) return false;
      const status = projectRuntime.snapshot().find((row) => row.challengeId === targetId)?.status;
      if (status === "reviewing") return true;
      if (pendingCandidateTargets.has(targetId)) return true;
      return candidateReviewTracker.pendingTargetIds().includes(targetId);
    };
    while (stillReviewing()) {
      const reviewWait = reviewReleaseWaits.waitCancelable();
      const abortWait = whenAbortedCancelable(aborter.signal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 250);
      });
      await Promise.race([reviewWait.promise.then(() => undefined), abortWait.promise, timeout]);
      if (timer) clearTimeout(timer);
      reviewWait.cancel();
      abortWait.cancel();
    }
  };
  const dropCandidateWakes = (targetId: string): void => {
    pendingCandidateTargets.delete(targetId);
    candidateReviewTracker.clearTarget(targetId);
    for (let i = missionWakes.length - 1; i >= 0; i -= 1) {
      const queued = missionWakes[i];
      if (queued?.kind === "candidate_report" && queued.targetId === targetId) missionWakes.splice(i, 1);
    }
  };
  const deliverOrQueueWake = (wake: MissionWake): void => {
    if (resolveMissionWake) {
      const resolve = resolveMissionWake;
      resolveMissionWake = undefined;
      resolve(wake);
    } else {
      missionWakes.push(wake);
    }
  };
  const pushCandidateReportWake = (input: {
    targetId: string;
    status: "reported" | "duplicate";
    reviewGenerationId: number;
  }): void => {
    const closed =
      projectRuntime.snapshot().find((row) => row.challengeId === input.targetId)?.status === "closed";
    const noted = candidateReviewTracker.noteCandidateWake({ ...input, closed });
    process.stderr.write(
      `silver: candidate-wake ${input.targetId} outcome=${noted.outcome} closed=${closed} waiting=${Boolean(resolveMissionWake)} generation=${input.reviewGenerationId}\n`,
    );
    if (noted.outcome === "ignored_closed") return;
    pendingCandidateTargets.add(input.targetId);
    if (!resolveMissionWake) return;
    const wake = candidateReviewTracker.takeNextWake();
    if (wake) {
      const resolve = resolveMissionWake;
      resolveMissionWake = undefined;
      resolve(wake);
    }
  };
  const pushMissionWake = (wake: MissionWake): void => {
    if (wake.kind === "candidate_report") {
      pushCandidateReportWake({
        targetId: wake.targetId,
        status: wake.status,
        reviewGenerationId: wake.reviewGenerationId,
      });
      return;
    }
    if (
      wake.kind === "compat_group_stalled" &&
      missionWakes.some(
        (queued) =>
          queued.kind === "compat_group_stalled" &&
          queued.targetId === wake.targetId &&
          queued.groupId === wake.groupId,
      )
    ) {
      return;
    }
    if (
      wake.kind === "room_control_request" &&
      missionWakes.some(
        (queued) =>
          queued.kind === "room_control_request" &&
          queued.request.targetId === wake.request.targetId,
      )
    ) {
      return;
    }
    deliverOrQueueWake(wake);
  };
  const waitMissionWake = (): Promise<MissionWake> => {
    const candidate = candidateReviewTracker.takeNextWake();
    if (candidate) return Promise.resolve(candidate);
    const wake = missionWakes.shift();
    if (wake) return Promise.resolve(wake);
    return new Promise((resolve) => {
      resolveMissionWake = resolve;
    });
  };
  const activeRoomControls = new Map<
    string,
    {
      recordTaskReview: (review: {
        status: "completed" | "pending";
        reason: string;
        ackedGenerationId?: number;
        platformProgress?: {
          correctFlagCount?: number;
          totalFlagCount?: number;
          completed?: boolean;
        };
      }) => void | Promise<void | { storedStatus: "completed" | "exhausted" }>;
      resolveRoomRequest: (decision: "continue" | "defer") => void;
      halt: (reason?: LiveRunStopReason) => void;
      pulse: () => ProjectPulse;
    }
  >();
  const haltActiveRooms = (reason: LiveRunStopReason = "interrupted"): void => {
    for (const controller of activeRoomAborters.values()) controller.abort(reason);
    for (const controls of activeRoomControls.values()) {
      try {
        controls.halt(reason);
      } catch {
        /* best-effort */
      }
    }
  };
  const restorePendingCandidateWakes = (): void => {
    candidateReviewTracker.restorePendingWakes();
    for (const targetId of candidateReviewTracker.pendingTargetIds()) {
      pendingCandidateTargets.add(targetId);
    }
  };
  let activeSession: ReturnType<typeof spawnOfficialDshAcpSession> | undefined;
  let commanderMessageTimer: ReturnType<typeof setInterval> | undefined;
  const pollCommanderMessage = (): void => {
    try {
      const request = consumeOperatorCommanderMessage(contestDir);
      if (!request || missionDone || aborter.signal.aborted) return;
      pushMissionWake({ kind: "operator_message", message: request.message });
      acknowledgeOperatorCommanderMessage(contestDir, request.requestId);
      if (request.mode === "interrupt" && activeSession?.isPrompting()) {
        void activeSession.cancelPrompt().catch(() => undefined);
      }
    } catch {
      // A concurrent write or shutdown must not end the Mission.
    }
  };
  const markControlProgress = (): void => {
    if (!commanderControlProgressAt) commanderControlProgressAt = new Date().toISOString();
  };
  let checkpointStatus: MissionCommanderState["status"] = missionDone ? "terminal" : "active";
  const persistCheckpoint = (status: MissionCommanderState["status"] = checkpointStatus): void => {
    if (checkpointStatus === "terminal") status = "terminal";
    else if (checkpointStatus === "interrupted" && status === "active") status = "interrupted";
    checkpointStatus = status;
    writeMissionCommanderState(statePath, {
      schema: "silver.mission-commander-state.v1",
      missionFingerprint,
      status,
      missionDone,
      ...(terminalKind ? { terminalKind } : {}),
      ...(terminalReason ? { reason: terminalReason } : {}),
      ...(sampleSizeSettled ? { sampleSizeSettled: true } : {}),
      ...(pool ? { maxConcurrentRooms: pool.maxConcurrent } : {}),
      ...(commanderSessionId ? { commanderSessionId } : {}),
      commanderHostWakes,
      commanderTransportResumes,
      startedAt: new Date(startedAt).toISOString(),
      ...(commanderControlProgressAt ? { commanderControlProgressAt } : {}),
      updatedAt: new Date().toISOString(),
      results: settled,
      targetReviews,
      projects: projectRuntime.snapshot(),
      pendingCandidateTargetIds: candidateReviewTracker.pendingTargetIds(),
      candidateReviewGenerations: candidateReviewTracker.snapshot(),
      platformAdmissions,
      discoveredTargetIds: [...discoveredTargetIds],
      closedContestTargetIds: [...closedContestTargets],
      allocationStates: [...allocationStates.values()],
    });
  };
  const requeueDurableAdmissions = (): void => {
    if (!pool) return;
    const blockedTargetIds = nonRelaunchableTargetIds();
    for (const row of durableAdmissionsToQueue(
      platformAdmissions.filter((admission) => !blockedTargetIds.has(admission.targetId) && !closedContestTargets.has(admission.targetId)),
    )) {
      workerFlagCounts.set(row.targetId, row.flagCount);
      if (projectRuntime.inFlight().some((project) => project.challengeId === row.targetId)) continue;
      if (settled.some((result) => result.targetId === row.targetId)) continue;
      const slots = pool.status();
      if (slots.activeIds.includes(row.targetId) || slots.queuedIds.includes(row.targetId)) continue;
      pool.enqueue({
        targetId: row.targetId,
        targetUrl: row.bundle.targetUrl,
        bundle: row.bundle,
      });
    }
  };
  const requireRecoveredProjectBundle = (project: ReturnType<ProjectRuntime["inFlight"]>[number]): ChallengeBundle => {
    if (!project.bundle) {
      throw new Error(`cannot recover ${project.challengeId}: durable Commander childMission is missing`);
    }
    try {
      requireCommanderChildMission(project.bundle.childMission);
    } catch {
      throw new Error(`cannot recover ${project.challengeId}: durable Commander childMission is missing`);
    }
    return project.bundle;
  };
  const validateRecoveredCommanderWork = (): void => {
    const blockedTargetIds = nonRelaunchableTargetIds();
    for (const project of projectRuntime.inFlight()) {
      if (!blockedTargetIds.has(project.challengeId) && !closedContestTargets.has(project.challengeId)) {
        requireRecoveredProjectBundle(project);
      }
    }
    durableAdmissionsToQueue(
      platformAdmissions.filter((admission) => !blockedTargetIds.has(admission.targetId) && !closedContestTargets.has(admission.targetId)),
    );
  };
  const requeueInFlightProjects = (): void => {
    if (!pool) return;
    const blockedTargetIds = nonRelaunchableTargetIds();
    for (const project of projectRuntime.inFlight()) {
      if (blockedTargetIds.has(project.challengeId) || closedContestTargets.has(project.challengeId)) continue;
      const bundle = requireRecoveredProjectBundle(project);
      const retry = settled.some((row) => row.targetId === project.challengeId);
      pool.enqueue(
        {
          targetId: project.challengeId,
          targetUrl: bundle.targetUrl,
          bundle,
        },
        { retry },
      );
    }
  };
  let interruptedBy: NodeJS.Signals | undefined;
  const signalHandlers: Array<readonly [NodeJS.Signals, () => void]> = [];
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (aborter.signal.aborted) return;
      interruptedBy = signalName;
      missionDone = signalName === "SIGINT" && process.env.SILVER_MISSION_SUPERVISED !== "1";
      terminalKind = missionDone ? "operator_stop" : undefined;
      terminalReason = `mission interrupted by ${signalName}`;
      emit({ type: "interrupt", signal: signalName });
      persistProcessProjection("interrupted", {
        signal: signalName,
        reason: `mission interrupted by ${signalName}`,
        exitCode: null,
      });
      haltActiveRooms("interrupted");
      aborter.abort(`mission interrupted by ${signalName}`);
      projectRuntime.interrupt();
      pushMissionWake({ kind: "stop" });
      persistCheckpoint("interrupted");
    };
    process.once(signalName, handler);
    signalHandlers.push([signalName, handler]);
  }
  let summaryPersisted = false;
  const persistSummary = (announce = true): MissionCommanderSummary => {
    const slots = pool?.status();
    const terminalResults = collapseTerminalSolvedResults(settled);
    const summary: MissionCommanderSummary = {
      schema: "silver.mission-commander-summary.v1",
      missionDone,
      ...(terminalKind ? { terminalKind } : {}),
      ...(terminalReason ? { reason: terminalReason } : {}),
      configured: Boolean(pool),
      ...(pool ? { maxConcurrent: pool.maxConcurrent } : {}),
      queued: slots?.queued ?? 0,
      settled: terminalResults.length,
      ...(commanderSessionId ? { commanderSessionId } : {}),
      commanderHostWakes,
      commanderTransportResumes,
      wallTimeMs: Date.now() - startedAt,
      results: annotateMissionResultsWithPlatform(terminalResults, targetReviews),
      targetReviews: latestMissionTargetReviews(targetReviews),
      unresolvedTargetIds: unresolvedMissionTargetIds(
        settled,
        targetReviews,
        platformAdmissions.map((row) => row.targetId),
      ),
    };
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    summaryPersisted = true;
    if (announce) {
      process.stdout.write(`silver-mission-summary ${summaryPath}\n`);
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    }
    return summary;
  };
  const finishIfSampleSizeSettled = (): boolean => {
    if (missionDone) return false;
    const admitted = sampleSizeSettledTargetIds({
      sampleSize: missionSampleSize,
      platformAdmissions,
      results: settled,
      reviews: targetReviews,
      slots: pool?.status(),
    });
    if (!admitted) return false;
    const terminal = sampleSizeTerminal({
      admittedTargetIds: admitted,
      results: settled,
      reviews: targetReviews,
    });
    missionDone = true;
    terminalKind = terminal.terminalKind;
    terminalReason = terminal.reason;
    sampleSizeSettled = true;
    markControlProgress();
    persistCheckpoint("active");
    emit({ type: "mission-done", terminalKind, reason: terminalReason, slots: pool?.status() ?? null });
    setImmediate(() => activeSession?.stop("host_terminal_stop"));
    return true;
  };
  const finishIfAdmissibleTargetsSolved = (): boolean => {
    if (finishIfSampleSizeSettled()) return true;
    if (missionDone) return false;
    const slots = pool?.status();
    const kind = missionAdmissibleTerminal({
      onlyBoardIds: missionOnlyBoardIds,
      sampleSize: missionSampleSize,
      settled,
      active: slots?.active ?? 0,
      queued: slots?.queued ?? 0,
    });
    if (!kind) return false;
    missionDone = true;
    terminalKind = kind;
    terminalReason =
      kind === "sample_completed"
        ? "sample-size limit reached; all admissible targets are already solved"
        : "every admissible target is already solved";
    markControlProgress();
    persistCheckpoint("active");
    emit({ type: "mission-done", terminalKind, reason: terminalReason, slots: slots ?? null });
    setImmediate(() => activeSession?.stop("host_terminal_stop"));
    return true;
  };
  const selectedRoomMode = resolveRoomMode({
    config,
    ...(args.profile !== undefined ? { profile: args.profile } : {}),
    ...(args.officialTeam ? { officialTeam: true } : {}),
    ...(args.team !== undefined ? { team: args.team } : {}),
  }).mode;
  const officialSwarmRoom = selectedRoomMode === "swarm";
  const configuredHintPolicy = mission.hintPolicy ?? config.competition.hintPolicy;
  const hintAvailable =
    roomKind === "ctf" && configuredHintPolicy === "open" && typeof contestAdapter?.requestHint === "function";
  const missionRoomAssembly = buildRoomAssembly(roomKind, {
    formalTeam: officialSwarmRoom,
    submit: submitAvailable,
    hint: hintAvailable,
  });
  const missionAcceptanceText = roomAssemblyAcceptanceText(missionRoomAssembly);
  const readPlatformProgress = async (
    targetId: string,
  ): Promise<{ correctFlagCount: number; totalFlagCount: number; completed: boolean } | undefined> => {
    if (!contestAdapter?.list) return undefined;
    try {
      const row = (await contestAdapter.list()).find((candidate) => candidate.boardId === targetId);
      if (!row) return undefined;
      return {
        correctFlagCount: row.correctFlagCount,
        totalFlagCount: row.flagCount,
        completed: row.isCompleted,
      };
    } catch {
      return undefined;
    }
  };
  const worker = async (job: SlotJob): Promise<SlotResult> => {
    if (aborter.signal.aborted) {
      return { targetId: job.targetId, targetUrl: job.targetUrl, outcome: "stalled", reason: "interrupted" };
    }
    if (!job.bundle) {
      throw new Error(`cannot start ${job.targetId}: durable Commander childMission is missing`);
    }
    const childMission = requireCommanderChildMission(job.bundle.childMission);
    const roomBundle = withCommanderChildMission(
      job.bundle,
      childMission,
      missionAcceptanceText,
    );
    const flagCount = workerFlagCounts.get(job.targetId) ?? 1;
    const challenge = {
      id: job.targetId,
      flagCount,
      flags: [] as string[],
      html: `<!doctype html><p>${job.targetId}</p>\n`,
    };
    const child: MissionBrief = {
      title: job.targetId,
      target: roomBundle.targetUrl,
      inScope: scopeForChallenge(job.targetUrl, roomBundle),
      challengeId: job.targetId,
      challengeBundle: roomBundle,
      body: materialsPrefix(roomBundle, hintAvailable).trimEnd(),
      ...(mission.flagPattern ? { flagPattern: mission.flagPattern } : {}),
      hintPolicy: hintAvailable ? "open" : "off",
    };
    const targetDir = path.join(contestDir, "targets", job.targetId);
    fs.mkdirSync(targetDir, { recursive: true });
    projectRuntime.open({
      challengeId: job.targetId,
      targetUrl: roomBundle.targetUrl,
      bundle: roomBundle,
    });
    const resumeReviewHold = !submitAvailable && pendingCandidateTargets.has(job.targetId);
    if (resumeReviewHold) projectRuntime.noteReviewing(job.targetId);
    persistCheckpoint(aborter.signal.aborted ? "interrupted" : "active");
    emit({ type: "worker-start", targetId: job.targetId, targetUrl: job.targetUrl });
    const workerStartedAt = Date.now();
    const priorAllocationState = job.freshAttempt ? undefined : allocationStates.get(job.targetId);
    const allocationState: MissionAllocationState = priorAllocationState ?? {
      targetId: job.targetId,
      startedAtMs: workerStartedAt,
      nextCheckpointMinute: 30,
    };
    allocationStates.set(job.targetId, allocationState);
    persistCheckpoint("active");
    const initialPlatformProgress = await readPlatformProgress(job.targetId);
    const contestSubmit: ContestSubmitHook | undefined = submitAvailable
      ? async ({ raw }) => {
          let verdict: ContestSubmitVerdict;
          try {
            verdict = await contestAdapter!.submit!(job.targetId, raw);
          } catch (error) {
            if (!(error instanceof ContestDuplicateError)) throw error;
            const duplicateProgress = await readPlatformProgress(job.targetId);
            if (!duplicateProgress) throw error;
            verdict = {
              correct: true,
              duplicate: true,
              correctFlagCount: duplicateProgress.correctFlagCount,
              totalFlagCount: duplicateProgress.totalFlagCount,
              completed: duplicateProgress.completed,
            };
          }
          const platformProgress = await readPlatformProgress(job.targetId);
          const accepted = Math.max(
            verdict.correctFlagCount ?? 0,
            platformProgress?.correctFlagCount ?? 0,
          );
          const total = verdict.totalFlagCount && verdict.totalFlagCount > 0
            ? verdict.totalFlagCount
            : platformProgress?.totalFlagCount;
          const reconciledVerdict: ContestSubmitVerdict = {
            ...verdict,
            ...(total !== undefined ? { correctFlagCount: accepted, totalFlagCount: total } : {}),
            ...(
              verdict.completed === true ||
              platformProgress?.completed === true ||
              (total !== undefined && total > 0 && accepted >= total)
                ? { completed: true }
                : {}
            ),
          };
          try {
            emit({
              type: "submit",
              targetId: job.targetId,
              correct: reconciledVerdict.correct,
              awarded: reconciledVerdict.awarded,
              correctFlagCount: reconciledVerdict.correctFlagCount,
              totalFlagCount: reconciledVerdict.totalFlagCount,
            });
          } catch {
            // Mission-event projection is best-effort. The submitter must
            // receive the platform verdict that the adapter already returned.
          }
          return reconciledVerdict;
        }
      : undefined;
    const contestVerify: ContestVerifyHook | undefined = verifyAvailable
      ? ({ challengeId, raw }) => contestAdapter!.verify!(challengeId, raw)
      : undefined;
    const contestHint: ContestHintHook | undefined = hintAvailable
      ? ({ challengeId }) => contestAdapter!.requestHint!(challengeId)
      : undefined;
    const contestRestart: ContestRestartHook | undefined = contestAdapter?.close && contestAdapter.start
      ? async () => {
          const existing = contestRestartInFlight.get(job.targetId);
          if (existing) return existing;
          const restart = (async (): Promise<Record<string, unknown>> => {
            const controller = new AbortController();
            await waitForContestClose(
              Promise.resolve().then(() => contestAdapter.close!(job.targetId, { signal: controller.signal })),
              job.targetId,
              MISSION_CONTEST_CLOSE_TIMEOUT_MS,
              () => controller.abort(),
            );
            const startedTarget = await contestAdapter.start!(job.targetId);
            closedContestTargets.delete(startedTarget.boardId);
            let listedTarget = commanderPlatformRows.get(startedTarget.boardId) ?? commanderPlatformRows.get(job.targetId);
            if (contestAdapter.list) {
              const rows = await contestAdapter.list();
              for (const row of rows) commanderPlatformRows.set(row.boardId, row);
              listedTarget = rows.find((row) => row.boardId === startedTarget.boardId) ?? listedTarget;
            }
            const content = mergePlatformLayers({
              ...(listedTarget ? { list: listedTarget } : {}),
              start: startedTarget,
            });
            const baseBundle = challengeBundleFromPlatform({
              challengeId: startedTarget.boardId,
              ...(listedTarget ? { flagCount: listedTarget.flagCount } : {}),
              containerAddr: startedTarget.containerAddr,
              ...content,
            });
            const restartedBundle = baseBundle
              ? withCommanderChildMission(baseBundle, childMission, missionAcceptanceText)
              : undefined;
            if (restartedBundle) {
              commanderStartedBundles.set(startedTarget.boardId, restartedBundle);
              const admission = platformAdmissions.find((row) => row.targetId === job.targetId);
              if (admission) {
                admission.bundle = restartedBundle;
                admission.targetUrl = restartedBundle.targetUrl;
                admission.flagCount = restartedBundle.flagCount;
              }
              persistCheckpoint("active");
            }
            const targetUrls = startedTarget.containerAddr.map(contestTargetUrl);
            emit({
              type: "restart",
              targetId: job.targetId,
              targetUrls,
            });
            return {
              restarted: true,
              targetId: startedTarget.boardId,
              ...(listedTarget ? projectContestBoard(listedTarget) : content),
              ...content,
              containerAddr: startedTarget.containerAddr,
              targetUrls,
              ...(targetUrls[0] ? { targetUrl: targetUrls[0] } : {}),
              guidance:
                "Immediately record one concise environment-reset Intel fact with the new inputs and any environment-bound state that may now be stale. That Intel write notifies active Workers.",
            };
          })().finally(() => {
            contestRestartInFlight.delete(job.targetId);
          });
          contestRestartInFlight.set(job.targetId, restart);
          return restart;
        }
      : undefined;
    const runRoom = selectedRoomMode === "three-graph" ? runIsolatedThreeGraphSwarms : runLiveHostFs;
    const roomAborter = new AbortController();
    const onMissionAbort = () => roomAborter.abort("mission interrupted");
    if (aborter.signal.aborted) onMissionAbort();
    else aborter.signal.addEventListener("abort", onMissionAbort, { once: true });
    activeRoomAborters.set(job.targetId, roomAborter);
    let allocationTimer: ReturnType<typeof setTimeout> | undefined;
    let platformCheckTimer: ReturnType<typeof setTimeout> | undefined;
    let observedPlatformCompletion:
      | { correctFlagCount: number; totalFlagCount: number; completed: boolean }
      | undefined;
    const schedulePlatformCompletionCheck = (): void => {
      if (!contestAdapter?.list) return;
      platformCheckTimer = setTimeout(() => {
        void (async () => {
          const progress = await readPlatformProgress(job.targetId);
          if (activeRoomAborters.get(job.targetId) !== roomAborter || roomAborter.signal.aborted) return;
          if (progress?.completed) {
            observedPlatformCompletion = progress;
            roomAborter.abort("platform completed");
          } else {
            schedulePlatformCompletionCheck();
          }
        })();
      }, 60_000);
    };
    schedulePlatformCompletionCheck();
    if (initialPlatformProgress && !priorAllocationState) {
      allocationState.previousPlatformProgress = {
        observedAt: new Date().toISOString(),
        accepted: initialPlatformProgress.correctFlagCount,
        expected: initialPlatformProgress.totalFlagCount,
      };
      persistCheckpoint("active");
    }
    const scheduleAllocationCheckpoint = (checkpointMinute: 30 | 60): void => {
      allocationTimer = setTimeout(() => {
        void (async () => {
          if (roomAborter.signal.aborted || missionDone) return;
          const progress = await readPlatformProgress(job.targetId);
          if (roomAborter.signal.aborted || missionDone || activeRoomAborters.get(job.targetId) !== roomAborter) return;
          const currentPlatformProgress = progress
            ? {
                observedAt: new Date().toISOString(),
                accepted: progress.correctFlagCount,
                expected: progress.totalFlagCount,
              }
            : undefined;
          const review: MissionAllocationCheckpoint = {
            targetId: job.targetId,
            elapsedMs: Date.now() - allocationState.startedAtMs,
            checkpointMinute,
            ...(allocationState.previousPlatformProgress
              ? { previousPlatformProgress: allocationState.previousPlatformProgress }
              : {}),
            ...(currentPlatformProgress ? { currentPlatformProgress } : {}),
          };
          pendingAllocationReviews.set(job.targetId, review);
          persistCheckpoint("active");
          pushMissionWake({ kind: "allocation_checkpoint", review });
        })();
      }, Math.max(1, checkpointMinute * 60_000 - (Date.now() - allocationState.startedAtMs)));
    };
    activeAllocationContinuations.set(job.targetId, () => scheduleAllocationCheckpoint(60));
    if (allocationState.nextCheckpointMinute) scheduleAllocationCheckpoint(allocationState.nextCheckpointMinute);
    const result = await runRoom({
      repoRoot,
      spinePatch: path.join(repoRoot, "packages", "ctf-spine", "cordis.patch.yml"),
      platform: new MockPlatform([challenge]),
      row: { challenge, contamination: "public-cutoff" },
      resolved,
      resolvedPlan: plan,
      challengeId: job.targetId,
      config,
      roomAssembly: missionRoomAssembly,
      args: { ...args, replayPath: targetDir },
      mission: child,
      roomWorkDir: targetDir,
      ...(initialPlatformProgress ? { initialPlatformProgress } : {}),
      ...(job.freshAttempt ? { freshAttempt: true } : {}),
      goalBound: true,
      projects: projectRuntime,
      ...(resumeReviewHold ? { resumeReviewHold: true } : {}),
      ...(contestSubmit ? { contestSubmit } : {}),
      ...(contestVerify ? { contestVerify } : {}),
      ...(contestHint ? { contestHint } : {}),
      ...(contestRestart ? { contestRestart } : {}),
      onCandidateReported: (event: {
        targetId: string;
        fingerprint: string;
        status: "reported" | "duplicate";
        wakeCommander?: boolean;
        reviewGenerationId?: number;
      }) => {
        emit({
          type: "candidate-report-ready",
          targetId: job.targetId,
          status: event.status,
          fingerprint: event.fingerprint,
        });
        applyMissionCandidateReported({
          targetId: job.targetId,
          event,
          noteReviewing: (targetId) => projectRuntime.noteReviewing(targetId),
          pushCandidateReportWake: (wake) => pushCandidateReportWake(wake),
        });
        persistCheckpoint("active");
      },
      onCompatibilityGroupStalled: (event) => {
        projectRuntime.noteGroupStall(job.targetId, event.groupId);
        emit({ type: "group-stalled", targetId: job.targetId, groupId: event.groupId });
        pushMissionWake({ kind: "compat_group_stalled", targetId: job.targetId, groupId: event.groupId });
      },
      onAllGroupsStalled: () => {
        projectRuntime.noteAllGroupsStalled(job.targetId);
        persistCheckpoint("active");
        emit({ type: "project-stalled", targetId: job.targetId, awaitingResourceDecision: true });
      },
      onRoomControlRequested: (request) => {
        const previous = pendingRoomControlRequests.get(job.targetId);
        if (previous?.type === request.type && previous.text === request.text) return;
        const pending = { targetId: job.targetId, type: request.type, text: request.text } as const;
        pendingRoomControlRequests.set(job.targetId, pending);
        emit({
          type: "room-control-request",
          targetId: pending.targetId,
          requestType: pending.type,
          text: pending.text,
        });
        pushMissionWake({ kind: "room_control_request", request: pending });
      },
      onGroupSession: (event) => {
        projectRuntime.noteGroupSession(job.targetId, event.groupId, event.sessionId);
      },
      projectSnapshot: () => {
        const row = projectRuntime.snapshot().find((project) => project.challengeId === job.targetId);
        if (!row) return undefined;
        return { status: row.status };
      },
      onRoomControls: (controls) => {
        activeRoomControls.set(job.targetId, {
          recordTaskReview: controls.recordTaskReview,
          resolveRoomRequest: controls.resolveRoomRequest,
          halt: controls.halt,
          pulse: controls.pulse,
        });
      },
      soft: true,
      silent: true,
      signal: roomAborter.signal,
    }).catch((err) => {
      const reason = missionCommanderFailureReason(err);
      return {
        outcome: aborter.signal.aborted ? "stalled" : "failed",
        wallTimeMs: Date.now() - workerStartedAt,
        turns: undefined,
        toolCalls: undefined,
        stopReason: undefined,
        acpStopReason: undefined,
        diagnostics: undefined,
        reason,
        error: reason,
      };
    }).finally(() => {
      if (allocationTimer) clearTimeout(allocationTimer);
      if (platformCheckTimer) clearTimeout(platformCheckTimer);
      activeAllocationContinuations.delete(job.targetId);
      aborter.signal.removeEventListener("abort", onMissionAbort);
      activeRoomAborters.delete(job.targetId);
    });
    const finalPlatformProgress = !aborter.signal.aborted && contestAdapter?.list
      ? await readPlatformProgress(job.targetId)
      : undefined;
    const completedPlatformProgress = observedPlatformCompletion ??
      (finalPlatformProgress?.completed ? finalPlatformProgress : undefined);
    if (completedPlatformProgress && !aborter.signal.aborted) {
      scheduledDeferTargetIds.delete(job.targetId);
      result.outcome = "solved";
      result.stopReason = "host_terminal_stop";
      delete result.error;
      delete result.reason;
    }
    if (scheduledDeferTargetIds.delete(job.targetId) && result.outcome !== "solved" && !("platformProgress" in result && result.platformProgress?.completed === true)) {
      result.outcome = "stalled";
      result.stopReason = "timeout";
      result.reason = "Commander deferred this allocation after the soft checkpoint";
    }
    pendingAllocationReviews.delete(job.targetId);
    allocationStates.delete(job.targetId);
    if (contestSubmit && officialContestRoomTerminal(result)) {
      const workerResultNumber = settled.filter((row) => row.targetId === job.targetId).length + 1;
      if (
        !targetReviews.some(
          (row) =>
            row.targetId === job.targetId &&
            row.workerResultNumber === workerResultNumber &&
            row.status === "completed",
        )
      ) {
        targetReviews.push(officialContestCompletedReview({ targetId: job.targetId, workerResultNumber }));
      }
      result.outcome = "solved";
      delete result.error;
      delete result.reason;
    }
    const identity = liveTaskIdentity({ challengeId: job.targetId, roomWorkDir: targetDir, replayPath: targetDir });
    const clock = readRoomClock(
      roomClockPath(path.join(identity.storageBase, ".silver-room", identity.shortId), job.targetId),
    );
    const projected: SlotResult = {
      targetId: job.targetId,
      targetUrl: job.targetUrl,
      ...(clock ? { logicalAttemptKey: `${clock.startedAt}/${clock.deadlineAt}` } : {}),
      ...(result.outcome ? { outcome: result.outcome } : {}),
      ...(result.stopReason ? { stopReason: result.stopReason } : {}),
      ...("controlRequest" in result && result.controlRequest
        ? { controlRequest: result.controlRequest }
        : {}),
      ...(result.wallTimeMs !== undefined ? { wallTimeMs: result.wallTimeMs } : {}),
      ...(result.turns !== undefined ? { turns: result.turns } : {}),
      ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
      ...("platformProgress" in result && result.platformProgress
        ? { platformProgress: result.platformProgress }
        : completedPlatformProgress
          ? {
              platformProgress: {
                acceptedCount: completedPlatformProgress.correctFlagCount,
                totalCount: completedPlatformProgress.totalFlagCount,
                remainingCount: 0,
                completed: true,
              },
            }
        : {}),
      ...(!["solved", "reported"].includes(result.outcome ?? "")
        ? {
            reason:
              result.reason ??
              [
                `Worker ended with outcome=${result.outcome ?? "unknown"}`,
                result.stopReason ? `stopReason=${result.stopReason}` : undefined,
                result.acpStopReason ? `acpStopReason=${result.acpStopReason}` : undefined,
                result.diagnostics?.length ? `diagnostics=${result.diagnostics.join(",")}` : undefined,
              ]
                .filter(Boolean)
                .join("; "),
          }
        : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    if (aborter.signal.aborted) {
      projectRuntime.interrupt(job.targetId);
      settled.push(projected);
      persistCheckpoint("interrupted");
      if (summaryPersisted) persistSummary(false);
      emit({ type: "project-interrupted", targetId: job.targetId, groups: projectRuntime.snapshot().find((row) => row.challengeId === job.targetId)?.groups ?? [] });
      return projected;
    }
    // Pending/reviewing Projects keep the SlotPool seat until Commander clears the review.
    await waitWhileProjectReviewing(job.targetId);
    if (aborter.signal.aborted) {
      projectRuntime.interrupt(job.targetId);
      settled.push(projected);
      persistCheckpoint("interrupted");
      if (summaryPersisted) persistSummary(false);
      return projected;
    }
    const snapshot = projectRuntime.snapshot().find((row) => row.challengeId === job.targetId);
    const settledOutcome = slotOutcomeAfterContestBoard({
      ...(result.outcome ? { outcome: result.outcome } : {}),
      ...(snapshot?.status ? { projectStatus: snapshot.status } : {}),
      boardCompleted: result.outcome === "solved",
    });
    if (settledOutcome) projected.outcome = settledOutcome;
    if (settledOutcome === "solved") delete projected.reason;
    if (snapshot?.status === "stalled" && projected.outcome !== "solved") {
      projected.outcome = "stalled";
      projected.reason = "all Group roots stalled; awaiting resource decision";
    } else if (snapshot?.status !== "reviewing" && snapshot?.status !== "closed" && projected.outcome !== "solved") {
      projectRuntime.noteWorkerEnded(job.targetId);
    }
    settled.push(projected);
    finishIfAdmissibleTargetsSolved();
    if (!candidateReviewTracker.pendingTargetIds().includes(job.targetId)) {
      pendingCandidateTargets.delete(job.targetId);
    }
    activeRoomControls.delete(job.targetId);
    pendingRoomControlRequests.delete(job.targetId);
    for (let i = missionWakes.length - 1; i >= 0; i -= 1) {
      const wake = missionWakes[i];
      if (wake?.kind === "room_control_request" && wake.request.targetId === job.targetId) {
        missionWakes.splice(i, 1);
      }
      if (wake?.kind === "allocation_checkpoint" && wake.review.targetId === job.targetId) {
        missionWakes.splice(i, 1);
      }
    }
    persistCheckpoint("active");
    // Persist the authoritative solve before a slow platform release. The
    // release is bounded and can be retried by terminal cleanup or recovery.
    if (result.outcome === "solved" || result.stopReason === "host_terminal_stop") {
      await closeContestTarget(job.targetId);
    } else if (result.stopReason === "timeout") {
      await releaseContestTarget(job.targetId);
    }
    emit({ type: "worker-end", ...projected });
    setImmediate(() => pushMissionWake({ kind: "worker_end", result: projected }));
    return projected;
  };

  const roomCapacity = (() => {
    const configured = config.competition.maxConcurrentRooms;
    const persisted = persistedRoomCapacity(recovered);
    if (persisted !== undefined && persisted !== configured) {
      throw new Error(
        `competition.maxConcurrentRooms=${configured} conflicts with persisted room capacity ${persisted}; fail closed`,
      );
    }
    return persisted ?? configured;
  })();
  for (const row of platformAdmissions) workerFlagCounts.set(row.targetId, row.flagCount);
  if (recovered) validateRecoveredCommanderWork();
  pool = new SlotPool(roomCapacity, worker, settled);
  if (recovered && !missionDone) {
    const blockedTargetIds = nonRelaunchableTargetIds();
    await Promise.all(
      platformAdmissions
        .filter(
          (row) =>
            (row.phase === "started" || row.phase === "queued") &&
            blockedTargetIds.has(row.targetId) &&
            !closedContestTargets.has(row.targetId),
        )
        .map((row) => closeContestTarget(row.targetId)),
    );
    requeueInFlightProjects();
    requeueDurableAdmissions();
  }
  if (!(missionDone && recovered?.status === "terminal")) persistCheckpoint(checkpointStatus);
  restorePendingCandidateWakes();

  if (missionDone && recovered) {
    if (terminalReleasesContestTargets(terminalKind, sampleSizeSettled)) await closeAdmittedContestTargets();
    persistCheckpoint("terminal");
    persistProcessProjection("terminal");
    for (const [signalName, handler] of signalHandlers) process.off(signalName, handler);
    return persistSummary();
  }

  const platform = new MockPlatform([
    { id: mission.challengeId, flagCount: 1, flags: [], html: `<!doctype html><p>${mission.title}</p>\n` },
  ]);
  let broker: LlmBrokerHandle | undefined;
  let rpc: HostRpcHandle | undefined;
  let runtime: ChallengeRuntime | undefined;
  let ledger: Ledger | undefined;
  try {
    commanderMessageTimer = setInterval(pollCommanderMessage, 100);
    commanderMessageTimer.unref();
    await platform.listen();
    const sandbox = new HostFsSandbox();
    const runtimeDbPath = path.join(commanderRoot, "runtime.db");
    const recoveringRuntime = fs.existsSync(runtimeDbPath);
    ledger = new Ledger(runtimeDbPath);
    if (recoveringRuntime) ledger.resumeMission("mission-commander", config.competition.autonomy);
    else ledger.createMission("mission-commander", config.competition.autonomy);
    const liveRuntime = new ChallengeRuntime(ledger, platform, randomCapabilitySecret(), sandbox);
    runtime = liveRuntime;
    const workspace = path.join(commanderRoot, "challenges", mission.challengeId);
    liveRuntime.startChallenge(
      {
        missionId: "mission-commander",
        challengeId: mission.challengeId,
        flagCount: 1,
        autonomy: config.competition.autonomy,
        targetUrl: mission.target,
        workspace,
        track: config.competition.track,
        flagPattern: mission.flagPattern ?? config.competition.flagPattern,
        hintPolicy: mission.hintPolicy ?? config.competition.hintPolicy,
        acceptanceMode: "candidate-report",
        inScopeUrls: mission.inScope,
      },
      { toolsPreset: "commander" },
      { resumeExisting: recoveringRuntime },
    );
    const started = liveRuntime.startAttempt(
      mission.challengeId,
      {
        attemptId: "commander",
        containerId: HOSTFS_CONTAINER_ID,
        toolsPreset: "commander",
      },
      {
        resumeExisting: recoveringRuntime,
        // Process-local RPC scope. Do not inherit the independently queued room budget.
        capabilityTtlMs: Number.MAX_SAFE_INTEGER - Date.now() - 60_000,
      },
    );
    liveRuntime.setMissionCommanderBinding(mission.challengeId, {
      invoke: async (method, payload) => {
        if (method === "contest_list") {
          if (!contestAdapter?.list) throw new Error("contest_list is not available for this Mission");
          const rows = await contestAdapter.list();
          for (const row of rows) commanderPlatformRows.set(row.boardId, row);
          return {
            challenges: rows.map((row) => ({
              ...projectContestBoard(row),
              targetId: row.boardId,
              acceptedCount: row.correctFlagCount,
              completed: row.isCompleted,
              targetUrls: row.containerAddr.map(contestTargetUrl),
            })),
          };
        }
        if (method === "contest_start") {
          if (!contestAdapter?.start) throw new Error("contest_start is not available for this Mission");
          const targetId = String(payload.targetId ?? "").trim();
          if (!targetId) throw new Error("contest_start requires targetId");
          if (contestAdapter.list) {
            for (const row of await contestAdapter.list()) commanderPlatformRows.set(row.boardId, row);
          }
          const startedTarget = await contestAdapter.start(targetId);
          closedContestTargets.delete(startedTarget.boardId);
          const listedTarget = commanderPlatformRows.get(startedTarget.boardId) ?? commanderPlatformRows.get(targetId);
          const content = mergePlatformLayers({
            ...(listedTarget ? { list: listedTarget } : {}),
            start: startedTarget,
          });
          const bundle = challengeBundleFromPlatform({
            challengeId: startedTarget.boardId,
            ...(listedTarget ? { flagCount: listedTarget.flagCount } : {}),
            containerAddr: startedTarget.containerAddr,
            ...content,
          });
          if (bundle) commanderStartedBundles.set(startedTarget.boardId, bundle);
          const admission = platformAdmissions.find((row) => row.targetId === startedTarget.boardId);
          if (admission && bundle) {
            admission.bundle = admission.bundle?.childMission
              ? withCommanderChildMission(bundle, admission.bundle.childMission, missionAcceptanceText)
              : bundle;
            admission.targetUrl = bundle.targetUrl;
            admission.flagCount = bundle.flagCount;
          }
          persistCheckpoint("active");
          const targetUrls = startedTarget.containerAddr.map(contestTargetUrl);
          return {
            ...(listedTarget ? projectContestBoard(listedTarget) : content),
            ...content,
            targetId: startedTarget.boardId,
            containerAddr: startedTarget.containerAddr,
            targetUrls,
            ...(targetUrls[0] ? { targetUrl: targetUrls[0] } : {}),
          };
        }
        if (method === "queue_target") {
          const livePool = pool;
          if (!livePool) throw new Error("room pool is not initialized");
          if (
            !freshAttemptRetryDecision({
              missionTerminal: missionDone,
              targetSolved: false,
              platformCompleted: false,
              targetActive: false,
              roomExpired: false,
            }).allowed
          ) {
            throw new Error("mission is already terminal");
          }
          const targetId = String(payload.targetId ?? "").trim();
          const targetUrl = String(payload.targetUrl ?? "").trim();
          if (payload.start !== undefined) {
            throw new Error("queue_target does not start platform targets; Commander must follow the Mission and pass targetUrl");
          }
          const requestedChildMission = requireCommanderChildMission(payload.childMission);
          const childMission = requestedChildMission;
          const acceptance = missionAcceptanceText;
          const withChild = (bundle?: ChallengeBundle) =>
            bundle ? withCommanderChildMission(bundle, childMission, acceptance) : bundle;
          const declaredFlagCount = payload.flagCount === undefined ? undefined : Number(payload.flagCount);
          if (
            declaredFlagCount !== undefined &&
            (!Number.isInteger(declaredFlagCount) || declaredFlagCount < 1 || declaredFlagCount > 128)
          ) {
            throw new Error("queue_target flagCount must be an integer from 1 to 128");
          }
          // Compatibility-only capacity for the existing ledger/admission types.
          // Absence remains visible as unknown in the Room task contract.
          const flagCount = declaredFlagCount ?? 1;
          const onlyGate = missionOnlyBoardAdmission({ onlyBoardIds: missionOnlyBoardIds, targetId });
          if (!onlyGate.accepted) {
            const refused = {
              ...livePool.status(),
              accepted: false as const,
              reason: onlyGate.reason,
              onlyBoardIds: onlyGate.onlyBoardIds,
            };
            emit({ type: "queue-target", targetId, targetUrl, ...(declaredFlagCount !== undefined ? { flagCount } : {}), retry: payload.retry === true, start: payload.start === true, ...refused });
            return refused;
          }
          if (closedContestTargets.has(targetId)) {
            const refused = {
              ...livePool.status(),
              accepted: false as const,
              reason: "target_environment_closed",
              guidance: "Call contest_start for this challenge, then queue_target with its current targetUrl.",
            };
            emit({ type: "queue-target", targetId, targetUrl, retry: payload.retry === true, ...refused });
            return refused;
          }
          const expiredClock = readExpiredMissionRoomClock(contestDir, targetId);
          const retry = payload.retry === true;
          const start = false;
          const slots = livePool.status();
          const solvedTargetIds = new Set(
            settled.filter((row) => row.outcome === "solved").map((row) => row.targetId),
          );
          const platformCompletedTargetIds = nonRelaunchableTargetIds();
          const targetBusy = slots.activeIds.includes(targetId) || slots.queuedIds.includes(targetId);
          const previousResult = settled.filter((row) => row.targetId === targetId).at(-1);
          const retryDecision = freshAttemptRetryDecision({
            missionTerminal: missionDone,
            targetSolved: solvedTargetIds.has(targetId),
            platformCompleted: platformCompletedTargetIds.has(targetId),
            targetActive: targetBusy,
            roomExpired: Boolean(expiredClock),
            ...(previousResult?.stopReason ? { previousStopReason: previousResult.stopReason } : {}),
          });
          if (!retryDecision.allowed) {
            const refused = {
              ...livePool.status(),
              accepted: false as const,
              reason: retryDecision.reason,
            };
            emit({ type: "queue-target", targetId, targetUrl, ...(declaredFlagCount !== undefined ? { flagCount } : {}), retry, start, ...refused });
            if (retryDecision.reason === "target_already_solved") finishIfAdmissibleTargetsSolved();
            return refused;
          }
          const admitted = await advancePlatformAdmission({
            records: platformAdmissions,
            admittedTargetIds,
            starting: admissionStarts,
            sampleSize: missionSampleSize,
            targetId,
            retry,
            start,
            ...(start ? {} : { targetUrl }),
            replaceStoredTarget: retryDecision.freshAttempt,
            flagCount,
            poolBusy: slots.activeIds.includes(targetId) || slots.queuedIds.includes(targetId),
            solvedTargetIds,
            platformCompletedTargetIds,
            commit: () => persistCheckpoint("active"),
            rememberFlagCount: (id, count) => {
              workerFlagCounts.set(id, count);
            },
            startBoard: async () => {
              throw new Error("queue_target does not start platform targets");
            },
            hydrateBoard: async (boardId, knownUrl) => {
              const startedBundle = commanderStartedBundles.get(boardId);
              if (startedBundle) return withChild(startedBundle);
              const listedTarget = commanderPlatformRows.get(boardId);
              if (listedTarget) {
                return withChild(challengeBundleFromBoard(listedTarget, [knownUrl]));
              }
              return withChild(
                challengeBundleFromPlatform({
                  challengeId: boardId,
                  ...(declaredFlagCount !== undefined ? { flagCount } : {}),
                  containerAddr: [knownUrl],
                }),
              );
            },
            enqueue: (row, opts) => {
              const bundle = withChild(row.bundle);
              if (!bundle) {
                throw new Error(`queue_target ${targetId} did not produce a Commander childMission bundle`);
              }
              const record = platformAdmissions.find((candidate) => candidate.targetId === targetId);
              if (record) {
                record.bundle = bundle;
                record.flagCount = bundle.flagCount;
                persistCheckpoint("active");
              }
              return livePool.enqueue({
                ...row,
                bundle,
                ...(retryDecision.freshAttempt ? { freshAttempt: true } : {}),
              }, opts);
            },
          });
          if (admitted.outcome === "refused") {
            const refused = {
              ...livePool.status(),
              accepted: false as const,
              reason: admitted.reason,
              ...(admitted.reason === "sample_size_reached"
                ? { sampleSize: admitted.sampleSize, admitted: admitted.admitted }
                : {}),
            };
            emit({ type: "queue-target", targetId, targetUrl, ...(declaredFlagCount !== undefined ? { flagCount } : {}), retry, start, ...refused });
            finishIfAdmissibleTargetsSolved();
            return refused;
          }
          emit({
            type: "queue-target",
            targetId,
            targetUrl: admitted.targetUrl,
            ...(declaredFlagCount !== undefined ? { flagCount } : {}),
            retry,
            start,
            started: admitted.started,
            ...admitted.result,
          });
          if (admitted.result.accepted) {
            markControlProgress();
            persistCheckpoint("active");
          }
          return {
            ...admitted.result,
            ...(admitted.started ? { targetUrl: admitted.targetUrl, started: true } : {}),
          };
        }
        if (method === "mission_status") {
          const liveProjects = [...activeRoomControls.entries()].map(([id, controls]) => {
            try {
              return controls.pulse();
            } catch {
              return { challengeId: id, error: "pulse_unavailable" };
            }
          });
          const liveIds = new Set(
            liveProjects.map((row) => (row as { challengeId?: string }).challengeId).filter(Boolean) as string[],
          );
          const stalledProjects = projectRuntime.snapshot()
            .filter((row) => row.status === "stalled" && !liveIds.has(row.challengeId))
            .map((row) => ({
              challengeId: row.challengeId,
              status: row.status,
              allGroupsStalled: true,
              awaitingResourceDecision: true,
              groups: row.groups.map((group) => ({
                groupId: group.groupId,
                status: "stalled",
                ...(group.sessionId ? { sessionId: group.sessionId } : {}),
              })),
            }));
          const projects = [...liveProjects, ...stalledProjects];
          const attemptCounts = logicalAttemptCounts(settled);
          emit({ type: "project-pulse", projects });
          return {
            configured: Boolean(pool),
            missionDone,
            slots: pool?.status() ?? null,
            firstPassTargetIds: platformAdmissions.map((row) => row.targetId),
            attemptCounts,
            recentResults: settled.slice(-8),
            recentTargetReviews: latestMissionTargetReviews(targetReviews).slice(-8),
            unresolvedTargetIds: unresolvedMissionTargetIds(
              settled,
              targetReviews,
              platformAdmissions.map((row) => row.targetId),
            ),
            pendingCandidateTargetIds: candidateReviewTracker.pendingTargetIds(),
            pendingRoomControlRequests: [...pendingRoomControlRequests.values()],
            pendingAllocationReviews: [...pendingAllocationReviews.values()],
            projects,
          };
        }
        if (method === "review_room_allocation") {
          const targetId = String(payload.targetId ?? "").trim();
          const decision = String(payload.decision ?? "");
          const reason = String(payload.reason ?? "").trim();
          const review = pendingAllocationReviews.get(targetId);
          if (!targetId || !review) {
            throw new Error("review_room_allocation requires a pending active-room checkpoint");
          }
          if (decision !== "continue" && decision !== "defer") {
            throw new Error("review_room_allocation decision must be continue or defer");
          }
          if (!reason) throw new Error("review_room_allocation requires a factual scheduling reason");
          const controller = activeRoomAborters.get(targetId);
          if (!controller || controller.signal.aborted) {
            throw new Error("review_room_allocation requires an active Room");
          }
          pendingAllocationReviews.delete(targetId);
          for (let i = missionWakes.length - 1; i >= 0; i -= 1) {
            const wake = missionWakes[i];
            if (wake?.kind === "allocation_checkpoint" && wake.review.targetId === targetId) missionWakes.splice(i, 1);
          }
          if (decision === "defer") {
            scheduledDeferTargetIds.add(targetId);
            controller.abort("allocation deferred");
          } else if (review.checkpointMinute === 30) {
            const state = allocationStates.get(targetId);
            if (state) {
              state.nextCheckpointMinute = 60;
              if (review.currentPlatformProgress) state.previousPlatformProgress = review.currentPlatformProgress;
            }
            activeAllocationContinuations.get(targetId)?.();
          } else {
            const state = allocationStates.get(targetId);
            if (state) {
              delete state.nextCheckpointMinute;
              if (review.currentPlatformProgress) state.previousPlatformProgress = review.currentPlatformProgress;
            }
          }
          markControlProgress();
          persistCheckpoint("active");
          emit({ type: "room-allocation-reviewed", targetId, checkpointMinute: review.checkpointMinute, decision, reason });
          return { reviewed: true, targetId, decision };
        }
        if (method === "resolve_room_request") {
          const targetId = String(payload.targetId ?? "").trim();
          const decision = String(payload.decision ?? "");
          const reason = String(payload.reason ?? "").trim();
          if (!targetId || !/^[A-Za-z0-9._-]+$/.test(targetId)) {
            throw new Error("resolve_room_request targetId must be [A-Za-z0-9._-]+");
          }
          if (decision !== "continue" && decision !== "defer") {
            throw new Error("resolve_room_request decision must be continue or defer");
          }
          if (!reason) throw new Error("resolve_room_request requires a factual reason");
          const request = pendingRoomControlRequests.get(targetId);
          if (!request) throw new Error(`resolve_room_request has no pending request for ${targetId}`);
          const controls = activeRoomControls.get(targetId);
          if (!controls) throw new Error(`resolve_room_request requires an active Room: ${targetId}`);
          // Persist the Commander's external facts before either continuing or
          // stopping the attempt so the current or next Team can read them.
          liveRuntime.recordRoomControlResolution(targetId, reason);
          controls.resolveRoomRequest(decision);
          pendingRoomControlRequests.delete(targetId);
          markControlProgress();
          persistCheckpoint("active");
          emit({ type: "room-control-resolved", targetId, decision, reason });
          return {
            resolved: true,
            targetId,
            decision,
            roomAction: decision === "defer" ? "stopping" : "continued",
          };
        }
        if (method === "record_target_result") {
          const targetId = String(payload.targetId ?? "").trim();
          const status = String(payload.status ?? "");
          const reason = String(payload.reason ?? "").trim();
          if (!targetId || !/^[A-Za-z0-9._-]+$/.test(targetId)) {
            throw new Error("record_target_result targetId must be [A-Za-z0-9._-]+");
          }
          if (status !== "completed" && status !== "pending") {
            throw new Error("record_target_result status must be completed or pending");
          }
          if (!reason) throw new Error("record_target_result requires a factual external-result reason");
          const slots = pool?.status();
          if (slots?.queuedIds.includes(targetId)) {
            throw new Error(`record_target_result refused while target is queued: ${targetId}`);
          }
          const active = Boolean(slots?.activeIds.includes(targetId));
          const controls = activeRoomControls.get(targetId);
          if (active && !controls) {
            throw new Error(`record_target_result requires an active Project: ${targetId}`);
          }
          if (active && status === "pending" && !pendingCandidateTargets.has(targetId)) {
            throw new Error(`record_target_result pending requires an active candidate report: ${targetId}`);
          }
          const projectStatus = projectRuntime.snapshot().find((row) => row.challengeId === targetId)?.status;
          if (projectStatus === "closed") {
            dropCandidateWakes(targetId);
            markControlProgress();
            persistCheckpoint("active");
            return { recorded: true, discarded: true, reason: "project_closed" };
          }
          const settledCount = settled.filter((row) => row.targetId === targetId).length;
          const workerResultNumber = settledCount + (active ? 1 : 0);
          if (workerResultNumber === 0) throw new Error(`record_target_result requires a finished Worker: ${targetId}`);
          const prior = targetReviews.findLast(
            (row) => row.targetId === targetId && row.workerResultNumber === workerResultNumber,
          );
          const reviewState = candidateReviewTracker.stateFor(targetId);
          const rawAcked = Number(payload.reviewGenerationId);
          const ackedFromPayload =
            Number.isFinite(rawAcked) && rawAcked >= 1 ? Math.floor(rawAcked) : undefined;
          const needsGenerationAck =
            Boolean(reviewState && reviewState.latestReviewGeneration > reviewState.ackedReviewGeneration) ||
            pendingCandidateTargets.has(targetId);
          if (needsGenerationAck && status !== "completed") {
            if (ackedFromPayload === undefined) {
              throw new Error(
                "record_target_result requires reviewGenerationId echoing the candidate report wake",
              );
            }
          }
          const applyPendingAck = (): void => {
            if (ackedFromPayload === undefined) {
              pendingCandidateTargets.delete(targetId);
              return;
            }
            const acked = candidateReviewTracker.ackReviewGeneration({
              targetId,
              reviewGenerationId: ackedFromPayload,
            });
            if (acked.caughtUp) {
              pendingCandidateTargets.delete(targetId);
            } else {
              pendingCandidateTargets.add(targetId);
              // needsRewake: tracker already upgraded/queued latest generation.
            }
          };
          /** Room hold first, Mission tracker second — never leave split ack watermarks. */
          const ackPending = async (): Promise<void> => {
            if (!controls) {
              applyPendingAck();
              signalReviewReleased(targetId);
              return;
            }
            await ackPendingRoomThenMission({
              noteReviewReleased: () => projectRuntime.noteReviewReleased(targetId),
              recordRoomPending: async () => {
                await controls.recordTaskReview({
                  status: "pending",
                  reason,
                  ...(ackedFromPayload !== undefined ? { ackedGenerationId: ackedFromPayload } : {}),
                });
              },
              applyMissionAck: applyPendingAck,
              signalReviewReleased: () => signalReviewReleased(targetId),
            });
          };
          if (prior?.status === status && prior.reason === reason) {
            if (active && controls && status !== "completed") {
              await ackPending();
            } else if (status === "completed") {
              await closeContestTarget(targetId);
              dropCandidateWakes(targetId);
              signalReviewReleased(targetId);
            }
            markControlProgress();
            persistCheckpoint("active");
            return {
              recorded: true,
              duplicate: true,
              review: prior,
              roomAction: active ? (status === "completed" ? "closed" : "continued") : "settled",
            };
          }
          const storedStatus: MissionTargetReview["status"] = status;
          const review: MissionTargetReview = {
            targetId,
            status: storedStatus,
            reason,
            workerResultNumber,
            reviewedAt: new Date().toISOString(),
          };
          targetReviews.push(review);
          if (storedStatus === "completed") {
            dropCandidateWakes(targetId);
            if (active && controls) {
              await Promise.resolve(controls.recordTaskReview({ status, reason }));
            } else if (!(active && controls)) {
              const targetDir = path.join(contestDir, "targets", targetId);
              const roomClockDir = liveRoomClockDir({
                challengeId: targetId,
                roomWorkDir: targetDir,
                replayPath: targetDir,
              });
              await applyRoomPlatformAcceptedStop({
                roomClockDir,
                roomId: targetId,
                challengeId: targetId,
                projects: projectRuntime,
                stopReason: "host_terminal_stop",
              });
            }
            markControlProgress();
            persistCheckpoint("active");
            await closeContestTarget(targetId);
            signalReviewReleased(targetId);
          } else if (active && controls) {
            await ackPending();
          } else {
            applyPendingAck();
            signalReviewReleased(targetId);
          }
          markControlProgress();
          persistCheckpoint("active");
          const roomAction = !active ? "settled" : storedStatus === "completed" ? "closed" : "continued";
          emit({ type: "target-result-recorded", ...review, roomAction });
          finishIfAdmissibleTargetsSolved();
          return { recorded: true, duplicate: false, review, roomAction };
        }
        terminalKind = String(payload.terminalKind ?? "");
        if (
          !["all_completed", "platform_ended", "invalid_mission", "deadline", "operator_stop", "failed"].includes(
            terminalKind,
          )
        ) {
          throw new Error("mission_done terminalKind is invalid");
        }
        if (terminalKind === "failed" && missionSampleSize === undefined) {
          throw new Error("mission_done failed refused for an open full Mission; retry unresolved challenges until completion or an explicit runtime stop");
        }
        if (
          process.env.SILVER_MISSION_SUPERVISED === "1" &&
          missionSampleSize === undefined &&
          terminalKind !== "all_completed"
        ) {
          throw new Error("a supervised full Mission only accepts platform-confirmed all_completed; stop the supervisor to end the run");
        }
        if (terminalKind === "all_completed") {
          const stalled = projectRuntime.snapshot().filter((row) => row.status === "stalled");
          if (stalled.length > 0) {
            throw new Error(
              `mission_done all_completed refused while stalled Projects await a resource decision: ${stalled.map((row) => row.challengeId).join(",")}`,
            );
          }
        }
        terminalReason = String(payload.reason ?? "").trim();
        if (!terminalReason) throw new Error("mission_done requires a factual reason");
        const slots = pool?.status();
        if (slots && (slots.active > 0 || slots.queued > 0)) {
          throw new Error(`mission_done refused while work remains: active=${slots.active} queued=${slots.queued}`);
        }
        const unresolvedTargetIds = unresolvedMissionTargetIds(
          settled,
          targetReviews,
          platformAdmissions.map((row) => row.targetId),
        );
        if (terminalKind === "all_completed" && unresolvedTargetIds.length > 0) {
          throw new Error(
            `mission_done all_completed refused until Commander records fresh platform completion for: ${unresolvedTargetIds.join(",")}`,
          );
        }
        if (terminalKind === "all_completed" && contestAdapter?.boardCompletionAuthoritative && contestAdapter.list) {
          const latestBoard = await contestAdapter.list();
          const eligible = missionOnlyBoardIds
            ? missionOnlyBoardIds.map((id) => latestBoard.find((row) => row.boardId === id))
            : latestBoard;
          if (eligible.length === 0 || eligible.some((row) => !row?.isCompleted)) {
            throw new Error("mission_done all_completed refused: the latest platform board still has unresolved or unknown challenges");
          }
        }
        missionDone = true;
        markControlProgress();
        persistCheckpoint("active");
        emit({ type: "mission-done", terminalKind, reason: terminalReason, slots: slots ?? null });
        setImmediate(() => activeSession?.stop("host_terminal_stop"));
        return { missionDone: true, terminalKind, reason: terminalReason, slots: slots ?? null };
      },
    });
    rpc = await listenHostRpc({ dispatch: (request) => liveRuntime.dispatchRpc(request) });

    const cwd = path.join(workspace, "attempts", "commander");
    const home = path.join(cwd, ".home");
    const tmpDir = path.join(cwd, ".tmp");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const binDir = writeHostFsToolShims(cwd);
    linkHostFsCtfSpinePackage(cwd, repoRoot);
    const seededCommanderMaterials = seedLiveMaterials(cwd, args);
    let route: { baseUrl: string; apiKeyEnv: string } | undefined;
    let llmCapability: string | undefined;
    if (liveNeedsApiKey(resolved)) {
      const apiKey = requireLiveApiKey(resolved);
      llmCapability = randomLlmCapability();
      broker = await listenLlmBroker({
        upstreamBaseUrl: resolved.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL,
        upstreamApiKey: apiKey,
        capability: llmCapability,
        ledgerPath: path.join(commanderRoot, "llm-turns.jsonl"),
        wireDebugPath: path.join(contestDir, "commander-wire.jsonl"),
        provider: resolved.provider,
        model: resolved.model,
        api: liveLlmWireApi(resolved),
        ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
        effort: resolved.effort,
        maxConsecutiveFailedTurns: LIVE_LLM_MAX_CONSECUTIVE_FAILED_TURNS,
        onTransportFailureBudget: () => activeSession?.stop("llm_transport_failure"),
      });
      route = { baseUrl: broker.origin, apiKeyEnv: LLM_CAPABILITY_ENV };
    }
    const { dshHome, modelPatch, storagePatch, personaPatch } = writeLiveDshHome(
      cwd,
      resolved,
      route,
      liveDshHomeOptions({
        personaPrefix: missionCommanderPersona(
          submitAvailable,
          config.competition.track,
          config.competition.autonomy,
          mission.hintPolicy ?? config.competition.hintPolicy,
        ),
        llmRequest: commanderLlmRequestPolicy(),
        commanderSurface: true,
      }),
    );
    await persistSeededMaterials(dshHome, cwd, seededCommanderMaterials);
    const patches = [writeCtfSpinePatch(commanderRoot, repoRoot), modelPatch, storagePatch, personaPatch];
    const cellEnv = liveCellEnv(resolved, {
      challengeId: mission.challengeId,
      attemptId: "commander",
      targetUrl: mission.target,
      inScope: mission.inScope.join(","),
      flagPattern: mission.flagPattern ?? config.competition.flagPattern,
      track: config.competition.track,
      hintPolicy: mission.hintPolicy ?? config.competition.hintPolicy,
      dshHome,
      toolsPreset: "commander",
      externalSearch: config.runtime.externalSearch,
      ...(route && llmCapability ? { llm: { baseUrl: route.baseUrl, capability: llmCapability } } : {}),
      host: { mode: "rpc", origin: rpc.origin, capability: started.capability },
    });
    cellEnv.SILVER_CWD = cwd;
    writeMissionBriefFile(cwd, mission);
    const env = hostSpawnEnv(cellEnv, {
      home, tmpDir, binDir,
      ...(config.runtime.executionProfile === "host" ? { toolsRoot: path.join(repoRoot, ".silver-tools", "host") } : {}),
    });
    const sessionInput = {
      repoRoot,
      cwd,
      patches,
      env,
      modelSelection: {
        provider: resolved.provider,
        model: resolved.model,
        reasoningEffort: resolved.effort,
      },
      signal: aborter.signal,
    };
    let wakePrompt: string | ReturnType<typeof liveSessionPrompt> = recovered && commanderSessionId
      ? `Silver Host process restarted for this same Mission. Resume the existing Mission from official DSH history. Host checkpoint retained ${settled.length} settled Worker result(s); inspect mission_status and current platform state, then continue pending work. Do not count a prior result twice. The full natural-language Mission remains in mission-brief.md.`
      : liveSessionPrompt(
          [
            "Read and execute this complete operator Mission. Treat its prose as the task; it is not a hidden Markdown schema.",
            "Write one private, single-challenge childMission for each Room. Include only that challenge's objective, scope, target, supplied material, current accepted progress, completion condition, task-scoped authentication material, and exact submit procedure. Exclude the wider competition goal, sibling challenge status, global ordering or capacity, and Commander-only list/start/restart/close procedure. Preserve included task-scoped facts exactly; do not summarize away or rewrite them.",
            commanderMaterialsNotice(seededCommanderMaterials),
            "",
            mission.body,
          ].join("\n"),
          cwd,
          { images: false },
        );
    while (!missionDone && !aborter.signal.aborted) {
      if (process.env.SILVER_TEST_COMMANDER_FAIL === "1" && (pool?.status().active ?? 0) > 0) {
        throw new Error("test-injected commander failure");
      }
      if (candidateReviewTracker.reviewRepromptExhausted()) {
        reviewUnacknowledged = true;
        break;
      }
      activeSession = spawnOfficialDshAcpSession({
        ...sessionInput,
        timeoutMs: Number.POSITIVE_INFINITY,
        prompt: wakePrompt,
        ...(commanderSessionId ? { sessionId: commanderSessionId } : {}),
        preserveOnStopReasons: ["llm_transport_failure", "interrupted"],
        preserveOnFailure: true,
        onSessionReady: ({ sessionId }) => {
          commanderSessionId = sessionId;
          persistCheckpoint("active");
        },
      });
      const result = await activeSession.result;
      broker?.resetTransportFailures?.();
      commanderSessionId = result.dshSessionId ?? commanderSessionId;
      if (missionDone || aborter.signal.aborted) break;
      const operatorWakeIndex = missionWakes.findIndex((wake) => wake.kind === "operator_message");
      if (operatorWakeIndex >= 0 && commanderSessionId) {
        const [operatorWake] = missionWakes.splice(operatorWakeIndex, 1);
        if (operatorWake?.kind === "operator_message") {
          wakePrompt = operatorWake.message;
          continue;
        }
      }
      const naturalIdle = isNaturalLiveIdle(result);
      if (!naturalIdle || !commanderSessionId) {
        if (shouldResumeLiveSession(result, aborter.signal)) {
          const now = Date.now();
          commanderTransportRecoveryStartedAt ??= now;
          const recoveryDeadline =
            commanderTransportRecoveryStartedAt +
            commanderTransportDurationMs(
              "SILVER_TEST_COMMANDER_TRANSPORT_RECOVERY_WINDOW_MS",
              MISSION_COMMANDER_TRANSPORT_RECOVERY_WINDOW_MS,
            );
          if (now >= recoveryDeadline) {
            emit({
              type: "commander-transport-waiting",
              commanderSessionId,
              resumeCount: commanderTransportResumes,
              reason:
                "Commander transport is still down. Live rooms keep their own deadline. Host is not stopping them.",
            });
            commanderTransportRecoveryStartedAt = undefined;
            const backoff = await waitForCommanderTransportBackoff(
              aborter.signal,
              commanderTransportDurationMs(
                "SILVER_TEST_COMMANDER_TRANSPORT_BACKOFF_MS",
                MISSION_COMMANDER_TRANSPORT_BACKOFF_MS,
              ),
            );
            if (backoff === "aborted") break;
            continue;
          }
          commanderTransportResumes += 1;
          persistCheckpoint("active");
          emit({
            type: "commander-transport-resume",
            commanderSessionId,
            resumeCount: commanderTransportResumes,
            status: result.status,
            stopReason: result.stopReason ?? null,
            recoveryRemainingMs: Math.max(0, recoveryDeadline - now),
          });
          continue;
        }
        terminalKind = "failed";
        terminalReason = result.stderr.trim()
          ? missionCommanderFailureReason(result.stderr)
          : `Commander session stopped before mission_done (status=${result.status}, stopReason=${result.stopReason ?? "none"})`;
        break;
      }
      commanderTransportRecoveryStartedAt = undefined;
      if (reviewFocusTargetId) {
        const reviewState = candidateReviewTracker.stateFor(reviewFocusTargetId);
        const owed =
          reviewState !== undefined && reviewState.latestReviewGeneration > reviewState.ackedReviewGeneration;
        if (!owed) {
          reviewFocusTargetId = undefined;
        } else {
          const step = candidateReviewTracker.noteUnackedReprompt(reviewFocusTargetId);
          persistCheckpoint("active");
          if (step.exhausted) {
            reviewUnacknowledged = true;
            break;
          }
          if (step.reprompt) {
            wakePrompt = commanderReviewPrompt(step.reviewGenerationId);
            continue;
          }
        }
      }
      commanderHostWakes += 1;
      persistCheckpoint("active");
      const queuedCandidate = candidateReviewTracker.takeNextWake();
      if (queuedCandidate) {
        reviewFocusTargetId = queuedCandidate.targetId;
        wakePrompt = commanderCandidateReportWakePrompt(queuedCandidate);
        continue;
      }
      const status = pool?.status();
      const awaitingResourceDecision =
        pendingRoomControlRequests.size > 0 ||
        projectRuntime.snapshot().some(
          (row) => row.status === "stalled" || row.status === "interrupted",
        );
      if (pool && status && (status.active > 0 || status.queued > 0 || awaitingResourceDecision)) {
        const wake = await waitMissionWake();
        if (wake.kind === "stop") break;
        if (wake.kind === "candidate_report") reviewFocusTargetId = wake.targetId;
        wakePrompt =
          wake.kind === "operator_message"
            ? wake.message
            : wake.kind === "candidate_report"
            ? commanderCandidateReportWakePrompt(wake)
            : wake.kind === "compat_group_stalled"
              ? `A non-formal compatibility Group went idle without a Host candidate: ${JSON.stringify({ targetId: wake.targetId, groupId: wake.groupId })}. Reconcile authoritative platform state only. Inspect mission_status and refresh the platform state if needed. Do not choose a technical route, inspect room tactics, or assign work among room members. This is not a win; sibling compatibility Groups may still be working.`
              : wake.kind === "room_control_request"
                ? `A live Room Lead made a natural-language request using the legacy defer_unavailable transport: ${JSON.stringify(wake.request)}. The transport name makes no claim about resource state, and the Room is still running on its original deadline. Observe the requested external state or perform the requested external action only when the Mission authorizes it, then call resolve_room_request with only the external facts observed and actions performed, including any changed endpoint when relevant. continue keeps the live attempt and deadline; defer ends that attempt so another target may use the slot. Host persists the factual result in the Room Feed before applying either choice. Do not inspect or choose the Room's technical route, and do not return technical direction.`
              : wake.kind === "allocation_checkpoint"
                ? `A Room reached its ${wake.review.checkpointMinute}-minute soft allocation checkpoint: ${JSON.stringify(wake.review)}. The Room is still working. Read mission_status and fresh contest_list; compare remaining score, authoritative accepted progress, and untried challenges. Missing platform progress is unknown, not zero. Use review_room_allocation to continue a promising attempt or defer one with weak payoff so another challenge can use the slot. At 60 minutes, no new accepted result favors yielding to an untried challenge unless available room evidence supports a near-term result; activity counts alone do not prove that. This is a scheduling choice, not a technical direction or hard timeout.`
              : wake.kind === "worker_end"
                ? `A Host worker event is ready: ${JSON.stringify(wake.result)}. Refresh that target's authoritative platform state. If this result carries a defer_unavailable controlRequest, the legacy name has no liveness meaning: follow its text as the Room Lead's natural-language request for an authorized external control or query action. Observe or act externally under the Mission, then use resolve_room_request to return only the external facts observed and actions performed, including any changed endpoint when relevant. continue keeps a still-live attempt and its deadline; defer ends that attempt so another target may use the slot. Neither choice expresses a technical judgment, and resolve_room_request does not itself perform the external action. mission_status exposes firstPassTargetIds and attemptCounts as scheduling facts; choose retry order from the Mission, current platform state, and remaining work. Do not inspect their technical route. Otherwise resume the Mission, inspect mission_status and the latest platform state, then refill available slots or finish only when terminal.`
                : "Resume the Mission: inspect mission_status and the latest platform state, queue remaining challenges, or call mission_done only with a real terminal condition.";
      } else {
        wakePrompt =
          "The Mission is still active and no Worker is currently running. Resume the Mission: inspect mission_status and the latest platform state, queue remaining challenges, or call mission_done only with a real terminal condition.";
      }
    }
    if (reviewUnacknowledged) {
      terminalKind = COMMANDER_REVIEW_UNACKNOWLEDGED;
      terminalReason = COMMANDER_REVIEW_UNACKNOWLEDGED;
      missionDone = false;
      persistProcessProjection("interrupted", { reason: COMMANDER_REVIEW_UNACKNOWLEDGED });
    } else if (aborter.signal.aborted) {
      terminalKind = interruptedBy === "SIGINT" ? "operator_stop" : undefined;
      terminalReason = String(aborter.signal.reason ?? "Mission interrupted");
      missionDone = interruptedBy === "SIGINT";
      persistProcessProjection("interrupted");
    }
    if (!missionDone) {
      if (!aborter.signal.aborted) aborter.abort("mission unresolved exit");
      haltActiveRooms("interrupted");
      pool?.halt();
    }
    if (pool) await pool.drain(MISSION_DRAIN_TIMEOUT_MS);
    if (terminalReleasesContestTargets(terminalKind, sampleSizeSettled)) await closeAdmittedContestTargets();
    persistCheckpoint(missionDone ? "terminal" : "interrupted");
    persistProcessProjection(missionDone ? "terminal" : "interrupted");
    return persistSummary();
  } catch (err) {
    terminalKind ??= "failed";
    terminalReason ??= missionCommanderFailureReason(err);
    emit({ type: "mission-failed", terminalKind, reason: terminalReason });
    if (!missionDone) {
      if (!aborter.signal.aborted) aborter.abort("mission unresolved exit");
      haltActiveRooms("interrupted");
      pool?.halt();
      if (pool) await pool.drain(MISSION_DRAIN_TIMEOUT_MS);
    }
    persistCheckpoint("interrupted");
    persistProcessProjection("failed");
    persistSummary();
    throw new Error(`${terminalReason}; summary=${summaryPath}`);
  } finally {
    if (commanderMessageTimer) clearInterval(commanderMessageTimer);
    for (const [signalName, handler] of signalHandlers) process.off(signalName, handler);
    const pendingSession = activeSession;
    pendingSession?.stop("interrupted");
    if (pendingSession) await pendingSession.result.catch(() => undefined);
    pool?.halt();
    runtime?.setMissionCommanderBinding(mission.challengeId, undefined);
    await runtime?.stopAllAttempts();
    await rpc?.close();
    await broker?.close();
    ledger?.close();
    await platform.close();
    idleSleepGuard?.stop();
  }
}

function missionCommanderFailureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = redactMissionRuntimeText(raw);
  return `Mission Commander failed: ${redacted.slice(0, 500) || "unknown error"}`;
}

function redactMissionRuntimeText(raw: string): string {
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|xai-|gsk_)[A-Za-z0-9._-]{8,}/gi, "[REDACTED]")
    .replace(/([?&](?:token|key|secret|auth)\s*=)[^&\s]+/gi, "$1[REDACTED]");
}

async function runLiveOfficialDsh(
  args: ReturnType<typeof parseCliArgs>,
  cases: CaseSpec[],
  repoRoot: string,
  plan: ResolvedModelCall[],
  config: ReturnType<typeof loadSilverConfig>,
  mission?: MissionBrief,
): Promise<void> {
  const row = cases[0];
  if (!row) throw new Error("no cases");
  const resolved = plan[0];
  if (!resolved) throw new Error("live attempt plan is empty");
  const challengeId = row.challenge.id;
  const spinePatch = path.join(repoRoot, "packages", "ctf-spine", "cordis.patch.yml");
  const aborter = new AbortController();
  const onSigint = (): void => {
    if (!aborter.signal.aborted) aborter.abort("SIGINT");
  };
  const onSigterm = (): void => {
    if (!aborter.signal.aborted) aborter.abort("SIGTERM");
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  try {
  if (!args.isolate && cases.length > 1) {
    const results: ContestSolveResult[] = [];
    for (const current of cases) {
      const currentPlan = resolveAttemptPlan({
        config,
        profile: args.profile ?? "single-fast",
        agent: "ctf-solver",
        challengeId: current.challenge.id,
      });
      if (currentPlan.length === 0) throw new Error(`attempt profile ${args.profile ?? "single-fast"} has no live slices`);
      for (const currentResolved of currentPlan) {
        assertLiveDshRoute(currentResolved);
        if (liveNeedsApiKey(currentResolved)) requireLiveApiKey(currentResolved);
      }
      const caseArgs: ReturnType<typeof parseCliArgs> = { ...args };
      const replayPath = liveCaseReplayPath(args.replayPath, current.challenge.id);
      if (replayPath) caseArgs.replayPath = replayPath;
      const platform = new MockPlatform([current.challenge]);
      const contestSubmit = testContestSubmitHook();
      results.push(
        await runLiveHostFs({
          repoRoot,
          spinePatch,
          platform,
          row: current,
          resolved: currentPlan[0]!,
          resolvedPlan: currentPlan,
          challengeId: current.challenge.id,
          config,
          roomAssembly: ctfRoomAssemblyForRun(config, caseArgs, false),
          args: caseArgs,
          soft: true,
          signal: aborter.signal,
          ...(contestSubmit ? { contestSubmit } : {}),
        }),
      );
      if (aborter.signal.aborted) break;
    }
    const failed = results.filter((result) => result.outcome !== "solved");
    process.stdout.write(`${JSON.stringify(liveCaseAllSummary(results), null, 2)}\n`);
    if (failed.length > 0) process.exitCode = 1;
    return;
  }
  const platform = new MockPlatform([row.challenge]);
  let broker: LlmBrokerHandle | undefined;
  let rpc: HostRpcHandle | undefined;
  let runtime: ChallengeRuntime | undefined;
  let ledger: Ledger | undefined;
  try {
    if (!args.isolate) {
      const contestSubmit = testContestSubmitHook();
      await runLiveHostFs({
        repoRoot,
        spinePatch,
        platform,
        row,
        resolved,
        resolvedPlan: plan,
        challengeId,
        config,
        roomAssembly: ctfRoomAssemblyForRun(
          config,
          args,
          (mission?.hintPolicy ?? config.competition.hintPolicy) === "open",
        ),
        args,
        ...(mission ? { mission } : {}),
        signal: aborter.signal,
        ...(contestSubmit ? { contestSubmit } : {}),
      });
      return;
    }
    if (plan.length > 1) {
      throw new Error("silver run --live --isolate currently supports one DSH root session; use HostFs live for multi-attempt");
    }
    const budget = liveBudgetFromArgs(config, args);
    const execDir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-live-exec-"));
    const turnsPath = path.join(execDir, "llm-turns.jsonl");
    const wirePath = liveWireDebugPath(args.replayPath, execDir);
    const startedAt = new Date();
    await platform.listen("0.0.0.0");
    let hostStop: LiveRunStopReason | undefined;
    let session: ReturnType<typeof spawnOfficialDshAcpSession> | undefined;
    let liveRoute: { baseUrl: string; apiKeyEnv: string } | undefined;
    let llmCapability: string | undefined;
    if (liveNeedsApiKey(resolved)) {
      const apiKey = requireLiveApiKey(resolved);
      llmCapability = randomLlmCapability();
      broker = await listenLlmBroker({
        upstreamBaseUrl: resolved.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL,
        upstreamApiKey: apiKey,
        capability: llmCapability,
        ledgerPath: turnsPath,
        wireDebugPath: wirePath,
        provider: resolved.provider,
        model: resolved.model,
        api: liveLlmWireApi(resolved),
        ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
        effort: resolved.effort,
        maxConsecutiveFailedTurns: LIVE_LLM_MAX_CONSECUTIVE_FAILED_TURNS,
        admitChatTurn: (turnIndex) => !liveTurnCapReached(budget, turnIndex - 1),
        onRejectedChatTurn: () => {
          hostStop = "max_turns";
          session?.stop("max_turns");
        },
        onTransportFailureBudget: () => {
          hostStop = "llm_transport_failure";
          session?.stop("llm_transport_failure");
        },
        ...cellBrokerBind(),
      });
      liveRoute = { baseUrl: broker.origin, apiKeyEnv: LLM_CAPABILITY_ENV };
    }
    const sandbox = new IsolationSandbox({
      isolation: new IsolationHost(new ProcessDocker()),
      repoRoot,
      execDir,
      image: resolveCellImage(),
    });
    ledger = new Ledger(path.join(execDir, "runtime.db"));
    ledger.createMission("mission-live", config.competition.autonomy);
    const liveRuntime = new ChallengeRuntime(ledger, platform, randomCapabilitySecret(), sandbox);
    runtime = liveRuntime;
    const workspace = isolationCellDir(execDir, challengeId);
    const origin = platform.origin("host.docker.internal");
    const solve = liveSolveUrls(origin, challengeId, config, mission, Boolean(row.challenge.agent));
    const availableSkills = liveAvailableSkillsForChallenge(config, args);
    const isolatedRoomAssembly = ctfRoomAssemblyForRun(
      config,
      args,
      (mission?.hintPolicy ?? config.competition.hintPolicy) === "open",
    );
    liveRuntime.startChallenge({
      missionId: "mission-live",
      challengeId,
      flagCount: row.challenge.flagCount,
      autonomy: config.competition.autonomy,
      targetUrl: solve.targetUrl,
      workspace,
      track: config.competition.track,
      acceptanceKind: isolatedRoomAssembly.domain,
      acceptanceContract: isolatedRoomAssembly.acceptanceContract,
      flagPattern: mission?.flagPattern ?? config.competition.flagPattern,
      hintPolicy: mission?.hintPolicy ?? config.competition.hintPolicy,
      acceptanceMode: liveAcceptanceMode(Boolean(mission)),
      inScopeUrls: solve.inScope.split(",").filter(Boolean),
      ...(solve.agentUrl ? { inScopeAgentUrls: [solve.agentUrl] } : {}),
      ...(availableSkills ? { availableSkills } : {}),
      ...(mission?.challengeBundle ? { challengeBundle: mission.challengeBundle } : {}),
    });
    const containerId = liveRuntime.cellContainerId(challengeId);
    if (!containerId) throw new Error("live IsolationHost cell has no container id");
    const started = liveRuntime.startAttempt(challengeId, { attemptId: "a0", containerId, toolsPreset: "solver" });
    rpc = await listenHostRpc({
      dispatch: dispatchUntilHostTerminal(liveRuntime, challengeId, Boolean(mission), () => {
        hostStop = "host_terminal_stop";
        session?.stop("host_terminal_stop");
      }),
      ...liveHostRpcBind(),
    });
    const cellWorkspace = path.join(workspace, "workspace");
    seedCaseWorkspace(row, cellWorkspace);
    seedCaseWorkspace(row, path.join(workspace, "attempts", "a0"));
    const seededCell = seedLiveMaterials(cellWorkspace, args);
    const seededAttempt = seedLiveMaterials(path.join(workspace, "attempts", "a0"), args);
    const skillMount = materializeLiveSkillMount(
      liveSkillMountFromConfig(config, liveSkillsEnabled(args)),
      cellWorkspace,
    );
    const hostDshHome = path.join(cellWorkspace, ".silver-dsh");
    const cellDshHome = sandbox.mapPath?.(hostDshHome, challengeId) ?? hostDshHome;
    writeMissionBriefFile(cellWorkspace, mission, { room: true });
    writeMissionBriefFile(path.join(workspace, "attempts", "a0"), mission, { room: true });
    const task = liveSolveTask(solve.targetUrl, isolatedRoomAssembly, mission);
    const prompt = liveSessionPrompt(task, cellWorkspace, { images: liveRouteAcceptsImages(resolved) });
    const promptSkillGestures = promptSkillGesturesFromText(task);
    const { dshHome, modelPatch, storagePatch, personaPatch } = writeLiveDshHome(
      cellWorkspace,
      resolved,
      liveRoute,
      liveDshHomeOptions({
        ...(skillMount ? { skills: skillMount } : {}),
        dshHomeForPatch: cellDshHome,
        // Persona plugin names must resolve inside the cell via the repo mount.
        pluginModuleRepoRoot: REPO_MOUNT,
        llmRequest: workerLlmRequestPolicy(),
        roomCompaction: true,
        ...searchOffOption(config),
        personaPrefix: isolatedRoomAssembly.persona,
      }),
    );
    const collaborationPatch = writeMemberCollaborationPatch(cellWorkspace);
    await persistSeededMaterials(dshHome, cellWorkspace, seededCell);
    await persistSeededMaterials(dshHome, path.join(workspace, "attempts", "a0"), seededAttempt);
    const dshRuntime = describeOfficialDshRuntime({
      repoRoot,
      profile: "acp",
      patches: [spinePatch, modelPatch, storagePatch, personaPatch, collaborationPatch],
    });
    assertAcpDshRuntimeReady(dshRuntime);
    let result = { stdout: "", stderr: "", status: 1 };
    let acpStopReason: string | undefined;
    let dshSessionId: string | undefined;
    try {
      session = sandbox.spawnOfficialDshAcpSession(challengeId, {
        repoRoot,
        cwd: WORKDIR,
        task: prompt,
        env: liveCellEnv(resolved, {
          challengeId,
          attemptId: "a0",
          targetUrl: solve.targetUrl,
          inScope: solve.inScope,
          flagPattern: mission?.flagPattern ?? config.competition.flagPattern,
          track: config.competition.track,
          hintPolicy: mission?.hintPolicy ?? config.competition.hintPolicy,
          dshHome: cellDshHome,
          ...(liveRoute && llmCapability ? { llm: { baseUrl: liveRoute.baseUrl, capability: llmCapability } } : {}),
          host: { mode: "rpc", origin: rpc.origin, capability: started.capability },
        }),
        patches: [
          sandbox.mapPath?.(modelPatch, challengeId) ?? modelPatch,
          sandbox.mapPath?.(storagePatch, challengeId) ?? storagePatch,
          sandbox.mapPath?.(personaPatch, challengeId) ?? personaPatch,
          sandbox.mapPath?.(collaborationPatch, challengeId) ?? collaborationPatch,
        ],
        timeoutMs: budget.timeoutMs,
        modelSelection: {
          provider: resolved.provider,
          model: resolved.model,
          reasoningEffort: resolved.effort,
        },
      });
      const ran = await session.result;
      if (ran.stopReason) hostStop = ran.stopReason;
      if (ran.acpStopReason) acpStopReason = ran.acpStopReason;
      if (ran.dshSessionId) dshSessionId = ran.dshSessionId;
      result = { stdout: ran.stdout, stderr: ran.stderr, status: ran.status };
    } catch (err) {
      const failed = err as { stdout?: string; stderr?: string; code?: string; status?: number };
      result = {
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? (err instanceof Error ? err.message : String(err)),
        status: typeof failed.status === "number" ? failed.status : 1,
      };
      if (!hostStop && (failed.code === "ETIMEDOUT" || /timed out/i.test(result.stderr))) {
        hostStop = "timeout";
      }
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const dshStatus = hostStop ? 1 : result.status;
    const technicalProgress = liveRuntime.progressFor(challengeId);
    finishLiveRun({
      mission,
      runtime: liveRuntime,
      technicalProgress,
      challengeId,
      dshStatus,
      stdout: result.stdout,
      stderr: result.stderr,
      ledger: liveRunLedger({
        args,
        mission,
        challengeId,
        startedAt,
        dshStatus,
        ...(dshSessionId ? { dshSessionId } : {}),
        turnsPath,
        promptSkillGestures,
        wirePath,
        runtime: liveRuntime,
        dshRuntime,
        dshHome,
        ...(hostStop ? { stopReason: hostStop } : {}),
        ...(acpStopReason ? { acpStopReason } : {}),
      }),
      ledgerPath: replayOutputPath(args.replayPath, cellWorkspace),
      evidenceRoot: cellWorkspace,
      budget,
    });
  } finally {
    await runtime?.stopAllAttempts();
    await rpc?.close();
    await broker?.close();
    ledger?.close();
    await platform.close();
  }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

const THREE_GRAPH_WORK_MAX_MS = 10 * 60_000;
const THREE_GRAPH_PLAN_GUIDANCE_MS = 60_000;
const THREE_GRAPH_PLAN_WINDOW_MS = 3 * 60_000;
const THREE_GRAPH_PLAN_FAILURES_PER_ROUND = 2;
const THREE_GRAPH_AUDIT_SLOT_THRESHOLD = Math.ceil(THREE_GRAPH_WORKER_COUNT / 2);
const THREE_GRAPH_AUDIT_WINDOW_MS = 90_000;
const THREE_GRAPH_RESTART_COOLDOWN_MS = 20 * 60_000;
const THREE_GRAPH_RESTART_NOTICE_MS = 5 * 60_000;
const THREE_GRAPH_TRANSPORT_BACKOFF_MS = 30_000;

type ThreeGraphLiveSession = {
  attemptId: string;
  session: ReturnType<typeof spawnOfficialDshAcpSession>;
  spawn: (
    prompt: string,
    sessionId?: string,
  ) => ReturnType<typeof spawnOfficialDshAcpSession>;
  dshSessionId?: string;
  transportResumeCount: number;
  closed: boolean;
  acceptedSeen: number;
  auditor: boolean;
  noticeDir?: string;
  intelNoticeUnread: boolean;
  intelNoticeRequestId?: string;
};

function threeGraphTransportResumeTask(task: string): string {
  return [
    "A transient model transport failure interrupted this same logical Room role. Continue the current task; do not treat the failure as evidence about the task state.",
    "Reconcile any tool outcome that may have completed before repeating a side effect. Re-read the Room graphs at the next natural decision point so a fresh process does not rely on lost chat context.",
    "",
    task,
  ].join("\n");
}

function threeGraphIntelNotice(nodeId: string): string {
  return [
    `Room notice (intel). A teammate marked Intel node ${nodeId} as a new positive finding relevant to active work.`,
    "No reply or acknowledgement is required. This notice does not cancel your current work and does not assign a route.",
    "At the next natural decision point, use graph_query with graph=intel and this nodeId. Check the wider graph only if needed, then independently decide whether to continue your Intent or change route. Other updates may also be present in the graph.",
  ].join("\n");
}

function threeGraphAcceptanceChangedNotice(
  previousAccepted: number,
  current: { accepted: number; expected: number },
): string {
  return [
    `AUTHORITATIVE EXTERNAL PROGRESS CHANGED while this Session was active: ${previousAccepted}/${current.expected} -> ${current.accepted}/${current.expected} accepted outcomes.`,
    "This is a shared Room fact, not a Host route assignment. Before further task work, call graph_overview and reconcile the recorded Intent against the remaining Room Goal.",
    "If the Intent still advances a missing accepted result, update its relationship to that remaining result and continue. If the accepted result satisfied or displaced the Intent, mark it completed or superseded and record a replacement Intent before changing route. A still-live capability may continue toward deeper missing results.",
  ].join("\n");
}

function threeGraphMissionContext(
  mission: MissionBrief | undefined,
  challengeId: string,
  targetUrl: string,
  accepted: number,
  expected: number,
  hintPolicy: "open" | "off",
): string {
  return [
    "SOLE AUTHORITATIVE OBJECTIVE: complete the current Room childMission below. It is not background context or the Commander's wider objective. There is no second objective for this Room:",
    `Task: ${challengeId}`,
    `Current authoritative progress known to this room: ${accepted}/${expected} externally accepted outcomes.`,
    `Initial work item: ${targetUrl}`,
    "This childMission is the Room's only goal. Participants choose their own method within its scope and use the graphs only to coordinate reusable state and progress.",
    ...(mission
      ? ["The Commander has already opened this task. Do not call external start or close procedures directly; use the mounted lifecycle procedure only when the task contract requires it."]
      : []),
    ...(hintPolicy === "off"
      ? ["EXTERNAL HINTS ARE DISABLED: continue from the supplied material and current evidence."]
      : []),
    "Full Commander childMission:",
    mission?.body?.trim() || `Complete the long-running task beginning from ${targetUrl}.`,
  ].join("\n");
}

function threeGraphBreadthTask(missionContext: string): string {
  return [
    missionContext,
    "",
    "Begin persistent breadth exploration now. Call graph_overview once, then investigate a materially uncovered work item, dependency, input, or assumption without starving completion work.",
    "Publish confirmed reusable Intel immediately. At the batch boundary, record concise tested coverage, positive and negative outcomes with evidence references, and the next independent blind spot, then return.",
    "The Host will continue this same breadth Session while the Room remains open.",
  ].join("\n");
}

function threeGraphBreadthContinueTask(missionContext: string): string {
  return [
    missionContext,
    "",
    "Continue persistent breadth exploration now. The Room is still open.",
    "Read only enough of the graphs to avoid repeating covered or active work, then investigate the next materially uncovered item or dimension without starving completion work.",
    "Publish confirmed reusable Intel immediately. Record concise coverage, positive and negative outcomes with evidence references, and the next blind spot before returning.",
  ].join("\n");
}

function threeGraphWholeGoalTask(turnId: string, missionContext: string): string {
  return [
    missionContext,
    "",
    "Read mission-brief.md and make the first concrete task action now. Continue until the Room Goal is externally accepted or the Room closes.",
    `Use ${turnId} as the turnId for a multi-minute active Intent; publish reusable Intel as discovered and use the Mission's completion procedure when an outcome is ready.`,
  ].join("\n");
}

function threeGraphWholeGoalContinueTask(missionContext: string): string {
  return [
    missionContext,
    "",
    "Continue working in this same Session. Check the graphs as needed, perform the next decisive task action, and keep reusable findings current until the Room Goal is complete.",
  ].join("\n");
}

function threeGraphWorkerTurnTask(turnId: string, missionContext: string, auditNotice?: string): string {
  return [
    missionContext,
    "",
    `Take the next global decision for this whole task in turn ${turnId}.`,
    ...(auditNotice
      ? [
          `NON-OPTIONAL ROOM STAGNATION RESET FROM THE LATEST WORKER AUDIT: ${auditNotice}`,
          "Reassess the Room's dominant assumptions, unused positive chains, other known work items, and missing prerequisites before choosing work. Do not rename and repeat the same premise. This warning does not assign a route.",
        ]
      : []),
    "Read graph_overview and the linked graph slices needed to understand the remaining Goal, known work items and capabilities, prior results, and active work. Consider the most relevant recent handoff: take its next check when it still advances the Goal, or briefly say in your Intent why another route is better or already active. Choose one work item or capability and one evidence-backed question that advances a missing accepted outcome. Do not repeat the same premise in new wording or collide with an active Intent; distinct questions on the same item may proceed. Record one concise exploring Intent for this exact turn id, linked to relevant nodes, with exploration_update, then return without executing the task. Plan quickly.",
  ].join("\n");
}

function threeGraphWorkerPlanCorrectionTask(turnId: string): string {
  return [
    `Your planning step for ${turnId} is overdue and has been interrupted. Stop task execution now.`,
    "Read graph_overview and the graph slices needed to choose one work item or capability and one evidence-backed, non-duplicative question. Use exploration_update to record the missing exploring Intent with this exact turn id, intended result, reason, relevant links, and return condition.",
    "Return immediately after recording it. Execution begins only after the Host observes the Intent.",
  ].join("\n");
}

function threeGraphWorkerExecutionTask(turnId: string): string {
  return [
    `The plan for ${turnId} is recorded. Begin its execution step now.`,
    "Execute with full method autonomy. After each meaningful result, use its feedback to choose and perform the next decisive action in this same Session; do not stop at a next-step plan. Record reusable positive Intel when found and use the Mission's completion procedure when an outcome is ready.",
    "The complete childMission remains the Goal. If this route ends while time remains, record its outcome, choose a better non-duplicative route, and continue.",
    "Before returning, close the Intent and write one concise linked result with exploration_update: proven chain edge (or none), next test and expected signal, reusable evidence reference, and volatile state to recheck after a reset. Do not leave the frontier only in Session context or scratch files.",
  ].join("\n");
}

function threeGraphCloseoutTask(turnId: string): string {
  return [
    `Host interruption: the maximum execution window for ${turnId} has ended. Stop task execution immediately. This is a mandatory phase change, not advice. Do not begin another action.`,
    `Your only remaining work is to close the Intent for ${turnId}, create one concise linked result with exploration_update, and record any missing reusable Intel with intel_record. In that result state: the proven chain edge or none, the next check and expected signal, a reusable evidence file or stable tool-result reference, and volatile state to recheck after a reset. State exactly what a negative check covered; do not call an entire chain dead from one local failure. Record actual external verdicts as receipts. Do not paste full transcripts or large outputs.`,
    "Return immediately after those updates. Aim to finish this closeout within about one minute; the minute is guidance, not a duration to consume.",
  ].join("\n");
}

function threeGraphRoundAuditTask(
  checkpointFile: string,
  currentFile: string,
  resultFile: string,
  missionContext: string,
): string {
  return [
    missionContext,
    "",
    `Audit the work since the prior checkpoint, after at least ${THREE_GRAPH_AUDIT_SLOT_THRESHOLD} distinct Task Executor slots completed a turn, under the read-only auditor contract. Account for active Intents; an unfinished chain is not stagnant solely because its turn has not closed.`,
    `Compare the prior two-graph projection at ${checkpointFile} with the current projection at ${currentFile}. These files contain concise node summaries; use graph_query read-only for the detail of a specific finding only when needed for your decision.`,
    `If the cycle materially shortened a credible completion chain or produced accepted progress, return without creating ${resultFile}. If it repeated or expanded low-signal work, write one concise natural-language stagnation warning to ${resultFile}, then return. Do not plan, assign work, execute the task, or write either graph.`,
  ].join("\n");
}

type ThreeGraphRoomInput = Parameters<typeof runLiveHostFs>[0] & { threeGraphSwarmId?: string };

async function runThreeGraphRoom(input: ThreeGraphRoomInput): Promise<ContestSolveResult> {
  const { repoRoot, platform, row, resolved, challengeId, config, mission, args } = input;
  const roomAssembly = requireRoomAssembly(input.roomAssembly);
  const startedAt = Date.now();
  const budget = liveBudgetFromArgs(config, args);
  const activeSessions = new Map<string, ThreeGraphLiveSession>();
  let runtime: ChallengeRuntime | undefined;
  let ledger: Ledger | undefined;
  let rpc: HostRpcHandle | undefined;
  let broker: LlmBrokerHandle | undefined;
  let roomTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let roomClosed = false;
  let roomStopReason: LiveRunStopReason | undefined;
  let resolveRoomStopped: (() => void) | undefined;
  const roomStopped = new Promise<void>((resolve) => {
    resolveRoomStopped = resolve;
  });
  const stopRoom = (reason: LiveRunStopReason): void => {
    if (roomClosed) return;
    roomClosed = true;
    roomStopReason = reason;
    for (const live of activeSessions.values()) live.session.stop(reason);
    resolveRoomStopped?.();
  };

  try {
    await platform.listen();
    const solve = liveSolveUrls(platform.origin(), challengeId, config, mission, Boolean(row.challenge.agent));
    const runRoot = liveHostFsRuntimeRoot({
      ...(args.replayPath ? { replayPath: args.replayPath } : {}),
      challengeId,
      targetUrl: solve.targetUrl,
      plan: [resolved],
      ...(input.rootSession !== undefined ? { rootSession: input.rootSession } : {}),
      ...(input.roomWorkDir ? { roomWorkDir: input.roomWorkDir } : {}),
    });
    const root = runRoot.root;
    const runtimeDb = path.join(root, "runtime.db");
    const recovering = fs.existsSync(runtimeDb);
    ledger = new Ledger(runtimeDb);
    if (recovering) ledger.resumeMission("mission-live", config.competition.autonomy);
    else ledger.createMission("mission-live", config.competition.autonomy);
    const graphStore = new RoomGraphStore(
      ledger.db,
      challengeId,
      input.threeGraphSwarmId ?? "primary",
    );
    graphStore.ensureGoal(
      `Complete the Room childMission for ${challengeId}: obtain all ${row.challenge.flagCount} required platform-accepted result${row.challenge.flagCount === 1 ? "" : "s"}`,
      `The Room childMission in mission-brief.md is the sole objective and authority. Exploration, verification, and graph work are useful only when they advance this childMission. Initial input: ${solve.targetUrl}.`,
    );
    const priorResets = graphStore.query({ graph: "intel", kinds: ["environment_reset"], limit: 1 });
    let environmentGeneration = priorResets.total;
    let lastRestartAt = Date.parse(priorResets.nodes[0]?.createdAt ?? "") || 0;
    let currentTargetUrls = [solve.targetUrl];
    const observedEnvironmentGeneration = new Map<string, number>();
    let restartInFlight: Promise<Record<string, unknown>> | undefined;
    const coordinatedRestart: ContestRestartHook | undefined = input.contestRestart
      ? async ({ challengeId: restartChallengeId, attemptId }) => {
          if (restartInFlight) return restartInFlight;
          if (!attemptId || observedEnvironmentGeneration.get(attemptId) !== environmentGeneration) {
            return { restarted: false, error: "environment_generation_changed", environmentGeneration,
              guidance: "Read graph_overview and reassess the current environment before requesting another restart." };
          }
          const retryAfterMs = lastRestartAt + THREE_GRAPH_RESTART_COOLDOWN_MS - Date.now();
          if (retryAfterMs > 0) {
            return { restarted: false, error: "restart_cooldown", environmentGeneration,
              retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
              guidance: "The restart was not performed. Do not wait for the timer and retry the same symptom. Stop bulk traffic on the affected service, check its health at low rate, and continue normal targeted work on healthy services. Record persistent instability in the Room graph." };
          }
          restartInFlight = (async () => {
            const result = await input.contestRestart!({ challengeId: restartChallengeId, attemptId });
            if (result.restarted !== true) return result;
            environmentGeneration += 1;
            lastRestartAt = Date.now();
            const urls = Array.isArray(result.targetUrls)
              ? result.targetUrls.filter((value): value is string => typeof value === "string")
              : typeof result.targetUrl === "string" ? [result.targetUrl] : [];
            if (urls.length) currentTargetUrls = urls;
            let resetFactRecorded = false;
            try {
              graphStore.write("intel", "host", {
                kind: "environment_reset",
                state: "observed",
                summary: `Platform restarted this Room environment; generation ${environmentGeneration}.`,
                detail: "The task environment was refreshed. Read graph_overview for current inputs. Preserve established facts, but recheck environment-bound state before relying on it. Stop stale background work, perform one small health check, and reconcile active Intents before resuming. Work on unaffected items may continue. If the same symptom persists, record it instead of repeating the restart cycle.",
                authority: "platform",
              });
              resetFactRecorded = true;
            } catch {
              // The platform restart already happened; never turn a graph-write error into a second restart.
            }
            const message = [
              `ROOM ENVIRONMENT RESTARTED; generation ${environmentGeneration}.`,
              "Read graph_overview for current inputs and reconcile your active Intent before using old environment-bound state.",
              "Keep established facts, but recheck volatile state before relying on it.",
              "RECOVERY STEP: stop stale background work and make one small health check before resuming the affected work item.",
              "Work on unaffected items may continue. When stable, resume without duplicate ownership. If the same symptom persists, record it instead of repeating the restart cycle.",
            ].join("\n");
            let noticeFailures = 0;
            for (const live of activeSessions.values()) {
              if (live.auditor || !live.noticeDir || !live.session.isActive()) continue;
              try {
                const sent = writeOperatorRoomMessage(live.noticeDir, {
                  message,
                  mode: "steer",
                  ttlMs: 60_000,
                  ...(live.intelNoticeRequestId ? { replacePendingRequestId: live.intelNoticeRequestId } : {}),
                });
                live.intelNoticeRequestId = sent.request.requestId;
                live.intelNoticeUnread = true;
              } catch {
                noticeFailures += 1;
              }
            }
            return { ...result, environmentGeneration, resetFactRecorded, noticeFailures,
              guidance: noticeFailures === 0 && resetFactRecorded
                ? "Host recorded and broadcast the restart. Stop old bulk jobs on the affected service and check health at low rate before resuming bulk traffic; other healthy work continues normally."
                : "The platform restart succeeded, but some Room notifications or the graph fact failed. Stop old bulk jobs on the affected service and check health at low rate before resuming bulk traffic; other healthy work continues normally." };
          })().finally(() => {
            restartInFlight = undefined;
          });
          return restartInFlight;
        }
      : undefined;
    const liveRuntime = new ChallengeRuntime(
      ledger,
      platform,
      randomCapabilitySecret(),
      new HostFsSandbox(),
      input.contestSubmit,
      input.contestHint,
      liveEntry(args) !== "mission",
      input.contestVerify,
      coordinatedRestart,
    );
    const currentAcceptanceProgress = (): { accepted: number; expected: number; completed: boolean } => {
      const progress = liveRuntime.acceptanceProgressFor(challengeId);
      return {
        accepted: progress.platformAcceptedCount ?? progress.knownAcceptedFingerprints.length,
        expected: progress.platformTotalCount ?? progress.expectedFlagCount,
        completed: progress.completed === true,
      };
    };
    liveRuntime.setRoomGraphBinding(challengeId, {
      invoke(method, payload, actor) {
        const caller = activeSessions.get(actor.attemptId);
        if (
          caller &&
          (method === "graph_overview" || (method === "graph_query" && payload.graph === "intel"))
        ) {
          caller.intelNoticeUnread = false;
        }
        if (method === "graph_overview") {
          observedEnvironmentGeneration.set(actor.attemptId, environmentGeneration);
          return {
            ...graphStore.overview(),
            authoritativePlatformAcceptance: currentAcceptanceProgress(),
            environmentGeneration,
            currentTargetUrls,
          };
        }
        if (method === "graph_query") return graphStore.query(payload);
        const owner = actor.memberId ?? actor.attemptId;
        const written = graphStore.write(method === "intel_record" ? "intel" : "exploration", owner, payload);
        if (method === "intel_record" && payload.notifyRoom === true) {
          const message = threeGraphIntelNotice(written.node.id);
          for (const live of activeSessions.values()) {
            if (
              live.auditor ||
              live.attemptId === actor.attemptId ||
              !live.noticeDir ||
              live.intelNoticeUnread ||
              !live.session.isActive()
            ) continue;
            try {
              const sent = writeOperatorRoomMessage(live.noticeDir, { message, mode: "steer", ttlMs: 60_000 });
              live.intelNoticeRequestId = sent.request.requestId;
            } catch {
              // A request in this private inbox can only be the prior generic Intel notice.
            }
            live.intelNoticeUnread = true;
          }
        }
        return written;
      },
    });
    runtime = liveRuntime;
    const workspace = input.roomWorkDir
      ? path.join(input.roomWorkDir, "room")
      : path.join(root, "challenges", challengeId);
    fs.mkdirSync(workspace, { recursive: true });
    writeMissionBriefFile(workspace, mission, { room: true });
    const challengeMaterialsFile = writeChallengeMaterialsFile(
      workspace,
      mission,
      (mission?.hintPolicy ?? config.competition.hintPolicy) === "open" && Boolean(input.contestHint),
    );
    const seededMaterials = seedLiveMaterials(workspace, args);
    fs.mkdirSync(path.join(workspace, "scratch"), { recursive: true });
    const binDir = writeHostFsToolShims(workspace);
    linkHostFsCtfSpinePackage(workspace, repoRoot);
    const spinePatch = writeCtfSpinePatch(root, repoRoot);
    const skillMount = materializeLiveSkillMount(
      liveSkillMountFromConfig(config, liveSkillsEnabled(args)),
      workspace,
    );
    const hintAvailable =
      (mission?.hintPolicy ?? config.competition.hintPolicy) === "open" &&
      (Boolean(input.contestHint) || typeof platform.requestHint === "function");
    const candidateTools = liveEntry(args) !== "mission" || Boolean(input.contestSubmit);
    const availableSkills = liveAvailableSkillsForChallenge(config, args);
    liveRuntime.startChallenge({
      missionId: "mission-live",
      challengeId,
      flagCount: row.challenge.flagCount,
      autonomy: config.competition.autonomy,
      targetUrl: solve.targetUrl,
      workspace,
      track: config.competition.track,
      acceptanceKind: roomAssembly.domain,
      acceptanceContract: roomAssembly.acceptanceContract,
      flagPattern: mission?.flagPattern ?? config.competition.flagPattern,
      hintPolicy: hintAvailable ? "open" : "off",
      acceptanceMode: liveAcceptanceMode(Boolean(mission), Boolean(input.contestSubmit)),
      roomGraph: true,
      inScopeUrls: solve.inScope.split(",").filter(Boolean),
      ...(solve.agentUrl ? { inScopeAgentUrls: [solve.agentUrl] } : {}),
      ...(availableSkills ? { availableSkills } : {}),
      ...(mission?.challengeBundle ? { challengeBundle: mission.challengeBundle } : {}),
    }, {
      policy: "single-fast",
      maxAttempts: 1,
      attemptSlices: [toAttemptSlice(resolved)],
      toolsPreset: "solver",
    }, recovering ? { resumeExisting: true } : undefined);
    if (recovering) ledger.recoverInterruptedSubmissions(challengeId);
    if (input.initialPlatformProgress) {
      liveRuntime.recordPlatformProgress(challengeId, input.initialPlatformProgress);
      if (liveRuntime.platformCompleted(challengeId)) {
        const accepted = input.initialPlatformProgress.correctFlagCount ?? row.challenge.flagCount;
        const total = input.initialPlatformProgress.totalFlagCount ?? row.challenge.flagCount;
        return {
          targetId: challengeId,
          targetUrl: solve.targetUrl,
          outcome: "solved",
          wallTimeMs: Date.now() - startedAt,
          stopReason: "host_terminal_stop",
          platformProgress: {
            acceptedCount: accepted,
            totalCount: total,
            remainingCount: Math.max(0, total - accepted),
            completed: true,
          },
        };
      }
    }
    const currentMissionContext = (): string => {
      const progress = currentAcceptanceProgress();
      return threeGraphMissionContext(mission, challengeId, currentTargetUrls[0] ?? solve.targetUrl, progress.accepted, progress.expected, hintAvailable ? "open" : "off");
    };

    rpc = await listenHostRpc({
      dispatch: dispatchUntilHostTerminal(
        liveRuntime,
        challengeId,
        Boolean(mission),
        () => stopRoom("host_terminal_stop"),
        Boolean(input.contestSubmit),
        true,
      ),
    });

    let route: { baseUrl: string; apiKeyEnv: string } | undefined;
    let llmCapability: string | undefined;
    if (liveNeedsApiKey(resolved)) {
      llmCapability = randomLlmCapability();
      broker = await listenLlmBroker({
        upstreamBaseUrl: resolved.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL,
        upstreamApiKey: requireLiveApiKey(resolved),
        capability: llmCapability,
        ledgerPath: path.join(root, "llm-turns.jsonl"),
        wireDebugPath: path.join(root, "llm-wire.jsonl"),
        provider: resolved.provider,
        model: resolved.model,
        api: liveLlmWireApi(resolved),
        ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
        effort: resolved.effort,
        maxConsecutiveFailedTurns: LIVE_LLM_MAX_CONSECUTIVE_FAILED_TURNS,
      });
      route = { baseUrl: broker.origin, apiKeyEnv: LLM_CAPABILITY_ENV };
    }

    const roomDeadlineAt = startedAt + budget.timeoutMs;
    roomTimer = setTimeout(() => stopRoom("timeout"), Math.max(1, roomDeadlineAt - Date.now()));
    abortListener = () => stopRoom("interrupted");
    if (input.signal?.aborted) abortListener();
    input.signal?.addEventListener("abort", abortListener, { once: true });

    let attemptSequence = ledger.attempts(challengeId).reduce(
      (latest, attempt) => Math.max(latest, attempt.generation),
      0,
    );
    const openSession = async (inputSession: {
      label: string;
      persona: string;
      prompt: string;
      auditor?: boolean;
      hintAllowed?: boolean;
    }): Promise<ThreeGraphLiveSession> => {
      if (roomClosed) throw new Error("room is already closed");
      attemptSequence += 1;
      const swarmPrefix = input.threeGraphSwarmId ? `${input.threeGraphSwarmId}-` : "";
      const attemptId = `${swarmPrefix}${inputSession.label}-${String(attemptSequence).padStart(3, "0")}`;
      const started = liveRuntime.startAttempt(challengeId, {
        ...toAttemptSlice(resolved),
        attemptId,
        containerId: HOSTFS_CONTAINER_ID,
        generation: attemptSequence,
        toolsPreset: "solver",
      }, {
        capabilityTtlMs: capabilityTtlForRoom({ roomDeadlineAtMs: roomDeadlineAt }),
      });
      const sessionDir = path.join(workspace, ".sessions", attemptId);
      const noticeDir = inputSession.auditor ? undefined : path.join(sessionDir, ".room-notices");
      const home = path.join(sessionDir, ".home");
      const tmpDir = path.join(sessionDir, ".tmp");
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      const { dshHome, modelPatch, storagePatch, personaPatch } = writeLiveDshHome(
        sessionDir,
        resolved,
        route,
        liveDshHomeOptions({
          ...(skillMount ? { skills: skillMount } : {}),
          llmRequest: workerLlmRequestPolicy(),
          roomCompaction: true,
          ...searchOffOption(config),
          personaPrefix: inputSession.persona,
        }),
      );
      const sessionHintAvailable = hintAvailable && inputSession.hintAllowed !== false;
      const collaborationPatch = inputSession.auditor
        ? undefined
        : writeMemberCollaborationPatch(sessionDir, {
            hintPolicy: sessionHintAvailable ? "open" : "off",
            contestSubmit: candidateTools,
            contestVerify: Boolean(input.contestVerify) || liveEntry(args) !== "mission",
          });
      await persistSeededMaterials(dshHome, workspace, seededMaterials);
      const cellEnv = liveCellEnv(resolved, {
        challengeId,
        attemptId,
        targetUrl: currentTargetUrls[0] ?? solve.targetUrl,
        inScope: [...new Set([...solve.inScope.split(","), ...currentTargetUrls].filter(Boolean))].join(","),
        flagPattern: mission?.flagPattern ?? config.competition.flagPattern,
        track: config.competition.track,
        domain: roomAssembly.domain,
        hintPolicy: sessionHintAvailable ? "open" : "off",
        contestSubmit: candidateTools,
        contestVerify: Boolean(input.contestVerify) || liveEntry(args) !== "mission",
        contestRestart: Boolean(input.contestRestart),
        dshHome,
        repoRoot,
        ...(args.replayPath ? { replayPath: path.resolve(args.replayPath) } : {}),
        ...(route && llmCapability ? { llm: { baseUrl: route.baseUrl, capability: llmCapability } } : {}),
        host: { mode: "rpc", origin: rpc!.origin, capability: started.capability },
      });
      cellEnv.SILVER_CWD = workspace;
      cellEnv.SILVER_ROOM_GRAPH = "1";
      if (noticeDir) cellEnv[DIRECT_SESSION_NOTICE_DIR_ENV] = noticeDir;
      if (challengeMaterialsFile) cellEnv.SILVER_CHALLENGE_MATERIALS_FILE = challengeMaterialsFile;
      const env = hostSpawnEnv(cellEnv, {
        home,
        tmpDir,
        binDir,
        ...(config.runtime.executionProfile === "host"
          ? { toolsRoot: path.join(repoRoot, ".silver-tools", "host") }
          : {}),
      });
      if (inputSession.auditor) env.SILVER_ROUND_AUDITOR = "1";
      let liveRef: ThreeGraphLiveSession | undefined;
      const spawnSession = (
        prompt: string,
        sessionId?: string,
      ): ReturnType<typeof spawnOfficialDshAcpSession> => spawnOfficialDshAcpSession({
          repoRoot,
          cwd: workspace,
          patches: [
            spinePatch,
            modelPatch,
            storagePatch,
            personaPatch,
            ...(collaborationPatch ? [collaborationPatch] : []),
          ],
          timeoutMs: Math.max(1, roomDeadlineAt - Date.now()),
          env,
          prompt: liveSessionPrompt(prompt, workspace, {
            images: liveRouteAcceptsImages(resolved),
          }),
          ...(sessionId ? { sessionId } : {}),
          modelSelection: {
            provider: resolved.provider,
            model: resolved.model,
            reasoningEffort: resolved.effort,
          },
          ...(input.signal ? { signal: input.signal } : {}),
          preserveOnStopReasons: ["llm_transport_failure"],
          preserveOnFailure: true,
          keepOfficialTeamLeadAlive: true,
          onSessionReady: ({ sessionId: readySessionId }) => {
            if (liveRef) liveRef.dshSessionId = readySessionId;
            input.onGroupSession?.({ groupId: attemptId, sessionId: readySessionId });
          },
        });
      const session = spawnSession(inputSession.prompt);
      const live: ThreeGraphLiveSession = {
        attemptId,
        session,
        spawn: spawnSession,
        transportResumeCount: 0,
        closed: false,
        acceptedSeen: currentAcceptanceProgress().accepted,
        auditor: inputSession.auditor === true,
        intelNoticeUnread: false,
        ...(noticeDir ? { noticeDir } : {}),
      };
      liveRef = live;
      activeSessions.set(attemptId, live);
      return live;
    };

    const closeSession = async (live: ThreeGraphLiveSession, turnId?: string): Promise<void> => {
      live.closed = true;
      if (live.session.isActive()) live.session.stop(roomClosed ? (roomStopReason ?? "interrupted") : "interrupted");
      await live.session.settled;
      activeSessions.delete(live.attemptId);
      observedEnvironmentGeneration.delete(live.attemptId);
      await liveRuntime.stopAttempt(live.attemptId);
      if (turnId) graphStore.abandonActiveIntent(turnId);
    };

    let transportBackoff: Promise<void> | undefined;
    const waitForThreeGraphTransport = (): Promise<void> => {
      if (transportBackoff) return transportBackoff;
      transportBackoff = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, THREE_GRAPH_TRANSPORT_BACKOFF_MS);
            }),
            roomStopped,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          broker?.resetTransportFailures?.();
        }
      })().finally(() => {
        transportBackoff = undefined;
      });
      return transportBackoff;
    };

    const runThreeGraphSessionTurn = async (
      live: ThreeGraphLiveSession,
      turn: Promise<OfficialDshAcpSessionResult>,
      task: string,
    ): Promise<OfficialDshAcpSessionResult> => {
      let current = turn;
      while (true) {
        let result: OfficialDshAcpSessionResult | undefined;
        let failure: unknown;
        try {
          result = await current;
        } catch (err) {
          failure = err;
        }
        const recoverable = result
          ? shouldResumeLiveSession(result, input.signal)
          : isOfficialDshAcpPromptTransportError(failure);
        if (!recoverable || roomClosed || live.closed || input.signal?.aborted) {
          if (failure) throw failure;
          return result!;
        }
        const sessionId = result?.dshSessionId ?? live.dshSessionId;
        if (live.session.isActive()) live.session.stop("llm_transport_failure");
        await live.session.settled;
        await waitForThreeGraphTransport();
        if (roomClosed || live.closed || input.signal?.aborted) {
          if (failure) throw failure;
          return result!;
        }
        const resumeSameSession = Boolean(sessionId) && hasLiveSessionResumeBudget(live.transportResumeCount);
        if (resumeSameSession) live.transportResumeCount += 1;
        else live.transportResumeCount = 0;
        live.session = live.spawn(
          threeGraphTransportResumeTask(task),
          resumeSameSession ? sessionId : undefined,
        );
        current = live.session.result;
      }
    };

    const acceptanceBoundaryPrompt = (live: ThreeGraphLiveSession, prompt: string): string => {
      const current = currentAcceptanceProgress();
      if (current.accepted <= live.acceptedSeen) return prompt;
      const previousAccepted = live.acceptedSeen;
      live.acceptedSeen = current.accepted;
      return [prompt, "", threeGraphAcceptanceChangedNotice(previousAccepted, current)].join("\n");
    };

    const runWorkWindow = async (
      live: ThreeGraphLiveSession,
      work: Promise<OfficialDshAcpSessionResult>,
      task: string,
      windowMs: number,
      closeoutPrompt: string,
      options?: {
        turnId?: string;
      },
    ): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), windowMs);
        });
        const outcome = await Promise.race([
          runThreeGraphSessionTurn(live, work, task).then(() => "done" as const, () => "done" as const),
          timeout,
          roomStopped.then(() => "stopped" as const),
        ]);
        if (outcome === "timeout" && !roomClosed && live.session.isActive()) {
          if (live.session.isPrompting()) await live.session.cancelPrompt();
          if (!roomClosed && live.session.isActive()) {
            const closeoutTask = acceptanceBoundaryPrompt(live, closeoutPrompt);
            await runThreeGraphSessionTurn(live, live.session.prompt(closeoutTask), closeoutTask);
          }
        }
        if (liveRuntime.platformCompleted(challengeId)) stopRoom("host_terminal_stop");
      } finally {
        if (timer) clearTimeout(timer);
        await closeSession(live, options?.turnId);
      }
    };

    const runPersistentSession = async (
      live: ThreeGraphLiveSession,
      initialTurn: Promise<OfficialDshAcpSessionResult>,
      initialTask: string,
      continueTask: () => string,
      turnId?: string,
    ): Promise<void> => {
      let turn = runThreeGraphSessionTurn(live, initialTurn, initialTask);
      try {
        while (!roomClosed) {
          const outcome = await Promise.race([
            turn.then(() => "finished" as const, () => "finished" as const),
            roomStopped.then(() => "stopped" as const),
          ]);
          if (outcome === "stopped" || roomClosed) break;
          if (liveRuntime.platformCompleted(challengeId)) {
            stopRoom("host_terminal_stop");
            break;
          }
          if (!live.session.isActive()) break;
          const task = acceptanceBoundaryPrompt(live, continueTask());
          turn = runThreeGraphSessionTurn(live, live.session.prompt(task), task);
        }
      } finally {
        await closeSession(live, turnId);
      }
    };

    let persistentWholeRun: Promise<void> | undefined;
    const breadthTask = threeGraphBreadthTask(currentMissionContext());
    const breadthSession = await openSession({
      label: "explorer",
      persona: loadBreadthReconRolePrompt(),
      prompt: breadthTask,
      hintAllowed: false,
    });
    const persistentBreadthRun = runPersistentSession(
      breadthSession,
      breadthSession.session.result,
      breadthTask,
      () => threeGraphBreadthContinueTask(currentMissionContext()),
    );
    if (!roomClosed) {
      const wholeTurnId = `end-to-end-executor-${attemptSequence + 1}`;
      const wholeTask = threeGraphWholeGoalTask(wholeTurnId, currentMissionContext());
      const wholeRacerSession = await openSession({
        label: "end-to-end-executor",
        persona: loadWholeRacerRolePrompt(),
        prompt: wholeTask,
      });
      persistentWholeRun = runPersistentSession(
        wholeRacerSession,
        wholeRacerSession.session.result,
        wholeTask,
        () => threeGraphWholeGoalContinueTask(currentMissionContext()),
        wholeTurnId,
      );
    }

    const roundProgressProjection = (): Record<string, unknown> => {
      const rawOverview = graphStore.overview();
      const rawRecent = graphStore.query({ graph: "exploration", limit: 80 });
      const auditNode = (node: RoomGraphNode) => ({
        id: node.id,
        graph: node.graph,
        kind: node.kind,
        state: node.state,
        summary: node.summary,
        owner: node.owner,
        ...(node.turnId ? { turnId: node.turnId } : {}),
        updatedAt: node.updatedAt,
      });
      const overviewReceipts = Array.isArray(rawOverview.receipts)
        ? rawOverview.receipts.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
        : [];
      const overviewExploration = Array.isArray(rawOverview.recentExploration)
        ? rawOverview.recentExploration.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
        : [];
      const receiptIds = new Set([
        ...overviewReceipts.map((node) => String(node.id ?? "")),
        ...overviewExploration.filter((node) => node.kind === "receipt").map((node) => String(node.id ?? "")),
        ...rawRecent.nodes.filter((node) => node.kind === "receipt").map((node) => node.id),
      ].filter(Boolean));
      const { receipts: _omitReceipts, ...searchOverview } = rawOverview;
      for (const key of ["goals", "highSignalIntel", "activeIntents", "recentIntel"] as const) {
        if (Array.isArray(searchOverview[key])) {
          searchOverview[key] = (searchOverview[key] as RoomGraphNode[]).map(auditNode);
        }
      }
      searchOverview.recentExploration = overviewExploration
        .filter((node) => node.kind !== "receipt")
        .map((node) => auditNode(node as RoomGraphNode));
      searchOverview.counts = Array.isArray(rawOverview.counts)
        ? rawOverview.counts.filter((row) => !(
            row && typeof row === "object" &&
            (row as Record<string, unknown>).graph === "exploration" &&
            (row as Record<string, unknown>).kind === "receipt"
          ))
        : [];
      searchOverview.edges = Array.isArray(rawOverview.edges)
        ? rawOverview.edges.filter((edge) => {
            if (!edge || typeof edge !== "object") return false;
            const row = edge as Record<string, unknown>;
            return !receiptIds.has(String(row.from ?? "")) && !receiptIds.has(String(row.to ?? ""));
          })
        : [];
      const searchNodes = rawRecent.nodes.filter((node) => node.kind !== "receipt");
      const searchNodeIds = new Set(searchNodes.map((node) => node.id));
      return {
        authoritativePlatformAcceptance: currentAcceptanceProgress(),
        searchOverview,
        recentExploration: {
          nodes: searchNodes.map(auditNode),
          edges: rawRecent.edges.filter((edge) => (
            searchNodeIds.has(String(edge.from ?? "")) && searchNodeIds.has(String(edge.to ?? ""))
          )),
        },
      };
    };
    const checkpointFile = path.join(workspace, "scratch", "round-checkpoint.json");
    const auditUnavailableFile = path.join(workspace, "scratch", "round-audit-unavailable.json");
    const writeRoundCheckpoint = (): void => {
      fs.writeFileSync(checkpointFile, `${JSON.stringify(roundProgressProjection(), null, 2)}\n`);
    };
    let auditSequence = 0;
    const runRoundAudit = async (): Promise<string | undefined> => {
      if (roomClosed) return undefined;
      for (let attempt = 0; attempt < 2 && !roomClosed; attempt += 1) {
        auditSequence += 1;
        const resultFile = path.join(workspace, "scratch", `round-audit-${auditSequence}.txt`);
        const currentFile = path.join(workspace, "scratch", `round-current-${auditSequence}.json`);
        fs.rmSync(resultFile, { force: true });
        fs.writeFileSync(currentFile, `${JSON.stringify(roundProgressProjection(), null, 2)}\n`);
        const auditTask = threeGraphRoundAuditTask(
          path.relative(workspace, checkpointFile),
          path.relative(workspace, currentFile),
          path.relative(workspace, resultFile),
          currentMissionContext(),
        );
        let live: ThreeGraphLiveSession;
        try {
          live = await openSession({ label: "round-audit", persona: loadRoundAuditorRolePrompt(), prompt: auditTask, auditor: true });
        } catch {
          continue;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let outcome: "done" | "error" | "timeout" | "stopped";
        try {
          outcome = await Promise.race([
            runThreeGraphSessionTurn(live, live.session.result, auditTask).then(
              (result) => isNaturalLiveIdle(result)
                ? "done" as const
                : "error" as const,
              () => "error" as const,
            ),
            new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), THREE_GRAPH_AUDIT_WINDOW_MS);
            }),
            roomStopped.then(() => "stopped" as const),
          ]);
          if (outcome === "timeout" && live.session.isPrompting()) await live.session.cancelPrompt();
        } finally {
          if (timer) clearTimeout(timer);
          await closeSession(live);
        }
        if (outcome === "stopped" || roomClosed) return undefined;
        if (outcome !== "done") continue;
        const notice = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8").trim() : undefined;
        fs.copyFileSync(currentFile, checkpointFile);
        fs.rmSync(auditUnavailableFile, { force: true });
        return notice || undefined;
      }
      if (!roomClosed) {
        fs.writeFileSync(auditUnavailableFile,
          `${JSON.stringify({ at: new Date().toISOString(), checkpointRetained: true })}\n`);
        return "ROUND AUDIT UNAVAILABLE: the review did not complete, and its previous comparison checkpoint was retained. Independently compare the Room Goal and both graphs before choosing your next route; do not assume the current premise is making progress.";
      }
      return undefined;
    };
    writeRoundCheckpoint();
    const stagnationNoticeSlots = new Map<number, string>();
    const beginWorkerTurn = async (slot: number): Promise<{ run: Promise<void> } | undefined> => {
      const planningEnvironmentGeneration = environmentGeneration;
      if (roomClosed) return undefined;
      const turnId = `worker-${slot + 1}-turn-${attemptSequence + 1}`;
      const stagnationNotice = stagnationNoticeSlots.get(slot);
      stagnationNoticeSlots.delete(slot);
      const planningTask = [
        threeGraphWorkerTurnTask(turnId, currentMissionContext(), stagnationNotice),
        ...(Date.now() - lastRestartAt < THREE_GRAPH_RESTART_NOTICE_MS
          ? ["ROOM RESTART RECOVERY: read the latest environment_reset Intel, stop stale background work, and recheck volatile state before resuming the affected work item. Work on unaffected items may continue."]
          : []),
      ].join("\n");
      const live = await openSession({
        label: `task-executor-${slot + 1}`,
        persona: loadRotatingWorkerRolePrompt(),
        prompt: planningTask,
      });
      let planningPrompt = runThreeGraphSessionTurn(live, live.session.result, planningTask).then(
        (result) => ({ kind: "finished" as const, result }),
        () => ({ kind: "finished" as const, result: undefined }),
      );
      let planPoll: ReturnType<typeof setInterval> | undefined;
      const planningObserved = new Promise<{ kind: "planned" }>((resolve) => {
        planPoll = setInterval(() => {
          if (graphStore.hasTurnIntent(turnId)) {
            if (planPoll) clearInterval(planPoll);
            planPoll = undefined;
            resolve({ kind: "planned" });
          }
        }, 100);
        planPoll.unref?.();
      });
      const planningGuidance = new Promise<{ kind: "guidance" }>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: "guidance" }), THREE_GRAPH_PLAN_GUIDANCE_MS);
        timer.unref?.();
      });
      const planningDeadline = new Promise<{ kind: "deadline" }>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: "deadline" }), THREE_GRAPH_PLAN_WINDOW_MS);
        timer.unref?.();
      });
      let correctionSent = false;
      let planning: "planned" | "finished" | "stopped" = "finished";
      while (!roomClosed) {
        const outcome = await Promise.race([
          planningPrompt,
          planningObserved,
          ...(correctionSent ? [] : [planningGuidance]),
          planningDeadline,
          roomStopped.then(() => ({ kind: "stopped" as const })),
        ]);
        if (outcome.kind === "deadline") {
          if (live.session.isPrompting()) await live.session.cancelPrompt();
          planning = "finished";
          break;
        }
        if (outcome.kind === "stopped") {
          planning = "stopped";
        } else if (outcome.kind === "planned") {
          planning = "planned";
        } else if (outcome.kind === "finished") {
          if (graphStore.hasTurnIntent(turnId)) {
            planning = "planned";
          } else if (!correctionSent && live.session.isActive()) {
            const correctionTask = acceptanceBoundaryPrompt(live, threeGraphWorkerPlanCorrectionTask(turnId));
            planningPrompt = runThreeGraphSessionTurn(
              live,
              live.session.prompt(correctionTask),
              correctionTask,
            ).then(
              (result) => ({ kind: "finished" as const, result }),
              () => ({ kind: "finished" as const, result: undefined }),
            );
            correctionSent = true;
            continue;
          } else {
            planning = "finished";
          }
        } else if (!correctionSent) {
          if (live.session.isPrompting()) await live.session.cancelPrompt();
          if (!roomClosed && live.session.isActive()) {
            const correctionTask = acceptanceBoundaryPrompt(live, threeGraphWorkerPlanCorrectionTask(turnId));
            planningPrompt = runThreeGraphSessionTurn(
              live,
              live.session.prompt(correctionTask),
              correctionTask,
            ).then(
              (result) => ({ kind: "finished" as const, result }),
              () => ({ kind: "finished" as const, result: undefined }),
            );
            correctionSent = true;
            continue;
          }
          planning = "finished";
        }
        break;
      }
      if (planPoll) clearInterval(planPoll);
      if (planning !== "planned" || roomClosed) {
        await closeSession(live, turnId);
        return undefined;
      }
      if (liveRuntime.platformCompleted(challengeId)) {
        stopRoom("host_terminal_stop");
        await closeSession(live, turnId);
        return undefined;
      }
      if (live.session.isPrompting()) await live.session.cancelPrompt();
      if (roomClosed || !live.session.isActive()) {
        await closeSession(live, turnId);
        return undefined;
      }
      const executionTask = acceptanceBoundaryPrompt(live, [
        ...(environmentGeneration !== planningEnvironmentGeneration
          ? ["The Room restarted since you planned this Intent. Read graph_overview and reconcile or replace that Intent before using old routes or volatile state. Stop stale background work, make one small health check, and avoid duplicate ownership. Other unaffected work continues normally."]
          : []),
        threeGraphWorkerExecutionTask(turnId),
      ].join("\n"));
      const execution = live.session.prompt(executionTask);
      return {
        run: runWorkWindow(
          live,
          execution,
          executionTask,
          THREE_GRAPH_WORK_MAX_MS,
          threeGraphCloseoutTask(turnId),
          { turnId },
        ),
      };
    };

    const queue = Array.from({ length: THREE_GRAPH_WORKER_COUNT }, (_, index) => index);
    const active = new Map<number, Promise<void>>();
    let planning:
      | { slot: number; turn: Promise<{ run: Promise<void> } | undefined> }
      | undefined;
    const completedSinceCheckpoint = Array.from({ length: THREE_GRAPH_WORKER_COUNT }, () => 0);
    const consecutivePlanFailures = Array.from({ length: THREE_GRAPH_WORKER_COUNT }, () => 0);
    let roundAudit: Promise<void> | undefined;
    const maybeStartRoundAudit = (): void => {
      if (
        roomClosed ||
        roundAudit ||
        completedSinceCheckpoint.filter((count) => count > 0).length < THREE_GRAPH_AUDIT_SLOT_THRESHOLD
      ) return;
      completedSinceCheckpoint.fill(0);
      roundAudit = (async () => {
        const auditNotice = await runRoundAudit();
        if (auditNotice) {
          for (let slot = 0; slot < THREE_GRAPH_WORKER_COUNT; slot += 1) {
            stagnationNoticeSlots.set(slot, auditNotice);
          }
        }
      })().finally(() => {
        roundAudit = undefined;
        maybeStartRoundAudit();
      });
    };
    const completeSlotTurn = (slot: number): void => {
      completedSinceCheckpoint[slot] = (completedSinceCheckpoint[slot] ?? 0) + 1;
      queue.push(slot);
      maybeStartRoundAudit();
    };
    while (!roomClosed) {
      if (!planning && queue.length > 0 && active.size < THREE_GRAPH_WORKER_COUNT) {
        const slot = queue.shift()!;
        planning = { slot, turn: beginWorkerTurn(slot) };
      }
      if (roomClosed) break;
      if (!planning && active.size === 0) {
        await Promise.race([
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
          roomStopped,
        ]);
        continue;
      }
      const event = await nextThreeGraphSlotEvent({
        ...(planning ? { planning } : {}),
        active,
        stopped: roomStopped,
      });
      if (event.kind === "stopped") break;
      if (event.kind === "finished") {
        active.delete(event.slot);
        completeSlotTurn(event.slot);
        continue;
      }
      planning = undefined;
      if (event.turn) {
        consecutivePlanFailures[event.slot] = 0;
        active.set(event.slot, event.turn.run);
      } else if (!roomClosed) {
        const failures = (consecutivePlanFailures[event.slot] ?? 0) + 1;
        consecutivePlanFailures[event.slot] = failures;
        if (failures >= THREE_GRAPH_PLAN_FAILURES_PER_ROUND) {
          consecutivePlanFailures[event.slot] = 0;
          completeSlotTurn(event.slot);
        } else {
          queue.push(event.slot);
        }
      }
    }
    const pendingPlanning = planning?.turn.then((turn) => turn?.run);
    await Promise.allSettled([
      persistentBreadthRun,
      ...(persistentWholeRun ? [persistentWholeRun] : []),
      ...(roundAudit ? [roundAudit] : []),
      ...active.values(),
      ...(pendingPlanning ? [pendingPlanning] : []),
    ]);

    const platformVerdicts = liveRuntime.takePlatformVerdicts(challengeId);
    const platformProgress = platformProgressFromVerdicts(platformVerdicts);
    const solved = liveRuntime.platformCompleted(challengeId);
    const graphReportPath = path.join(workspace, "room-graph-overview.json");
    fs.writeFileSync(graphReportPath, `${JSON.stringify(graphStore.overview(), null, 2)}\n`);
    return {
      targetId: challengeId,
      targetUrl: solve.targetUrl,
      outcome: solved ? "solved" : "stalled",
      wallTimeMs: Date.now() - startedAt,
      ...(roomStopReason ? { stopReason: roomStopReason } : {}),
      ...(platformProgress ? { platformProgress } : {}),
      ...(platformVerdicts.length ? { platformVerdicts } : {}),
      replayPath: root,
      reportPath: graphReportPath,
    };
  } catch (err) {
    if (!input.soft) throw err;
    const platformVerdicts = runtime?.takePlatformVerdicts(challengeId) ?? [];
    const platformProgress = platformProgressFromVerdicts(platformVerdicts);
    return {
      targetId: challengeId,
      targetUrl: mission?.target ?? "",
      ...(runtime?.platformCompleted(challengeId) ? { outcome: "solved" } : { outcome: "failed" }),
      wallTimeMs: Date.now() - startedAt,
      ...(roomStopReason ? { stopReason: roomStopReason } : {}),
      ...(platformProgress ? { platformProgress } : {}),
      ...(platformVerdicts.length ? { platformVerdicts } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (roomTimer) clearTimeout(roomTimer);
    if (abortListener) input.signal?.removeEventListener("abort", abortListener);
    for (const live of activeSessions.values()) live.session.stop(roomStopReason ?? "interrupted");
    await Promise.allSettled([...activeSessions.values()].map((live) => live.session.settled));
    await runtime?.stopAllAttempts();
    await rpc?.close();
    await broker?.close();
    ledger?.close();
    await platform.close();
  }
}

async function runIsolatedThreeGraphSwarms(
  input: Parameters<typeof runLiveHostFs>[0],
): Promise<ContestSolveResult> {
  const swarmCount = input.config.room.swarmCount;
  const declaredRoutes = input.resolvedPlan?.slice(0, swarmCount) ?? [input.resolved];
  const routes = Array.from(
    { length: swarmCount },
    (_, index) => declaredRoutes[index] ?? declaredRoutes[0] ?? input.resolved,
  );
  const baseDir = input.roomWorkDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "silver-three-graph-swarms-"));
  const controllers = routes.map(() => new AbortController());
  const onParentAbort = (): void => {
    for (const controller of controllers) controller.abort();
  };
  if (input.signal?.aborted) onParentAbort();
  input.signal?.addEventListener("abort", onParentAbort, { once: true });

  let winner: ContestSolveResult | undefined;
  const settled = await Promise.allSettled(
    routes.map(async (route, index) => {
      const swarmId = index === 0 ? "swarm-a" : "swarm-b";
      const swarmDir = path.join(baseDir, swarmId);
      const result = await runThreeGraphRoom({
        ...input,
        platform: index === 0 ? input.platform : new MockPlatform([input.row.challenge]),
        resolved: route,
        resolvedPlan: [route],
        roomWorkDir: swarmDir,
        args: { ...input.args, replayPath: swarmDir },
        signal: controllers[index]!.signal,
        threeGraphSwarmId: swarmId,
      });
      if (result.outcome === "solved" || result.platformProgress?.completed === true) {
        winner ??= result;
        controllers.forEach((controller, siblingIndex) => {
          if (siblingIndex !== index) controller.abort();
        });
      }
      return result;
    }),
  ).finally(() => {
    input.signal?.removeEventListener("abort", onParentAbort);
  });

  if (winner) return winner;
  const results = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (results.length === 0) {
    throw new AggregateError(
      settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []),
      "all isolated three-graph swarms failed",
    );
  }
  return results.reduce((best, current) =>
    (current.platformProgress?.acceptedCount ?? 0) > (best.platformProgress?.acceptedCount ?? 0)
      ? current
      : best,
  );
}

async function runLiveHostFs(input: {
  repoRoot: string;
  spinePatch: string;
  platform: MockPlatform;
  row: CaseSpec;
  resolved: ResolvedModelCall;
  resolvedPlan?: ResolvedModelCall[];
  challengeId: string;
  config: ReturnType<typeof loadSilverConfig>;
  roomAssembly: RoomAssembly;
  args: ReturnType<typeof parseCliArgs>;
  mission?: MissionBrief;
  silent?: boolean;
  soft?: boolean;
  contestSubmit?: ContestSubmitHook;
  contestHint?: ContestHintHook;
  contestVerify?: ContestVerifyHook;
  contestRestart?: ContestRestartHook;
  /** Latest structured platform-list progress observed before the Room starts. */
  initialPlatformProgress?: {
    correctFlagCount?: number;
    totalFlagCount?: number;
    completed?: boolean;
  };
  stagnationCheckpoint?: boolean;
  rootSession?: number;
  previousRoot?: ChallengePreviousRoot;
  /** Mission Commander Project: Groups share the room clock; Host does not heartbeat the Commander model. */
  goalBound?: boolean;
  /**
   * Restore a candidate review hold. Groups wait for Commander pending/completed
   * before any new ACP prompt. Does not recall in-flight platform requests.
   */
  resumeReviewHold?: boolean;
  /** Candidate evidence from a Mission room; Commander performs the platform reconciliation. */
  onCandidateReported?: (event: {
    targetId: string;
    fingerprint: string;
    status: "reported" | "duplicate";
    /** When false, Host already has this target pending and no new generation opened. */
    wakeCommander?: boolean;
    reviewGenerationId?: number;
  }) => void;
  /** Legacy race/solo reconciliation only; formal Team/swarm idle stays inside the Room. */
  onCompatibilityGroupStalled?: (event: { groupId: string }) => void;
  onAllGroupsStalled?: (event: { challengeId: string }) => void;
  onRoomControlRequested?: (event: {
    targetId: string;
    type: "defer_unavailable";
    text: string;
  }) => void;
  onGroupSession?: (event: { groupId: string; sessionId: string }) => void;
  onAttemptProgress?: (event: LiveHostFsAttemptProgressEvent) => void;
  /** Stable contest/slot dir shared across fresh roots for the room clock. */
  roomWorkDir?: string;
  /** Prior attempt finished. New clock and new DSH session; workspace intel and feed stay. */
  freshAttempt?: boolean;
  /**
   * Mission Commander ProjectRuntime for this Room — required for platform-accepted
   * durable stop (close → roster → convergence abort).
   */
  projects?: ProjectRuntime;
  /**
   * Read-only ProjectRuntime row for this Room (Mission Commander).
   * C1 Room Projection uses it instead of inventing completed from Ledger flags.
   */
  projectSnapshot?: () => { status: string; reason?: string } | undefined;
  /** Host-facing room controls (deadline updates) for tests / operators. */
  onRoomControls?: (controls: {
    getClock: () => RoomClockState;
    setDeadline: (deadlineAtMs: number) => RoomClockState;
    recordTaskReview: (review: {
      status: "completed" | "pending";
      reason: string;
      ackedGenerationId?: number;
      platformProgress?: {
        correctFlagCount?: number;
        totalFlagCount?: number;
        completed?: boolean;
      };
    }) => void | Promise<void | { storedStatus: "completed" | "exhausted" }>;
    resolveRoomRequest: (decision: "continue" | "defer") => void;
    halt: (reason?: LiveRunStopReason) => void;
    pulse: () => ProjectPulse;
    dispose: () => void;
  }) => void;
  signal?: AbortSignal;
}): Promise<ContestSolveResult> {
  const { repoRoot, platform, row, resolved, challengeId, config, mission, args } = input;
  const roomAssembly = requireRoomAssembly(input.roomAssembly);
  const targetUrl = mission?.target ?? "";
  const basePlan = input.resolvedPlan && input.resolvedPlan.length > 0 ? input.resolvedPlan : [resolved];
  const explicitTeam = Boolean(args.team);
  const initialSpecs: TeamMemberSpec[] = explicitTeam
    ? parseTeamMemberSpecs(args.team!)
    : compatTeamSpecsForPlan(basePlan.length);
  const opened = openLiveRoom({
    config,
    ...(args.profile !== undefined ? { profile: args.profile } : {}),
    ...(args.officialTeam ? { officialTeam: true } : {}),
    ...(args.team !== undefined ? { team: args.team } : {}),
    ...(input.goalBound ? { goalBound: true } : {}),
    ...(explicitTeam ? { explicitTeam: true } : {}),
    ...(process.env.SILVER_ROOM_ENTRY_COMPAT === "replay" ? { compat: "replay" as const } : {}),
    teamSpecs: initialSpecs,
    basePlan,
  });
  for (const line of opened.deprecations) process.stderr.write(`silver: ${line}\n`);
  const teamSpecs = opened.teamSpecs;
  const plan = opened.plan;
  const teamMode = opened.live.teamMode;
  const roomSwarmMode = opened.live.roomSwarmMode;
  const soloConvergence = opened.live.soloConvergence;
  const officialTeamMode = opened.live.officialTeamMode;
  const bootstrapModels =
    officialTeamMode &&
    roomAssembly.domain === "ctf" &&
    config.attemptPolicies["thin-bootstrap"]
      ? resolveAttemptPlan({
          config,
          profile: "thin-bootstrap",
          agent: "ctf-solver",
          challengeId,
        })
      : [];
  if (roomAssembly.formalTeam !== officialTeamMode) {
    throw new Error(
      `room assembly formalTeam=${String(roomAssembly.formalTeam)} disagrees with selected room mode ${opened.selection.mode}`,
    );
  }
  const raceMode = opened.live.raceMode;
  const swarmMaxMembers = opened.selection.swarm.rosterCap;
  const maxWorkers = opened.selection.swarm.maxWorkers;
  const roomProjects = input.projects ?? (officialTeamMode ? new ProjectRuntime() : undefined);
  const configuredHintPolicy = mission?.hintPolicy ?? config.competition.hintPolicy;
  const hintAvailable =
    configuredHintPolicy === "open" &&
    (Boolean(input.contestHint) || typeof platform.requestHint === "function");
  const hintPolicy = hintAvailable ? "open" : "off";
  // Direct --case/--target compatibility has no platform adapter and reports candidates locally.
  // Natural-language Mission rooms mount submission tools only with an explicit contest adapter.
  const candidateTools = liveEntry(args) !== "mission" || Boolean(input.contestSubmit);
  const brokers: LlmBrokerHandle[] = [];
  const sessions: ReturnType<typeof spawnOfficialDshAcpSession>[] = [];
  const attempts: LiveHostFsAttempt[] = [];
  let roomMembers: RoomMembersState | undefined;
  let roomMembersFile: string | undefined;
  let rpc: HostRpcHandle | undefined;
  let runtime: ChallengeRuntime | undefined;
  let ledger: Ledger | undefined;
  let roomDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let disposeRoomControls: (() => void) | undefined;
  let onAbortRoom: (() => void) | undefined;
  try {
    const budget = liveBudgetFromArgs(config, args);
    await platform.listen();
    const origin = platform.origin();
    const solve = liveSolveUrls(origin, challengeId, config, mission, Boolean(row.challenge.agent));
    if (officialTeamMode && roomProjects && !input.projects) {
      roomProjects.open({ challengeId, targetUrl: solve.targetUrl });
    }
    if (input.signal?.aborted) {
      return { targetId: challengeId, targetUrl: solve.targetUrl, outcome: "stalled", reason: "interrupted" };
    }
    // Task identity and prior-room snapshot happen before mkdir/Ledger so this run's
    // runtime.db cannot be mistaken for old same-task evidence (fresh contest bug).
    const taskIdentity = liveTaskIdentity({
      challengeId,
      ...(input.roomWorkDir ? { roomWorkDir: input.roomWorkDir } : {}),
      ...(args.replayPath ? { replayPath: args.replayPath } : {}),
    });
    const intendedRuntimeRoot =
      args.replayPath || input.roomWorkDir
        ? path.join(
            taskIdentity.storageBase,
            ".silver-runtime",
            createHash("sha256")
              .update(
                JSON.stringify({
                  taskKey: taskIdentity.key,
                  rootSession: input.rootSession ?? 0,
                  plan: plan.map(liveModelRouteFingerprint),
                }),
              )
              .digest("hex")
              .slice(0, 16),
          )
        : undefined;
    const priorRoomEvidence = snapshotPriorRoomEvidence({
      challengeId,
      storageBase: taskIdentity.storageBase,
      ...(input.roomWorkDir ? { roomWorkDir: input.roomWorkDir } : {}),
      ...(args.replayPath ? { replayPath: args.replayPath } : {}),
      ...(intendedRuntimeRoot ? { excludeRuntimeRoot: intendedRuntimeRoot } : {}),
    });
    const runRoot = liveHostFsRuntimeRoot({
      ...(args.replayPath ? { replayPath: args.replayPath } : {}),
      challengeId,
      targetUrl: solve.targetUrl,
      plan,
      ...(input.rootSession !== undefined ? { rootSession: input.rootSession } : {}),
      ...(input.roomWorkDir ? { roomWorkDir: input.roomWorkDir } : {}),
    });
    const root = runRoot.root;
    const spinePatch = writeCtfSpinePatch(root, repoRoot);
    const sandbox = new HostFsSandbox();
    const runtimeDb = path.join(root, "runtime.db");
    const recovering = runRoot.persistent && fs.existsSync(runtimeDb);
    ledger = new Ledger(runtimeDb);
    if (recovering) ledger.resumeMission("mission-live", config.competition.autonomy);
    else ledger.createMission("mission-live", config.competition.autonomy);
    const liveRuntime = new ChallengeRuntime(
      ledger,
      platform,
      randomCapabilitySecret(),
      sandbox,
      input.contestSubmit,
      input.contestHint,
      liveEntry(args) !== "mission",
      input.contestVerify,
      input.contestRestart,
    );
    runtime = liveRuntime;
    const workspace = path.join(root, "challenges", challengeId);
    writeMissionBriefFile(workspace, mission, { room: true });
    const availableSkills = liveAvailableSkillsForChallenge(config, args);
    const profileName = args.profile ?? "single-fast";
    // Race and explicit Teams start their declared members immediately.
    let bootstrapCount = raceMode || teamMode
      ? plan.length
      : liveBootstrapAttemptCount(profileName, plan.length);
    liveRuntime.startChallenge({
      missionId: "mission-live",
      challengeId,
      flagCount: row.challenge.flagCount,
      autonomy: config.competition.autonomy,
      targetUrl: solve.targetUrl,
      workspace,
      track: config.competition.track,
      acceptanceKind: roomAssembly.domain,
      acceptanceContract: roomAssembly.acceptanceContract,
      flagPattern: mission?.flagPattern ?? config.competition.flagPattern,
      hintPolicy,
      acceptanceMode: liveAcceptanceMode(Boolean(mission), Boolean(input.contestSubmit)),
      inScopeUrls: solve.inScope.split(",").filter(Boolean),
      ...(solve.agentUrl ? { inScopeAgentUrls: [solve.agentUrl] } : {}),
      ...(availableSkills ? { availableSkills } : {}),
      ...(mission?.challengeBundle ? { challengeBundle: mission.challengeBundle } : {}),
      ...(input.previousRoot ? { previousRoot: input.previousRoot } : {}),
      ...(officialTeamChatMounted(opened.selection) && !raceMode
        ? {
            swarmRoom: {
              initialMembers: officialTeamMode ? 1 : (config.legacySwarm?.initialMembers ?? 1),
              maxMembers: opened.selection.swarm.rosterCap,
              feedDelivery: opened.selection.swarm.chatDelivery,
              chatEnabled: opened.selection.swarm.chatEnabled,
            },
          }
        : {}),
    }, {
      policy: !raceMode && plan.length > 1 ? "cheap-swarm" : "single-fast",
      maxAttempts: plan.length,
      attemptSlices: plan.map(toAttemptSlice),
      toolsPreset: "solver",
    }, recovering ? { resumeExisting: true } : undefined);
    if (recovering && !input.freshAttempt) ledger.recoverInterruptedSubmissions(challengeId);

    // Room clock uses task identity (not rootSession/model). Contest passes roomWorkDir.
    const roomClockDir = liveRoomClockDir({
      challengeId,
      ...(input.roomWorkDir ? { roomWorkDir: input.roomWorkDir } : {}),
      ...(args.replayPath ? { replayPath: args.replayPath } : {}),
    });
    const roomClockFile = roomClockPath(roomClockDir, challengeId);
    const sameTaskEvidence = recovering || priorRoomEvidence.sameTask;
    const legacyMigration = migrateLegacyRoomClock({
      destFile: roomClockFile,
      candidates: collectLegacyRoomClockCandidates({
        challengeId,
        storageBase: taskIdentity.storageBase,
        runtimeRoot: root,
        priorRuntimeRoots: priorRoomEvidence.priorRuntimeRoots,
        ...(input.roomWorkDir ? { roomWorkDir: input.roomWorkDir } : {}),
      }),
      roomId: challengeId,
      challengeId,
      sameTaskEvidence,
    });
    if (legacyMigration.status === "corrupt-same-task") {
      const detail = `corrupt room clock for this task at ${legacyMigration.from}: ${legacyMigration.detail}; refusing to overwrite or gift a fresh budget`;
      if (input.soft) {
        return { targetId: challengeId, targetUrl: solve.targetUrl, error: detail };
      }
      throw new Error(detail);
    }
    const clockRecovery = resumeOrStartRoomClock({
      file: roomClockFile,
      roomId: challengeId,
      challengeId,
      domain: roomAssembly.domain,
      formalTeam: roomAssembly.formalTeam,
      budgetMs: budget.timeoutMs,
      // Same-task history (slot / prior runtime / matching replay ledger) must not gift a fresh
      // 90m budget when the clock is missing — require an explicit recovery decision instead.
      requireExistingEvidence:
        recovering || priorRoomEvidence.sameTask || legacyMigration.status === "migrated",
    });
    if (clockRecovery.needsRecoveryDecision && !clockRecovery.resumed) {
      const detail =
        clockRecovery.state.migrationNote ??
        "room clock recovery decision required; refusing to gift a fresh budget";
      if (input.soft) {
        return { targetId: challengeId, targetUrl: solve.targetUrl, error: detail };
      }
      throw new Error(detail);
    }
    let roomClock = clockRecovery.state;
    const replaceFinishedAttempt = input.freshAttempt === true;
    if (replaceFinishedAttempt) {
      roomClock = beginFreshAttemptClock({
        previous: undefined,
        roomId: challengeId,
        challengeId,
        domain: roomAssembly.domain,
        formalTeam: roomAssembly.formalTeam,
        budgetMs: budget.timeoutMs,
      }).state;
    }
    writeRoomClock(roomClockFile, roomClock);
    roomMembersFile = roomMembersPath(roomClockDir, challengeId);
    const platformSolved = liveRuntime.platformCompleted(challengeId);
    if (!officialTeamMode && platformSolved) {
      return contestPlatformResult(liveRuntime, challengeId, solve.targetUrl, "solved");
    }
    if (officialTeamMode && roomProjects) {
      // An existing platform-stop journal is a completed stop, including candidate-report
      // where Host never stored platformCompleted. Replay it; do not start the room again.
      const journalPresent = isRoomPlatformStopPresent(roomClockDir, challengeId);
      const recovery = roomTerminalRecovery({
        platformSolved,
      });
      if (journalPresent || recovery === "platform_accepted") {
        await applyRoomPlatformAcceptedStop({
          roomClockDir,
          roomId: challengeId,
          challengeId,
          projects: roomProjects,
          membersFile: roomMembersFile,
          stopReason: "host_terminal_stop",
        });
        return contestPlatformResult(liveRuntime, challengeId, solve.targetUrl, "solved");
      }
    }
    if (officialTeamMode && replaceFinishedAttempt) {
      retireExpiredOfficialTeamChannel({ roomClockDir, challengeId });
    }
    // C6: on crash recovery, durable roster may already include recruited Workers while
    // CLI argv is still `--team lead`. Expand specs before align so Workers are not dropped.
    if (roomSwarmMode) {
      const durable = readRoomMembers(roomMembersFile);
      if (durable) {
        for (const row of durable.members) {
          if (teamSpecs.some((spec) => spec.memberId === row.memberId)) continue;
          // Official Team rows are nativeSession members, not Host independent roots.
          // A missing binding never reaches here: readRoomMembers fails closed.
          if (!row.attemptId) continue;
          teamSpecs.push({
            memberId: row.memberId,
            attemptId: row.attemptId,
            role: row.role,
            ...(row.duty ? { duty: row.duty } : {}),
          });
        }
        while (plan.length < teamSpecs.length) plan.push(plan[0]!);
        bootstrapCount = teamSpecs.length;
      }
    }
    if (raceMode) {
      const rosterFile = raceRosterPath(roomClockDir, challengeId);
      const persistedRoster = readRaceRoster(rosterFile);
      if (persistedRoster) {
        try {
          assertSameRaceRoster(persistedRoster, teamSpecs, challengeId);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          if (input.soft) return { targetId: challengeId, targetUrl: solve.targetUrl, error: detail };
          throw new Error(detail);
        }
      } else if (recovering || clockRecovery.resumed) {
        const detail = `race roster missing for ${challengeId}; refusing to add racers; fail closed`;
        if (input.soft) return { targetId: challengeId, targetUrl: solve.targetUrl, error: detail };
        throw new Error(detail);
      } else {
        writeRaceRoster(rosterFile, { challengeId, racers: teamSpecs });
      }
      bootstrapCount = teamSpecs.length;
    }
    const durableRoster = readRoomMembers(roomMembersFile);
    const nativeProjection =
      officialTeamMode && durableRoster?.members.some((row) => row.nativeSession) === true;
    roomMembers = nativeProjection
      ? emptyRoomMembers({
          roomId: challengeId,
          challengeId,
          specs: teamSpecs,
        })
      : resumeOrCreateRoomMembers({
          file: roomMembersFile,
          roomId: challengeId,
          challengeId,
          specs: teamSpecs,
        }).state;
    const publishRoomMembers = (): void => {
      // Official Team projection owns the roster after admission. A stale Lead
      // upsert would erase nativeSession rows and make remove look missing.
      if (officialTeamMode || !roomMembersFile || !roomMembers) return;
      writeRoomMembers(roomMembersFile, roomMembers);
    };
    publishRoomMembers();
    // Goal-bound rooms use this hub for Host control and Intel wakes.
    const memberWakeHub = teamMode || soloConvergence ? new FormalMemberWakeHub() : undefined;
    const maybeQuiesceTeamRoom = (): void => {
      if (!teamMode || !memberWakeHub || roomClosed || !roomMembers) return;
      if (roomSwarmMode) return;
      if (memberWakeHub.hasQueued() || memberWakeHub.isBusyAny()) return;
      // Idle waiters with no Host work left can be released; do not release while a
      // member is mid-turn (busy) or holding an undelivered wake (queued).
      const someoneBusy = roomMembers.members.some(
        (row) => row.status === "active" || row.status === "pending",
      );
      if (someoneBusy) return;
      memberWakeHub.stopAll();
    };
    let roomClosed = false;
    let deferStopSent = false;
    let roomControlRequest: SlotResult["controlRequest"];
    let roomStopReason: LiveRunStopReason | undefined;
    let roomControlsDisposed = false;
    let roomUnresolvedStall = false;
    const stalledGroups = new Set<string>();
    const roomHalt = createWaitBroadcast<"halt">();
    let roomHalted = false;
    const waitRoomHalt = async (): Promise<void> => {
      if (roomClosed || roomHalted || roomExpired(roomClock) || input.signal?.aborted) return;
      await Promise.race([roomHalt.wait(), whenAborted(input.signal)]);
    };
    const signalRoomHalt = (): void => {
      roomHalted = true;
      roomHalt.signal("halt");
    };
    const haltRoom = (reason: LiveRunStopReason = "interrupted"): void => {
      roomStopReason ??= reason;
      roomClosed = true;
      signalRoomHalt();
      memberWakeHub?.stopAll();
      if (officialTeamMode) liveRuntime.setOfficialTeamRpcGate(challengeId, undefined);
      if (reason === "interrupted" || input.signal?.aborted) {
        for (const session of sessions) session.stop("interrupted");
      }
    };
    onAbortRoom = () => {
      try {
        haltRoom("interrupted");
      } catch {
        /* best-effort */
      }
    };
    if (input.signal?.aborted) onAbortRoom();
    input.signal?.addEventListener("abort", onAbortRoom, { once: true });
    type GoalReview = { status: "completed" | "pending"; reason: string; ackedGenerationId?: number };
    const goalReviews = createWaitBroadcast<GoalReview>();
    let goalReviewEpoch = 0;
    let latestGoalReview: GoalReview | undefined;
    let candidateReviewHoldRef: ReturnType<typeof createCandidateReviewHold> | undefined;
    const resumeHoldSnapshot = input.resumeReviewHold
      ? readCandidateReviewHoldSnapshot(roomClockDir, challengeId)
      : undefined;
    const candidateReviewHold = createCandidateReviewHold({
      leaseMs: candidateReviewLeaseMsFromEnv(),
      ...(resumeHoldSnapshot ? { resume: resumeHoldSnapshot } : {}),
      onSnapshot: (snapshot) => writeCandidateReviewHoldSnapshot(roomClockDir, challengeId, snapshot),
      onLeaseExpired: (review) => {
        if (roomClosed || roomControlsDisposed || candidateReviewHoldRef?.isTerminalStopping()) return;
        latestGoalReview = review;
        goalReviewEpoch += 1;
        goalReviews.signal(review);
        // Clear holding + resume sessions; keep Project reviewing until Commander
        // record_target_result so SlotPool does not free the slot while review is owed.
        if (roomMembers && roomMembersFile) {
          for (const attempt of attempts) {
            if (!attempt.memberId) continue;
            roomMembers = upsertRoomMember(roomMembers, {
              memberId: attempt.memberId,
              status: "active",
              ...(attempt.dshSessionId ? { dshSessionId: attempt.dshSessionId } : {}),
            });
          }
          publishRoomMembers();
        }
        process.stderr.write(
          `silver: candidate review lease expired for ${challengeId}; workers resumed, Commander still owes platform review\n`,
        );
      },
    });
    candidateReviewHoldRef = candidateReviewHold;
    // Pending target with missing/corrupt snapshot: owed, not holding.
    if (input.resumeReviewHold && !resumeHoldSnapshot) {
      candidateReviewHold.markCommanderReviewOwed();
    }
    const candidateAwaitingReview = (): boolean => candidateReviewHold.isHolding();
    const signalGoalReview = (review: GoalReview) => {
      const resolved = candidateReviewHold.resolveFromCommander(review);
      latestGoalReview = review;
      goalReviewEpoch += 1;
      // completed / caught-up pending: wake waiters. Dirty pending keeps the newer hold
      // and must not resume workers as if the review chain were clear.
      if (review.status === "completed" || !resolved.dirty) {
        goalReviews.signal(review);
      }
      return resolved;
    };
    const maybeReleaseStalledProject = (): void => {
      if (candidateAwaitingReview() || roomClosed || input.signal?.aborted) return;
      if (attempts.length < bootstrapCount) return;
      const live = attempts.filter((row) => !row.groupEnded);
      if (live.length === 0) return;
      if (!live.every((row) => stalledGroups.has(row.attemptId))) return;
      roomUnresolvedStall = true;
      input.onAllGroupsStalled?.({ challengeId });
      signalRoomHalt();
    };

    // Projection for every Room (solo / parallel / groups / team). Formal Member
    // binding stays team-only so Intel principal remains group:* for independent roots.
    const projectionMembersSnapshot = () =>
      (roomMembers?.members ?? []).map((row) => ({
        memberId: row.memberId,
        role: row.role,
        duty: row.duty,
        status: row.status,
        ...(row.attemptId ? { attemptId: row.attemptId } : {}),
        ...(row.dshSessionId ? { dshSessionId: row.dshSessionId } : {}),
        ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      }));
    const projectionPlatformSnapshot = () => {
      const project = input.projectSnapshot?.();
      if (project?.status) {
        return {
          status: project.status,
          ...(project.reason
            ? { reason: project.reason }
            : latestGoalReview?.reason
              ? { reason: latestGoalReview.reason }
              : {}),
        };
      }
      if (roomClosed) {
        return {
          status: "closed",
          reason: latestGoalReview?.reason ?? roomStopReason ?? "room closed",
        };
      }
      const holdView = candidateReviewHold.platformView();
      if (holdView.status !== "active") {
        return {
          status: holdView.status,
          ...(holdView.reason ? { reason: holdView.reason } : {}),
        };
      }
      if (roomUnresolvedStall) return { status: "stalled", reason: "all groups stalled" };
      return { status: "active" };
    };
    let officialTeamRecruitBound: (() => void) | undefined;
    let leadOfficialFollowUp: ((prompt: string) => Promise<void>) | undefined;
    let leadCanTakeControl: (() => boolean) | undefined;
    const leadControl = createLeadControlDispatch({
      shouldStop: () =>
        roomClosed || Boolean(input.signal?.aborted) || isRoomPlatformStopPresent(roomClockDir, challengeId),
      canDispatch: () => Boolean(leadOfficialFollowUp) && (!leadCanTakeControl || leadCanTakeControl()),
      dispatch: async () => {
        if (!leadOfficialFollowUp) throw new Error("Lead control transport is unavailable");
        const leadId = attempts.find((row) => row.role === "lead")?.memberId ?? "lead";
        await leadOfficialFollowUp(liveLeadControlResumePrompt(leadId));
      },
      onError: (err) => {
        process.stderr.write(
          `silver: official Team Lead control wake failed for ${challengeId}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      },
    });
    const flushLeadControl = (): void => leadControl.flush();
    const wakeLeadForControl = (): void => leadControl.request();
    if (officialTeamMode) {
      liveRuntime.setOfficialTeamRpcGate(challengeId, {
        roomId: challengeId,
        roomClockDir,
        maxMembers: swarmMaxMembers,
        onRecruitBound: () => officialTeamRecruitBound?.(),
      });
    }
    liveRuntime.setRoomProjectionBinding(challengeId, {
      roomClockDir,
      roomId: challengeId,
      memberIdForAttempt: (attemptId) =>
        roomMembers?.members.find((row) => row.attemptId === attemptId)?.memberId,
      membersSnapshot: projectionMembersSnapshot,
      platformSnapshot: projectionPlatformSnapshot,
    });
    liveRuntime.setRoomConvergenceBinding(challengeId, {
      roomClockDir,
      roomId: challengeId,
    });
    const noteConvergence = async (trigger: {
      eventId: string;
      kind:
        | "member_turn_ended"
        | "member_help_requested"
        | "intel_changed"
        | "candidate_changed"
        | "platform_verdict_changed"
        | "deadline_boundary"
        | "stall_boundary"
        | "bootstrap_ready"
        | "review_changed"
        | "evidence_source_exhausted";
      subjectRef?: string;
      version?: string;
    }): Promise<void> => {
      const noted = await noteRoomConvergenceTrigger({
        roomClockDir,
        roomId: challengeId,
        challengeId,
        trigger,
      });
      if (!noted.ok) {
        throw new Error(`convergence trigger refused: ${noted.reason}`);
      }
    };
    /** C5b: claim → DSH Reviewer → apply → signal solo Member wake (single-flight). */
    const kickSoloConvergenceAndWake = async (): Promise<boolean> => {
      if (!soloConvergence || !memberWakeHub || roomClosed || input.signal?.aborted) return false;
      const projection = liveRuntime.roomProjectionForConvergence(challengeId);
      if (!projection) return false;
      const lead =
        attempts.find((row) => row.memberId === SOLO_MEMBER_ID || row.role === "lead") ?? attempts[0];
      if (!lead?.resolved) return false;
      const reviewerCwd = path.join(workspace, "attempts", "convergence-reviewer");
      fs.mkdirSync(reviewerCwd, { recursive: true });
      const home = path.join(reviewerCwd, ".home");
      const tmpDir = path.join(reviewerCwd, ".tmp");
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      const binDir = writeHostFsToolShims(reviewerCwd);
      linkHostFsCtfSpinePackage(reviewerCwd, repoRoot);
      const { dshHome, modelPatch, storagePatch, personaPatch } = writeLiveDshHome(
        reviewerCwd,
        lead.resolved,
        undefined,
        liveDshHomeOptions({
          llmRequest: reviewerLlmRequestPolicy(),
        }),
      );
      const reviewerPersona = path.join(reviewerCwd, ".silver-convergence-reviewer.persona.patch.yml");
      fs.writeFileSync(reviewerPersona, convergenceReviewerPersonaPatchYaml());
      const patches = [spinePatch, modelPatch, storagePatch, personaPatch, reviewerPersona];
      const cellEnv = liveCellEnv(lead.resolved, {
        challengeId,
        attemptId: `convergence-reviewer`,
        targetUrl: solve.targetUrl,
        inScope: solve.inScope,
        flagPattern: mission?.flagPattern ?? config.competition.flagPattern,
        track: config.competition.track,
        hintPolicy,
        dshHome,
        host: { mode: "mock", platformOrigin: "convergence-reviewer" },
      });
      cellEnv.SILVER_CWD = reviewerCwd;
      cellEnv.SILVER_CONVERGENCE_REVIEWER = "1";
      const env = hostSpawnEnv(cellEnv, {
        home, tmpDir, binDir,
        ...(config.runtime.executionProfile === "host" ? { toolsRoot: path.join(repoRoot, ".silver-tools", "host") } : {}),
      });
      const reviewer = createOfficialDshConvergenceReviewer({
        repoRoot,
        cwd: reviewerCwd,
        patches,
        env,
        timeoutMs: Math.max(1_000, roomRemainingMs(roomClock)),
        modelSelection: {
          provider: lead.resolved.provider,
          model: lead.resolved.model,
          reasoningEffort: lead.resolved.effort,
        },
        onSession: (session) => {
          sessions.push(session as (typeof sessions)[number]);
        },
      });
      const episode = await runSoloConvergenceEpisodeSingleFlight({
        roomClockDir,
        roomId: challengeId,
        challengeId,
        projection,
        reviewer,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!episode.ok || episode.outcome === "idle") return false;
      return false;
    };
    /** C6: Lead decision → recruit/remove exec → spawn/stop DSH. */
    let swarmSynthRound = 0;
    /** Set by Lead startAttempt: resume the same Lead ACP session for a serial decision turn. */
    let leadDecisionTurn: ResumeLeadDecisionTurn | undefined;
    /** Set by Lead startAttempt: after an empty-actions decision, continue the solve prompt. */
    let leadContinueSolve: ((signal?: AbortSignal) => Promise<void>) | undefined;
    let leadDecisionTurnBusy = false;
    let officialTeamSolveStarted = officialTeamMode;
    let officialTeamSolvePending = false;
    let officialTeamBootstrapFailed = false;
    let maybeAdvanceOfficialTeamRoom = async (): Promise<void> => undefined;
    let flushOfficialTeamSolve = async (): Promise<boolean> => false;
    const kickSwarmConvergenceAndApply = async (): Promise<boolean> => {
      if (officialTeamMode) return false;
      if (!roomSwarmMode || !memberWakeHub || roomClosed || input.signal?.aborted) return false;
      const projection = liveRuntime.roomProjectionForConvergence(challengeId);
      if (!projection) return false;
      const decisionPath = process.env.SILVER_TEST_SWARM_SYNTHESIZER_JSON?.trim();
      const synthesizer: ConvergenceReviewer = decisionPath
        ? {
            synthesize: async (synthInput) => {
              const raw = JSON.parse(fs.readFileSync(decisionPath, "utf8")) as unknown;
              const rows = Array.isArray(raw) ? raw : [raw];
              const rowIndex = Math.min(swarmSynthRound, rows.length - 1);
              const row = rows[rowIndex] as Record<string, unknown>;
              swarmSynthRound += 1;
              const envelope = parseDecisionEnvelope({
                ...row,
                decisionId:
                  typeof row.decisionId === "string"
                    ? `${row.decisionId}:g${synthInput.generationId}:i${rowIndex}`
                    : `swarm-dec:g${synthInput.generationId}:i${rowIndex}`,
                expectedGeneration: synthInput.generationId,
                roomId: synthInput.roomId,
                challengeId: synthInput.challengeId,
                actorMemberId: "lead",
              });
              return { ok: true, envelope };
            },
          }
        : leadDecisionTurn
          ? createLeadSessionSwarmSynthesizer({
              roomClockDir,
              resumeLeadDecisionTurn: leadDecisionTurn,
              ...(officialTeamMode
                ? {
                    officialTeam: true,
                    leadCapability: () => {
                      for (const id of liveRuntime.liveAttemptIds(challengeId)) {
                        const capability = liveRuntime.attemptCapability(id);
                        if (capability) return capability;
                      }
                      return undefined;
                    },
                  }
                : {}),
            })
          : {
              synthesize: async () => ({ ok: false, reason: "lead_session_not_ready" }),
            };
      const episode = await runSwarmConvergenceEpisodeSingleFlight({
        roomClockDir,
        roomId: challengeId,
        challengeId,
        projection,
        synthesizer,
        maxMembers: swarmMaxMembers,
        ...(officialTeamMode ? { officialTeam: true } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!episode.ok) return false;
      if (officialTeamMode) {
        if (episode.officialFollowUp && leadOfficialFollowUp) {
          try {
            await leadOfficialFollowUp(episode.officialFollowUp);
          } catch (err) {
            if (
              err instanceof Error &&
              (err.message === "lead_session_still_active" || err.message === "lead session is not ready")
            ) {
              return false;
            }
            throw err;
          }
        }
        const applied = episode.apply;
        const appliedNoop =
          episode.outcome === "applied" &&
          applied?.ok === true &&
          applied.actions.length === 0 &&
          !episode.officialFollowUp;
        if (appliedNoop && leadContinueSolve) {
          try {
            await leadContinueSolve(input.signal);
          } catch (err) {
            if (
              err instanceof Error &&
              (err.message === "lead_session_still_active" || err.message === "lead session is not ready")
            ) {
              return false;
            }
            throw err;
          }
        }
        if (episode.officialFollowUp?.includes("Call spawn_teammate with name exactly") && memberWakeHub) {
          memberWakeHub.signal("lead", { kind: "host_control" });
        }
        return Boolean(episode.officialFollowUp);
      }
      if (roomMembersFile) {
        roomMembers = readRoomMembers(roomMembersFile) ?? roomMembers;
      }
      for (const spawn of episode.spawnMembers) {
        if (attempts.some((row) => row.memberId === spawn.memberId)) continue;
        const spec: TeamMemberSpec = {
          memberId: spawn.memberId,
          attemptId: spawn.attemptId,
          role: spawn.role,
          ...(spawn.duty ? { duty: spawn.duty } : {}),
        };
        if (!teamSpecs.some((row) => row.memberId === spawn.memberId)) teamSpecs.push(spec);
        while (plan.length < teamSpecs.length) plan.push(plan[0]!);
        const index = teamSpecs.findIndex((row) => row.memberId === spawn.memberId);
        if (index < 0) continue;
        await startAttempt(index);
        if (roomMembersFile) {
          roomMembers = readRoomMembers(roomMembersFile) ?? roomMembers;
        }
      }
      for (const stop of episode.stopMembers) {
        const attempt = attempts.find((row) => row.memberId === stop.memberId);
        attempt?.session?.stop("interrupted");
        memberWakeHub.release(stop.memberId);
        if (roomMembersFile) {
          roomMembers = readRoomMembers(roomMembersFile) ?? roomMembers;
        }
      }
      return episode.spawnMembers.length > 0;
    };
    liveRuntime.setRoomMemberBinding(
      challengeId,
      !officialTeamMode && (teamMode || soloConvergence)
        ? {
            roomClockDir,
            roomId: challengeId,
            memberIdForAttempt: (attemptId) =>
              roomMembers?.members.find((row) => row.attemptId === attemptId)?.memberId,
            roleForAttempt: (attemptId) =>
              roomMembers?.members.find((row) => row.attemptId === attemptId)?.role,
            dutyForAttempt: (attemptId) =>
              roomMembers?.members.find((row) => row.attemptId === attemptId)?.duty,
            membersSnapshot: projectionMembersSnapshot,
            ...(!officialTeamMode
              ? {
                  onIntelChange: (event: { memberIds: string[] }) => {
                    if (!memberWakeHub) return;
                    for (const memberId of event.memberIds) {
                      const notices = liveRuntime.pendingIntelNotices(challengeId, memberId);
                      if (notices.length === 0) continue;
                      memberWakeHub.signal(memberId, { kind: "intel" });
                    }
                  },
                }
              : {}),
          }
        : undefined,
    );
    const waitGoalReview = (attempt: LiveHostFsAttempt): Promise<GoalReview> => {
      const applied = attempt.appliedReviewEpoch ?? 0;
      if (latestGoalReview && goalReviewEpoch > applied) {
        attempt.appliedReviewEpoch = goalReviewEpoch;
        return Promise.resolve(latestGoalReview);
      }
      return Promise.race([
        goalReviews.wait().then((review) => {
          attempt.appliedReviewEpoch = goalReviewEpoch;
          return review;
        }),
        whenAborted(input.signal).then((): GoalReview => ({ status: "pending", reason: "room halted" })),
      ]);
    };
    let deadlineControlWatch: ReturnType<typeof setInterval> | undefined;
    const clearAttemptWatches = (): void => {
      for (const attempt of attempts) {
        if (attempt.stagnationWatch) {
          clearInterval(attempt.stagnationWatch);
          delete attempt.stagnationWatch;
        }
      }
    };
    const clearRoomDeadlineTimer = (): void => {
      if (roomDeadlineTimer) {
        clearTimeout(roomDeadlineTimer);
        roomDeadlineTimer = undefined;
      }
    };
    const clearDeadlineControlWatch = (): void => {
      if (deadlineControlWatch) {
        clearInterval(deadlineControlWatch);
        deadlineControlWatch = undefined;
      }
    };
    const stopLiveSessionsOnly = async (reason: LiveRunStopReason): Promise<void> => {
      clearRoomDeadlineTimer();
      clearAttemptWatches();
      clearDeadlineControlWatch();
      roomStopReason ??= reason;
      roomClosed = true;
      if (roomMembersFile && reason === "timeout") projectInterruptedRoomMembers(roomMembersFile, "timeout");
      signalRoomHalt();
      memberWakeHub?.stopAll();
      cancelRoomConvergenceFlight(challengeId, challengeId, reason);
      for (const session of sessions) session.stop(reason);
      for (const liveBroker of brokers) {
        try {
          liveBroker.abortActive?.(reason);
        } catch {
          /* best-effort cancel of in-flight upstream */
        }
      }
      // Receipt must wait for ACP children to settle — stop() alone is not confirmation.
      await Promise.all(sessions.map((session) => session.settled.catch(() => undefined)));
      for (const live of attempts) {
        if (!live.sessionStatePath || !live.dshSessionId || !live.dshHome) continue;
        writeLiveSessionState(live.sessionStatePath, {
          challengeId,
          attemptId: live.attemptId,
          targetUrl: solve.targetUrl,
          provider: live.resolved.provider,
          model: live.resolved.model,
          routeFingerprint: liveModelRouteFingerprint(live.resolved),
          cwd: live.cwd,
          dshHome: live.dshHome,
          sessionId: live.dshSessionId,
          status: reason === "host_terminal_stop" ? "terminal" : "interrupted",
          resumeCount: live.transportResumeCount ?? 0,
          ...(live.hostWakeCount ? { hostWakeCount: live.hostWakeCount } : {}),
          startedAt: live.startedAt,
          stopReason: reason,
        });
      }
    };
    const runStop = async (
      review: GoalReview = { status: "completed", reason: "room closed" },
    ): Promise<void> => {
      // Cancel lease immediately; do not wake workers until durable stop finishes.
      candidateReviewHold.beginTerminalStop();
      if (roomProjects) {
        await applyRoomPlatformAcceptedStop({
          roomClockDir,
          roomId: challengeId,
          challengeId,
          projects: roomProjects,
          ...(roomMembersFile ? { membersFile: roomMembersFile } : {}),
          stopReason: "host_terminal_stop",
          stopLiveSessions: () => stopLiveSessionsOnly("host_terminal_stop"),
        });
        if (roomMembersFile) {
          roomMembers = readRoomMembers(roomMembersFile) ?? roomMembers;
        }
      } else {
        await stopLiveSessionsOnly("host_terminal_stop");
      }
      // Single terminal notification after durable stop (+ live sessions) succeed.
      // completed does not mint review_changed — platform-stop aborts pending generations.
      signalGoalReview(review);
    };
    let roomStopPromise: Promise<void> | undefined;
    const stopAll = (reason: LiveRunStopReason): void => {
      if (officialTeamMode) liveRuntime.setOfficialTeamRpcGate(challengeId, undefined);
      if (officialTeamMode && reason === "host_terminal_stop") {
        roomStopPromise ??= runStop();
        void roomStopPromise;
        return;
      }
      roomStopPromise ??= stopLiveSessionsOnly(reason).then(() => {
        signalGoalReview({ status: "completed", reason: "room closed" });
      });
      void roomStopPromise;
    };
    maybeAdvanceOfficialTeamRoom = async (): Promise<void> => {
      if (!officialTeamMode || officialTeamSolveStarted || officialTeamBootstrapFailed || roomClosed) return;
      const phase = officialTeamRoomPhase(roomClockDir);
      if (phase === "bootstrap_degraded") {
        officialTeamBootstrapFailed = true;
        stopAll("bootstrap_degraded");
        return;
      }
      if (phase === "active") officialTeamSolvePending = true;
    };
    flushOfficialTeamSolve = async (): Promise<boolean> => {
      await maybeAdvanceOfficialTeamRoom();
      if (officialTeamBootstrapFailed || roomClosed) return false;
      if (!officialTeamSolvePending || officialTeamSolveStarted || !leadContinueSolve) return false;
      const lead = attempts.find((row) => row.role === "lead");
      if (lead?.session?.isPrompting?.()) return false;
      officialTeamSolveStarted = true;
      officialTeamSolvePending = false;
      try {
        await leadContinueSolve(input.signal);
        return true;
      } catch (err) {
        officialTeamSolveStarted = false;
        officialTeamSolvePending = true;
        if (
          err instanceof Error &&
          (err.message === "lead_session_still_active" || err.message === "lead session is not ready")
        ) {
          return false;
        }
        throw err;
      }
    };
    const syncSessionDeadlines = (): void => {
      const remain = roomRemainingMs(roomClock);
      for (const session of sessions) {
        if (session.isActive?.()) session.setTimeoutMs(remain);
      }
    };
    const armRoomDeadlineTimer = (): void => {
      if (roomControlsDisposed || roomClosed) return;
      clearRoomDeadlineTimer();
      const remain = roomRemainingMs(roomClock);
      if (!Number.isFinite(remain)) return;
      const deadlineEventId = `deadline_boundary:${challengeId}:${roomClock.deadlineAt}`;
      const fire = (): void => {
        beginRoomDeadlineStop({
          stopAll,
          ...(!officialTeamMode
            ? {
                noteConvergence: () => {
                  // TEST-ONLY. Production never sets this. A hung or rejected note must not delay stop.
                  const noteMode = process.env.SILVER_TEST_DEADLINE_NOTE?.trim();
                  if (noteMode === "hang") return new Promise(() => undefined);
                  if (noteMode === "reject") return Promise.reject(new Error("deadline convergence note rejected"));
                  return noteConvergence({
                    eventId: deadlineEventId,
                    kind: "deadline_boundary" as const,
                    subjectRef: challengeId,
                    version: roomClock.deadlineAt,
                  });
                },
                onNoteError: (err: unknown) => {
                  process.stderr.write(
                    `silver: deadline convergence note failed: ${err instanceof Error ? err.message : String(err)}\n`,
                  );
                },
              }
            : {}),
        });
      };
      if (remain <= 0) {
        fire();
        return;
      }
      roomDeadlineTimer = setTimeout(fire, remain);
    };
    /** Host-authoritative deadline update: rewrite clock, reschedule room + active ACP timers. */
    const setLiveRoomDeadline = (deadlineAtMs: number): RoomClockState => {
      if (roomClosed || roomControlsDisposed) {
        throw new Error("cannot change deadline on a closed room; resume must be an explicit Host operation");
      }
      roomClock = updateRoomDeadline(roomClock, { deadlineAtMs });
      writeRoomClock(roomClockFile, roomClock);
      armRoomDeadlineTimer();
      syncSessionDeadlines();
      if (roomExpired(roomClock)) stopAll("timeout");
      return roomClock;
    };
    const disposeRoom = (): void => {
      roomControlsDisposed = true;
      leadControl.dispose();
      candidateReviewHold.dispose();
      clearRoomDeadlineTimer();
      clearAttemptWatches();
      clearDeadlineControlWatch();
    };
    disposeRoomControls = disposeRoom;
    liveRuntime.setRoomDeadlineHandler(challengeId, (deadlineAtMs) => {
      const state = setLiveRoomDeadline(deadlineAtMs);
      return {
        startedAt: state.startedAt,
        deadlineAt: state.deadlineAt,
        budgetMs: state.budgetMs,
        remainingMs: roomRemainingMs(state),
      };
    });
    const liveProjectPulse = (): ProjectPulse => {
      const records = liveRuntime.candidateRecords(challengeId);
      const roster = roomMembersFile ? readRoomMembers(roomMembersFile) ?? roomMembers : roomMembers;
      const pulseStatusFor = (ended: boolean): GroupPulse["status"] => {
        if (roomClosed && roomStopReason === "host_terminal_stop") return "terminal";
        if (roomUnresolvedStall) return "stalled";
        if (roomClosed || ended) return "terminal";
        return "running";
      };
      const officialMembers =
        officialTeamMode && roster
          ? roster.members.map((row) => ({
              memberId: row.memberId,
              role: row.role,
              status: pulseStatusFor(row.status === "stopped" || row.status === "blocked"),
              executionRoot: row.role === "lead" && !row.nativeSession?.parentSessionId,
            }))
          : undefined;
      const rootAttempts = officialTeamMode
        ? attempts.filter((row) => row.role === "lead").slice(0, 1)
        : attempts;
      const groupsSource = rootAttempts.length > 0 ? rootAttempts : attempts;
      return projectPulse({
        challengeId,
        remainingMs: roomRemainingMs(roomClock),
        deadlineAt: roomClock.deadlineAt,
        candidateCount: records.length,
        pendingReview: officialTeamMode && Boolean(input.contestSubmit) ? false : candidateAwaitingReview(),
        groups: groupsSource.map((attempt) => {
          let status: GroupPulse["status"] = "running";
          if (roomClosed && roomStopReason === "host_terminal_stop") status = "terminal";
          else if (stalledGroups.has(attempt.attemptId) || roomUnresolvedStall) status = "stalled";
          else if (roomClosed || attempt.groupEnded) status = "terminal";
          const observed = observedLiveActivity(attempt.turnsPath, attempt.dshHome);
          return groupPulseFromObserved({
            groupId: attempt.attemptId,
            provider: attempt.resolved.provider,
            model: attempt.resolved.model,
            status,
            hostWakeCount: attempt.hostWakeCount ?? 0,
            activitySource: observed.source,
            turns: observed.turns,
            ...(officialMembers ? { members: officialMembers } : {}),
          });
        }),
        allGroupsStalled: attempts.length > 0 && attempts.every((row) => stalledGroups.has(row.attemptId) || row.groupEnded),
        awaitingResourceDecision: roomUnresolvedStall && !roomClosed,
      });
    };
    input.onRoomControls?.({
      getClock: () => roomClock,
      setDeadline: setLiveRoomDeadline,
      recordTaskReview: async (review) => {
        if (!input.goalBound) throw new Error("platform review control requires a goal-bound Mission room");
        if (review.status !== "completed") {
          // Release workers first — platform already said incomplete. C2 is best-effort projection.
          const resolved = signalGoalReview({
            status: review.status,
            reason: review.reason,
            ...(review.ackedGenerationId !== undefined
              ? { ackedGenerationId: review.ackedGenerationId }
              : {}),
          });
          if (!officialTeamMode) {
            const reasonDigest = createHash("sha256").update(review.reason).digest("hex").slice(0, 16);
            try {
              await noteConvergence({
                eventId: `review_changed:${challengeId}:${review.status}:${reasonDigest}`,
                kind: "review_changed",
                subjectRef: challengeId,
                version: review.status,
              });
            } catch (err) {
              process.stderr.write(
                `silver: review_changed convergence note failed after pending release: ${
                  err instanceof Error ? err.message : String(err)
                }\n`,
              );
            }
            // The candidate decision flight applies its own envelope. If that flight
            // already died and left processing, kick once so the durable submit is
            // applied or the generation is retried and the Worker can continue.
            if (!activeRoomConvergenceFlight(challengeId, challengeId)) {
              try {
                await kickSwarmConvergenceAndApply();
              } catch (err) {
                process.stderr.write(
                  `silver: pending review convergence kick failed: ${
                    err instanceof Error ? err.message : String(err)
                  }\n`,
                );
              }
            }
          }
          if (resolved.wakeCommander) {
            input.onCandidateReported?.({
              targetId: challengeId,
              fingerprint: candidateReviewHold.activeFingerprint() ?? "",
              status: "duplicate",
              wakeCommander: true,
              reviewGenerationId: resolved.generationId,
            });
          }
          return;
        }
        if (review.platformProgress) {
          liveRuntime.recordPlatformCompletion(challengeId, review.platformProgress);
        }
        // Commander reconciliation is authoritative even when a direct-submit
        // adapter is mounted: not every platform completion passes through it.
        await runStop(review);
        return officialTeamMode ? { storedStatus: "completed" } : undefined;
      },
      resolveRoomRequest: (decision) => {
        const text = readRoomDeferUnavailable(roomClockDir, challengeId) ?? "";
        clearRoomDeferUnavailable(roomClockDir);
        deferStopSent = false;
        if (decision === "continue") {
          roomControlRequest = undefined;
          if (officialTeamMode) wakeLeadForControl();
          return;
        }
        roomControlRequest = { type: "defer_unavailable", text };
        deferStopSent = true;
        stopAll("defer_unavailable");
      },
      halt: haltRoom,
      pulse: liveProjectPulse,
      dispose: disposeRoom,
    });
    // File-based Host/operator control: `silver room set-deadline` writes deadline-request.json here.
    deadlineControlWatch = setInterval(() => {
      if (roomControlsDisposed || roomClosed) return;
      const consumed = consumeRoomDeadlineRequest(roomClockDir);
      if (consumed?.kind === "expired") {
        writeRoomDeadlineResult(roomClockDir, {
          requestId: consumed.request.requestId,
          ok: false,
          error: `deadline request ${consumed.request.requestId} expired at ${consumed.request.expiresAt} before Host applied it`,
          appliedAt: new Date().toISOString(),
        });
      } else if (consumed?.kind === "request") {
        try {
          const deadlineAtMs = resolveRoomDeadlineRequest(consumed.request, roomClock);
          const state = setLiveRoomDeadline(deadlineAtMs);
          writeRoomDeadlineResult(roomClockDir, {
            requestId: consumed.request.requestId,
            ok: true,
            deadlineAt: state.deadlineAt,
            remainingMs: roomRemainingMs(state),
            appliedAt: new Date().toISOString(),
          });
        } catch (err) {
          writeRoomDeadlineResult(roomClockDir, {
            requestId: consumed.request.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            appliedAt: new Date().toISOString(),
          });
        }
      }
      const deferRequest = !deferStopSent
        ? readRoomDeferUnavailable(roomClockDir, challengeId)
        : undefined;
      if (deferRequest !== undefined) {
        deferStopSent = true;
        input.onRoomControlRequested?.({
          targetId: challengeId,
          type: "defer_unavailable",
          text: deferRequest,
        });
      }
      const completionEvidence = consumeRoomTaskComplete(roomClockDir, challengeId);
      if (completionEvidence !== undefined) {
        const fingerprint = createHash("sha256")
          .update(`room-task-complete\0${challengeId}\0${completionEvidence}`)
          .digest("hex");
        const noted = candidateReviewHold.noteCandidate({ fingerprint });
        if (noted.wakeCommander) {
          input.onCandidateReported?.({
            targetId: challengeId,
            fingerprint,
            status: "reported",
            wakeCommander: true,
            reviewGenerationId: noted.generationId,
          });
        }
        return;
      }
    }, 200);
    armRoomDeadlineTimer();
    if (roomExpired(roomClock) || roomClosed) {
      const detail = `room deadline already expired at ${roomClock.deadlineAt}; refusing to start DSH`;
      if (input.soft) {
        return { targetId: challengeId, targetUrl: solve.targetUrl, error: detail };
      }
      throw new Error(detail);
    }
    const quiesceSessionsForCandidateReview = (): void => {
      // Cancels the current official DSH ACP turn and refuses later Silver
      // submit_candidate. Cannot recall a platform request already sent or still
      // in transport; a small number of late platform submits may still land.
      for (const session of sessions) {
        if (session.isActive()) session.stop("candidate_checkpoint");
      }
    };
    const forwardHostCandidateReported = async (event: {
      fingerprint: string;
      status: "reported" | "duplicate";
    }): Promise<void> => {
      const fingerprint = event.fingerprint.trim() || `reported:${challengeId}:${event.status}`;
      const noted = candidateReviewHold.noteCandidate({ fingerprint });
      process.stderr.write(
        `silver: candidate-callback ${challengeId} status=${event.status} outcome=${noted.outcome} wakeCommander=${noted.wakeCommander} generation=${noted.generationId} waitingOfficialTeam=${officialTeamMode}\n`,
      );
      if (noted.quiesceSessions && !raceMode && !officialTeamMode) {
        quiesceSessionsForCandidateReview();
      }
      // Commander platform verdict is independent of Official Team Lead signaling.
      if (noted.wakeCommander) {
        input.onCandidateReported?.({
          targetId: challengeId,
          fingerprint,
          status: event.status,
          wakeCommander: true,
          reviewGenerationId: Math.max(noted.generationId, 1),
        });
      }
      if (!officialTeamMode) {
        await noteConvergence({
          eventId: `candidate_changed:${fingerprint}`,
          kind: "candidate_changed",
          subjectRef: fingerprint,
          version: event.status,
        });
      }
    };
    const officialHostVerdict = officialTeamMode && Boolean(input.contestSubmit);
    if (
      liveAcceptanceMode(Boolean(mission), Boolean(input.contestSubmit)) === "candidate-report" ||
      officialTeamMode
    ) {
      liveRuntime.setOnCandidateReported(challengeId, forwardHostCandidateReported);
    }
    rpc = await listenHostRpc({
      dispatch: dispatchUntilHostTerminal(
        liveRuntime,
        challengeId,
        Boolean(mission),
        () => stopAll("host_terminal_stop"),
        Boolean(input.contestSubmit),
        Boolean(input.goalBound),
        officialHostVerdict ? undefined : forwardHostCandidateReported,
        () => candidateAwaitingReview(),
        !raceMode && !officialHostVerdict,
      ),
    });
    const hostRpc = rpc;
    const baseTask = liveSolveTask(solve.targetUrl, roomAssembly, mission);
    const promptSkillGestures = promptSkillGesturesFromText(baseTask);
    if (roomSwarmMode && !officialTeamMode) process.env[ROOM_SWARM_ENV] = "1";
    if (officialTeamMode) {
      officialTeamRecruitBound = () => {
        void maybeAdvanceOfficialTeamRoom().then(() => {
          if (!officialTeamSolvePending || officialTeamSolveStarted || roomClosed) return;
          const lead = attempts.find((row) => row.role === "lead");
          if (lead?.memberId && memberWakeHub) {
            memberWakeHub.signal(lead.memberId, { kind: "host_control" });
          }
        });
      };
    }

    const startAttempt = async (index: number): Promise<void> => {
      const attemptResolved = plan[index]!;
      const memberSpec = teamSpecs[index] ?? { memberId: `a${index}`, attemptId: `a${index}`, role: "lead" as const };
      const attemptId = memberSpec.attemptId;
      const markMemberBlocked = (err: unknown): void => {
        if (!roomMembers || !roomMembersFile) return;
        roomMembers = upsertRoomMember(roomMembers, {
          memberId: memberSpec.memberId,
          status: "blocked",
          blockReason: err instanceof Error ? err.message : String(err),
        });
        publishRoomMembers();
      };
      let started;
      try {
        const roomDeadlineAtMs = roomClock.unbounded ? Number.NaN : Date.parse(roomClock.deadlineAt);
        started = liveRuntime.startAttempt(challengeId, {
          ...toAttemptSlice(attemptResolved),
          attemptId,
          containerId: HOSTFS_CONTAINER_ID,
          generation: index + 1,
          toolsPreset: "solver",
        }, {
          ...(recovering ? { resumeExisting: true } : {}),
          capabilityTtlMs: Number.isFinite(roomDeadlineAtMs)
            ? capabilityTtlForRoom({ roomDeadlineAtMs })
            : capabilityTtlForUnboundedRoom(),
        });
      } catch (err) {
        markMemberBlocked(err);
        throw err;
      }
      const cwd = path.join(workspace, "attempts", attemptId);
      const home = path.join(cwd, ".home");
      const tmpDir = path.join(cwd, ".tmp");
      const attemptDir = plan.length === 1 ? root : path.join(root, "attempt-runs", attemptId);
      const turnsPath = path.join(attemptDir, "llm-turns.jsonl");
      const wirePath = plan.length === 1 ? liveWireDebugPath(args.replayPath, root) : path.join(attemptDir, "llm-wire.jsonl");
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.mkdirSync(attemptDir, { recursive: true });
      const binDir = writeHostFsToolShims(cwd);
      linkHostFsCtfSpinePackage(cwd, repoRoot);
      seedCaseWorkspace(row, cwd);
      writeMissionBriefFile(cwd, mission, { room: true });
      const challengeMaterialsFile = writeChallengeMaterialsFile(
        cwd,
        mission,
        hintAvailable,
      );
      const seededMaterials = seedLiveMaterials(cwd, args);

      const attempt: LiveHostFsAttempt = {
        attemptId,
        memberId: memberSpec.memberId,
        role: memberSpec.role,
        resolved: attemptResolved,
        cwd,
        startedAt: new Date(),
        turnsPath,
        wirePath,
        ledgerPath: liveAttemptReplayPath(args.replayPath, cwd, attemptId, plan.length),
      };
      let attemptBroker: LlmBrokerHandle | undefined;
      try {
      if (process.env.SILVER_TEST_FAIL_MEMBER_INIT === memberSpec.memberId) {
        throw new Error(`test-injected init failure for ${memberSpec.memberId}`);
      }
      let route: { baseUrl: string; apiKeyEnv: string } | undefined;
      let llmCapability: string | undefined;
      const bootstrapModelPatches: string[] = [];
      const bootstrapModelEnv: Record<string, string> = {};
      const bootstrapModelRoutes: Array<{
        model: ResolvedModelCall;
        baseUrl: string;
        apiKeyEnv: string;
      }> = [];
      if (liveNeedsApiKey(attemptResolved)) {
        const apiKey = requireLiveApiKey(attemptResolved);
        llmCapability = randomLlmCapability();
        const broker = await listenLlmBroker({
          upstreamBaseUrl: attemptResolved.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL,
          upstreamApiKey: apiKey,
          capability: llmCapability,
          ledgerPath: turnsPath,
          wireDebugPath: wirePath,
          provider: attemptResolved.provider,
          model: attemptResolved.model,
          api: liveLlmWireApi(attemptResolved),
          ...(attemptResolved.maxTokens !== undefined ? { maxTokens: attemptResolved.maxTokens } : {}),
          effort: attemptResolved.effort,
          maxConsecutiveFailedTurns: LIVE_LLM_MAX_CONSECUTIVE_FAILED_TURNS,
          admitChatTurn: (turnIndex) => !liveTurnCapReached(budget, turnIndex - 1),
          onRejectedChatTurn: () => {
            attempt.session?.stop("max_turns");
          },
          onTransportFailureBudget: () => {
            attempt.session?.stop("llm_transport_failure");
          },
        });
        brokers.push(broker);
        attemptBroker = broker;
        route = { baseUrl: broker.origin, apiKeyEnv: LLM_CAPABILITY_ENV };
        if (attemptResolved.llmPlugin === "llm-pi-ai") {
          bootstrapModelRoutes.push({ model: attemptResolved, ...route });
        }
      }
      if (officialTeamMode && memberSpec.role === "lead") {
        const seen = new Set([`${attemptResolved.provider}\0${attemptResolved.model}`]);
        const requestPolicy = workerLlmRequestPolicy();
        for (const [index, bootstrapModel] of bootstrapModels.entries()) {
          const key = `${bootstrapModel.provider}\0${bootstrapModel.model}`;
          if (seen.has(key)) continue;
          seen.add(key);
          assertLiveDshRoute(bootstrapModel);
          if (bootstrapModel.llmPlugin !== "llm-pi-ai" || !liveNeedsApiKey(bootstrapModel)) {
            throw new Error(
              `thin-bootstrap auxiliary route ${bootstrapModel.provider}/${bootstrapModel.model} must be an api-key llm-pi-ai route`,
            );
          }
          const capability = randomLlmCapability();
          const capabilityEnv = `SILVER_BOOTSTRAP_LLM_CAPABILITY_${index + 1}`;
          const broker = await listenLlmBroker({
            upstreamBaseUrl: bootstrapModel.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL,
            upstreamApiKey: requireLiveApiKey(bootstrapModel),
            capability,
            ledgerPath: path.join(attemptDir, `llm-turns-bootstrap-${index + 1}.jsonl`),
            wireDebugPath: path.join(attemptDir, `llm-wire-bootstrap-${index + 1}.jsonl`),
            provider: bootstrapModel.provider,
            model: bootstrapModel.model,
            api: liveLlmWireApi(bootstrapModel),
            ...(bootstrapModel.maxTokens !== undefined ? { maxTokens: bootstrapModel.maxTokens } : {}),
            effort: bootstrapModel.effort,
            maxConsecutiveFailedTurns: LIVE_LLM_MAX_CONSECUTIVE_FAILED_TURNS,
          });
          brokers.push(broker);
          bootstrapModelEnv[capabilityEnv] = capability;
          bootstrapModelRoutes.push({
            model: bootstrapModel,
            baseUrl: broker.origin,
            apiKeyEnv: capabilityEnv,
          });
        }
        if (seen.size > 1 && bootstrapModelRoutes.length > 0) {
          const patchFile = path.join(cwd, "bootstrap-model-routes.patch.yml");
          fs.writeFileSync(
            patchFile,
            livePiAiRoutePatchYaml(
              bootstrapModelRoutes.map(({ model, baseUrl, apiKeyEnv }) => ({
                provider: model.provider,
                model: model.model,
                baseUrl,
                apiKeyEnv,
                ...(model.api ? { api: model.api } : {}),
                effort: model.effort,
                ...(model.reasoningEfforts !== undefined ? { reasoningEfforts: model.reasoningEfforts } : {}),
                ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
                ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
                ...(model.compat !== undefined ? { compat: model.compat } : {}),
                ...(model.cacheRetention !== undefined ? { cacheRetention: model.cacheRetention } : {}),
                ...requestPolicy,
              })),
            ),
          );
          bootstrapModelPatches.push(patchFile);
        }
      }
      const skillMount = materializeLiveSkillMount(liveSkillMountFromConfig(config, liveSkillsEnabled(args)), cwd);
      const { dshHome, modelPatch, storagePatch, personaPatch } = writeLiveDshHome(
        cwd,
        attemptResolved,
        route,
        liveDshHomeOptions({
          ...(skillMount ? { skills: skillMount } : {}),
          ...(isSwarmProfile(profileName) ? { swarmRoom: true } : {}),
          llmRequest: workerLlmRequestPolicy(),
          roomCompaction: true,
          ...searchOffOption(config),
          personaPrefix: roomAssembly.persona,
        }),
      );
      attempt.dshHome = dshHome;
      await persistSeededMaterials(dshHome, cwd, seededMaterials);
      const collaborationPatch =
        !officialTeamMode
          ? writeMemberCollaborationPatch(cwd, {
              hintPolicy,
              contestSubmit: candidateTools,
              contestVerify: Boolean(input.contestVerify) || liveEntry(args) !== "mission",
            })
          : undefined;
      const officialPatches =
        officialTeamMode && memberSpec.role === "lead"
          // DSH maxMembers counts teammates only. Silver's Host gate uses
          // rosterCap (Lead + Workers), while the Team patch uses maxWorkers.
          ? writeOfficialTeamExperimentPatches(
              path.join(roomClockDir, "official-team-patches"),
              // DSH requires at least one teammate slot even when Silver's
              // Worker cap is zero; the Host roster cap still rejects that child.
              Math.max(1, maxWorkers),
            )
          : [];
      const patches =
        officialPatches.length > 0
          ? [modelPatch, ...bootstrapModelPatches, storagePatch, personaPatch, ...officialPatches, spinePatch]
          : [
              spinePatch,
              modelPatch,
              storagePatch,
              personaPatch,
              ...(collaborationPatch ? [collaborationPatch] : []),
            ];
      attempt.sessionStatePath = liveSessionStatePath(attempt.ledgerPath);
      const sessionIdentity = {
        challengeId,
        attemptId,
        targetUrl: solve.targetUrl,
        provider: attemptResolved.provider,
        model: attemptResolved.model,
        routeFingerprint: liveModelRouteFingerprint(attemptResolved),
        cwd,
        dshHome,
      };
      const loadedSession = input.freshAttempt
        ? undefined
        : readResumableLiveSessionState(attempt.sessionStatePath, sessionIdentity);
      const persistedSession =
        loadedSession && hasLiveSessionResumeBudget(loadedSession.resumeCount) ? loadedSession : undefined;
      const bindingLeadSessionId = ((): string | undefined => {
        if (input.freshAttempt || !officialTeamMode || memberSpec.role !== "lead") return undefined;
        try {
          return readNativeSessionBinding(roomClockDir).leadSessionId?.trim() || undefined;
        } catch {
          return undefined;
        }
      })();
      const resumeLeadSessionId = liveSessionIdForAttempt({
        ...(input.freshAttempt ? { freshAttempt: true } : {}),
        ...(persistedSession?.sessionId ? { persistedSessionId: persistedSession.sessionId } : {}),
        ...(bindingLeadSessionId ? { bindingSessionId: bindingLeadSessionId } : {}),
      });
      if (persistedSession) attempt.startedAt = new Date(persistedSession.startedAt);
      attempt.transportResumeCount = persistedSession ? persistedSession.resumeCount + 1 : 0;
      attempt.hostWakeCount = persistedSession?.hostWakeCount ?? 0;
      attempt.sessionResumeCount = attempt.transportResumeCount;
      const cellEnv = liveCellEnv(attemptResolved, {
        challengeId,
        attemptId,
        targetUrl: solve.targetUrl,
        inScope: solve.inScope,
        flagPattern: mission?.flagPattern ?? config.competition.flagPattern,
        track: config.competition.track,
        domain: roomAssembly.domain,
        hintPolicy,
        contestSubmit: candidateTools,
        contestVerify: Boolean(input.contestVerify) || liveEntry(args) !== "mission",
        contestRestart: Boolean(input.contestRestart),
        dshHome,
        repoRoot,
        ...(args.replayPath ? { replayPath: path.resolve(args.replayPath) } : {}),
        ...(officialTeamMode ? { roomClockDir } : {}),
        ...(route && llmCapability ? { llm: { baseUrl: route.baseUrl, capability: llmCapability } } : {}),
        host: { mode: "rpc", origin: hostRpc.origin, capability: started.capability },
      });
      Object.assign(cellEnv, bootstrapModelEnv);
      cellEnv.SILVER_CWD = cwd;
      if (challengeMaterialsFile) cellEnv.SILVER_CHALLENGE_MATERIALS_FILE = challengeMaterialsFile;
      if (!raceMode && officialTeamChatMounted(opened.selection)) cellEnv.SILVER_SWARM_ROOM = "1";
      if (!raceMode && !officialTeamMode && roomSwarmMode && memberSpec.role === "lead") {
        cellEnv[ROOM_SWARM_ENV] = "1";
      }
      if (officialTeamMode && memberSpec.role === "lead") {
        cellEnv.SILVER_TEAM_IDENTITY_PROBE = "1";
        cellEnv.SILVER_HOST_MODE = "";
        // Product tests set this so they can POST /rpc after remove. Unset in normal runs.
        const authFile = process.env.SILVER_TEST_RPC_AUTH_FILE?.trim();
        if (authFile) {
          fs.writeFileSync(
            authFile,
            JSON.stringify({ origin: hostRpc.origin, capability: started.capability }),
          );
        }
      }
      if (officialTeamMode) cellEnv.SILVER_FORMAL_TEAM = "1";
      const env = hostSpawnEnv(cellEnv, {
        home, tmpDir, binDir,
        ...(config.runtime.executionProfile === "host" ? { toolsRoot: path.join(repoRoot, ".silver-tools", "host") } : {}),
      });
      const task = raceMode
        ? liveRaceRacerTask({
            memberId: memberSpec.memberId,
            attemptId,
            workers: plan.length,
            baseTask,
          })
        : [
            liveMemberSolveTask({
              baseTask,
              memberId: memberSpec.memberId,
              role: memberSpec.role,
              duty: memberSpec.duty ?? (memberSpec.role === "lead" ? "coordinate" : "explore"),
              teamSpecs,
              challengeId,
              teamMode,
              ...(officialTeamMode ? { officialTeam: true } : {}),
              ...(input.freshAttempt ? { freshAttempt: true } : {}),
              domain: roomAssembly.domain,
            }),
            officialTeamMode && memberSpec.role === "lead" && bootstrapModels.length > 0
              ? [
                  "Opening full-goal Worker model routes (assign one route to each Worker, in this order):",
                  ...bootstrapModels.map(
                    (model, index) => `${index + 1}. ${model.provider}/${model.model}`,
                  ),
                ].join("\n")
              : "",
            plan.length > 1
              ? isSwarmProfile(profileName)
                ? `You are Group ${attemptId} of this Project. Sibling Groups are independent Host-started roots sharing Intel and a Silver Room feed/status. This is not official DSH Agent Team and not Lead spawn. Choose an independent route.`
                : `You are Group ${attemptId} of this Project. Sibling Groups share the intel board. Choose an independent route.`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
      attempt.dshRuntime = describeOfficialDshRuntime({
        repoRoot,
        profile: "acp",
        patches,
      });
      assertAcpDshRuntimeReady(attempt.dshRuntime);
      const sessionInput = {
        repoRoot,
        cwd,
        patches,
        env,
        modelSelection: {
          provider: attemptResolved.provider,
          model: attemptResolved.model,
          reasoningEffort: attemptResolved.effort,
        },
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const startAcpProcess = (
        sessionId?: string,
        _resumeCount = attempt.transportResumeCount ?? attempt.sessionResumeCount ?? 0,
        promptText?: string,
      ) => {
        if (input.signal?.aborted || roomHalted) {
          throw new Error("room halted; refusing to start DSH");
        }
        if (roomClosed || roomExpired(roomClock)) {
          throw new Error(`room deadline already expired at ${roomClock.deadlineAt}; refusing to start DSH`);
        }
        const remainingMs = roomRemainingMs(roomClock);
        const prompt =
          promptText ??
          (sessionId
            ? officialTeamMode
              ? [
                  liveMemberResumePrompt(memberSpec.memberId, memberSpec.role, true),
                  "Reconcile the current Room against this authoritative task contract; repeating it on cold recovery is idempotent:",
                  task,
                ].join("\n\n")
              : liveMemberResumePrompt(memberSpec.memberId, memberSpec.role, false)
            : liveSessionPrompt(task, cwd, { images: liveRouteAcceptsImages(attemptResolved) }));
        return spawnOfficialDshAcpSession({
          ...sessionInput,
          timeoutMs: remainingMs,
          prompt,
          ...(sessionId ? { sessionId } : {}),
          preserveOnStopReasons: ["llm_transport_failure", "interrupted", "candidate_checkpoint"],
          preserveOnFailure: true,
          ...(officialTeamMode && memberSpec.role === "lead"
            ? {
                keepOfficialTeamLeadAlive: true,
              }
            : {}),
          onSessionReady: ({ sessionId: readySessionId }) => {
            attempt.dshSessionId = readySessionId;
            input.onGroupSession?.({ groupId: attemptId, sessionId: readySessionId });
            writeLiveSessionState(attempt.sessionStatePath!, {
              ...sessionIdentity,
              sessionId: readySessionId,
              status: "active",
              resumeCount: attempt.transportResumeCount ?? 0,
              ...(attempt.hostWakeCount ? { hostWakeCount: attempt.hostWakeCount } : {}),
              startedAt: attempt.startedAt,
            });
            if (roomMembers && roomMembersFile && attempt.memberId) {
              roomMembers = upsertRoomMember(roomMembers, {
                memberId: attempt.memberId,
                status: "active",
                dshSessionId: readySessionId,
                cwd: attempt.cwd,
                ...(attempt.dshHome ? { dshHome: attempt.dshHome } : {}),
                startedAt: attempt.startedAt.toISOString(),
              });
              publishRoomMembers();
            }
          },
        });
      };
      let resumeLeadPrompt = async (
        _promptText: string,
        _signal?: AbortSignal,
      ): Promise<OfficialDshAcpSessionResult | undefined> => undefined;
      if (roomSwarmMode && memberSpec.role === "lead") {
        if (officialTeamMode) {
          leadCanTakeControl = () => {
            const live = attempt.session;
            return Boolean(attempt.dshSessionId && !live?.isPrompting?.());
          };
        }
        const waitLeadPromptSlot = async (signal?: AbortSignal): Promise<boolean> => {
          const deadline = Date.now() + (officialTeamMode ? 10_000 : 120_000);
          const live = attempt.session;
          if (
            officialTeamMode &&
            live &&
            officialTeamLeadCanTakeSerialPrompt({
              keepAlive: true,
              prompting: live.isPrompting?.() === true,
              active: live.isActive?.() === true,
              aborted: Boolean(signal?.aborted),
            })
          ) {
            return Boolean(attempt.dshSessionId);
          }
          while (
            (officialTeamMode ? live?.isPrompting?.() : live?.isActive?.()) &&
            !signal?.aborted &&
            !roomClosed &&
            !roomExpired(roomClock) &&
            Date.now() < deadline
          ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
          }
          if (signal?.aborted || roomClosed || roomExpired(roomClock) || !attempt.dshSessionId) return false;
          if (officialTeamMode ? live?.isPrompting?.() : live?.isActive?.()) {
            throw new Error("lead_session_still_active");
          }
          return true;
        };
        resumeLeadPrompt = async (
        promptText: string,
        signal?: AbortSignal,
      ): Promise<OfficialDshAcpSessionResult | undefined> => {
        if (!(await waitLeadPromptSlot(signal))) return undefined;
          const prompt = promptText;
          if (memberWakeHub) memberWakeHub.markBusy(memberSpec.memberId);
          attempt.hostWakeCount = (attempt.hostWakeCount ?? 0) + 1;
          if (attempt.sessionStatePath && attempt.dshSessionId) {
            writeLiveSessionState(attempt.sessionStatePath, {
              ...sessionIdentity,
              sessionId: attempt.dshSessionId,
              status: "active",
              resumeCount: attempt.transportResumeCount ?? 0,
              hostWakeCount: attempt.hostWakeCount,
              startedAt: attempt.startedAt,
            });
          }
          const live = attempt.session;
          if (
            officialTeamMode &&
            live?.prompt &&
            officialTeamLeadCanTakeSerialPrompt({
              keepAlive: true,
              prompting: live.isPrompting?.() === true,
              active: live.isActive?.() === true,
              aborted: Boolean(signal?.aborted),
            })
          ) {
            return await live.prompt(prompt);
          }
          const woken = startAcpProcess(
            attempt.dshSessionId,
            attempt.transportResumeCount ?? 0,
            prompt,
          );
          attempt.session = woken;
          sessions.push(woken);
          return await woken.result.catch(() => undefined);
        };
        if (officialTeamMode && memberSpec.role === "lead") {
          let fullSolveTaskDelivered = true;
          leadContinueSolve = async (signal) => {
            const result = await resumeLeadPrompt(
              fullSolveTaskDelivered
                ? liveMemberResumePrompt(memberSpec.memberId, memberSpec.role, true)
                : task,
              signal,
            );
            if (result?.status === 0) fullSolveTaskDelivered = true;
          };
        }
        if (!officialTeamMode) {
          leadDecisionTurn = async ({ prompt: decisionPrompt, submitPath, signal }) => {
            if (leadDecisionTurnBusy) {
              while (leadDecisionTurnBusy && !signal?.aborted && !roomClosed) {
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
              }
            }
            if (signal?.aborted || roomClosed) return;
            leadDecisionTurnBusy = true;
            env[CONVERGENCE_SUBMIT_PATH_ENV] = submitPath;
            env[ROOM_SWARM_ENV] = "1";
            try {
              await resumeLeadPrompt(decisionPrompt, signal);
            } finally {
              delete env[CONVERGENCE_SUBMIT_PATH_ENV];
              leadDecisionTurnBusy = false;
            }
          };
        }
        leadOfficialFollowUp = async (followUpPrompt: string) => {
          if (leadDecisionTurnBusy) {
            while (leadDecisionTurnBusy && !roomClosed) {
              await new Promise<void>((resolve) => setTimeout(resolve, 25));
            }
          }
          if (roomClosed) return;
          leadDecisionTurnBusy = true;
          delete env[CONVERGENCE_SUBMIT_PATH_ENV];
          try {
            const result = await resumeLeadPrompt(followUpPrompt);
            if (!result && !roomClosed && !roomExpired(roomClock) && !input.signal?.aborted) {
              throw new Error("lead session is not ready");
            }
          } finally {
            leadDecisionTurnBusy = false;
          }
        };
        flushLeadControl();
      }
      if (teamMode && memberWakeHub) memberWakeHub.markBusy(memberSpec.memberId);
      const holdResume = Boolean(
        input.resumeReviewHold &&
          persistedSession?.sessionId &&
          shouldResumeSessionsInReviewHold(candidateReviewHold.snapshot()) &&
          candidateReviewHold.isHolding(),
      );
      if (holdResume && persistedSession?.sessionId) {
        attempt.dshSessionId = persistedSession.sessionId;
        input.onGroupSession?.({ groupId: attemptId, sessionId: persistedSession.sessionId });
        writeLiveSessionState(attempt.sessionStatePath, {
          ...sessionIdentity,
          sessionId: persistedSession.sessionId,
          status: "active",
          resumeCount: attempt.transportResumeCount ?? 0,
          ...(attempt.hostWakeCount ? { hostWakeCount: attempt.hostWakeCount } : {}),
          startedAt: attempt.startedAt,
        });
      }
      const session = holdResume
        ? undefined
        : startAcpProcess(resumeLeadSessionId, attempt.transportResumeCount);
      if (session) attempt.session = session;
      if (input.contestSubmit && session) {
        attempt.stagnationWatch = setInterval(() => {
          if (
            hostTerminalForLive(
              liveRuntime,
              challengeId,
              Boolean(mission),
              Boolean(input.contestSubmit),
              Boolean(input.goalBound),
            )
          ) return;
          let turns;
          try {
            turns = observedLiveTurns(turnsPath, attempt.dshHome);
          } catch {
            return;
          }
          const technicalProgress = technicalProgressForLiveRun({
            officialTeamMode,
            runtime: liveRuntime,
            challengeId,
            attemptId,
          });
          const progress = technicalProgress ? contestProgressSummary(technicalProgress) : undefined;
          const wire = summarizeLiveWireFile(attempt.wirePath);
          updateAttemptActivity(attempt, turns.length, wire?.requests ?? 0);
          maybeEmitAttemptProgress({
            attempt,
            attemptIndex: index,
            challengeId,
            turns,
            ...(progress ? { progress } : {}),
            ...(input.onAttemptProgress ? { onAttemptProgress: input.onAttemptProgress } : {}),
            ...(input.rootSession !== undefined ? { rootSession: input.rootSession } : {}),
          });
          // Stagnation / candidate / no-turn heuristics are observational only (no session.stop).
        }, 2_000);
      }
      attempt.resultPromise = (
        holdResume && persistedSession?.sessionId
          ? Promise.resolve({
              status: 0,
              stdout: "",
              stderr: "",
              resumed: true,
              closed: false,
              dshSessionId: persistedSession.sessionId,
              stopReason: "candidate_checkpoint" as const,
              dshProcessRestarts: 0,
            })
          : session!.result
      ).then(async (first) => {
          let last = first;
          const releaseWakeOwnership = (exitStatus: "terminal" | "interrupted" = "interrupted"): void => {
            if (attempt.memberId && memberWakeHub) {
              // Project exit status before quiesce so other idle members are not blocked by a
              // still-"active" roster row for this departing member.
              if (roomMembers && roomMembersFile) {
                roomMembers = upsertRoomMember(roomMembers, {
                  memberId: attempt.memberId,
                  status: exitStatus,
                  ...(attempt.dshSessionId || last.dshSessionId
                    ? { dshSessionId: last.dshSessionId ?? attempt.dshSessionId }
                    : {}),
                  ...(last.stopReason ? { stopReason: last.stopReason } : {}),
                });
                publishRoomMembers();
              }
              memberWakeHub.release(attempt.memberId);
              maybeQuiesceTeamRoom();
            }
          };
          const applySerialLeadResult = (next: OfficialDshAcpSessionResult): void => {
            last = {
              ...next,
              dshProcessRestarts: (last.dshProcessRestarts ?? 0) + (next.dshProcessRestarts ?? 0),
              stderr: [last.stderr.trim(), next.stderr.trim()].filter(Boolean).join("\n"),
            };
          };
          /** Official Team Lead wakes stay on the live session.prompt. A dead process may still respawn. */
          type SerialLeadPromptResult = "not_admitted" | "transport_failure" | "completed";
          const serialOfficialLeadPrompt = async (promptText: string): Promise<SerialLeadPromptResult> => {
            if (!(officialTeamMode && memberSpec.role === "lead")) return "not_admitted";
            let next: OfficialDshAcpSessionResult | undefined;
            try {
              next = await resumeLeadPrompt(promptText, input.signal);
            } catch (error) {
              if (
                input.signal?.aborted ||
                roomClosed ||
                !isOfficialDshAcpPromptTransportError(error)
              ) {
                throw error;
              }
              const dshSessionId = attempt.dshSessionId ?? last.dshSessionId;
              if (!dshSessionId) throw error;
              next = {
                status: 1,
                stdout: "",
                stderr: error instanceof Error ? error.message : String(error),
                dshSessionId,
                stopReason: "llm_transport_failure",
              };
            }
            if (!next) return "not_admitted";
            applySerialLeadResult(next);
            return shouldResumeLiveSession(next, input.signal) ? "transport_failure" : "completed";
          };
          const markSessionIdleAwaitingHostWake = (sessionId: string): void => {
            if (!roomMembers || !roomMembersFile) return;
            const memberId =
              roomMembers.members.find(
                (row) => row.nativeSession?.sessionId === sessionId || row.dshSessionId === sessionId,
              )?.memberId ?? attempt.memberId;
            if (!memberId) return;
            roomMembers = upsertRoomMember(roomMembers, {
              memberId,
              status: "idle_awaiting_host_wake",
              stopReason: "idle_awaiting_host_wake",
              dshSessionId: sessionId,
            });
            publishRoomMembers();
          };
          async function resumeTransport(): Promise<void> {
            while (
              liveSessionRecoveryAction(last, attempt.transportResumeCount ?? 0, input.signal) === "resume"
            ) {
              attemptBroker?.resetTransportFailures?.();
              attempt.transportResumeCount = (attempt.transportResumeCount ?? 0) + 1;
              attempt.sessionResumeCount = attempt.transportResumeCount;
              const promptResult = await serialOfficialLeadPrompt(
                liveMemberResumePrompt(memberSpec.memberId, memberSpec.role, officialTeamMode),
              );
              if (promptResult !== "not_admitted") {
                continue;
              }
              const resumed = startAcpProcess(last.dshSessionId, attempt.transportResumeCount);
              attempt.session = resumed;
              sessions.push(resumed);
              const next = await resumed.result;
              last = {
                ...next,
                dshProcessRestarts: (last.dshProcessRestarts ?? 0) + 1 + (next.dshProcessRestarts ?? 0),
                stderr: [last.stderr.trim(), next.stderr.trim()].filter(Boolean).join("\n"),
              };
            }
            if (liveSessionRecoveryAction(last, attempt.transportResumeCount ?? 0, input.signal) === "exhausted") {
              stopAll("llm_transport_failure");
            }
          }
          const candidateReviewPending = (): boolean =>
            Boolean(input.goalBound) &&
            Boolean(last.dshSessionId) &&
            (last.stopReason === "candidate_checkpoint" ||
              candidateAwaitingReview() ||
              Boolean(latestGoalReview && goalReviewEpoch > (attempt.appliedReviewEpoch ?? 0)));
          /** Pending / lease expiry: same dshSessionId, Member active. false = stop this member. */
          const resumeAfterCandidateReview = async (): Promise<boolean> => {
            const review = await waitGoalReview(attempt);
            if (review.status === "completed" || roomClosed || input.signal?.aborted) return false;
            if (roomMembers && roomMembersFile && attempt.memberId && last.dshSessionId) {
              roomMembers = upsertRoomMember(roomMembers, {
                memberId: attempt.memberId,
                status: "active",
                dshSessionId: last.dshSessionId,
              });
              publishRoomMembers();
            }
            if (officialTeamMode && memberSpec.role === "lead") {
              await serialOfficialLeadPrompt(liveGoalBoundWorkerReviewPrompt(challengeId, review.reason));
              await resumeTransport();
              return true;
            }
            attempt.hostWakeCount = (attempt.hostWakeCount ?? 0) + 1;
            if (attempt.sessionStatePath && last.dshSessionId) {
              writeLiveSessionState(attempt.sessionStatePath, {
                ...sessionIdentity,
                sessionId: last.dshSessionId,
                status: "active",
                resumeCount: attempt.transportResumeCount ?? 0,
                hostWakeCount: attempt.hostWakeCount,
                startedAt: attempt.startedAt,
              });
            }
            const woken = startAcpProcess(
              last.dshSessionId,
              attempt.transportResumeCount ?? 0,
              liveGoalBoundWorkerReviewPrompt(challengeId, review.reason),
            );
            attempt.session = woken;
            sessions.push(woken);
            const next = await woken.result;
            last = {
              ...next,
              dshProcessRestarts: (last.dshProcessRestarts ?? 0) + (next.dshProcessRestarts ?? 0),
              stderr: [last.stderr.trim(), next.stderr.trim()].filter(Boolean).join("\n"),
            };
            await resumeTransport();
            return true;
          };
          const settleLeadResult = async (): Promise<"continue" | "break" | "natural_idle"> => {
            const step = nextLeadResultStep({
              aborted: Boolean(input.signal?.aborted),
              roomClosed,
              ...(last.dshSessionId ? { dshSessionId: last.dshSessionId } : {}),
              candidateReviewPending: candidateReviewPending(),
              naturalIdle: isNaturalLiveIdle(last),
            });
            if (step === "candidate_review") {
              return (await resumeAfterCandidateReview()) ? "continue" : "break";
            }
            return step === "natural_idle" ? "natural_idle" : "break";
          };
          try {
            await resumeTransport();
            if (input.goalBound) {
              while (
                !input.signal?.aborted &&
                !roomClosed &&
                !roomExpired(roomClock) &&
                !hostTerminalForLive(
                  liveRuntime,
                  challengeId,
                  Boolean(mission),
                  Boolean(input.contestSubmit),
                  Boolean(input.goalBound),
                )
              ) {
                const leadStep = await settleLeadResult();
                if (leadStep === "continue") continue;
                const idleSessionId = last.dshSessionId;
                if (leadStep !== "natural_idle" || !idleSessionId) break;
                // Team/swarm: leave GoalReview wait for the formal-member hub only after
                // a natural idle (not while a candidate checkpoint still needs resume).
                if (teamMode) break;
                stalledGroups.add(attempt.attemptId);
                if (attempt.sessionStatePath && last.dshSessionId && attempt.dshHome) {
                  writeLiveSessionState(attempt.sessionStatePath, {
                    ...sessionIdentity,
                    sessionId: last.dshSessionId,
                    status: "interrupted",
                    resumeCount: attempt.transportResumeCount ?? 0,
                    ...(attempt.hostWakeCount ? { hostWakeCount: attempt.hostWakeCount } : {}),
                    startedAt: attempt.startedAt,
                    stopReason: "idle_awaiting_host_wake",
                  });
                }
                if (last.dshSessionId) markSessionIdleAwaitingHostWake(last.dshSessionId);
                await noteConvergence({
                  eventId: `member_turn_ended:${attempt.memberId ?? attempt.attemptId}:${last.dshSessionId}:idle:w${attempt.hostWakeCount ?? 0}`,
                  kind: "member_turn_ended",
                  subjectRef: attempt.memberId ?? SOLO_MEMBER_ID,
                  version: `${last.dshSessionId}:w${attempt.hostWakeCount ?? 0}`,
                });
                if (soloConvergence && memberWakeHub && attempt.memberId) {
                  if (roomMembers && roomMembersFile) {
                    roomMembers = upsertRoomMember(roomMembers, {
                      memberId: attempt.memberId,
                      status: "idle",
                      dshSessionId: idleSessionId,
                    });
                    publishRoomMembers();
                  }
                  memberWakeHub.markIdle(attempt.memberId);
                  const delivered = await kickSoloConvergenceAndWake();
                  if (
                    !delivered ||
                    roomClosed ||
                    input.signal?.aborted ||
                    roomExpired(roomClock) ||
                    hostTerminalForLive(
                      liveRuntime,
                      challengeId,
                      Boolean(mission),
                      Boolean(input.contestSubmit),
                      Boolean(input.goalBound),
                    )
                  ) {
                    stalledGroups.add(attempt.attemptId);
                    if (!teamMode && !officialTeamMode && !roomSwarmMode) {
                      input.onCompatibilityGroupStalled?.({ groupId: attempt.attemptId });
                    }
                    maybeReleaseStalledProject();
                    await waitRoomHalt();
                    break;
                  }
                  const wake = await memberWakeHub.wait(attempt.memberId);
                  if (wake.kind === "stop" || roomClosed || roomExpired(roomClock) || input.signal?.aborted) {
                    break;
                  }
                  if (wake.kind === "host_control" || wake.kind === "convergence") continue;
                  const wakePrompt = liveMemberWakeIntelPrompt(attempt.memberId, []);
                  memberWakeHub.markBusy(attempt.memberId);
                  attempt.hostWakeCount = (attempt.hostWakeCount ?? 0) + 1;
                  if (attempt.sessionStatePath) {
                    writeLiveSessionState(attempt.sessionStatePath, {
                      ...sessionIdentity,
                      sessionId: idleSessionId,
                      status: "active",
                      resumeCount: attempt.transportResumeCount ?? 0,
                      hostWakeCount: attempt.hostWakeCount,
                      startedAt: attempt.startedAt,
                    });
                  }
                  const woken = startAcpProcess(
                    last.dshSessionId,
                    attempt.transportResumeCount ?? 0,
                    wakePrompt,
                  );
                  attempt.session = woken;
                  sessions.push(woken);
                  const next = await woken.result;
                  last = {
                    ...next,
                    dshProcessRestarts: (last.dshProcessRestarts ?? 0) + (next.dshProcessRestarts ?? 0),
                    stderr: [last.stderr.trim(), next.stderr.trim()].filter(Boolean).join("\n"),
                  };
                  await resumeTransport();
                  continue;
                }
                if (!teamMode && !officialTeamMode && !roomSwarmMode) {
                  input.onCompatibilityGroupStalled?.({ groupId: attempt.attemptId });
                }
                maybeReleaseStalledProject();
                await waitRoomHalt();
                break;
              }
              if (!teamMode || !memberWakeHub || !attempt.memberId) {
                attempt.groupEnded = true;
                return last;
              }
            }
            if (!teamMode || !memberWakeHub || !attempt.memberId) return last;

            // Formal members: natural end_turn is idle, not room exit. Host wakes do not consume
            // the transport resume budget — only ACP/transport faults do.
            while (
              !roomClosed &&
              !roomExpired(roomClock) &&
              !hostTerminalForLive(
                liveRuntime,
                challengeId,
                Boolean(mission),
                Boolean(input.contestSubmit),
                Boolean(input.goalBound),
              )
            ) {
              if (await flushOfficialTeamSolve()) continue;
              const leadStep = await settleLeadResult();
              if (leadStep === "continue") continue;
              const idleSessionId = last.dshSessionId ?? attempt.dshSessionId;
              // Official Team keep-alive is hub ownership, not "ACP process still
              // isActive". A cancelled/end_turn Lead must stay parked so an
              // all-idle roster cannot fall out of this loop into finishLiveRun.
              const keepAliveLead =
                officialTeamMode &&
                memberSpec.role === "lead" &&
                Boolean(memberWakeHub) &&
                Boolean(attempt.memberId);
              if (leadStep !== "natural_idle") {
                if (keepAliveLead && (await flushOfficialTeamSolve())) continue;
                if (keepAliveLead && memberWakeHub && attempt.memberId) {
                  memberWakeHub.markIdle(attempt.memberId);
                  const wake = await memberWakeHub.wait(attempt.memberId);
                  if (wake.kind === "stop" || roomClosed) break;
                  continue;
                }
                break;
              }
              if (!idleSessionId) break;
              if (officialTeamMode && memberSpec.role === "lead" && (await flushOfficialTeamSolve())) {
                continue;
              }

              if (roomMembers && roomMembersFile) {
                roomMembers = upsertRoomMember(roomMembers, {
                  memberId: attempt.memberId,
                  status: "idle",
                  dshSessionId: idleSessionId,
                });
                publishRoomMembers();
              }
              if (!officialTeamMode) {
                await noteConvergence({
                  eventId: `member_turn_ended:${attempt.memberId}:${idleSessionId}:idle:w${attempt.hostWakeCount ?? 0}`,
                  kind: "member_turn_ended",
                  subjectRef: attempt.memberId,
                  version: `${idleSessionId}:w${attempt.hostWakeCount ?? 0}`,
                });
              }
              if (!officialTeamMode && roomSwarmMode && attempt.role === "lead") {
                // Serial Lead coordination turn on the same session (not a second Reviewer root).
                await kickSwarmConvergenceAndApply();
                if (roomClosed || input.signal?.aborted || roomExpired(roomClock)) break;
              }
              if (attempt.sessionStatePath && attempt.dshHome) {
                writeLiveSessionState(attempt.sessionStatePath, {
                  ...sessionIdentity,
                  sessionId: idleSessionId,
                  status: "interrupted",
                  resumeCount: attempt.transportResumeCount ?? 0,
                  ...(attempt.hostWakeCount ? { hostWakeCount: attempt.hostWakeCount } : {}),
                  startedAt: attempt.startedAt,
                  stopReason: "idle_awaiting_host_wake",
                });
              }
              markSessionIdleAwaitingHostWake(idleSessionId);
              memberWakeHub.markIdle(attempt.memberId);
              const wakePromise = memberWakeHub.wait(attempt.memberId);
              maybeQuiesceTeamRoom();
              const wake = await wakePromise;
              if (wake.kind === "stop" || roomClosed || roomExpired(roomClock)) break;
              if (wake.kind === "host_control" || wake.kind === "convergence") continue;
              if (
                hostTerminalForLive(
                  liveRuntime,
                  challengeId,
                  Boolean(mission),
                  Boolean(input.contestSubmit),
                  Boolean(input.goalBound),
                )
              ) {
                break;
              }
              const pendingNotices = liveRuntime.pendingIntelNotices(challengeId, attempt.memberId).map(
                (row) => ({
                  intelId: row.intelId,
                  previousVersion: row.previousVersion,
                  currentVersion: row.currentVersion,
                  status: row.status,
                  kind: row.kind,
                  ...(row.commentIds ? { commentIds: row.commentIds } : {}),
                  ...(row.unreadCommentCount !== undefined
                    ? { unreadCommentCount: row.unreadCommentCount }
                    : {}),
                }),
              );
              // Intel wake reason only; authoritative pending is resolved here. Skip empty wakes.
              if (wake.kind === "intel" && pendingNotices.length === 0) {
                continue;
              }
              const wakePrompt = liveMemberWakeIntelPrompt(attempt.memberId, pendingNotices);
              if ((await serialOfficialLeadPrompt(wakePrompt)) !== "not_admitted") {
                await resumeTransport();
                continue;
              }
              memberWakeHub.markBusy(attempt.memberId);
              // Persist before ACP start so interrupt mid-wake still records the Host wake count
              // separately from transport resumeCount.
              attempt.hostWakeCount = (attempt.hostWakeCount ?? 0) + 1;
              if (attempt.sessionStatePath && last.dshSessionId) {
                writeLiveSessionState(attempt.sessionStatePath, {
                  ...sessionIdentity,
                  sessionId: last.dshSessionId,
                  status: "active",
                  resumeCount: attempt.transportResumeCount ?? 0,
                  hostWakeCount: attempt.hostWakeCount,
                  startedAt: attempt.startedAt,
                });
              }
              const woken = startAcpProcess(
                last.dshSessionId,
                attempt.transportResumeCount ?? 0,
                wakePrompt,
              );
              attempt.session = woken;
              sessions.push(woken);
              const next = await woken.result;
              last = {
                ...next,
                dshProcessRestarts: (last.dshProcessRestarts ?? 0) + (next.dshProcessRestarts ?? 0),
                stderr: [last.stderr.trim(), next.stderr.trim()].filter(Boolean).join("\n"),
              };
              await resumeTransport();
            }
            // Swarm / official-team: leaving this loop is not "the Room is done".
            // An all-idle moment (Lead + A idle, B still held) must wait for a
            // real room halt — deadline, platform accepted, or operator SIGINT.
            if (
              officialTeamMode &&
              !roomClosed &&
              !input.signal?.aborted &&
              !roomExpired(roomClock) &&
              !hostTerminalForLive(
                liveRuntime,
                challengeId,
                Boolean(mission),
                Boolean(input.contestSubmit),
                Boolean(input.goalBound),
              )
            ) {
              if (memberWakeHub && attempt.memberId) memberWakeHub.markIdle(attempt.memberId);
              await waitRoomHalt();
            }
            return last;
          } finally {
            const naturalIdle = isNaturalLiveIdle(last);
            const terminal =
              !naturalIdle ||
              roomClosed ||
              roomExpired(roomClock) ||
              hostTerminalForLive(
                liveRuntime,
                challengeId,
                Boolean(mission),
                Boolean(input.contestSubmit),
                Boolean(input.goalBound),
              );
            releaseWakeOwnership(terminal ? "terminal" : "interrupted");
          }
        })
        .catch((err) => {
          if (attempt.memberId && memberWakeHub) {
            if (roomMembers && roomMembersFile) {
              const memberId = resolveRoomMemberId(roomMembers, {
                memberId: attempt.memberId,
                ...(attempt.role ? { role: attempt.role } : {}),
                ...(attempt.dshSessionId ? { sessionId: attempt.dshSessionId } : {}),
              });
              if (memberId) {
                roomMembers = upsertRoomMember(roomMembers, {
                  memberId,
                  status: roomStopReason === "host_terminal_stop" ? "stopped" : "terminal",
                  ...(attempt.dshSessionId ? { dshSessionId: attempt.dshSessionId } : {}),
                  stopReason: roomStopReason === "host_terminal_stop" ? "host_terminal_stop" : "attempt_error",
                });
                publishRoomMembers();
              }
            }
            memberWakeHub.release(attempt.memberId);
            maybeQuiesceTeamRoom();
          }
          return {
            status: 1,
            stdout: "",
            stderr: err instanceof Error ? err.stack ?? err.message : String(err),
          };
        });
      if (session) sessions.push(session);
      attempts.push(attempt);
      ledger?.appendEvent(
        "live_attempt_start",
        {
          attemptId,
          index,
          provider: attemptResolved.provider,
          model: attemptResolved.model,
          presentation: attemptResolved.presentation,
          memberId: memberSpec.memberId,
          role: memberSpec.role,
        },
        { missionId: "mission-live", challengeId, attemptId },
      );
      } catch (err) {
        if (officialTeamMode && memberSpec.role === "lead" && !attempt.dshSessionId) {
          liveRuntime.setOfficialTeamRpcGate(challengeId, undefined);
        }
        markMemberBlocked(err);
        try {
          await attemptBroker?.close();
        } catch {
          /* best-effort */
        }
        try {
          await liveRuntime.stopAttempt(attemptId);
        } catch {
          /* best-effort */
        }
        throw err;
      }
    };
    for (let index = 0; index < bootstrapCount; index += 1) {
      await startAttempt(index);
    }
    if (officialTeamMode && officialTeamRoomPhase(roomClockDir) === "bootstrap_degraded") {
      stopAll("bootstrap_degraded");
    } else {
      void flushOfficialTeamSolve();
    }

    const finishAttempt = async (attempt: LiveHostFsAttempt): Promise<FinishedLiveHostFsAttempt> => {
      const result = await attempt.resultPromise!;
      attempt.groupEnded = true;
      const effectiveStopReason = roomStopReason ?? result.stopReason;
      if (
        officialTeamMode &&
        roomMembersFile &&
        (input.signal?.aborted || roomStopReason === "interrupted") &&
        roomStopReason !== "host_terminal_stop"
      ) {
        projectInterruptedRoomMembers(roomMembersFile, "interrupted");
      }
      if (attempt.stagnationWatch) clearInterval(attempt.stagnationWatch);
      if (!input.silent) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      const sessionId = result.dshSessionId ?? attempt.dshSessionId;
      if (sessionId && attempt.sessionStatePath && attempt.dshHome) {
        const hostTerminal = roomStopReason === "host_terminal_stop" || hostTerminalForLive(
          liveRuntime,
          challengeId,
          Boolean(mission),
          Boolean(input.contestSubmit),
          Boolean(input.goalBound),
        );
        const status = input.signal?.aborted && !hostTerminal
          ? "interrupted"
          : hostTerminal
            ? "terminal"
            : stalledGroups.has(attempt.attemptId) || roomUnresolvedStall
              ? "stalled"
              : result.closed === true
                ? "terminal"
                : "interrupted";
        writeLiveSessionState(attempt.sessionStatePath, {
          challengeId,
          attemptId: attempt.attemptId,
          targetUrl: solve.targetUrl,
          provider: attempt.resolved.provider,
          model: attempt.resolved.model,
          routeFingerprint: liveModelRouteFingerprint(attempt.resolved),
          cwd: attempt.cwd,
          dshHome: attempt.dshHome,
          sessionId,
          status,
          resumeCount: attempt.transportResumeCount ?? attempt.sessionResumeCount ?? 0,
          ...(attempt.hostWakeCount ? { hostWakeCount: attempt.hostWakeCount } : {}),
          startedAt: attempt.startedAt,
          ...(effectiveStopReason ? { stopReason: effectiveStopReason } : {}),
        });
        if (roomMembers && roomMembersFile) {
          const memberId = resolveRoomMemberId(roomMembers, {
            ...(attempt.memberId ? { memberId: attempt.memberId } : {}),
            ...(attempt.role ? { role: attempt.role } : {}),
            sessionId,
          });
          const current = memberId ? roomMembers.members.find((row) => row.memberId === memberId) : undefined;
          if (memberId && current?.status !== "stopped") {
            roomMembers = upsertRoomMember(roomMembers, {
              memberId,
              status,
              dshSessionId: sessionId,
              ...(effectiveStopReason ? { stopReason: effectiveStopReason } : {}),
            });
            publishRoomMembers();
          }
        }
      }
      const built = liveRunLedger({
        args,
        mission,
        contestSubmit: Boolean(input.contestSubmit),
        challengeId,
        startedAt: attempt.startedAt,
        dshStatus: result.status,
        ...(sessionId ? { dshSessionId: sessionId } : {}),
        ...(result.dshProcessRestarts ? { dshProcessRestarts: result.dshProcessRestarts } : {}),
        ...(attempt.transportResumeCount || attempt.sessionResumeCount
          ? { dshSessionResumes: attempt.transportResumeCount ?? attempt.sessionResumeCount ?? 0 }
          : {}),
        ...((attempt.hostWakeCount ?? 0) > 0 ? { dshHostWakes: attempt.hostWakeCount } : {}),
        turnsPath: attempt.turnsPath,
        promptSkillGestures,
        wirePath: attempt.wirePath,
        runtime: liveRuntime,
        ...(attempt.dshRuntime ? { dshRuntime: attempt.dshRuntime } : {}),
        ...(attempt.dshHome ? { dshHome: attempt.dshHome } : {}),
        ...(effectiveStopReason ? { stopReason: effectiveStopReason } : {}),
        ...(result.acpStopReason ? { acpStopReason: result.acpStopReason } : {}),
      });
      return { ...attempt, result, ledger: built };
    };
    const finished: FinishedLiveHostFsAttempt[] = [];
    const finishedIds = new Set<string>();
    const finishPromises = new Map<string, Promise<FinishedLiveHostFsAttempt>>();
    const finishPromiseFor = (attempt: LiveHostFsAttempt): Promise<FinishedLiveHostFsAttempt> => {
      const existing = finishPromises.get(attempt.attemptId);
      if (existing) return existing;
      const created = finishAttempt(attempt);
      finishPromises.set(attempt.attemptId, created);
      return created;
    };
    while (finishedIds.size < attempts.length) {
      const pending = attempts.filter((attempt) => !finishedIds.has(attempt.attemptId));
      const next = await Promise.race(pending.map((attempt) => finishPromiseFor(attempt)));
      finishedIds.add(next.attemptId);
      finished.push(next);
    }
    const primary = pickPrimaryLiveAttempt(finished);
    for (const attempt of finished) {
      if (attempt === primary) continue;
      writeLiveRunLedger(attempt.ledgerPath, attempt.ledger);
    }
    // All attempts have ended; retain derived progress only for legacy/offline-compatible runs.
    const technicalProgress = technicalProgressForLiveRun({
      officialTeamMode,
      runtime: liveRuntime,
      challengeId,
      attemptId: primary.attemptId,
    });
    try {
      finishLiveRun({
        mission,
        runtime: liveRuntime,
        ...(technicalProgress ? { technicalProgress } : {}),
        challengeId,
        attemptId: primary.attemptId,
        dshStatus: primary.result.status,
        stdout: primary.result.stdout,
        stderr: primary.result.stderr,
        ledger: primary.ledger,
        ledgerPath: primary.ledgerPath,
        evidenceRoot: primary.cwd,
        budget,
        contestSubmit: Boolean(input.contestSubmit),
        ...(input.silent ? { silent: true } : {}),
      });
    } catch (err) {
      if (input.soft) {
        const platformVerdicts = liveRuntime.takePlatformVerdicts(challengeId);
        const platformProgress = platformProgressFromVerdicts(platformVerdicts);
        const soft = contestResultFromLiveAttempt(
          primary,
          finished,
          challengeId,
          solve.targetUrl,
          technicalProgress ? contestProgressSummary(technicalProgress) : undefined,
          roomControlRequest,
          platformProgress,
          platformVerdicts.length > 0,
        );
        if (platformVerdicts.length) soft.platformVerdicts = platformVerdicts;
        soft.error = err instanceof Error ? err.message : String(err);
        return soft;
      }
      throw err;
    }
    const leftoverRaw = liveRuntime.takePassedRaw(challengeId);
    const platformVerdicts = liveRuntime.takePlatformVerdicts(challengeId);
    const platformProgress = platformProgressFromVerdicts(platformVerdicts);
    const out = contestResultFromLiveAttempt(
      primary,
      finished,
      challengeId,
      solve.targetUrl,
      technicalProgress ? contestProgressSummary(technicalProgress) : undefined,
      roomControlRequest,
      platformProgress,
      platformVerdicts.length > 0,
    );
    if (leftoverRaw.length) out.leftoverRaw = leftoverRaw;
    if (platformVerdicts.length) out.platformVerdicts = platformVerdicts;
    if (
      officialTeamMode &&
      isRoomPlatformStopApplied(roomClockDir, challengeId) &&
      officialContestRoomTerminal({
        ...(out.outcome ? { outcome: out.outcome } : {}),
        platformVerdicts,
      })
    ) {
      out.outcome = "solved";
      delete out.error;
      delete out.reason;
    }
    return out;
  } catch (err) {
    if (input.soft) {
      const clockDir = liveRoomClockDir({
        challengeId,
        ...(input.roomWorkDir ? { roomWorkDir: input.roomWorkDir } : {}),
        ...(args.replayPath ? { replayPath: args.replayPath } : {}),
      });
      const platformSolved = Boolean(
        officialTeamMode &&
        isRoomPlatformStopApplied(clockDir, challengeId) &&
        runtime?.platformCompleted(challengeId),
      );
      const platformVerdicts = runtime?.takePlatformVerdicts(challengeId) ?? [];
      const platformProgress = platformProgressFromVerdicts(platformVerdicts);
      return {
        targetId: challengeId,
        targetUrl: mission?.target ?? targetUrl,
        ...(platformSolved ? { outcome: "solved" } : {}),
        ...(platformProgress ? { platformProgress } : {}),
        ...(platformVerdicts.length ? { platformVerdicts } : {}),
        ...(!platformSolved ? { error: err instanceof Error ? err.message : String(err) } : {}),
      };
    }
    throw err;
  } finally {
    if (onAbortRoom) input.signal?.removeEventListener("abort", onAbortRoom);
    if (roomDeadlineTimer) {
      clearTimeout(roomDeadlineTimer);
      roomDeadlineTimer = undefined;
    }
    disposeRoomControls?.();
    runtime?.setRoomDeadlineHandler(challengeId, undefined);
    runtime?.setRoomProjectionBinding(challengeId, undefined);
    runtime?.setRoomMemberBinding(challengeId, undefined);
    if (roomSwarmMode && !officialTeamMode) delete process.env[ROOM_SWARM_ENV];
    for (const session of sessions) session.stop(input.signal?.aborted ? "interrupted" : "timeout");
    await Promise.allSettled(sessions.map((session) => session.settled));
    await runtime?.stopAllAttempts();
    await rpc?.close();
    for (const liveBroker of brokers) await liveBroker.close();
    ledger?.close();
    await platform.close();
  }
}

interface LiveHostFsAttempt {
  attemptId: string;
  memberId?: string;
  role?: "lead" | "worker";
  resolved: ResolvedModelCall;
  cwd: string;
  dshHome?: string;
  dshSessionId?: string;
  /** Transport/ACP fault recovery only — gated by LIVE_SESSION_MAX_RESUMES. */
  transportResumeCount?: number;
  /** Host control, convergence, and Intel wakes — not gated by transport resume budget. */
  hostWakeCount?: number;
  appliedReviewEpoch?: number;
  /** Official Team: Host interrupted this Lead prompt so C2 can take a decision turn. */
  groupEnded?: boolean;
  /** @deprecated alias of transportResumeCount for ledger fields */
  sessionResumeCount?: number;
  sessionStatePath?: string;
  startedAt: Date;
  turnsPath: string;
  wirePath: string;
  ledgerPath: string;
  dshRuntime?: DshRuntimeFingerprint;
  session?: ReturnType<typeof spawnOfficialDshAcpSession>;
  resultPromise?: Promise<OfficialDshAcpSessionResult>;
  stagnationWatch?: ReturnType<typeof setInterval>;
  candidateEvidenceFirstTurn?: number;
  lastProgressEmitMs?: number;
  lastActivityMs?: number;
  lastActivityTurnCount?: number;
  lastActivityWireRequests?: number;
}

interface FinishedLiveHostFsAttempt extends LiveHostFsAttempt {
  result: OfficialDshAcpSessionResult;
  ledger: ReturnType<typeof buildLiveRunLedger>;
}

interface LiveHostFsAttemptProgressEvent {
  type: "solver-progress";
  targetId: string;
  attemptId: string;
  rootSession: number;
  elapsedMs: number;
  turns: number;
  toolCalls: number;
  skillCalls: number;
  todoCalls: number;
  candidateEvidenceCount?: number;
  workMemoryState?: string;
  repeatedAxisCount?: number;
  wireRequests?: number;
  wireFailures?: number;
  maxWireBodyBytes?: number;
}

function maybeEmitAttemptProgress(input: {
  attempt: LiveHostFsAttempt;
  attemptIndex: number;
  rootSession?: number;
  challengeId: string;
  turns: ReturnType<typeof readLiveTurns>;
  progress?: ContestSolveResult["progress"];
  onAttemptProgress?: (event: LiveHostFsAttemptProgressEvent) => void;
}): void {
  if (!input.onAttemptProgress) return;
  const now = Date.now();
  const elapsedMs = now - input.attempt.startedAt.getTime();
  if (input.turns.length === 0) return;
  if (input.attempt.lastProgressEmitMs !== undefined && now - input.attempt.lastProgressEmitMs < 60_000) return;
  input.attempt.lastProgressEmitMs = now;
  const wire = summarizeLiveWireFile(input.attempt.wirePath);
  input.onAttemptProgress({
    type: "solver-progress",
    targetId: input.challengeId,
    attemptId: input.attempt.attemptId,
    rootSession: input.rootSession ?? input.attemptIndex,
    elapsedMs,
    turns: input.turns.length,
    toolCalls: countToolCalls(input.turns),
    skillCalls: countNamedCalls(input.turns, "skill"),
    todoCalls: countNamedCalls(input.turns, "todo_write"),
    ...(input.progress?.candidateEvidenceCount !== undefined
      ? { candidateEvidenceCount: input.progress.candidateEvidenceCount }
      : {}),
    ...(input.progress?.workMemoryState ? { workMemoryState: input.progress.workMemoryState } : {}),
    ...(input.progress?.repeatedAxisCount !== undefined ? { repeatedAxisCount: input.progress.repeatedAxisCount } : {}),
    ...(wire?.requests !== undefined ? { wireRequests: wire.requests } : {}),
    ...(wire?.failedRequests !== undefined ? { wireFailures: wire.failedRequests } : {}),
    ...(wire?.maxBodyBytes !== undefined ? { maxWireBodyBytes: wire.maxBodyBytes } : {}),
  });
}

function updateAttemptActivity(attempt: LiveHostFsAttempt, turnCount: number, wireRequests: number): void {
  const changed =
    attempt.lastActivityTurnCount === undefined ||
    attempt.lastActivityWireRequests === undefined ||
    turnCount !== attempt.lastActivityTurnCount ||
    wireRequests !== attempt.lastActivityWireRequests;
  if (!changed) return;
  attempt.lastActivityTurnCount = turnCount;
  attempt.lastActivityWireRequests = wireRequests;
  attempt.lastActivityMs = Date.now();
}

function liveBootstrapAttemptCount(profile: string, planLength: number): number {
  if (planLength <= 0) return 0;
  if (profile === "cheap-swarm") return Math.min(2, planLength);
  return planLength;
}

function expandPlanForTeam(
  basePlan: ResolvedModelCall[],
  teamSpecs: TeamMemberSpec[],
  explicitTeam: boolean,
): ResolvedModelCall[] {
  // Without --team, roster is sized to the full profile plan.
  if (!explicitTeam) return basePlan;
  // Explicit --team lead (or lead,worker,…) must match started root count exactly.
  if (basePlan.length >= teamSpecs.length) return basePlan.slice(0, teamSpecs.length);
  const template = basePlan[0];
  if (!template) throw new Error("attempt plan is empty");
  return teamSpecs.map((_, index) => basePlan[index] ?? template);
}

function liveAttemptReplayPath(
  replayPath: string | undefined,
  cwd: string,
  attemptId: string,
  totalAttempts: number,
): string {
  if (totalAttempts === 1) return replayOutputPath(replayPath, cwd);
  if (!replayPath) return path.join(cwd, "live-run-ledger.json");
  if (replayPath.endsWith(path.sep)) return path.join(replayPath, attemptId, "live-run-ledger.json");
  try {
    if (fs.existsSync(replayPath) && fs.statSync(replayPath).isDirectory()) {
      return path.join(replayPath, attemptId, "live-run-ledger.json");
    }
  } catch {
    /* use file stem */
  }
  const dir = path.dirname(replayPath);
  const ext = path.extname(replayPath) || ".json";
  const base = path.basename(replayPath, ext);
  return path.join(dir, `${base}-${attemptId}${ext}`);
}

function pickPrimaryLiveAttempt(attempts: FinishedLiveHostFsAttempt[]): FinishedLiveHostFsAttempt {
  if (attempts.length === 0) throw new Error("no live attempts finished");
  const lead = attempts.find((row) => row.role === "lead" || row.memberId === "lead" || row.attemptId === "a0");
  if (lead && (lead.ledger.outcome === "solved" || lead.ledger.outcome === "reported")) return lead;
  return attempts.reduce((best, row) => {
    const bestRank = liveAttemptRank(best);
    const rowRank = liveAttemptRank(row);
    if (rowRank !== bestRank) return rowRank > bestRank ? row : best;
    if (row.ledger.toolCalls !== best.ledger.toolCalls) {
      return row.ledger.toolCalls > best.ledger.toolCalls ? row : best;
    }
    // Prefer formal Lead when ranks tie.
    if ((row.role === "lead") !== (best.role === "lead")) return row.role === "lead" ? row : best;
    return row.attemptId < best.attemptId ? row : best;
  });
}

function liveAttemptRank(attempt: FinishedLiveHostFsAttempt): number {
  if (attempt.ledger.outcome === "solved") return 5;
  if (attempt.ledger.outcome === "reported") return 4;
  if (attempt.ledger.outcome === "candidate") return 3;
  if (attempt.ledger.outcome === "stalled") return 2;
  return 1;
}

function contestResultFromLiveAttempt(
  primary: FinishedLiveHostFsAttempt,
  attempts: FinishedLiveHostFsAttempt[],
  challengeId: string,
  targetUrl: string,
  progress?: ContestSolveResult["progress"],
  controlRequest?: SlotResult["controlRequest"],
  platformProgress?: SlotResult["platformProgress"],
  platformVerdictsObserved = false,
): ContestSolveResult {
  const out: ContestSolveResult = {
    targetId: challengeId,
    targetUrl,
    outcome: primary.ledger.outcome,
    wallTimeMs: Math.max(...attempts.map((row) => row.ledger.wallTimeMs)),
    turns: attempts.reduce((sum, row) => sum + row.ledger.turns.length, 0),
    toolCalls: attempts.reduce((sum, row) => sum + row.ledger.toolCalls, 0),
    noToolTurns: attempts.reduce((sum, row) => sum + row.ledger.noToolTurns, 0),
    maxNoToolStreak: Math.max(...attempts.map((row) => row.ledger.maxNoToolStreak)),
    lengthStops: attempts.reduce((sum, row) => sum + row.ledger.lengthStops, 0),
    assistantTextBytes: attempts.reduce((sum, row) => sum + row.ledger.assistantTextBytes, 0),
    maxAssistantTextBytes: Math.max(...attempts.map((row) => row.ledger.maxAssistantTextBytes)),
    promptSkillGestures: uniqueStrings(attempts.flatMap((row) => row.ledger.promptSkillGestures)),
    promptSkillGestureCount: attempts.reduce((sum, row) => sum + row.ledger.promptSkillGestures.length, 0),
    skillCalls: attempts.reduce((sum, row) => sum + row.ledger.skillCalls, 0),
    todoCalls: attempts.reduce((sum, row) => sum + row.ledger.todoCalls, 0),
    lastTodoTurn: primary.ledger.lastTodoTurn,
    turnsSinceTodo: primary.ledger.turnsSinceTodo,
    fingerprintCount: primary.ledger.terminal.candidateCount,
    replayPath: primary.ledgerPath,
    reportPath: candidateReportPaths(primary.ledgerPath).json,
    ...(platformProgress ? { platformProgress } : {}),
  };
  const usage = sumAttemptUsage(attempts);
  if (usage) {
    out.promptTokens = usage.promptTokens;
    out.completionTokens = usage.completionTokens;
    out.totalTokens = usage.totalTokens;
  }
  if (primary.ledger.stopReason) out.stopReason = primary.ledger.stopReason;
  if (controlRequest) out.controlRequest = controlRequest;
  if (primary.ledger.acpStopReason) out.acpStopReason = primary.ledger.acpStopReason;
  if (primary.ledger.dshSessionId) out.dshSessionId = primary.ledger.dshSessionId;
  if (primary.ledger.outcome !== "solved" && primary.ledger.outcome !== "reported") {
    const naturalPlatform = primary.ledger.acceptanceMode === "candidate-report";
    const authoritativePlatform = platformProgress !== undefined;
    const platformCountUnknown = !authoritativePlatform && platformVerdictsObserved;
    const platformProjected = authoritativePlatform || platformCountUnknown;
    out.reason = [
      naturalPlatform
        ? `Worker ended before Commander platform reconciliation (outcome=${primary.ledger.outcome})`
        : `Worker ended without Host acceptance (outcome=${primary.ledger.outcome})`,
      naturalPlatform || platformProjected
        ? undefined
        : `status=${primary.ledger.terminal.status}`,
      authoritativePlatform
        ? `platformProgress=${platformProgress.acceptedCount}/${platformProgress.totalCount}`
        : platformCountUnknown
          ? "platformProgress=unknown"
          : naturalPlatform
            ? undefined
            : `remainingFlags=${primary.ledger.terminal.remainingFlags}`,
      authoritativePlatform
        ? `platformRemaining=${platformProgress.remainingCount}`
        : platformProjected
          ? undefined
          : naturalPlatform
            ? `hostCandidateReports=${primary.ledger.terminal.candidateCount}`
            : `candidateCount=${primary.ledger.terminal.candidateCount}`,
      primary.ledger.stopReason ? `stopReason=${primary.ledger.stopReason}` : undefined,
      primary.ledger.acpStopReason ? `acpStopReason=${primary.ledger.acpStopReason}` : undefined,
    ]
      .filter(Boolean)
      .join("; ");
  }
  const wire = mergeLiveWireSummaries(attempts.map((attempt) => attempt.ledger.wire));
  if (wire) out.wire = wire;
  if (progress) out.progress = progress;
  return out;
}

function contestPlatformResult(
  runtime: ChallengeRuntime,
  challengeId: string,
  targetUrl: string,
  outcome: "solved",
): ContestSolveResult {
  const platformVerdicts = runtime.takePlatformVerdicts(challengeId);
  const platformProgress = platformProgressFromVerdicts(platformVerdicts);
  return {
    targetId: challengeId,
    targetUrl,
    outcome,
    ...(platformProgress ? { platformProgress } : {}),
    ...(platformVerdicts.length ? { platformVerdicts } : {}),
  };
}

function platformProgressFromVerdicts(
  verdicts: readonly ContestSubmitVerdict[],
): SlotResult["platformProgress"] | undefined {
  const count = mergePlatformAcceptanceSnapshots(verdicts);
  if (!count) return undefined;
  return {
    acceptedCount: count.accepted,
    totalCount: count.total,
    remainingCount: count.total - count.accepted,
    completed: verdicts.some((row) => row.completed === true),
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    seen.add(value);
  }
  return [...seen];
}

function sumAttemptUsage(
  attempts: FinishedLiveHostFsAttempt[],
): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let any = false;
  for (const attempt of attempts) {
    const usage = attempt.ledger.usage;
    if (!usage) continue;
    any = true;
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    totalTokens += usage.totalTokens;
  }
  if (!any) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

function contestProgressSummary(progress: ReturnType<ChallengeRuntime["progressFor"]>): ContestSolveResult["progress"] {
  const state = progress.navigation?.state ?? progress.workMemory.state;
  const assetCounts = compactPositiveCounts(progress.assetMemory.counts);
  const explorationCounts = compactPositiveCounts({
    attemptedAxes: progress.explorationMemory.attemptedAxes.length,
    findings: progress.explorationMemory.findings.length,
    openObservations: progress.explorationMemory.openObservations.length,
  });
  const findingStatusCounts = compactPositiveCounts(progress.findingLedger.counts);
  const findingKindCounts = compactPositiveCounts(progress.findingLedger.kindCounts);
  return {
    ...(state ? { state } : {}),
    ...(progress.navigation?.observations.length ? { observations: progress.navigation.observations } : {}),
    focusObjective: progress.focus.objective,
    focusReason: progress.focus.reason,
    ...(progress.candidateEvidence.length
      ? {
          candidateEvidence: progress.candidateEvidence.slice(0, 2).map((row) => ({
            title: row.title,
            ...(row.artifactRef ? { artifactRef: row.artifactRef } : {}),
          })),
        }
      : {}),
    repeatedAxisCount: progress.navigation?.repeatedAxes.length ?? 0,
    testedAxisCount: progress.testedAxes.length,
    candidateEvidenceCount: progress.candidateEvidence.length,
    artifactCount: progress.artifacts.length,
    offTargetProbeCount: progress.offTargetProbes.length,
    hostFileProbeCount: progress.hostFileProbes.length,
    workMemoryState: progress.workMemory.state,
    workMemoryNextCheckCount: progress.workMemory.nextChecks.length,
    workMemoryEvidenceCount: progress.workMemory.evidence.length,
    workMemoryHypothesisCount: progress.workMemory.activeHypotheses.length,
    ...(progress.workMemory.nextChecks.length
      ? {
          workMemoryNextChecks: progress.workMemory.nextChecks.slice(0, 3).map((row) => {
            const expected = row.expectedObservation ? ` expect=${row.expectedObservation}` : "";
            return `${row.objective}${expected}`;
          }),
        }
      : {}),
    ...(progress.workMemory.evidence.length ? { workMemoryEvidence: progress.workMemory.evidence.slice(0, 3) } : {}),
    ...(progress.workMemory.activeHypotheses.length
      ? { workMemoryHypotheses: progress.workMemory.activeHypotheses.slice(0, 2) }
      : {}),
    ...(Object.keys(assetCounts).length > 0 ? { assetCounts } : {}),
    ...(Object.keys(explorationCounts).length > 0 ? { explorationCounts } : {}),
    ...(Object.keys(findingStatusCounts).length > 0 ? { findingStatusCounts } : {}),
    ...(Object.keys(findingKindCounts).length > 0 ? { findingKindCounts } : {}),
  };
}

function compactPositiveCounts(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) {
    if (Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

main().catch((err) => {
  updateDetachedMissionProcessStatus("failed");
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
