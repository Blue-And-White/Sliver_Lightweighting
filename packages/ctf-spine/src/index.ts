export {
  CTF_SOLVER_PERSONA,
  CTF_SOLVER_PERSONA_COMPACT,
  CTF_SOLVER_HINT_RULE,
  CTF_SOLVER_SKILL_RULE,
  CTF_SOLVER_WORK_CYCLE,
  CTF_FORMAL_TEAM_PERSONA,
  OFFICIAL_TEAM_WORKER_ROLE_CONTRACT,
  COMMANDER_GENERIC_DISCOVERY_RULE,
  commanderPersonaWithDiscovery,
  ctfSolverPersona,
  assembleRoomPersona,
  SOCIAL_SWARM_PERSONA,
  AWD_DOMAIN_PERSONA,
  AWD_LEAD_PERSONA,
  AWD_CONTEST_STRATEGY,
  CONTEST_OFFENSE_IDENTITY,
  PENTEST_DOMAIN_PERSONA,
  PENTEST_LEAD_PERSONA,
  KOH_DOMAIN_PERSONA,
  KOH_LEAD_PERSONA,
  VULN_DOMAIN_PERSONA,
  VULN_LEAD_PERSONA,
  REPORT_DOMAIN_PERSONA,
  isRoomDomain,
  type RoomDomain,
  DSH_SOLVER_PERSONA,
  CTF_INTERNAL_PERSONA,
  SKEPTIC_PERSONA,
  DSH_SKEPTIC_PERSONA,
} from "./persona.ts";
export {
  ROLE_PROMPT_MODES,
  isRolePromptMode,
  loadCommanderRolePrompt,
  loadRoomSharedPrompt,
  loadLeadRolePrompt,
  loadWorkerRolePrompt,
  loadBreadthReconRolePrompt,
  loadWholeRacerRolePrompt,
  loadRoundAuditorRolePrompt,
  loadRotatingWorkerRolePrompt,
  loadRolePrompt,
  loadRoomRolePrompts,
  type RolePromptMode,
  type StaticRole,
} from "./role-prompts.ts";
export {
  tools,
  getTool,
  toolsVisible,
  llmToolSpecs,
  SILVER_ROOM_CORE_TOOLS,
  SILVER_CONVERGENCE_REVIEWER_TOOLS,
  SILVER_ROOM_SWARM_LEAD_TOOLS,
  SILVER_SWARM_ROOM_TOOLS,
  SILVER_PUBLIC_INTEL_TOOLS,
  SILVER_ROOM_GRAPH_TOOLS,
  SILVER_ASSISTANT_DENY_TOOLS,
  SILVER_COMMANDER_TOOLS,
  COMMANDER_GENERIC_DISCOVERY_TOOLS,
  COMMANDER_TOOL_ALLOWLIST,
  SILVER_HTTP_LEAVES,
  SILVER_FS_LEAVES,
  SILVER_GENERIC_LEAVES,
  SILVER_IAT_LEAVES,
  iatLeavesEnabled,
  hintLeavesEnabled,
  swarmRoomToolsEnabled,
  roomSwarmLeadToolsEnabled,
  convergenceReviewerToolsEnabled,
  roomGraphToolsEnabled,
  requireRoomAssembly,
  type RoomAssembly,
  type RoomAcceptanceContract,
} from "./tools.ts";
export {
  COMMANDER_DISCOVERY_PATH_REFUSED,
  refuseCommanderDiscoveryPath,
} from "./commander-discovery.ts";
export { TOOL_SCHEMAS } from "./tool-schemas.ts";
export type { HostBridge, Presentation, ToolPreset, ToolContext, ToolDefinition, ToolResult, SessionEvent, JsonSchema } from "./types.ts";
export { AttemptNotebook, notebookRead, notebookWrite, type NotebookEntry } from "./notebook.ts";
export { boundUnderRoot } from "./artifacts.ts";
export { redactToolArgs, redactToolData, redactSecretsInText, logToolCall, logToolResult, logToolExchange } from "./tool-log.ts";
export { HTTP_PREVIEW_BYTES } from "./http.ts";
export { redactPayloadPreview, PAYLOAD_PREVIEW_BYTES } from "./redact.ts";
export { CookieJar } from "./cookie-jar.ts";
export { TerminalHub } from "./terminal.ts";
export {
  bindChallengeContext,
  clearChallengeContext,
  name,
  inject,
  apply,
  hostFromEnv,
  rpcHost,
  mockEnvHost,
  appendChallengeMaterialsPrompt,
  officialTeamNoticeText,
  quietRoomNoticeText,
  commitQuietLeadDelivery,
  takeQuietLeadNotice,
  officialTeamNoticeReachesMember,
  installOperatorRoomMessageBridge,
  installDirectSessionNoticeBridge,
} from "./plugin.ts";
export { rejectedVerdictText } from "./exploration-ledger.ts";
export {
  DIRECT_SESSION_NOTICE_DIR_ENV,
  OPERATOR_ROOM_MESSAGE_MAX_BYTES,
  OPERATOR_ROOM_MESSAGE_REQUEST_SCHEMA,
  OPERATOR_ROOM_MESSAGE_RESULT_SCHEMA,
  OPERATOR_ROOM_MESSAGE_TTL_MS,
  consumeOperatorRoomMessage,
  deliverOperatorRoomMessage,
  deliverOperatorRoomMessageToTeam,
  readOperatorRoomMessageResult,
  withdrawOperatorRoomMessage,
  writeExpiredOperatorRoomMessageResult,
  writeOperatorRoomMessage,
  type OperatorRoomMessageRequest,
  type OperatorRoomMessageResult,
} from "./operator-room-message.ts";
export { readOperatorRoomLive, type OperatorRoomLiveState } from "./operator-room-live.ts";
export {
  HOST_CHANNEL_FD_ENV,
  captureModelUnreadableHostChannel,
  hostChannel,
  resetHostChannelForTests,
} from "./host-channel.ts";
export {
  currentNativeSessionRpc,
  isOfficialTeamHostTool,
  nativeSessionRpcMeta,
  readNativeSessionIdentity,
  runWithNativeSession,
  type NativeSessionIdentity,
} from "./native-session.ts";
export {
  collectLiveToolPaths,
  isHistoricalSilverPath,
  LIVE_FILE_TOOLS,
  LIVE_HISTORY_PATH_REFUSED,
  liveHistoryPathPolicyFromEnv,
  refuseLiveHistoryPath,
  type LiveHistoryPathPolicy,
} from "./live-history-path-guard.ts";
export {
  QUIET_ROOM_WAKE_FILE,
  armQuietRoomWakeHandoff,
  dropUndeliveredQuietWake,
  markQuietRoomWakeDelivered,
  persistedStallEventId,
  quietRoomWakePath,
  quietStallSupersededByProgress,
  readQuietRoomWake,
  readQuietRoomWakeEventId,
  restorePersistedStallWake,
  stallLeaseFilePath,
  writeQuietRoomWakeFile,
  type QuietRoomWake,
} from "./quiet-room-wake.ts";
export {
  OFFICIAL_TEAM_REJECTED_FINGERPRINTS_SCHEMA,
  officialTeamRejectedFingerprintsPath,
  readOfficialTeamRejectedFingerprints,
  writeOfficialTeamRejectedFingerprints,
} from "./official-team-rejected.ts";
