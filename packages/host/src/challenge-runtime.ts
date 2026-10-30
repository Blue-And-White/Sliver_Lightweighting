import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChallengeBundle } from "./challenge-bundle.ts";
import { taskMaterialForHintAvailability, taskMaterialFromPlatform } from "./task-material.ts";
import {
  AttemptNotebook,
  writeOfficialTeamRejectedFingerprints,
  type HostBridge,
  type Presentation,
  type RoomAcceptanceContract,
  type RoomDomain,
  type ToolPreset,
} from "@silver/ctf-spine";
import { callTool, createSpine, disposeSpine, type SpineRun } from "../../ctf-spine/src/direct.ts";
import type { Ledger } from "@silver/ledger";
import { artifactInAttemptRoot, artifactRefEscapeGuidance, verifyCandidate } from "@silver/oracle";
import type { MockPlatform } from "@silver/platform-mock";
import {
  bindFingerprint,
  compileFlagPolicy,
  flagPatternOrAny,
  fingerprintCandidate,
  AWD_ROLES,
  isAwdMoveKind,
  isAwdRole,
  isDirtyKind,
  isImplantDurability,
  type Autonomy,
  type AwdMoveKind,
  type AwdRole,
  type CandidateRef,
  type CandidateSubmitInput,
  type DirtyKind,
  type AcceptanceMode,
  type HintPolicy,
  type HostRpcMethod,
  type HostRpcRequest,
  type HostRpcResponse,
  officialSessionProofMatches,
  type NativeSessionRpcMeta,
  type OperatorDecision,
  type RpcScope,
  type TrackKind,
} from "@silver/protocol";
import { CapabilityGate, randomCapabilitySecret } from "./capability.ts";
import { aggregateCandidateRecords } from "./candidate-records.ts";
import {
  DEFAULT_COORDINATOR,
  type ChallengePolicyName,
  type CoordinatorConfig,
} from "./lazy-spawn.ts";
import { IntelPool, poolPath, type IntelViewItem } from "./intel-pool.ts";
import {
  PublicIntelStore,
  type PublicIntelComment,
  type PublicIntelEvidenceRef,
  type PublicIntelLink,
  type PublicIntelRecord,
  type PublicIntelTag,
  type IntelPolarity,
} from "./intel-v2.ts";
import { FindingStore } from "./finding-v1.ts";
import { mergeAuthoredFindingsIntoLedger } from "./finding-ledger.ts";
import { ProjectRoomStore, type RoomFeedDelivery } from "./project-room.ts";
import { critique, type SkepticReport } from "./skeptic.ts";
import { runJailedChecker } from "./jailed-checker.ts";
import { SubmitBroker } from "./submit-broker.ts";
import type { ContestSubmitVerdict } from "./contest-platform.ts";
import { HostFsSandbox, type ChallengeSandbox } from "./challenge-sandbox.ts";
import { deriveProgressSnapshot } from "./progress.ts";
import { promoteGate } from "./promote-gate.ts";
import { OperatorInbox, type AwdImplantSpec, type OperatorMoveView } from "./operator-inbox.ts";
import { readRoomMembers, roomMembersPath, type RoomMemberRole } from "./room-members.ts";
import { readRoomClock, roomClockPath } from "./room-clock.ts";
import {
  buildRoomProjection,
  foldRoomProjectionFacts,
  mapProjectRuntimeStatusToPlatform,
  roomProjectionChallengeInfo,
  shortCandidateFingerprint,
  type RoomPlatformStatus,
  type RoomProjection,
  type RoomProjectionChangeSection,
  type RoomProjectionFact,
} from "./room-projection.ts";
import { noteRoomConvergenceTrigger } from "./room-convergence.ts";
import { applyAwdServiceRoom } from "./awd-service-room.ts";
import { assertRoomAcceptsActivity, isRoomPlatformStopPresent } from "./room-platform-stop-state.ts";
import type { ConvergenceTriggerKind } from "./convergence-generation.ts";
import { isStallProgress, type StallProgressKind } from "./stall-lease.ts";
import {
  acceptanceProgressFromReviews,
  authoritativePlatformCount,
  platformRoomCompleted,
  readLocalRemainingSlots,
  type AcceptanceProgress,
} from "./acceptance-progress.ts";
import {
  admitNativeSessionMember,
  readNativeSessionBinding,
  rosterMemberIsLead,
  stripModelIdentity,
  type NativeSessionMember,
  type OfficialTeamRpcGate,
} from "./team-member-identity.ts";
import {
  bindOfficialTeamRecruitPermit,
  officialTeamRecruitBlockReason,
  readOfficialTeamPermits,
} from "./official-team-c3.ts";

export type { ChallengePolicyName, CoordinatorConfig };

/**
 * C1 Room Projection surface for every Room (solo / parallel / groups / team).
 * Does not change the Intel reader principal.
 */
export type RoomProjectionBinding = {
  roomClockDir: string;
  roomId: string;
  memberIdForAttempt: (attemptId: string) => string | undefined;
  membersSnapshot: () => Array<{
    memberId: string;
    role: RoomMemberRole;
    duty: string;
    status: string;
    /** Runtime binding only — product key remains memberId. */
    attemptId?: string;
    dshSessionId?: string;
    updatedAt?: string;
  }>;
  /** Read-only Room / ProjectRuntime platform facts — not a new state machine. */
  platformSnapshot?: () => {
    status: RoomPlatformStatus | string;
    reason?: string;
  };
};

/**
 * Formal team Member binding for Intel member principals and notices.
 * Only set when SILVER_ROOM_MEMBERS / --team is active. Independent Groups keep
 * Intel principal kind=group via the absence of this binding.
 */
export type RoomMemberHostBinding = {
  roomClockDir: string;
  roomId: string;
  memberIdForAttempt: (attemptId: string) => string | undefined;
  roleForAttempt: (attemptId: string) => RoomMemberRole | undefined;
  dutyForAttempt: (attemptId: string) => string | undefined;
  membersSnapshot: () => Array<{
    memberId: string;
    role: RoomMemberRole;
    duty: string;
    status: string;
    /** Runtime binding only — product key remains memberId. */
    attemptId?: string;
    dshSessionId?: string;
    updatedAt?: string;
  }>;
  /** Optional Host wake when public intel a member previously read was revised/retracted. */
  onIntelChange?: (event: {
    challengeId: string;
    intelId: string;
    memberIds: string[];
    notices: Array<{
      intelId: string;
      previousVersion: number;
      currentVersion: number;
      status: string;
      kind: string;
    }>;
  }) => void;
};

export type MissionCommanderHostBinding = {
  invoke: (
    method:
      | "contest_list"
      | "contest_start"
      | "queue_target"
      | "mission_status"
      | "review_room_allocation"
      | "record_target_result"
      | "resolve_room_request"
      | "mission_done",
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

/** Room-scoped dual graph. The binding stores Agent-authored semantics only. */
export type RoomGraphHostBinding = {
  invoke: (
    method: "graph_overview" | "graph_query" | "intel_record" | "exploration_update",
    payload: Record<string, unknown>,
    actor: { attemptId: string; memberId?: string },
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
};

/** Room delivery callbacks plus the legacy convergence ledger for non-formal rooms. */
export type RoomConvergenceBinding = {
  roomClockDir: string;
  roomId: string;
  /** Legacy non-formal stall lease only. Feed/status must not call this. */
  onStallProgress?: (kind: StallProgressKind) => void;
  /** After Host notes a legacy convergence trigger. */
  onTriggerNoted?: (info: {
    kind: ConvergenceTriggerKind;
    outcome: "merged" | "minted" | "ignored_duplicate" | "queued_for_next";
  }) => void;
  /**
   * Official Team only. Intel/platform-verdict delivery.
   * Not a C2 generation. Status must not call this.
   * Native teammates are delivered by the official team mailbox.
   */
  onSocialNotice?: (notice: RoomSocialNotice) => void;
};

export type RoomSocialNotice = {
  kind: "platform_verdict" | "intel";
  /** Skip the author. Host verdicts omit this. */
  exceptMemberId?: string;
  /**
   * Cold recovery: unread projection is still there and no live tool caller
   * can send the mailbox message. Lead's wake prompt relays send_message once.
   * Not a durable receipt.
   */
  relay?: boolean;
};

type OfficialIntelNoticeChange = {
  intelId: string;
  version: number;
  previousVersion: number;
  changeType: "published" | "revised" | "retracted" | "commented" | "challenged";
  status: "active" | "challenged" | "retracted";
  observationExcerpt: string;
  conditionsExcerpt?: string;
  memberAuthoredLinkCount: number;
  commentExcerpt?: string;
  commentAboutVersion?: number;
};

type OfficialIntelTeamNotice = {
  kind: "intel";
  pendingMemberIds: string[];
  change: OfficialIntelNoticeChange;
};

const INTEL_NOTICE_EXCERPT_CHARS = 240;

function intelNoticeExcerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= INTEL_NOTICE_EXCERPT_CHARS) return compact;
  const tailLength = 72;
  return `${compact.slice(0, INTEL_NOTICE_EXCERPT_CHARS - tailLength - 1)}…${compact.slice(-tailLength)}`;
}

function officialIntelNoticeChange(
  record: PublicIntelRecord,
  changeType: OfficialIntelNoticeChange["changeType"],
  comment?: PublicIntelComment,
): OfficialIntelNoticeChange {
  const current = record.versions.find((row) => row.version === record.currentVersion)!;
  return {
    intelId: record.intelId,
    version: record.currentVersion,
    previousVersion:
      changeType === "published"
        ? 0
        : changeType === "commented" || changeType === "challenged"
          ? record.currentVersion
          : Math.max(0, record.currentVersion - 1),
    changeType,
    status: record.status,
    observationExcerpt: intelNoticeExcerpt(current.observation),
    ...(current.conditions
      ? { conditionsExcerpt: intelNoticeExcerpt(current.conditions) }
      : {}),
    memberAuthoredLinkCount: current.links?.length ?? 0,
    ...(comment
      ? {
          commentExcerpt: intelNoticeExcerpt(comment.body),
          commentAboutVersion: comment.aboutVersion,
        }
      : {}),
  };
}

export interface ChallengeSpec {
  missionId: string;
  challengeId: string;
  flagCount: number;
  autonomy: Autonomy;
  targetUrl: string;
  /** Platform materials. targetUrl stays the primary endpoint. */
  challengeBundle?: ChallengeBundle;
  workspace: string;
  checkerArgv?: string[];
  penalty?: "low" | "high";
  track?: TrackKind;
  /** Commander domain for this room. Omitted jeopardy stays CTF. */
  acceptanceKind?: RoomDomain;
  /** Pure-data acceptance contract selected by the upstream room assembly. */
  acceptanceContract?: RoomAcceptanceContract;
  flagPattern?: string;
  inScopeUrls?: string[];
  inScopeAgentUrls?: string[];
  hintPolicy?: HintPolicy;
  acceptanceMode?: AcceptanceMode;
  availableSkills?: ChallengeAvailableSkill[];
  previousRoot?: ChallengePreviousRoot;
  /** Mount the dual graph instead of the legacy public Intel surface. */
  roomGraph?: boolean;
  /** Durable Room Feed/Status channel used by Official Teams and legacy Room overlays. */
  swarmRoom?: {
    initialMembers: number;
    maxMembers: number;
    feedDelivery: RoomFeedDelivery;
    /** Ordinary Feed discussion; control records and Status remain available when false. */
    chatEnabled?: boolean;
  };
}

export interface ChallengeAvailableSkill {
  name: string;
  description: string;
}

export interface ChallengePreviousRoot {
  stopReason: string;
  diagnostics?: string[];
}

export interface AttemptVariant {
  presentation: Presentation;
  model: string;
  effort: string;
  seed: string;
  provider?: string;
  baseUrl?: string;
  apiKeyRef?: string;
  profile?: string;
  role?: AwdRole;
}

export interface AttemptSlice {
  presentation?: Presentation;
  model?: string;
  effort?: string;
  seed?: string;
  provider?: string;
  baseUrl?: string;
  apiKeyRef?: string;
  profile?: string;
  role?: AwdRole;
}

export interface AttemptSpec extends AttemptSlice {
  attemptId: string;
  containerId: string;
  generation?: number;
  toolsPreset?: ToolPreset;
}

export type ContestSubmitHook = (input: {
  challengeId: string;
  fingerprint: string;
  raw: string;
}) => Promise<ContestSubmitVerdict>;

export type ContestVerifyHook = (input: {
  challengeId: string;
  raw: string;
}) => Promise<Record<string, unknown>>;

export type ContestHintHook = (input: {
  challengeId: string;
}) => Promise<{ ok: true; hint: string; remaining?: number } | { ok: false; error: string }>;

export type ContestRestartHook = (input: {
  challengeId: string;
  attemptId?: string;
}) => Promise<Record<string, unknown>>;

export type PlatformReviewStatus = "pending" | "accepted" | "rejected" | "duplicate" | "unknown";

/** Mechanical platform fact after a reject. */
export const CONTEST_REJECTED_GUIDANCE =
  "platform rejected this exact candidate value; Host records the verdict but does not decide whether the room may submit it again";

export function contestRejectedGuidance(fingerprint: string): string {
  return `${CONTEST_REJECTED_GUIDANCE} (rejected ${shortCandidateFingerprint(fingerprint)})`;
}

export type PlatformReviewRecord = {
  fingerprint: string;
  status: PlatformReviewStatus;
  reviewedAt: string;
  submittedByMemberId?: string;
  candidateId?: string;
  artifactRef?: string;
  awarded?: number;
  correctFlagCount?: number;
  totalFlagCount?: number;
  platformCompleted?: boolean;
  platformCorrect?: boolean;
  httpStatus?: number;
  priorStatus?: PlatformReviewStatus;
  attemptId?: string;
};

function isRelayablePlatformVerdict(review: PlatformReviewRecord): boolean {
  return review.status !== "pending";
}

export type ChallengeStartOptions = Partial<CoordinatorConfig> & {
  attemptSlices?: AttemptSlice[];
  toolsPreset?: ToolPreset;
};

interface LiveAttempt {
  spec: ChallengeSpec;
  attemptId: string;
  containerId: string;
  generation: number;
  capability: string;
  spine: SpineRun;
  workspace: string;
  tmpDir: string;
  variant: AttemptVariant;
  idleCycles: number;
  toolsPreset: ToolPreset;
}

function roomDeferUnavailablePath(roomClockDir: string): string {
  return path.join(roomClockDir, "room-defer-unavailable.json");
}

function roomTaskCompletePath(roomClockDir: string): string {
  return path.join(roomClockDir, "room-task-complete.json");
}

export function writeRoomDeferUnavailable(roomClockDir: string, challengeId: string, text: string): void {
  const clock = readRoomClock(roomClockPath(roomClockDir, challengeId));
  if (!clock) return;
  const file = roomDeferUnavailablePath(roomClockDir);
  if (fs.existsSync(file)) {
    try {
      const previous = JSON.parse(fs.readFileSync(file, "utf8")) as { clockStartedAt?: unknown };
      if (previous.clockStartedAt === clock.startedAt) return;
    } catch {
      // Replace malformed or stale Host-owned control state.
    }
  }
  fs.mkdirSync(roomClockDir, { recursive: true });
  const body = {
    schema: "silver.room-defer-unavailable.v2",
    clockStartedAt: clock.startedAt,
    at: new Date().toISOString(),
    text: text.slice(0, 280),
  };
  fs.writeFileSync(file, `${JSON.stringify(body)}\n`);
}

export function readRoomDeferUnavailable(roomClockDir: string, challengeId: string): string | undefined {
  const file = roomDeferUnavailablePath(roomClockDir);
  if (!fs.existsSync(file)) return undefined;
  const clock = readRoomClock(roomClockPath(roomClockDir, challengeId));
  let clockStartedAt: unknown;
  let text: unknown;
  try {
    const row = JSON.parse(fs.readFileSync(file, "utf8")) as { clockStartedAt?: unknown; text?: unknown };
    clockStartedAt = row.clockStartedAt;
    text = row.text;
  } catch {
    clockStartedAt = undefined;
  }
  if (!clock || clockStartedAt !== clock.startedAt) return undefined;
  return typeof text === "string" ? text : "";
}

export function clearRoomDeferUnavailable(roomClockDir: string): void {
  fs.rmSync(roomDeferUnavailablePath(roomClockDir), { force: true });
}

export function consumeRoomDeferUnavailable(roomClockDir: string, challengeId: string): string | undefined {
  const text = readRoomDeferUnavailable(roomClockDir, challengeId);
  clearRoomDeferUnavailable(roomClockDir);
  return text;
}

export function writeRoomTaskComplete(roomClockDir: string, challengeId: string, text: string): void {
  const clock = readRoomClock(roomClockPath(roomClockDir, challengeId));
  if (!clock) return;
  fs.mkdirSync(roomClockDir, { recursive: true });
  fs.writeFileSync(
    roomTaskCompletePath(roomClockDir),
    `${JSON.stringify({
      schema: "silver.room-task-complete.v1",
      clockStartedAt: clock.startedAt,
      at: new Date().toISOString(),
      text: text.slice(0, 280),
    })}\n`,
  );
}

export function consumeRoomTaskComplete(roomClockDir: string, challengeId: string): string | undefined {
  const file = roomTaskCompletePath(roomClockDir);
  if (!fs.existsSync(file)) return undefined;
  const clock = readRoomClock(roomClockPath(roomClockDir, challengeId));
  let row: { clockStartedAt?: unknown; text?: unknown } = {};
  try {
    row = JSON.parse(fs.readFileSync(file, "utf8")) as typeof row;
  } catch {
    // Malformed control state is consumed and ignored.
  }
  fs.rmSync(file, { force: true });
  if (!clock || row.clockStartedAt !== clock.startedAt || typeof row.text !== "string") return undefined;
  return row.text;
}

export class ChallengeRuntime {
  private readonly ledger: Ledger;
  private readonly platform: MockPlatform;
  private readonly gate: CapabilityGate;
  private readonly broker: SubmitBroker;
  private readonly live = new Map<string, LiveAttempt>();
  private readonly pendingSpecs = new Map<string, ChallengeSpec>();
  private readonly coords = new Map<string, CoordinatorConfig>();
  private readonly pools = new Map<string, IntelPool>();
  private readonly publicIntel = new Map<string, PublicIntelStore>();
  private readonly projectRooms = new Map<string, ProjectRoomStore>();
  private readonly findingStores = new Map<string, FindingStore>();
  private readonly attemptSlices = new Map<string, AttemptSlice[]>();
  private readonly sandbox: ChallengeSandbox;
  private readonly cellIds = new Map<string, string>();
  private readonly operators = new OperatorInbox();
  private readonly attemptVariants = new Map<string, AttemptVariant>();
  private readonly toolPresets = new Map<string, ToolPreset>();
  private readonly passedRaw = new Map<string, Map<string, string>>();
  private readonly submittedFingerprints = new Map<string, Set<string>>();
  private readonly platformVerdicts = new Map<string, ContestSubmitVerdict[]>();
  private readonly platformReviews = new Map<string, PlatformReviewRecord[]>();
  private readonly roomDeadlineHandlers = new Map<
    string,
    (deadlineAtMs: number) => Record<string, unknown>
  >();
  private readonly roomMemberBindings = new Map<string, RoomMemberHostBinding>();
  private readonly officialTeamGates = new Map<string, OfficialTeamRpcGate>();
  private readonly candidateReportedHandlers = new Map<
    string,
    (event: { fingerprint: string; status: "reported" | "duplicate" }) => void | Promise<void>
  >();
  private readonly teamAdmitTail = new Map<string, Promise<void>>();
  private readonly roomConvergenceBindings = new Map<string, RoomConvergenceBinding>();
  /** Projection-only binding for every Room — does not alter Intel principal. */
  private readonly roomProjectionBindings = new Map<string, RoomProjectionBinding>();
  /** Last delivered Room Projection version + section digests per challenge (change index only). */
  private readonly roomProjectionPriors = new Map<
    string,
    { version: string; sectionDigests: Partial<Record<RoomProjectionChangeSection, string>> }
  >();
  private readonly missionCommanderBindings = new Map<string, MissionCommanderHostBinding>();
  private readonly roomGraphBindings = new Map<string, RoomGraphHostBinding>();
  private readonly contestSubmit: ContestSubmitHook | undefined;
  private readonly contestHint: ContestHintHook | undefined;
  private readonly localCandidateTools: boolean;
  private readonly contestVerify: ContestVerifyHook | undefined;
  private readonly contestRestart: ContestRestartHook | undefined;
  /** Test seam. Runs after the verdict is durable and before derived projection. */
  private contestDerivedFault: (() => void) | undefined;
  /** Full immutable task material is delivered once per live reader; later reads keep the file reference. */
  private readonly taskMaterialDelivered = new Set<string>();
  private unsupportedClaims = 0;

  constructor(
    ledger: Ledger,
    platform: MockPlatform,
    hmacSecret = randomCapabilitySecret(),
    sandbox: ChallengeSandbox = new HostFsSandbox(),
    contestSubmit?: ContestSubmitHook,
    contestHint?: ContestHintHook,
    localCandidateTools = false,
    contestVerify?: ContestVerifyHook,
    contestRestart?: ContestRestartHook,
  ) {
    this.ledger = ledger;
    this.platform = platform;
    this.gate = new CapabilityGate(hmacSecret);
    this.broker = new SubmitBroker(ledger, platform);
    this.sandbox = sandbox;
    this.contestSubmit = contestSubmit;
    this.contestHint = contestHint;
    this.localCandidateTools = localCandidateTools;
    this.contestVerify = contestVerify;
    this.contestRestart = contestRestart;
  }

  private hintAvailable(spec: ChallengeSpec): boolean {
    const adapterAvailable = Boolean(this.contestHint) || typeof this.platform.requestHint === "function";
    return acceptanceKindOf(spec) === "ctf" && spec.hintPolicy === "open" && adapterAvailable;
  }

  startChallenge(
    spec: ChallengeSpec,
    coord?: ChallengeStartOptions,
    options?: { resumeExisting?: boolean },
  ): void {
    const attached = this.sandbox.attach(spec);
    if (attached.containerId) this.cellIds.set(spec.challengeId, attached.containerId);
    this.pools.set(spec.challengeId, new IntelPool(poolPath(spec.workspace)));
    this.publicIntel.set(spec.challengeId, new PublicIntelStore(spec.workspace));
    if (spec.swarmRoom) {
      this.projectRooms.set(spec.challengeId, new ProjectRoomStore(spec.workspace, spec.challengeId));
    }
    this.findingStores.set(spec.challengeId, new FindingStore(spec.workspace));
    if (options?.resumeExisting) this.ledger.resumeChallenge(spec.challengeId, spec.missionId, spec.flagCount);
    else this.ledger.createChallenge(spec.challengeId, spec.missionId, spec.flagCount);
    this.bindSpec(spec);
    if (options?.resumeExisting) {
      this.hydrateContestSubmitState(spec.challengeId);
      this.settleAuthoritativePlatformCompletion(spec.challengeId);
    }
    const policy: ChallengePolicyName = coord?.policy ?? "single-fast";
    const defaults = DEFAULT_COORDINATOR[policy];
    this.coords.set(spec.challengeId, {
      policy,
      maxAttempts: Math.max(1, coord?.maxAttempts ?? defaults.maxAttempts),
      idleCyclesBeforeSpawn: Math.max(1, coord?.idleCyclesBeforeSpawn ?? defaults.idleCyclesBeforeSpawn),
    });
    if (coord?.attemptSlices) this.attemptSlices.set(spec.challengeId, coord.attemptSlices);
    this.toolPresets.set(spec.challengeId, coord?.toolsPreset ?? "solver");
  }

  bootstrapAttempts(challengeId: string, input: { containerId: string }): string[] {
    const coord = this.coord(challengeId);
    const n = coord.policy === "cheap-swarm" ? Math.min(2, coord.maxAttempts) : 1;
    const ids: string[] = [];
    const slices = this.attemptSlices.get(challengeId) ?? [];
    const containerId = this.cellIds.get(challengeId) ?? input.containerId;
    for (let i = 0; i < n; i += 1) {
      const attemptId = this.allocateAttemptId();
      this.startAttempt(
        challengeId,
        withSlice(
          {
            attemptId,
            containerId,
            generation: i + 1,
            presentation: i % 2 === 0 ? "native" : "code",
            seed: String(i),
            effort: i === 0 ? "low" : "high",
          },
          slices[i],
        ),
      );
      ids.push(attemptId);
    }
    return ids;
  }

  startAttempt(
    challengeId: string,
    attempt: AttemptSpec,
    options?: { resumeExisting?: boolean; capabilityTtlMs?: number },
  ): { capability: string; attemptId: string } {
    const spec = this.requireChallengeSpec(challengeId);
    const remaining = this.ledger.challenge(challengeId).remaining_flags;
    if (remaining <= 0) throw new Error(`challenge ${challengeId} has no remaining flags`);
    const generation = attempt.generation ?? this.liveFor(challengeId).length + 1;
    const variant: AttemptVariant = {
      presentation: attempt.presentation ?? (generation % 2 === 0 ? "code" : "native"),
      model: attempt.model ?? "default",
      effort: attempt.effort ?? "low",
      seed: attempt.seed ?? String(generation - 1),
    };
    if (attempt.provider) variant.provider = attempt.provider;
    if (attempt.baseUrl) variant.baseUrl = attempt.baseUrl;
    if (attempt.apiKeyRef) variant.apiKeyRef = attempt.apiKeyRef;
    if (attempt.profile) variant.profile = attempt.profile;
    if (attempt.role && isAwdRole(attempt.role)) variant.role = attempt.role;
    else if (spec.track === "awd" || spec.track === "agent-awd") variant.role = "attacker";
    const toolsPreset = attempt.toolsPreset ?? this.toolPresets.get(challengeId) ?? "solver";
    const scopes = scopesForPreset(toolsPreset, spec.track, {
      swarmRoom: Boolean(spec.swarmRoom),
      acceptanceKind: acceptanceKindOf(spec),
      contestSubmit: Boolean(this.contestSubmit) || this.localCandidateTools,
      contestVerify: Boolean(this.contestVerify) || this.localCandidateTools,
      contestRestart: Boolean(this.contestRestart),
      hint: this.hintAvailable(spec),
      roomGraph: spec.roomGraph === true,
    });
    const capabilityTtlMs = options?.capabilityTtlMs ?? 60 * 60 * 1000;
    if (!Number.isFinite(capabilityTtlMs) || capabilityTtlMs <= 0) {
      throw new Error("capabilityTtlMs must be positive");
    }
    const capability = this.gate.mint({
      challengeId,
      containerId: attempt.containerId,
      attemptId: attempt.attemptId,
      generation,
      exp: Date.now() + Math.floor(capabilityTtlMs),
      scopes,
    });
    const cwd = path.join(spec.workspace, "attempts", attempt.attemptId);
    const tmpDir = path.join(cwd, ".tmp");
    fs.mkdirSync(path.join(cwd, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "scratch"), { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const host = this.scopedHost(challengeId, attempt.containerId, attempt.attemptId, generation, capability);
    const spine = createSpine({
      cwd,
      sessionFile: path.join(cwd, "session.jsonl"),
      challengeId,
      attemptId: attempt.attemptId,
      host,
      presentation: variant.presentation,
      flagPolicy: compileFlagPolicy(flagPatternOrAny(spec.flagPattern)),
      track: spec.track ?? "jeopardy",
      toolsPreset,
      targetUrl: spec.targetUrl,
      ...(spec.inScopeUrls ? { inScopeUrls: spec.inScopeUrls } : {}),
      ...(spec.inScopeAgentUrls ? { inScopeAgentUrls: spec.inScopeAgentUrls } : {}),
    });
    if (options?.resumeExisting) {
      this.ledger.resumeAttempt(attempt.attemptId, challengeId, generation, attempt.containerId);
    } else {
      this.ledger.createAttempt(attempt.attemptId, challengeId, generation, attempt.containerId);
    }
    this.live.set(attempt.attemptId, {
      spec,
      attemptId: attempt.attemptId,
      containerId: attempt.containerId,
      generation,
      capability,
      spine,
      workspace: cwd,
      tmpDir,
      variant,
      idleCycles: 0,
      toolsPreset,
    });
    this.attemptVariants.set(attempt.attemptId, variant);
    return { capability, attemptId: attempt.attemptId };
  }

  async runFixtureWebSolve(attemptId: string): Promise<Record<string, unknown>[]> {
    const live = this.live.get(attemptId);
    if (!live) throw new Error(`attempt ${attemptId} is not live`);
    await this.callSolverTool(attemptId, "room_info", {});
    const page = await this.callSolverTool(attemptId, "http_request", {
      url: live.spec.targetUrl,
      method: "GET",
    });
    const hits = await this.callSolverTool(attemptId, "grep_artifacts", { pattern: "flag{" });
    const flags = [
      ...new Set(
        (hits.matches as Array<{ text: string }>)
          .flatMap((row) => [...String(row.text).matchAll(/flag\{[^}]+\}/g)].map((m) => m[0])),
      ),
    ];
    if (flags.length === 0) throw new Error("fixture runner found no flag in artifact — target is dry");
    const outcomes: Record<string, unknown>[] = [];
    for (const [index, raw] of flags.entries()) {
      const candidate: CandidateRef = {
        candidateId: `C${String(index + 1).padStart(3, "0")}`,
        fingerprint: fingerprintCandidate(raw),
        artifactRef: String(page.locator),
        shape: "flag{}",
        raw,
      };
      const verified = await this.callSolverTool(attemptId, "verify_candidate", { ...candidate });
      if (verified.oracle !== "pass") {
        throw new Error(`oracle refused candidate: ${verified.reason}`);
      }
      outcomes.push(await this.callSolverTool(attemptId, "submit_candidate", { ...candidate }));
    }
    return outcomes;
  }

  async runFixtureHoldoutSolve(attemptId: string): Promise<Record<string, unknown>[]> {
    const live = this.live.get(attemptId);
    if (!live) throw new Error(`attempt ${attemptId} is not live`);
    await this.callSolverTool(attemptId, "room_info", {});
    await this.callSolverTool(attemptId, "http_request", { url: live.spec.targetUrl, method: "GET" });
    const invUrl = `${live.spec.targetUrl.replace(/\/$/, "")}/inventory.json`;
    const feed = await this.callSolverTool(attemptId, "http_request", { url: invUrl, method: "GET" });
    const hits = await this.callSolverTool(attemptId, "grep_artifacts", { pattern: "flag{" });
    const flags = [
      ...new Set(
        (hits.matches as Array<{ text: string }>)
          .flatMap((row) => [...String(row.text).matchAll(/flag\{[^}]+\}/g)].map((m) => m[0])),
      ),
    ];
    if (flags.length === 0) throw new Error("fixture holdout runner found no flag in inventory feed");
    const outcomes: Record<string, unknown>[] = [];
    for (const [index, raw] of flags.entries()) {
      const candidate: CandidateRef = {
        candidateId: `C${String(index + 1).padStart(3, "0")}`,
        fingerprint: fingerprintCandidate(raw),
        artifactRef: String(feed.locator),
        shape: "flag{}",
        raw,
      };
      const verified = await this.callSolverTool(attemptId, "verify_candidate", { ...candidate });
      if (verified.oracle !== "pass") {
        throw new Error(`oracle refused candidate: ${verified.reason}`);
      }
      outcomes.push(await this.callSolverTool(attemptId, "submit_candidate", { ...candidate }));
    }
    return outcomes;
  }

  async runFixtureWebSolveCode(attemptId: string): Promise<Record<string, unknown>[]> {
    const live = this.live.get(attemptId);
    if (!live) throw new Error(`attempt ${attemptId} is not live`);
    await this.callSolverTool(attemptId, "room_info", {});
    const coded = await this.callSolverTool(attemptId, "run_code", {
      source: `
        const info = await tools.room_info();
        const url = info.taskMaterial?.resources?.endpoints?.[0] ?? info.taskMaterial?.resources?.addresses?.[0];
        if (!url) throw new Error("room_info task material has no target address");
        const page = await tools.http_request({ url, method: "GET" });
        const hits = await tools.grep_artifacts({ pattern: "flag{" });
        const flags = [...new Set(hits.matches.flatMap((row) => [...String(row.text).matchAll(/flag\\{[^}]+\\}/g)].map((m) => m[0])))];
        return { locator: page.locator, hash: page.hash, flags };
      `,
    });
    const packed = coded.result as { locator: string; flags: string[] };
    const flags = packed.flags ?? [];
    if (flags.length === 0) throw new Error("code-mode solver found no flag — target is dry");
    const outcomes: Record<string, unknown>[] = [];
    for (const [index, raw] of flags.entries()) {
      const candidate: CandidateRef = {
        candidateId: `C${String(index + 1).padStart(3, "0")}`,
        fingerprint: fingerprintCandidate(raw),
        artifactRef: packed.locator,
        shape: "flag{}",
        raw,
      };
      const verified = await this.callSolverTool(attemptId, "verify_candidate", { ...candidate });
      if (verified.oracle !== "pass") {
        throw new Error(`oracle refused candidate: ${verified.reason}`);
      }
      outcomes.push(await this.callSolverTool(attemptId, "submit_candidate", { ...candidate }));
    }
    return outcomes;
  }

  snapshot(challengeId: string): Record<string, unknown> {
    const ch = this.ledger.challenge(challengeId);
    const coord = this.coords.get(challengeId);
    return {
      challengeId,
      status: ch.status,
      remainingFlags: ch.remaining_flags,
      flagCount: ch.flag_count,
      solvedBy: ch.solved_by,
      policy: coord?.policy ?? "single-fast",
      intelCount: this.pool(challengeId).view(challengeId).length,
      operatorPaced: this.operatorPaced(challengeId),
      pendingMoves: this.operators.pending(challengeId).length,
      liveAttempts: this.liveFor(challengeId).map((a) => ({
        attemptId: a.attemptId,
        cwd: a.workspace,
        tmpDir: a.tmpDir,
        variant: a.variant,
        idleCycles: a.idleCycles,
      })),
    };
  }

  async stopAttempt(attemptId: string): Promise<void> {
    const live = this.live.get(attemptId);
    if (live) {
      await disposeSpine(live.spine);
      this.ledger.setAttemptStatus(attemptId, "stopped");
    }
    this.live.delete(attemptId);
  }

  async stopAllAttempts(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.stopAttempt(id);
    this.sandbox.detachAll();
    this.cellIds.clear();
  }

  async callSolverTool(attemptId: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const live = this.live.get(attemptId);
    if (!live) throw new Error(`attempt ${attemptId} is not live`);
    let result: Record<string, unknown>;
    try {
      result = await callTool(live.spine, name, args);
    } catch (err) {
      if (String(err).includes("unsupported_claim")) this.unsupportedClaims += 1;
      throw err;
    }
    await this.afterSolverTool(live, name, result);
    return result;
  }

  liveAttemptIds(challengeId: string): string[] {
    return this.liveFor(challengeId).map((a) => a.attemptId);
  }

  cellContainerId(challengeId: string): string | undefined {
    return this.cellIds.get(challengeId);
  }

  attemptCapability(attemptId: string): string | undefined {
    return this.live.get(attemptId)?.capability;
  }

  /** Host-authoritative room deadline updater for an active challenge room. */
  setRoomDeadlineHandler(
    challengeId: string,
    handler: ((deadlineAtMs: number) => Record<string, unknown>) | undefined,
  ): void {
    if (!handler) this.roomDeadlineHandlers.delete(challengeId);
    else this.roomDeadlineHandlers.set(challengeId, handler);
  }

  /**
   * C1 Room Projection binding for every Room (solo / parallel / groups / team).
   * Does not change the Intel reader principal.
   */
  setRoomProjectionBinding(challengeId: string, binding: RoomProjectionBinding | undefined): void {
    if (!binding) {
      this.roomProjectionBindings.delete(challengeId);
      this.roomProjectionPriors.delete(challengeId);
    } else this.roomProjectionBindings.set(challengeId, binding);
  }

  /** C5b: Host-owned thin projection for Convergence Reviewer prompts. */
  roomProjectionForConvergence(challengeId: string): ReturnType<typeof roomProjectionChallengeInfo> | undefined {
    const projection = this.rebuildRoomProjection(challengeId);
    if (!projection) return undefined;
    return roomProjectionChallengeInfo(projection);
  }

  /** Formal room member binding for assign/inbox/complete Host tools and Intel member principal. */
  setRoomMemberBinding(challengeId: string, binding: RoomMemberHostBinding | undefined): void {
    if (!binding) this.roomMemberBindings.delete(challengeId);
    else {
      this.roomMemberBindings.set(challengeId, binding);
      if (binding.onIntelChange && !this.officialTeamGates.has(challengeId)) {
        for (const member of binding.membersSnapshot()) {
          const pending = this.pendingIntelNotices(challengeId, member.memberId);
          for (const intelId of new Set(pending.map((row) => row.intelId))) {
            const notices = pending.filter((row) => row.intelId === intelId);
            binding.onIntelChange({ challengeId, intelId, memberIds: [member.memberId], notices });
          }
        }
      }
    }
  }

  /** C2 convergence notes for structural Host events. */
  setRoomConvergenceBinding(challengeId: string, binding: RoomConvergenceBinding | undefined): void {
    if (!binding) {
      this.roomConvergenceBindings.delete(challengeId);
      return;
    }
    this.roomConvergenceBindings.set(challengeId, binding);
    this.repairPlatformVerdictProjections(challengeId);
  }

  /** Mission-level tools stay capability-bound to the official Commander root. */
  setMissionCommanderBinding(challengeId: string, binding: MissionCommanderHostBinding | undefined): void {
    if (!binding) this.missionCommanderBindings.delete(challengeId);
    else this.missionCommanderBindings.set(challengeId, binding);
  }

  setRoomGraphBinding(challengeId: string, binding: RoomGraphHostBinding | undefined): void {
    if (!binding) this.roomGraphBindings.delete(challengeId);
    else this.roomGraphBindings.set(challengeId, binding);
  }

  /**
   * Official Team admission. Unset on the default live overlay, C6 Host recruit,
   * and production swarm. Native-session RPC is rejected unless this gate is set.
   */
  setOfficialTeamRpcGate(challengeId: string, gate: OfficialTeamRpcGate | undefined): void {
    if (!gate) {
      this.officialTeamGates.delete(challengeId);
      return;
    }
    this.officialTeamGates.set(challengeId, gate);
  }

  /** Persist and deliver Commander's factual lifecycle result; Host does not interpret it. */
  recordRoomControlResolution(challengeId: string, reason: string): void {
    const live = this.liveFor(challengeId)[0];
    const text = reason.trim();
    if (!live?.spec.swarmRoom || !text) return;
    this.requireProjectRoom(live).post({
      challengeId,
      authorAttemptId: "host:lifecycle",
      type: "status",
      text: `Commander lifecycle result: ${text}.`,
    });
  }

  /**
   * Room/Mission hook for candidate-report submit. Official Team uses this so a
   * reported submit signals Commander even when dispatchUntilHostTerminal is not
   * the only wrapper on the RPC.
   */
  setContestDerivedFault(fault: (() => void) | undefined): void {
    this.contestDerivedFault = fault;
  }

  setOnCandidateReported(
    challengeId: string,
    handler:
      | ((event: { fingerprint: string; status: "reported" | "duplicate" }) => void | Promise<void>)
      | undefined,
  ): void {
    if (!handler) this.candidateReportedHandlers.delete(challengeId);
    else this.candidateReportedHandlers.set(challengeId, handler);
  }

  private async emitCandidateReported(
    challengeId: string,
    fingerprint: string,
    status: "reported" | "duplicate",
  ): Promise<void> {
    const handler = this.candidateReportedHandlers.get(challengeId);
    if (!handler) return;
    await handler({ fingerprint, status });
  }

  private traceOfficialTeamCandidate(
    challengeId: string,
    method: string,
    row: { ok: boolean; result?: Record<string, unknown>; error?: string },
  ): void {
    if (method !== "verify_candidate" && method !== "submit_candidate") return;
    const gate = this.officialTeamGates.get(challengeId);
    if (!gate) return;
    const live = this.liveFor(challengeId)[0];
    const mappedRef = String(row.result?.evidenceRef ?? "");
    const attemptArtifacts = live ? path.join(live.workspace, "artifacts") : undefined;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      method,
      ok: row.ok,
      status: row.result?.status ?? undefined,
      oracle: row.result?.oracle ?? undefined,
      reason: row.result?.reason ?? row.error,
      fingerprint: row.result?.fingerprint ?? undefined,
      acceptanceMode: row.result?.acceptanceMode ?? undefined,
      attemptArtifactsRoot: row.result?.attemptArtifactsRoot ?? attemptArtifacts,
      ...(mappedRef ? { evidenceRef: mappedRef } : {}),
      ...(live ? { attemptWorkspace: live.workspace } : {}),
      ...(row.result?.resolvedArtifactsRoot ? { resolvedArtifactsRoot: row.result.resolvedArtifactsRoot } : {}),
      ...(row.result?.resolvedArtifactPath ? { resolvedArtifactPath: row.result.resolvedArtifactPath } : {}),
    });
    try {
      fs.appendFileSync(path.join(gate.roomClockDir, "candidate-report-trace.jsonl"), `${line}\n`);
    } catch {
      /* best-effort */
    }
    process.stderr.write(`silver: official-team ${method} ${line}\n`);
  }

  async dispatchRpc(request: HostRpcRequest): Promise<HostRpcResponse> {
    try {
      if (!request.capability?.trim()) return { ok: false, error: "missing capability" };
      const claims = this.gate.read(request.capability);
      const live = this.live.get(claims.attemptId);
      if (!live) return { ok: false, error: "attempt is not live" };
      const blocked = ctfSubmitBlocked(live.spec, request.method);
      if (blocked) return { ok: true, result: blocked };
      const officialGate = this.officialTeamGates.get(live.spec.challengeId);
      if (officialGate && !request.nativeSession) {
        return { ok: false, error: "official team sealed session principal required" };
      }
      if (officialGate) {
        if (
          !request.sessionProof ||
          !officialSessionProofMatches(request.capability, request.nativeSession!, request.sessionProof)
        ) {
          return { ok: false, error: "official team session proof rejected" };
        }
      }
      const roomCapability = this.roomCapabilityClock(live.spec.challengeId);
      this.gate.authorize(
        request.capability,
        request.method,
        {
          challengeId: live.spec.challengeId,
          containerId: live.containerId,
          attemptId: live.attemptId,
          generation: live.generation,
        },
        roomCapability,
      );
      if (officialGate) {
        assertRoomAcceptsActivity({
          roomClockDir: officialGate.roomClockDir,
          challengeId: live.spec.challengeId,
          activity: request.method,
        });
      }
      if (request.nativeSession) {
        if (!OFFICIAL_TEAM_RPC_METHODS.has(request.method)) {
          return { ok: false, error: `official team native session is not wired for ${request.method}` };
        }
        const payload = { ...(request.payload ?? {}) };
        const permitId = typeof payload.permitId === "string" ? payload.permitId.trim() : undefined;
        delete payload.permitId;
        const member = await this.admitOfficialTeam(
          live.spec.challengeId,
          request.nativeSession,
          request.method,
          permitId,
        );
        const result = await this.invokeOfficialTeamTool(
          live,
          member,
          request.method,
          stripModelIdentity(payload),
        );
        await this.afterSolverTool(live, request.method, result, member.memberId);
        this.traceOfficialTeamCandidate(live.spec.challengeId, request.method, { ok: true, result });
        return { ok: true, result };
      }
      const result = await this.invokeAuthorized(live, request.method, request.payload ?? {});
      await this.afterSolverTool(live, request.method, result);
      this.traceOfficialTeamCandidate(live.spec.challengeId, request.method, { ok: true, result });
      return { ok: true, result };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      try {
        const claims = request.capability?.trim() ? this.gate.inspect(request.capability) : undefined;
        const live = claims ? this.live.get(claims.attemptId) : undefined;
        if (live) this.traceOfficialTeamCandidate(live.spec.challengeId, request.method, { ok: false, error });
      } catch {
        /* trace is best-effort */
      }
      return { ok: false, error };
    }
  }

  private admitOfficialTeam(
    challengeId: string,
    meta: NativeSessionRpcMeta,
    tool: string,
    permitId?: string,
  ): Promise<NativeSessionMember> {
    const gate = this.officialTeamGates.get(challengeId);
    if (!gate) throw new Error("official team rpc is not enabled");
    const prev = this.teamAdmitTail.get(challengeId) ?? Promise.resolve();
    const admit = async () => {
      // Yield so concurrent RPC handlers cannot both read the binding before either writes.
      await Promise.resolve();
      const admitParent = typeof meta.parentSessionId === "string" ? meta.parentSessionId.trim() : "";
      if (gate.requireRecruitPermit && admitParent) {
        const block = officialTeamRecruitBlockReason(gate.roomClockDir, meta.sessionId, permitId);
        if (block === "removed") throw new Error("official team session was removed");
        // Room activation advances lifecycle; it never grants an unpermitted child a roster slot.
        if (block === "required") {
          throw new Error("official team recruit permit required before spawn_teammate");
        }
      }
      const member = admitNativeSessionMember({ gate, challengeId, meta, tool });
      if (gate.requireRecruitPermit && member.role === "worker" && member.parentSessionId) {
        const bound = readOfficialTeamPermits(gate.roomClockDir).find(
          (row) => row.kind === "recruit" && row.sessionId === member.sessionId && row.status === "bound",
        );
        if (!bound && permitId) {
          await bindOfficialTeamRecruitPermit({
            roomClockDir: gate.roomClockDir,
            roomId: gate.roomId,
            challengeId,
            permitId,
            sessionId: member.sessionId,
            parentSessionId: member.parentSessionId,
          });
          gate.onRecruitBound?.();
        }
      }
      return member;
    };
    const run = prev.then(admit, admit);
    this.teamAdmitTail.set(
      challengeId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async invokeOfficialTeamTool(
    live: LiveAttempt,
    member: NativeSessionMember,
    method: HostRpcMethod,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === "room_info" || method === "challenge_info") {
      const result = await this.invokeAuthorized(live, method, payload, member.memberId);
      delete result.attemptId;
      const projectRoom = this.officialTeamProjectRoomInfo(live, member);
      if (projectRoom) result.projectRoom = projectRoom;
      return {
        ...result,
        memberId: member.memberId,
        dshSessionId: member.sessionId,
        nativeSession: {
          sessionId: member.sessionId,
          ...(member.parentSessionId ? { parentSessionId: member.parentSessionId } : {}),
        },
      };
    }
    if (method === "intel_publish") {
      return this.intelPublishV2(live.spec.challengeId, live.attemptId, payload, member);
    }
    if (method === "intel_update") {
      return this.intelUpdateV2(live.spec.challengeId, live.attemptId, payload, member);
    }
    // Hidden legacy RPC aliases for an already-running pre-migration plugin.
    if (method === "intel_comment") {
      return this.intelCommentV2(live.spec.challengeId, live.attemptId, payload, member);
    }
    if (method === "intel_revise") {
      return this.intelReviseV2(live.spec.challengeId, live.attemptId, payload, member);
    }
    if (method === "intel_retract") {
      return this.intelRetractV2(live.spec.challengeId, live.attemptId, payload, member);
    }
    if (method === "intel_read") {
      return this.intelReadV2(live.spec.challengeId, live.attemptId, payload, member);
    }
    if (
      method === "graph_overview" ||
      method === "graph_query" ||
      method === "intel_record" ||
      method === "exploration_update"
    ) {
      const binding = this.roomGraphBindings.get(live.spec.challengeId);
      if (!binding) throw new Error("room graph is not available");
      return binding.invoke(method, payload, { attemptId: live.attemptId, memberId: member.memberId });
    }
    if (method === "room_feed_post") {
      return this.roomFeedPost(live, payload, member.memberId);
    }
    if (method === "room_feed_read") {
      return this.roomFeedRead(live, payload, member.memberId);
    }
    if (method === "room_status_set") {
      return this.roomStatusSet(live, payload, member.memberId, member.sessionId);
    }
    if (method === "room_status_read") {
      return this.roomStatusRead(live, this.officialTeamMemberIds(live.spec.challengeId));
    }
    if (method === "verify_candidate" || method === "submit_candidate") {
      return this.invokeAuthorized(live, method, payload, member.memberId);
    }
    if (method === "request_hint") {
      return this.invokeAuthorized(live, method, payload, member.memberId);
    }
    throw new Error(`official team native session is not wired for ${method}`);
  }

  attemptSpine(attemptId: string): SpineRun {
    const live = this.live.get(attemptId);
    if (!live) throw new Error(`attempt ${attemptId} is not live`);
    return live.spine;
  }

  attemptVariant(attemptId: string): AttemptVariant | undefined {
    return this.attemptVariants.get(attemptId);
  }

  intelView(challengeId: string): IntelViewItem[] {
    return this.pool(challengeId).view(challengeId);
  }

  intelInternal(challengeId: string) {
    return this.pool(challengeId).internal(challengeId);
  }

  publicIntelFor(challengeId: string, consumerAttemptId: string, limit = 8): IntelViewItem[] {
    return this.pool(challengeId)
      .internal(challengeId)
      .filter(
        (row) =>
          row.producerAttempt !== consumerAttemptId || row.alsoSeenBy.some((attemptId) => attemptId !== consumerAttemptId),
      )
      .slice(-limit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        observation: row.observation,
        artifactRef: row.artifactRef,
        reproHint: row.reproHint,
        nextObjectiveCheck: row.nextObjectiveCheck,
      }));
  }

  notebookEntries(attemptId: string) {
    const live = this.live.get(attemptId);
    if (!live) return [];
    return new AttemptNotebook(path.join(live.workspace, "notebook.jsonl"), attemptId).read();
  }

  unsupportedClaimCount(): number {
    return this.unsupportedClaims;
  }

  operatorMoves(challengeId: string): OperatorMoveView[] {
    return this.operators.view(challengeId);
  }

  async resolveOperatorMove(
    challengeId: string,
    moveId: string,
    decision: OperatorDecision,
    note?: string,
  ): Promise<Record<string, unknown>> {
    const move = this.operators.get(challengeId, moveId);
    if (!move) throw new Error(`unknown operator move ${moveId}`);
    if (move.status !== "pending") return { status: move.status, moveId };
    if (decision === "reject") {
      this.operators.resolve(move, "reject", note);
      this.ledger.appendEvent(
        "operator_rejected",
        { moveId, kind: move.kind },
        { missionId: this.requireChallengeSpec(challengeId).missionId, challengeId, attemptId: move.attemptId },
      );
      return { status: "rejected", moveId };
    }
    const applied = await this.applyOperatorMove(move);
    if (applied.status === "rejected") {
      this.operators.resolve(move, "reject", note ?? String(applied.reason ?? "apply failed"));
      return { status: "rejected", moveId, ...applied };
    }
    this.operators.resolve(move, "approve", note);
    this.ledger.appendEvent(
      "operator_applied",
      { moveId, kind: move.kind, ...(applied.status ? { submit: applied.status } : {}) },
      { missionId: this.requireChallengeSpec(challengeId).missionId, challengeId, attemptId: move.attemptId },
    );
    if (!this.contestSubmit && applied.status === "accepted" && readLocalRemainingSlots(applied) === 0) {
      if (!this.officialTeamGates.has(challengeId)) {
        await this.stopSiblings(challengeId, move.attemptId);
      }
    }
    return { status: "applied", moveId, outcome: applied };
  }

  runSkeptic(attemptId: string): SkepticReport {
    const live = this.live.get(attemptId);
    if (!live) throw new Error(`attempt ${attemptId} is not live`);
    return this.buildSkeptic(live);
  }

  private async afterSolverTool(
    live: LiveAttempt,
    name: HostRpcMethod | string,
    result: Record<string, unknown>,
    actorId?: string,
  ): Promise<void> {
    if (name !== "room_info" && name !== "challenge_info") {
      const room = this.projectRoom(live.spec.challengeId);
      if (room) {
        const official = this.officialTeamGates.has(live.spec.challengeId);
        if (!official || actorId) {
          try {
            room.noteTool(actorId ?? live.attemptId, String(name));
          } catch (error) {
            // A durable Feed write must not fail because its optional
            // Status projection could not record the last tool.
            if (name !== "room_feed_post" && name !== "submit_candidate") throw error;
          }
        }
      }
    }
    const official = this.officialTeamGates.has(live.spec.challengeId);
    if (!this.contestSubmit && name === "submit_candidate" && result.status === "accepted" && readLocalRemainingSlots(result) === 0) {
      if (!official) {
        await this.stopSiblings(live.spec.challengeId, live.attemptId);
      }
    }
  }

  private buildSkeptic(live: LiveAttempt): SkepticReport {
    const lastTools = live.spine.session
      .events()
      .filter((event) => event.type === "tool_call")
      .map((event) => String((event.payload as { name?: string }).name ?? ""));
    return critique({
      attemptId: live.attemptId,
      idleCycles: live.idleCycles,
      lastTools,
      notebook: new AttemptNotebook(path.join(live.workspace, "notebook.jsonl"), live.attemptId).read(),
      intel: this.pool(live.spec.challengeId).view(live.spec.challengeId),
      remainingFlags: this.ledger.challenge(live.spec.challengeId).remaining_flags,
    });
  }
  private async stopSiblings(challengeId: string, winnerId: string): Promise<void> {
    const ids = this.liveFor(challengeId).map((a) => a.attemptId).filter((id) => id !== winnerId);
    for (const id of ids) await this.stopAttempt(id);
  }

  private liveFor(challengeId: string): LiveAttempt[] {
    return [...this.live.values()].filter((a) => a.spec.challengeId === challengeId);
  }

  private allocateAttemptId(): string {
    for (let i = 0; i < 64; i += 1) {
      const id = `a${i}`;
      if (!this.live.has(id) && !this.ledger.attemptExists(id)) return id;
    }
    throw new Error("attempt id space exhausted");
  }

  private coord(challengeId: string): CoordinatorConfig {
    return this.coords.get(challengeId) ?? DEFAULT_COORDINATOR["single-fast"];
  }

  private pool(challengeId: string): IntelPool {
    const existing = this.pools.get(challengeId);
    if (existing) return existing;
    const spec = this.requireChallengeSpec(challengeId);
    const created = new IntelPool(poolPath(spec.workspace));
    this.pools.set(challengeId, created);
    return created;
  }

  private projectRoom(challengeId: string): ProjectRoomStore | undefined {
    return this.projectRooms.get(challengeId);
  }

  private requireProjectRoom(live: LiveAttempt): ProjectRoomStore {
    const room = this.projectRoom(live.spec.challengeId);
    if (!room || !live.spec.swarmRoom) throw new Error("project room is not enabled");
    return room;
  }

  private officialTeamMemberIds(challengeId: string, role?: RoomMemberRole): string[] {
    const gate = this.officialTeamGates.get(challengeId);
    if (!gate) return [];
    try {
      const roster = readRoomMembers(roomMembersPath(gate.roomClockDir, challengeId));
      if (roster) {
        return roster.members
          .filter(
            (row) =>
              row.status !== "stopped" &&
              row.status !== "terminal" &&
              (role === undefined || row.role === role),
          )
          .map((row) => row.memberId);
      }
      return readNativeSessionBinding(gate.roomClockDir).members
        .filter((row) => role === undefined || row.role === role)
        .map((row) => row.memberId);
    } catch {
      return [];
    }
  }

  private officialTeamProjectRoomInfo(
    live: LiveAttempt,
    member: NativeSessionMember,
  ): Record<string, unknown> | undefined {
    const spec = live.spec.swarmRoom;
    const room = this.projectRoom(live.spec.challengeId);
    if (!spec || !room) return undefined;
    const feed = room.consumeUnread(member.memberId, spec.feedDelivery);
    const statusCards = room.statusCards(this.officialTeamMemberIds(live.spec.challengeId)).map((row) => ({
      memberId: row.attemptId,
      approach: row.approach,
      ...(row.lastTool ? { lastTool: row.lastTool } : {}),
      updatedAt: row.updatedAt,
    }));
    const chatEnabled = spec.chatEnabled !== false;
    return {
      initialMembers: spec.initialMembers,
      maxMembers: spec.maxMembers,
      feedDelivery: spec.feedDelivery,
      chatEnabled,
      expansion: "official-team-on-demand",
      statusCards,
      feed: {
        unreadCount: feed.unreadCount,
        items: feed.items.map((item) => ({
          ...item,
          authorMemberId: item.authorAttemptId,
        })),
        ...(feed.recent
          ? {
              recent: feed.recent.map((item) => ({
                ...item,
                authorMemberId: item.authorAttemptId,
              })),
            }
          : {}),
      },
    };
  }

  private swarmRoomChallengeInfo(live: LiveAttempt): Record<string, unknown> {
    const spec = live.spec.swarmRoom;
    const room = this.projectRoom(live.spec.challengeId);
    if (!spec || !room) return {};
    // Official Team members share one process attempt. Do not consume a process-wide cursor.
    if (this.officialTeamGates.has(live.spec.challengeId)) return {};
    const siblings = this.liveFor(live.spec.challengeId).map((row) => row.attemptId);
    const feed = room.consumeUnread(live.attemptId, spec.feedDelivery);
    const expansion =
      spec.maxMembers > spec.initialMembers
        ? "official-dsh-team-unavailable: Host will not spawn extra members; maxMembers is a resource bound only"
        : "fixed-host-started-roots";
    return {
      projectRoom: {
        initialMembers: spec.initialMembers,
        maxMembers: spec.maxMembers,
        feedDelivery: spec.feedDelivery,
        expansion,
        statusCards: room.statusCards(siblings).map((row) => ({
          groupId: row.attemptId,
          approach: row.approach || undefined,
          lastTool: row.lastTool,
          updatedAt: row.updatedAt || undefined,
          live: siblings.includes(row.attemptId),
        })),
        feed: {
          unreadCount: feed.unreadCount,
          items: feed.items,
          ...(feed.recent ? { recent: feed.recent } : {}),
        },
      },
    };
  }

  private roomFeedPost(
    live: LiveAttempt,
    payload: Record<string, unknown>,
    actorId = live.attemptId,
  ): Record<string, unknown> {
    const official = this.officialTeamGates.has(live.spec.challengeId);
    if (official && (payload.type === "observation" || payload.type === "status")) {
      return {
        ok: false,
        status: "wrong_room_channel",
        message: "Publish reusable observations with intel_publish and current focus with room_status_set.",
      };
    }
    if ((payload.type === "defer_unavailable" || payload.type === "task_complete") && !this.actorIsLead(live, actorId)) {
      return {
        ok: false,
        status: "lead_only",
        message: "Only the Lead can request Commander reconciliation.",
      };
    }
    const formalControlPost =
      payload.type === "defer_unavailable" ||
      payload.type === "task_complete";
    if (
      official &&
      live.spec.swarmRoom?.chatEnabled === false &&
      !formalControlPost
    ) {
      return {
        ok: false,
        status: "room_chat_disabled",
        message: "Ordinary Room Feed chat is disabled; Status and DSH Team coordination remain available.",
      };
    }
    const room = this.requireProjectRoom(live);
    const feedInput = {
      challengeId: live.spec.challengeId,
      authorAttemptId: actorId,
      type: payload.type,
      text: payload.text,
      intelId: payload.intelId,
      checkpoint: payload.checkpoint,
    };
    const validFeed = room.validatePost(feedInput);
    if (!validFeed.ok) throw new Error(`room_feed_post failed: ${validFeed.reason}`);
    const result = room.post(feedInput);
    if (!result.ok) throw new Error(`room_feed_post failed: ${result.reason}`);
    if (payload.type === "defer_unavailable") {
      const roomClockDir =
        this.officialTeamGates.get(live.spec.challengeId)?.roomClockDir ??
        this.roomMemberBindings.get(live.spec.challengeId)?.roomClockDir;
      if (roomClockDir) {
        writeRoomDeferUnavailable(roomClockDir, live.spec.challengeId, String(payload.text ?? ""));
      }
    }
    if (payload.type === "task_complete") {
      const roomClockDir =
        this.officialTeamGates.get(live.spec.challengeId)?.roomClockDir ??
        this.roomMemberBindings.get(live.spec.challengeId)?.roomClockDir;
      if (roomClockDir) {
        writeRoomTaskComplete(roomClockDir, live.spec.challengeId, String(payload.text ?? ""));
      }
    }
    const message = official ? { ...result.message, authorMemberId: actorId } : result.message;
    return {
      ok: true,
      message,
      note: "Room chat is not Intel and not platform accepted",
    };
  }

  /**
   * One Lead check for room controls.
   * Official Team uses the roster role of the sealed session member.
   * The shared process attempt is not a Lead credential.
   */
  private actorIsLead(live: LiveAttempt, actorId: string): boolean {
    const gate = this.officialTeamGates.get(live.spec.challengeId);
    if (gate) {
      const members = readRoomMembers(roomMembersPath(gate.roomClockDir, live.spec.challengeId))?.members ?? [];
      return rosterMemberIsLead(members, { memberId: actorId });
    }
    return this.roomMemberBindings.get(live.spec.challengeId)?.roleForAttempt(live.attemptId) === "lead";
  }

  private roomFeedRead(
    live: LiveAttempt,
    payload: Record<string, unknown>,
    actorId = live.attemptId,
  ): Record<string, unknown> {
    const room = this.requireProjectRoom(live);
    const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
    const query = typeof payload.query === "string" ? payload.query : undefined;
    const afterSeq = Number(payload.afterSeq);
    const sequential = Number.isInteger(afterSeq) && !messageId && !query;
    const result = room.read({
      ...(messageId ? { messageId } : {}),
      ...(query ? { query } : {}),
      ...(Number.isInteger(afterSeq) ? { afterSeq } : {}),
      ...(Number.isInteger(Number(payload.limit)) ? { limit: Number(payload.limit) } : {}),
    });
    const pointRead = Boolean(messageId) && result.messages.length === 1;
    if (sequential && result.messages.length > 0) {
      const last = result.messages[result.messages.length - 1]!;
      room.markRead(actorId, last.seq);
    } else if (pointRead) {
      room.markMessageRead(actorId, result.messages[0]!.seq);
    }
    return {
      ok: true,
      messages: result.messages,
      note: sequential
        ? "sequential afterSeq read acked through the last returned message"
        : pointRead
          ? "messageId read acknowledged this message without skipping other unread posts"
          : "no matching point message was acknowledged; history and query reads do not advance unread state",
    };
  }

  private roomStatusSet(
    live: LiveAttempt,
    payload: Record<string, unknown>,
    actorId = live.attemptId,
    _sessionId?: string,
  ): Record<string, unknown> {
    const officialGate = this.officialTeamGates.get(live.spec.challengeId);
    const room = this.projectRooms.get(live.spec.challengeId);
    if (room && (live.spec.swarmRoom || officialGate)) {
      const result = room.setApproach(actorId, payload.approach);
      if (!result.ok) throw new Error(`room_status_set failed: ${result.reason}`);
      return {
        ok: true,
        status: officialGate ? { ...result.status, memberId: actorId } : result.status,
      };
    }
    if (officialGate) {
      const approach = typeof payload.approach === "string" ? payload.approach.trim() : "";
      if (!approach) throw new Error("room_status_set failed: approach_required");
      return { ok: true, status: { memberId: actorId, approach } };
    }
    const result = this.requireProjectRoom(live).setApproach(actorId, payload.approach);
    if (!result.ok) throw new Error(`room_status_set failed: ${result.reason}`);
    return { ok: true, status: result.status };
  }

  private roomStatusRead(live: LiveAttempt, actorIds?: string[]): Record<string, unknown> {
    const room = this.requireProjectRoom(live);
    const siblings = actorIds ?? this.liveFor(live.spec.challengeId).map((row) => row.attemptId);
    const cards = room.statusCards(siblings);
    return {
      ok: true,
      statusCards: actorIds
        ? cards.map((row) => ({ ...row, memberId: row.attemptId }))
        : cards,
    };
  }

  private publicIntelStore(challengeId: string): PublicIntelStore {
    const existing = this.publicIntel.get(challengeId);
    if (existing) {
      existing.ensureMigratedFromV1(this.pool(challengeId).internal(challengeId));
      return existing;
    }
    const spec = this.requireChallengeSpec(challengeId);
    const created = new PublicIntelStore(spec.workspace);
    created.ensureMigratedFromV1(this.pool(challengeId).internal(challengeId));
    this.publicIntel.set(challengeId, created);
    return created;
  }

  private findingStore(challengeId: string): FindingStore {
    const existing = this.findingStores.get(challengeId);
    if (existing) return existing;
    const spec = this.requireChallengeSpec(challengeId);
    const created = new FindingStore(spec.workspace);
    this.findingStores.set(challengeId, created);
    return created;
  }


  private requireChallengeSpec(challengeId: string): ChallengeSpec {
    const live = this.liveFor(challengeId)[0];
    if (live) return live.spec;
    const stored = this.pendingSpecs.get(challengeId);
    if (!stored) throw new Error(`challenge ${challengeId} was not started`);
    return stored;
  }

  bindSpec(spec: ChallengeSpec): void {
    this.pendingSpecs.set(spec.challengeId, spec);
  }

  private operatorPaced(challengeId: string): boolean {
    return this.ledger.missionAutonomy(this.requireChallengeSpec(challengeId).missionId) === "human_assisted";
  }

  private proposeAwdMove(
    challengeId: string,
    attemptId: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    const kindRaw = String(payload.kind ?? "");
    if (!isAwdMoveKind(kindRaw) || kindRaw === "attack_submit") {
      return { status: "rejected", reason: "unknown awd move kind" };
    }
    const summary = String(payload.summary ?? kindRaw).slice(0, 240);
    const implant = kindRaw === "implant" ? implantFromPayload(payload) : undefined;
    const honeypot = kindRaw === "honeypot" ? String(payload.token ?? payload.honeypot ?? "").trim() : "";
    const dirtyRaw = String(payload.dirty ?? "");
    if (kindRaw === "implant" && !implant) return { status: "rejected", reason: "implant token required" };
    if (kindRaw === "honeypot" && !honeypot) return { status: "rejected", reason: "honeypot token required" };
    if (kindRaw === "dirty" && !isDirtyKind(dirtyRaw)) return { status: "rejected", reason: "unknown dirty kind" };
    const drafted = {
      challengeId,
      attemptId,
      kind: kindRaw,
      summary,
      ...(implant ? { implant } : {}),
      ...(honeypot ? { honeypot } : {}),
      ...(kindRaw === "dirty" && isDirtyKind(dirtyRaw) ? { dirty: dirtyRaw } : {}),
    };
    if (this.operatorPaced(challengeId)) return this.queueOperatorMove(drafted);
    return this.applyAwdKind(challengeId, drafted);
  }

  private queueOperatorMove(input: {
    challengeId: string;
    attemptId: string;
    kind: AwdMoveKind;
    summary: string;
    fingerprint?: string;
    candidate?: CandidateRef;
    submittedByMemberId?: string;
    implant?: AwdImplantSpec;
    honeypot?: string;
    dirty?: DirtyKind;
  }): Record<string, unknown> {
    const move = this.operators.enqueue(input);
    const spec = this.requireChallengeSpec(input.challengeId);
    this.ledger.appendEvent(
      "operator_pending",
      { moveId: move.moveId, kind: move.kind, ...(move.fingerprint ? { fingerprint: move.fingerprint } : {}) },
      { missionId: spec.missionId, challengeId: input.challengeId, attemptId: input.attemptId },
    );
    return { status: "pending_operator", moveId: move.moveId, kind: move.kind };
  }

  private async applyOperatorMove(move: {
    challengeId: string;
    attemptId: string;
    kind: AwdMoveKind;
    fingerprint?: string;
    candidate?: CandidateRef;
    submittedByMemberId?: string;
    implant?: AwdImplantSpec;
    honeypot?: string;
    dirty?: DirtyKind;
  }): Promise<Record<string, unknown>> {
    if (move.kind === "attack_submit") {
      if (!move.candidate || !move.fingerprint) return { status: "rejected", reason: "missing candidate" };
      return this.submitNow(
        move.challengeId,
        move.attemptId,
        move.candidate,
        move.fingerprint,
        move.submittedByMemberId,
      );
    }
    return this.applyAwdKind(move.challengeId, move);
  }

  private applyAwdKind(
    challengeId: string,
    move: {
      kind: AwdMoveKind;
      implant?: AwdImplantSpec;
      honeypot?: string;
      dirty?: DirtyKind;
    },
  ): Record<string, unknown> {
    try {
      if (move.kind === "patch") this.platform.applyPatch(challengeId);
      else if (move.kind === "implant" && move.implant) this.platform.applyImplant(challengeId, move.implant);
      else if (move.kind === "honeypot" && move.honeypot) this.platform.applyHoneypot(challengeId, move.honeypot);
      else if (move.kind === "dirty" && move.dirty) this.platform.applyDirty(challengeId, move.dirty);
      else if (move.kind === "foothold") this.platform.applyFoothold(challengeId);
      else if (move.kind === "sniff") this.platform.applySniff(challengeId);
      else return { status: "rejected", reason: "incomplete awd move" };
      return { status: "applied", kind: move.kind, awd: this.platform.awdStatus(challengeId) };
    } catch (err) {
      return { status: "rejected", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  progressFor(challengeId: string, attemptId?: string): ReturnType<typeof deriveProgressSnapshot> {
    const live = attemptId ? this.live.get(attemptId) : this.liveFor(challengeId)[0];
    if (!live) return deriveProgressSnapshot({});
    const progress = deriveProgressSnapshot({
      events: live.spine.session.events(),
      artifactsDir: path.join(live.workspace, "artifacts"),
      targetUrl: live.spec.targetUrl,
      ...(live.spec.inScopeUrls ? { inScopeUrls: live.spec.inScopeUrls } : {}),
    });
    const authoredFindings = this.findingStore(challengeId).toLedgerEntries(challengeId, {
      intelStore: this.publicIntelStore(challengeId),
    });
    progress.findingLedger = mergeAuthoredFindingsIntoLedger(progress.findingLedger, authoredFindings);
    return progress;
  }

  candidateRecords(challengeId: string): ReturnType<typeof aggregateCandidateRecords> {
    return aggregateCandidateRecords(this.ledger.listOracleResults(challengeId), this.ledger.listSubmissions(challengeId));
  }

  takePassedRaw(challengeId: string): string[] {
    const map = this.passedRaw.get(challengeId);
    this.passedRaw.delete(challengeId);
    const submitted = this.submittedFingerprints.get(challengeId) ?? new Set();
    const out: string[] = [];
    if (!map) return out;
    for (const [fingerprint, raw] of map) {
      if (!submitted.has(fingerprint)) out.push(raw);
    }
    return out;
  }

  takePlatformVerdicts(challengeId: string): ContestSubmitVerdict[] {
    const rows = this.platformVerdicts.get(challengeId) ?? [];
    this.platformVerdicts.delete(challengeId);
    return rows;
  }

  platformCompleted(challengeId: string): boolean {
    const spec = this.liveFor(challengeId)[0]?.spec ?? this.pendingSpecs.get(challengeId);
    if (spec?.track === "awd" || spec?.track === "agent-awd") return false;
    return this.acceptanceProgressFor(challengeId).completed === true;
  }

  /** Project an already-recorded authoritative platform completion into the local runtime ledger. */
  settleAuthoritativePlatformCompletion(challengeId: string): boolean {
    if (!this.platformCompleted(challengeId)) return false;
    this.ledger.settlePlatformCompleted(challengeId);
    return true;
  }

  /** Persist an authoritative platform-list snapshot for Room progress and recovery. */
  recordPlatformProgress(
    challengeId: string,
    progress: { correctFlagCount?: number; totalFlagCount?: number; completed?: boolean },
  ): boolean {
    const spec = this.requireChallengeSpec(challengeId);
    const reviewedAt = new Date().toISOString();
    const completed = platformRoomCompleted(progress);
    const review: PlatformReviewRecord = {
      fingerprint: "platform:list:progress",
      status: "unknown",
      reviewedAt,
      ...(progress.correctFlagCount !== undefined ? { correctFlagCount: progress.correctFlagCount } : {}),
      ...(progress.totalFlagCount !== undefined ? { totalFlagCount: progress.totalFlagCount } : {}),
      platformCompleted: completed,
    };
    this.ledger.appendEvent(
      "contest_platform_observation",
      {
        correctFlagCount: review.correctFlagCount,
        totalFlagCount: review.totalFlagCount,
        platformCompleted: completed,
        observedAt: reviewedAt,
      },
      { missionId: spec.missionId, challengeId },
    );
    this.rememberReview(challengeId, review);
    return completed && this.settleAuthoritativePlatformCompletion(challengeId);
  }

  /** Persist an authoritative platform-list completion before stopping an active room. */
  recordPlatformCompletion(
    challengeId: string,
    progress: { correctFlagCount?: number; totalFlagCount?: number; completed?: boolean },
  ): boolean {
    if (!platformRoomCompleted(progress)) return false;
    return this.recordPlatformProgress(challengeId, progress);
  }

  /** Public Room review rows, including in-flight pending. */
  platformReviewRecords(challengeId: string): PlatformReviewRecord[] {
    return [...(this.platformReviews.get(challengeId) ?? [])];
  }

  private rememberPassedRaw(challengeId: string, fingerprint: string, raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let map = this.passedRaw.get(challengeId);
    if (!map) {
      map = new Map();
      this.passedRaw.set(challengeId, map);
    }
    map.set(fingerprint, trimmed);
  }

  private recordReportedCandidate(
    challengeId: string,
    attemptId: string,
    candidate: CandidateRef,
    fingerprint: string,
  ): Record<string, unknown> {
    const spec = this.requireChallengeSpec(challengeId);
    const inserted = this.ledger.insertSubmitting(challengeId, attemptId, fingerprint);
    if (inserted === "duplicate") {
      return { status: "duplicate", fingerprint, acceptanceMode: "candidate-report" };
    }
    this.ledger.finishSubmission(challengeId, fingerprint, "reported");
    if (candidate.raw) this.rememberPassedRaw(challengeId, fingerprint, candidate.raw);
    this.ledger.appendEvent(
      "candidate_recorded",
      { fingerprint, candidateId: candidate.candidateId },
      { missionId: spec.missionId, challengeId, attemptId },
    );
    return {
      status: "reported",
      fingerprint,
      acceptanceMode: "candidate-report",
      platformAcceptedPossible: false,
      platformReconciliationRequired: true,
    };
  }

  /** Official Team native RPC only. `spec.swarmRoom` is the legacy/C6 overlay. */
  private standardSwarmHotPath(challengeId: string): boolean {
    return this.officialTeamGates.has(challengeId);
  }

  private async submitNow(
    challengeId: string,
    attemptId: string,
    candidate: CandidateRef,
    fingerprint: string,
    submittedByMemberId?: string,
  ): Promise<Record<string, unknown>> {
    const spec = this.requireChallengeSpec(challengeId);
    if (this.contestSubmit) {
      return this.submitContest(challengeId, attemptId, candidate, fingerprint, submittedByMemberId);
    }
    if (
      (spec.acceptanceMode ?? "platform") === "candidate-report" ||
      this.candidateReportedHandlers.has(challengeId)
    ) {
      const recorded = this.recordReportedCandidate(challengeId, attemptId, candidate, fingerprint);
      const status = recorded.status === "duplicate" ? "duplicate" : "reported";
      await this.emitCandidateReported(challengeId, fingerprint, status);
      return recorded;
    }
    const outcome = await this.broker.submit({ challengeId, attemptId, candidate });
    this.ledger.appendEvent(
      "submit_outcome",
      { ...outcome, fingerprint },
      { missionId: spec.missionId, challengeId, attemptId },
    );
    return outcome as unknown as Record<string, unknown>;
  }

  private async submitContest(
    challengeId: string,
    attemptId: string,
    candidate: CandidateRef,
    fingerprint: string,
    submittedByMemberId?: string,
  ): Promise<Record<string, unknown>> {
    const spec = this.requireChallengeSpec(challengeId);
    const priorAccepted = this.platformReviewRecords(challengeId).findLast(
      (row) => row.fingerprint === fingerprint && row.status === "accepted",
    );
    if (priorAccepted) {
      const progress = this.acceptanceProgressFor(challengeId);
      const guidance = "The platform previously accepted this exact candidate for this challenge. No new submission or score was made now; continue toward missing results. This does not invalidate the route that produced it.";
      return {
        ...this.contestReturn(challengeId, priorAccepted),
        status: "duplicate",
        duplicate: true,
        alreadyAccepted: true,
        submittedNow: false,
        newlyAccepted: false,
        ...(progress.platformAcceptedCount !== undefined ? { correctFlagCount: progress.platformAcceptedCount } : {}),
        ...(progress.platformTotalCount !== undefined ? { totalFlagCount: progress.platformTotalCount } : {}),
        ...(progress.completed !== undefined ? { platformCompleted: progress.completed } : {}),
        guidance,
        message: guidance,
      };
    }
    try {
      this.ledger.beginContestSubmission(
        challengeId,
        attemptId,
        fingerprint,
        submittedByMemberId,
      );
    } catch {
      // Local audit state must never gate a new candidate's adapter call.
    }
    const pendingAt = new Date().toISOString();
    try {
      this.rememberReview(challengeId, {
        fingerprint,
        status: "pending",
        reviewedAt: pendingAt,
        attemptId,
        ...(submittedByMemberId ? { submittedByMemberId } : {}),
        ...(candidate.candidateId ? { candidateId: candidate.candidateId } : {}),
        ...(candidate.artifactRef ? { artifactRef: String(candidate.artifactRef) } : {}),
      });
    } catch {
      // Pending projection is best-effort; the platform call is authoritative.
    }
    let verdict: Awaited<ReturnType<ContestSubmitHook>>;
    try {
      verdict = await this.contestSubmit!({ challengeId, fingerprint, raw: candidate.raw ?? "" });
    } catch (err) {
      const review: PlatformReviewRecord = {
        fingerprint,
        status: "unknown",
        reviewedAt: new Date().toISOString(),
        attemptId,
        ...(submittedByMemberId ? { submittedByMemberId } : {}),
        ...(candidate.candidateId ? { candidateId: candidate.candidateId } : {}),
        ...(candidate.artifactRef ? { artifactRef: String(candidate.artifactRef) } : {}),
      };
      try {
        this.persistContestSubmitOutcome(spec.missionId, challengeId, attemptId, review);
      } catch {
        /* keep the adapter's original error */
      }
      try {
        this.ledger.recordContestSubmissionStatus(challengeId, fingerprint, "unknown", {
          attemptId,
          ...(submittedByMemberId ? { submittedByMemberId } : {}),
        });
      } catch {
        /* keep the adapter's original error */
      }
      try {
        this.rememberReview(challengeId, review);
      } catch {
        /* keep the adapter's original error */
      }
      // Record the indeterminate delivery fact, but preserve the adapter error for
      // the Worker. A later explicit call is allowed to reach the adapter again.
      throw err;
    }
    const reviewedAt = new Date().toISOString();
    const awdService = spec.track === "awd" || spec.track === "agent-awd";
    const platformCompleted = !awdService && verdict.completed === true;
    const duplicate = verdict.duplicate === true;
    const accepted = verdict.correct === true && !duplicate;
    const review: PlatformReviewRecord = {
      fingerprint,
      status: duplicate ? "duplicate" : accepted ? "accepted" : verdict.correct === false ? "rejected" : "unknown",
      reviewedAt,
      attemptId,
      ...(submittedByMemberId ? { submittedByMemberId } : {}),
      ...(verdict.awarded !== undefined ? { awarded: verdict.awarded } : {}),
      ...(verdict.correctFlagCount !== undefined ? { correctFlagCount: verdict.correctFlagCount } : {}),
      ...(verdict.totalFlagCount !== undefined ? { totalFlagCount: verdict.totalFlagCount } : {}),
      ...(verdict.httpStatus !== undefined ? { httpStatus: verdict.httpStatus } : {}),
      platformCompleted,
      ...(verdict.correct !== undefined ? { platformCorrect: verdict.correct } : {}),
      ...(candidate.candidateId ? { candidateId: candidate.candidateId } : {}),
      ...(candidate.artifactRef ? { artifactRef: String(candidate.artifactRef) } : {}),
    };
    try {
      this.persistContestSubmitOutcome(spec.missionId, challengeId, attemptId, review, verdict);
    } catch {
      // Recording is best-effort after the adapter has returned its verdict.
    }
    try {
      this.contestDerivedFault?.();
    } catch {
      // Faults in derived bookkeeping must not replace the platform verdict.
    }
    this.recordRawPlatformVerdict(challengeId, verdict);
    const submitted = this.submittedFingerprints.get(challengeId) ?? new Set();
    submitted.add(fingerprint);
    this.submittedFingerprints.set(challengeId, submitted);
    if (awdService && verdict.correct === true) {
      const gate = this.officialTeamGates.get(challengeId);
      if (gate) {
        try {
          applyAwdServiceRoom({
            roomClockDir: gate.roomClockDir,
            roomId: gate.roomId,
            challengeId,
            notice: { at: reviewedAt, platformStage: true },
          });
        } catch {
          /* platform verdict already stands */
        }
      }
    }
    // rejected is only verdict.correct === false. Missing correctness stays unknown.
    // The submission row is a fingerprint audit. It does not consume a local flag slot.
    try {
      this.ledger.recordContestSubmissionStatus(
        challengeId,
        fingerprint,
        duplicate ? "duplicate" : accepted ? "accepted" : verdict.correct === false ? "rejected" : "unknown",
        { attemptId, ...(submittedByMemberId ? { submittedByMemberId } : {}) },
      );
    } catch {
      /* platform verdict already stands */
    }
    try {
      this.rememberReview(challengeId, review);
    } catch {
      /* platform verdict already stands */
    }
    return this.finishContestReview(challengeId, review, { adapterVerdict: verdict });
  }

  /**
   * Durable verdict is already on the ledger. Notice first, then project.
   * A Feed/Intel failure must not swallow the notice or the submit result.
   */
  private async finishContestReview(
    challengeId: string,
    review: PlatformReviewRecord,
    extra?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let noticed = false;
    try {
      noticed = this.notifyPlatformVerdict(challengeId, review);
    } catch {
      /* notification is derived from the adapter verdict */
    }
    try {
      await this.projectPlatformVerdictNotice(challengeId, review);
    } catch {
      /* projection is derived; the notice and the submit result already stand */
    }
    let projected: Record<string, unknown> = {};
    try {
      projected = this.contestReturn(challengeId, review);
    } catch {
      /* the exact adapter verdict below remains authoritative */
    }
    return {
      ...projected,
      ...(extra ?? {}),
      ...(noticed ? { teamNotice: { kind: "platform_verdict" as const } } : {}),
    };
  }

  /** Official Team social notice for a persisted platform verdict, including authoritative duplicate counts. */
  private notifyPlatformVerdict(challengeId: string, review: PlatformReviewRecord): boolean {
    if (!isRelayablePlatformVerdict(review)) return false;
    if (!this.officialTeamGates.has(challengeId)) return false;
    this.notifySocial(challengeId, { kind: "platform_verdict" });
    return true;
  }

  private contestReturn(challengeId: string, review: PlatformReviewRecord): Record<string, unknown> {
    const rejectedGuidance =
      review.status === "rejected" ? contestRejectedGuidance(review.fingerprint) : undefined;
    return {
      status: review.status,
      fingerprint: review.fingerprint,
      acceptanceMode: "platform",
      platformAcceptedPossible: true,
      reviewedAt: review.reviewedAt,
      ...(review.submittedByMemberId ? { submittedByMemberId: review.submittedByMemberId } : {}),
      ...(rejectedGuidance ? { guidance: rejectedGuidance, message: rejectedGuidance } : {}),
      ...(review.platformCorrect !== undefined ? { platformCorrect: review.platformCorrect } : {}),
      ...(review.awarded !== undefined ? { awarded: review.awarded } : {}),
      ...(review.correctFlagCount !== undefined ? { correctFlagCount: review.correctFlagCount } : {}),
      ...(review.totalFlagCount !== undefined ? { totalFlagCount: review.totalFlagCount } : {}),
      ...(review.httpStatus !== undefined ? { httpStatus: review.httpStatus } : {}),
      ...(review.platformCompleted !== undefined ? { platformCompleted: review.platformCompleted } : {}),
      ...(review.candidateId ? { candidateId: review.candidateId } : {}),
      ...(review.artifactRef ? { artifactRef: review.artifactRef } : {}),
    };
  }

  /** Contract size plus platform facts already recorded. Does not invent missing fingerprints. */
  acceptanceProgressFor(challengeId: string): AcceptanceProgress {
    const spec = this.liveFor(challengeId)[0]?.spec ?? this.pendingSpecs.get(challengeId);
    const expectedFlagCount = spec?.flagCount ?? this.ledger.challenge(challengeId).flag_count;
    return acceptanceProgressFromReviews(expectedFlagCount, this.platformReviewRecords(challengeId));
  }

  private rememberReview(challengeId: string, review: PlatformReviewRecord): void {
    const rows = this.platformReviews.get(challengeId) ?? [];
    const pendingIndex = rows.findLastIndex(
      (row) =>
        row.fingerprint === review.fingerprint &&
        row.status === "pending" &&
        (review.attemptId === undefined || row.attemptId === review.attemptId),
    );
    if (pendingIndex >= 0) rows.splice(pendingIndex, 1);
    rows.push(review);
    this.platformReviews.set(challengeId, rows);
    this.persistRejectedFingerprints(challengeId);
  }

  private persistRejectedFingerprints(challengeId: string): void {
    const dir =
      this.officialTeamGates.get(challengeId)?.roomClockDir ??
      this.roomProjectionBindings.get(challengeId)?.roomClockDir;
    if (!dir) return;
    const latestByFingerprint = new Map<string, PlatformReviewRecord>();
    for (const row of this.platformReviews.get(challengeId) ?? []) {
      latestByFingerprint.set(row.fingerprint, row);
    }
    const fingerprints = [...latestByFingerprint.values()]
      .filter((row) => row.status === "rejected" || row.priorStatus === "rejected")
      .map((row) => row.fingerprint);
    writeOfficialTeamRejectedFingerprints(dir, fingerprints);
  }

  private recordRawPlatformVerdict(challengeId: string, verdict: ContestSubmitVerdict): void {
    const rows = this.platformVerdicts.get(challengeId) ?? [];
    rows.push(verdict);
    this.platformVerdicts.set(challengeId, rows);
  }

  private persistContestSubmitOutcome(
    missionId: string,
    challengeId: string,
    attemptId: string,
    review: PlatformReviewRecord,
    verdict?: ContestSubmitVerdict,
  ): void {
    this.ledger.appendEvent(
      "contest_submit_outcome",
      {
        fingerprint: review.fingerprint,
        status: review.status,
        correct: verdict?.correct ?? review.platformCorrect,
        awarded: review.awarded ?? verdict?.awarded,
        correctFlagCount: review.correctFlagCount ?? verdict?.correctFlagCount,
        totalFlagCount: review.totalFlagCount ?? verdict?.totalFlagCount,
        httpStatus: review.httpStatus ?? verdict?.httpStatus,
        platformCompleted: review.platformCompleted,
        duplicate: verdict?.duplicate === true,
        ...(verdict ? { adapterVerdict: verdict } : {}),
        ...(review.submittedByMemberId
          ? { submittedByMemberId: review.submittedByMemberId }
          : {}),
        ...(review.candidateId ? { candidateId: review.candidateId } : {}),
        ...(review.artifactRef ? { artifactRef: review.artifactRef } : {}),
        ...(verdict ? { cumulativeScore: verdict.cumulativeScore } : {}),
        reviewedAt: review.reviewedAt,
      },
      { missionId, challengeId, attemptId },
    );
  }

  private hydrateContestSubmitState(challengeId: string): void {
    // A process restart makes every previously in-flight platform request
    // indeterminate before we project submission rows back into room state.
    this.ledger.recoverInterruptedSubmissions(challengeId);
    const events = this.ledger.listEvents({ challengeId, kind: "contest_submit_outcome" });
    const reviews: PlatformReviewRecord[] = [];
    const verdicts: ContestSubmitVerdict[] = [];
    const submitted = new Set<string>();
    for (const event of events) {
      const fingerprint = String(event.payload.fingerprint ?? "").trim();
      if (!fingerprint) continue;
      const status = this.reviewStatusFromPayload(event.payload.status, event.payload.correct);
      const awarded = numberOrUndefined(event.payload.awarded);
      const cumulativeScore = numberOrUndefined(event.payload.cumulativeScore);
      const correctFlagCount = numberOrUndefined(event.payload.correctFlagCount);
      const totalFlagCount = numberOrUndefined(event.payload.totalFlagCount);
      const httpStatus = numberOrUndefined(event.payload.httpStatus);
      const persistedAdapterVerdict =
        event.payload.adapterVerdict &&
        typeof event.payload.adapterVerdict === "object" &&
        !Array.isArray(event.payload.adapterVerdict)
          ? (event.payload.adapterVerdict as ContestSubmitVerdict)
          : undefined;
      const platformCompleted =
        typeof event.payload.platformCompleted === "boolean"
          ? event.payload.platformCompleted
          : persistedAdapterVerdict?.completed === true;
      const review: PlatformReviewRecord = {
        fingerprint,
        status,
        reviewedAt: String(event.payload.reviewedAt ?? event.createdAt),
        ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        ...(event.payload.submittedByMemberId
          ? { submittedByMemberId: String(event.payload.submittedByMemberId) }
          : {}),
        ...(awarded !== undefined ? { awarded } : {}),
        ...(correctFlagCount !== undefined ? { correctFlagCount } : {}),
        ...(totalFlagCount !== undefined ? { totalFlagCount } : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(event.payload.candidateId ? { candidateId: String(event.payload.candidateId) } : {}),
        ...(event.payload.artifactRef ? { artifactRef: String(event.payload.artifactRef) } : {}),
        ...(event.payload.correct === true || event.payload.correct === false
          ? { platformCorrect: event.payload.correct }
          : {}),
        platformCompleted,
      };
      reviews.push(review);
      if (status !== "unknown" && status !== "pending") submitted.add(fingerprint);
      verdicts.push(
        persistedAdapterVerdict ?? {
          ...(event.payload.correct === true || event.payload.correct === false
            ? { correct: event.payload.correct }
            : {}),
          ...(awarded !== undefined ? { awarded } : {}),
          ...(cumulativeScore !== undefined ? { cumulativeScore } : {}),
          ...(correctFlagCount !== undefined ? { correctFlagCount } : {}),
          ...(totalFlagCount !== undefined ? { totalFlagCount } : {}),
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          ...(event.payload.duplicate === true ? { duplicate: true } : {}),
          ...(event.payload.platformCompleted === true ? { completed: true } : {}),
        },
      );
    }
    for (const event of this.ledger.listEvents({ challengeId, kind: "contest_platform_observation" })) {
      const correctFlagCount = numberOrUndefined(event.payload.correctFlagCount);
      const totalFlagCount = numberOrUndefined(event.payload.totalFlagCount);
      const completed = platformRoomCompleted({
        ...(correctFlagCount !== undefined ? { correctFlagCount } : {}),
        ...(totalFlagCount !== undefined ? { totalFlagCount } : {}),
        ...(event.payload.platformCompleted === true ? { completed: true } : {}),
      });
      reviews.push({
        fingerprint: "platform:list:progress",
        status: "unknown",
        reviewedAt: String(event.payload.observedAt ?? event.createdAt),
        ...(correctFlagCount !== undefined ? { correctFlagCount } : {}),
        ...(totalFlagCount !== undefined ? { totalFlagCount } : {}),
        platformCompleted: completed,
      });
    }
    for (const review of reviews) {
      if (
        review.status !== "accepted" &&
        review.status !== "rejected" &&
        review.status !== "duplicate" &&
        review.status !== "unknown"
      ) continue;
      this.ledger.recordContestSubmissionStatus(challengeId, review.fingerprint, review.status);
    }
    if (reviews.length > 0) this.platformReviews.set(challengeId, reviews);
    if (verdicts.length > 0) this.platformVerdicts.set(challengeId, verdicts);
    if (submitted.size > 0) this.submittedFingerprints.set(challengeId, submitted);
    this.persistRejectedFingerprints(challengeId);
  }

  private reviewStatusFromPayload(status: unknown, correct: unknown): PlatformReviewStatus {
    if (status === "pending" || status === "accepted" || status === "rejected" || status === "duplicate" || status === "unknown") {
      return status;
    }
    if (correct === false) return "rejected";
    if (correct === true) return "accepted";
    return "unknown";
  }

  private projectPlatformVerdictFeed(challengeId: string, review: PlatformReviewRecord): void {
    if (!isRelayablePlatformVerdict(review)) return;
    const room = this.projectRoom(challengeId);
    if (!room) return;
    const count = authoritativePlatformCount(review);
    const submitter = review.submittedByMemberId
      ? ` submittedByMemberId=${review.submittedByMemberId}`
      : "";
    const http = review.httpStatus !== undefined ? ` httpStatus=${review.httpStatus}` : "";
    const text =
      review.status === "duplicate" && count
        ? `Host verdict duplicate platformCount=${count.accepted}/${count.total}${http} fingerprint=${review.fingerprint}${submitter}`
        : `Host verdict ${review.status}${http} fingerprint=${review.fingerprint}${submitter}`;
    try {
      const already = room.read({ query: review.fingerprint }).messages.some(
        (row) => row.authorAttemptId === "host" && row.type === "status" && row.text.includes(review.status),
      );
      if (already) return;
      room.post({ challengeId, authorAttemptId: "host", type: "status", text });
    } catch {
      /* Feed is derived from the durable review */
    }
  }

  private repairPlatformVerdictProjections(challengeId: string): void {
    let relay = false;
    for (const review of this.platformReviewRecords(challengeId)) {
      if (!isRelayablePlatformVerdict(review)) continue;
      try {
        this.projectPlatformVerdictFeed(challengeId, review);
        void this.projectPlatformVerdictNotice(challengeId, review);
      } catch {
        /* projection failure must not block a later unread notice */
      }
      if (this.hostVerdictNeedsRelay(challengeId, review)) relay = true;
    }
    if (relay) this.notifySocial(challengeId, { kind: "platform_verdict", relay: true });
  }

  /**
   * Cold recovery looks at the existing unread projection. No exactly-once receipt.
   * Missing Feed still relays, because the durable verdict is already the fact.
   * Once every roster member has acked the host verdict, a repeat is a no-op.
   */
  private hostVerdictNeedsRelay(challengeId: string, review: PlatformReviewRecord): boolean {
    if (!isRelayablePlatformVerdict(review)) return false;
    const room = this.projectRoom(challengeId);
    if (!room) return true;
    const posted = room.read({ query: review.fingerprint }).messages.some(
      (row) => row.authorAttemptId === "host" && row.text.includes(review.status),
    );
    if (!posted) return true;
    const gate = this.officialTeamGates.get(challengeId);
    const roster = gate ? readRoomMembers(roomMembersPath(gate.roomClockDir, challengeId)) : undefined;
    const ids = (roster?.members ?? []).map((row) => row.memberId).filter((id) => id !== "host");
    if (ids.length === 0) return true;
    return ids.some((id) =>
      room.unread(id).some(
        (row) => row.authorAttemptId === "host" && row.text.includes(review.fingerprint) && row.text.includes(review.status),
      ),
    );
  }

  private async projectPlatformVerdictNotice(
    challengeId: string,
    review: PlatformReviewRecord,
  ): Promise<void> {
    try {
      this.projectPlatformVerdictFeed(challengeId, review);
      if (!isRelayablePlatformVerdict(review)) {
        this.noteStallLeaseProgress(challengeId, "candidate");
        return;
      }
      if (!this.standardSwarmHotPath(challengeId)) {
        try {
          await this.noteConvergenceTrigger(challengeId, {
            eventId: `platform_verdict_changed:${review.fingerprint}:${review.status}`,
            kind: "platform_verdict_changed",
            subjectRef: review.fingerprint,
            version: review.status,
          });
        } catch {
          /* projections already landed; do not fail the submit */
        }
      }
      this.noteStallLeaseProgress(challengeId, "candidate");
    } catch {
      /* Feed/convergence are derived from the durable platform review */
    }
  }

  private roomCapabilityClock(challengeId: string): { roomDeadlineAtMs?: number; roomTerminal?: boolean } | undefined {
    const dir =
      this.officialTeamGates.get(challengeId)?.roomClockDir ??
      this.roomProjectionBindings.get(challengeId)?.roomClockDir ??
      this.roomConvergenceBindings.get(challengeId)?.roomClockDir;
    if (!dir) return undefined;
    const clock = readRoomClock(roomClockPath(dir, challengeId));
    const ms = clock && !clock.unbounded ? Date.parse(clock.deadlineAt) : Number.NaN;
    const roomTerminal = isRoomPlatformStopPresent(dir, challengeId);
    if (!Number.isFinite(ms) && !roomTerminal) return undefined;
    return {
      ...(Number.isFinite(ms) ? { roomDeadlineAtMs: ms } : {}),
      ...(roomTerminal ? { roomTerminal: true } : {}),
    };
  }

  private readTraffic(challengeId: string, attemptId: string): Record<string, unknown> {
    const live = this.live.get(attemptId);
    if (!live) return { error: "attempt is not live", count: 0 };
    const awd = this.platform.awdStatus(challengeId);
    if (!awd?.sniffing) return { count: 0, reason: "no tap" };
    const frames = this.platform.releasedTraffic(challengeId);
    const locator = path.join(live.workspace, "artifacts", `traffic-${Date.now()}.jsonl`);
    fs.mkdirSync(path.dirname(locator), { recursive: true });
    fs.writeFileSync(locator, frames.map((row) => JSON.stringify(row)).join("\n") + (frames.length ? "\n" : ""), "utf8");
    return { count: frames.length, locator, sniffing: true };
  }

  private scopedHost(
    challengeId: string,
    containerId: string,
    attemptId: string,
    generation: number,
    capability: string,
  ): HostBridge {
    return {
      invoke: async (method, payload) => {
        const live = this.live.get(attemptId);
        if (!live) throw new Error("attempt is not live");
        const blocked = ctfSubmitBlocked(live.spec, method);
        if (blocked) return blocked;
        this.gate.authorize(
          capability,
          method,
          { challengeId, containerId, attemptId, generation },
          this.roomCapabilityClock(challengeId),
        );
        return this.invokeAuthorized(live, method, payload);
      },
    };
  }

  private async invokeAuthorized(
    live: LiveAttempt,
    method: HostRpcMethod,
    payload: Record<string, unknown>,
    actorCursor?: string,
  ): Promise<Record<string, unknown>> {
    const challengeId = live.spec.challengeId;
    const attemptId = live.attemptId;
    if (
      method === "contest_list" ||
      method === "contest_start" ||
      method === "queue_target" ||
      method === "mission_status" ||
      method === "review_room_allocation" ||
      method === "record_target_result" ||
      method === "resolve_room_request" ||
      method === "mission_done"
    ) {
      const binding = this.missionCommanderBindings.get(challengeId);
      if (!binding) throw new Error("mission commander control is not available");
      return binding.invoke(method, payload);
    }
    if (
      method === "graph_overview" ||
      method === "graph_query" ||
      method === "intel_record" ||
      method === "exploration_update"
    ) {
      const binding = this.roomGraphBindings.get(challengeId);
      if (!binding) throw new Error("room graph is not available");
      return binding.invoke(method, payload, { attemptId, ...(actorCursor ? { memberId: actorCursor } : {}) });
    }
    if (method === "room_info" || method === "challenge_info") {
      const spec = live.spec;
      const ch = this.ledger.challenge(challengeId);
      const acceptanceKind = acceptanceKindOf(spec);
      const awd = this.platform.awdStatus(challengeId);
      const acceptanceMode =
        acceptanceKind === "ctf" ? (spec.acceptanceMode ?? "platform") : undefined;
      const operatorPaced = this.operatorPaced(challengeId);
      const pendingMoves = this.operators.view(challengeId).filter((row) => row.status === "pending");
      const v2 = this.publicIntelStore(challengeId);
      const v2Summary = v2.summary(challengeId);
      const formalMemberId =
        this.officialTeamGates.has(challengeId) && actorCursor ? actorCursor : undefined;
      const memberId =
        formalMemberId ?? this.roomMemberBindings.get(challengeId)?.memberIdForAttempt(attemptId);
      // room_info.changeNotices stay formal-member-only. Independent Groups persist
      // read receipts and can query pendingNoticesForReader, but do not get this wake surface.
      const intelNotices =
        memberId && (formalMemberId !== undefined || process.env.SILVER_ROOM_MEMBERS === "1")
          ? v2.pendingNoticesForMember(challengeId, memberId)
          : [];
      // Current authority is v2 only — legacy auto rows appear as active v2 projections (migrated).
      // Hide sole-producer rows from the author (same rule as publicIntelFor); strip producerAttempt.
      const legacyAutoItems = v2
        .list(challengeId)
        .filter((row) => row.legacy)
        .filter((row) => {
          if (row.authorAttemptId !== attemptId) return true;
          const v1 = this.pool(challengeId)
            .internal(challengeId)
            .find((item) => item.id === row.intelId);
          return Boolean(v1?.alsoSeenBy.some((id) => id !== attemptId));
        })
        .map((row) => {
          const projected = v2.projectCurrent(row);
          const { producerAttempt: _omit, ...rest } = projected as Record<string, unknown> & {
            producerAttempt?: string;
          };
          return rest;
        });
      const acceptanceProgress =
        acceptanceKind === "ctf" &&
        (Boolean(this.contestSubmit) || this.platformReviewRecords(challengeId).length > 0)
          ? this.acceptanceProgressFor(challengeId)
          : undefined;
      const slotFields =
        acceptanceKind === "ctf" &&
        acceptanceMode === "platform" &&
        !this.contestSubmit &&
        spec.challengeBundle?.task?.indexes?.flagCount !== undefined
          ? { remainingFlags: ch.remaining_flags }
          : {};
      const hintAvailable = this.hintAvailable(spec);
      const taskMaterial = spec.challengeBundle?.task
        ? taskMaterialForHintAvailability(spec.challengeBundle.task, hintAvailable)
        : taskMaterialFromPlatform({
            addresses: [spec.targetUrl],
            endpoints: /^https?:\/\//i.test(spec.targetUrl) ? [spec.targetUrl] : [],
            ...(acceptanceKind === "ctf" ? { flagCount: ch.flag_count } : {}),
          });
      const taskMaterialReader = `${challengeId}:${formalMemberId ?? attemptId}`;
      const includeTaskMaterial = payload.includeTaskMaterial === true || !this.taskMaterialDelivered.has(taskMaterialReader);
      this.taskMaterialDelivered.add(taskMaterialReader);
      return {
        challengeId,
        ...(acceptanceProgress ? { acceptanceProgress } : {}),
        ...(includeTaskMaterial ? { taskMaterial } : {}),
        acceptanceContract: spec.acceptanceContract ?? acceptanceContractFor(spec),
        materialsRef: "challenge-materials.txt",
        taskMaterialDelivery: includeTaskMaterial ? "full" : "reference",
        availableCapabilities: availableCapabilitiesFor(
          Boolean(spec.swarmRoom || formalMemberId),
          Boolean(this.contestSubmit) || this.localCandidateTools,
          Boolean(this.contestVerify) || this.localCandidateTools,
          hintAvailable,
          spec.roomGraph === true,
          Boolean(this.contestRestart),
        ),
        ...slotFields,
        autonomy: this.ledger.missionAutonomy(spec.missionId),
        ...(spec.track ? { track: spec.track } : {}),
        ...(acceptanceMode ? { acceptanceMode } : {}),
        workspace: {
          cwd: ".",
          scratchDir: "scratch",
          attemptArtifactsRoot: path.join(live.workspace, "artifacts"),
          evidenceHint: artifactRefEscapeGuidance(path.join(live.workspace, "artifacts")),
        },
        publicIntel: {
          activeCount: v2Summary.activeCount,
          challengedCount: v2Summary.challengedCount,
          retractedCount: v2Summary.retractedCount,
          commentCount: v2Summary.commentCount,
          ...(intelNotices.length ? { changeNotices: intelNotices } : {}),
          ...(legacyAutoItems.length ? { legacyAutoItems } : {}),
        },
        ...(operatorPaced ? { operatorPaced } : {}),
        ...(pendingMoves.length > 0 ? { pendingMoves } : {}),
        ...((spec.track === "awd" || spec.track === "agent-awd")
          ? {
              awdRoles: [...AWD_ROLES],
              role: live.variant.role ?? "attacker",
            }
          : {}),
        ...(spec.inScopeUrls ? { inScopeUrls: spec.inScopeUrls } : {}),
        ...(spec.inScopeAgentUrls ? { inScopeAgentUrls: spec.inScopeAgentUrls } : {}),
        ...(hintAvailable ? { hintPolicy: "open" as const } : {}),
        ...(includeTaskMaterial && spec.availableSkills && spec.availableSkills.length > 0
          ? {
              availableSkills: {
                items: spec.availableSkills.slice(0, 12).map((row) => ({
                  name: row.name,
                  description: compactSkillDescription(row.description),
                })),
              },
            }
          : {}),
        ...(spec.previousRoot
          ? {
              previousRoot: spec.previousRoot,
            }
          : {}),
        ...(awd ? { awd } : {}),
        ...this.roomProjectionChallengeInfoSlice(challengeId, attemptId),
        ...this.swarmRoomChallengeInfo(live),
      };
    }
    if (method === "request_hint") {
      const policy = live.spec.hintPolicy ?? "off";
      if (!this.hintAvailable(live.spec)) {
        return { error: policy === "open" ? "hint_adapter_unavailable" : "hints_disabled", hintPolicy: policy };
      }
      const result = this.contestHint
        ? await this.contestHint({ challengeId })
        : await this.platform.requestHint(challengeId);
      if (!result.ok) return { error: result.error, hintPolicy: policy };
      return {
        hint: result.hint,
        ...(result.remaining !== undefined ? { remaining: result.remaining } : {}),
        hintPolicy: policy,
      };
    }
    if (method === "restart_challenge") {
      if (acceptanceKindOf(live.spec) !== "ctf" || !this.contestRestart) {
        return { error: "restart_unavailable" };
      }
      return await this.contestRestart({ challengeId, attemptId });
    }
    if (method === "verify_candidate") {
      const rawValue = (payload as { raw?: unknown }).raw;
      if (typeof rawValue !== "string" || rawValue.trim() === "") {
        return { oracle: "fail", reason: "candidate raw missing" };
      }
      if (this.contestVerify) {
        return await this.contestVerify({ challengeId, raw: rawValue });
      }
      const mappedRef = mapCellArtifactRef(String(payload.artifactRef ?? ""), live.spec.workspace);
      const candidate = { ...(payload as unknown as CandidateRef), artifactRef: mappedRef };
      const bound = bindFingerprint(candidate);
      const spec = live.spec;
      const artifactsRoot = this.officialTeamGates.has(challengeId)
        ? officialTeamArtifactsRoot(live, mappedRef)
        : artifactsRootFor(live, mappedRef);
      let result = verifyCandidate(candidate, {
        artifactsRoot,
        attemptRoot: live.workspace,
        flagPolicy: compileFlagPolicy(flagPatternOrAny(spec.flagPattern)),
      });
      if (result.oracle === "pass" && spec.checkerArgv && spec.checkerArgv.length > 0) {
        const ran = await runJailedChecker({
          argv: spec.checkerArgv,
          challengeRoot: spec.workspace,
          attemptRoot: live.workspace,
          raw: candidate.raw ?? "",
        });
        if (!ran.ok) {
          result = { oracle: "fail", reason: ran.reason, ...(result.evidenceRef ? { evidenceRef: result.evidenceRef } : {}) };
        } else {
          result = { oracle: "pass", reason: ran.reason, ...(result.evidenceRef ? { evidenceRef: result.evidenceRef } : {}) };
        }
      }
      this.ledger.recordOracle({
        challengeId,
        attemptId,
        candidateRef: candidate.candidateId,
        fingerprint: bound.ok ? bound.fingerprint : fingerprintCandidate(candidate.raw ?? ""),
        oracle: result.oracle,
        reason: result.reason,
        ...(result.evidenceRef ? { evidenceRef: result.evidenceRef } : {}),
      });
      if (result.oracle === "pass" && bound.ok) {
        if (candidate.raw) this.rememberPassedRaw(challengeId, bound.fingerprint, candidate.raw);
      }
      const attemptArtifactsRoot = path.join(live.workspace, "artifacts");
      const escaped =
        result.oracle === "fail" && String(result.reason).includes("escapes attempt artifacts root");
      const preflightNote =
        result.oracle === "pass"
          ? "Preflight passed; artifact reference is valid. Candidate correctness is only the platform verdict."
          : undefined;
      return {
        ...(result as unknown as Record<string, unknown>),
        attemptArtifactsRoot,
        ...(preflightNote ? { guidance: preflightNote, message: preflightNote } : {}),
        ...(escaped
          ? {
              guidance: artifactRefEscapeGuidance(attemptArtifactsRoot),
              message: artifactRefEscapeGuidance(attemptArtifactsRoot),
            }
          : {}),
      };
    }
    if (method === "submit_candidate") {
      const submitted = payload as unknown as CandidateSubmitInput;
      const raw = typeof submitted.raw === "string" ? submitted.raw : "";
      let fingerprint: string;
      if (this.contestSubmit) {
        fingerprint = createHash("sha256").update(raw, "utf8").digest("hex");
      } else {
        const bound = bindFingerprint({ raw });
        if (!bound.ok) return { status: "rejected", reason: bound.reason };
        fingerprint = bound.fingerprint;
      }
      const candidate: CandidateRef = {
        raw,
        fingerprint,
        candidateId: `raw-${fingerprint.slice(0, 16)}`,
        artifactRef: "",
        shape: "raw",
      };
      const submittedByMemberId =
        actorCursor ?? this.authorContext(challengeId, attemptId).authorMemberId;
      if (!this.contestSubmit && !this.ledger.hasOraclePass(challengeId, attemptId, fingerprint)) {
        return {
          status: "rejected",
          reason: "submit requires a matching preflight pass; candidate correctness is only the platform verdict",
        };
      }
      if (!this.contestSubmit && this.operatorPaced(challengeId)) {
        return this.queueOperatorMove({
          challengeId,
          attemptId,
          kind: "attack_submit",
          summary: "submit candidate",
          fingerprint,
          candidate,
          ...(submittedByMemberId ? { submittedByMemberId } : {}),
        });
      }
      return this.submitNow(challengeId, attemptId, candidate, fingerprint, submittedByMemberId);
    }
    if (method === "room_feed_post") {
      return this.roomFeedPost(live, payload);
    }
    if (method === "room_feed_read") {
      return this.roomFeedRead(live, payload);
    }
    if (method === "room_status_set") {
      return this.roomStatusSet(live, payload);
    }
    if (method === "room_status_read") {
      return this.roomStatusRead(live);
    }
    if (method === "intel_read") {
      return this.intelReadV2(challengeId, attemptId, payload);
    }
    if (method === "intel_publish") {
      return await this.intelPublishV2(challengeId, attemptId, payload);
    }
    if (method === "intel_update") {
      return await this.intelUpdateV2(challengeId, attemptId, payload);
    }
    // Hidden legacy RPC aliases for an already-running pre-migration plugin.
    if (method === "intel_comment") {
      return this.intelCommentV2(challengeId, attemptId, payload);
    }
    if (method === "intel_revise") {
      return await this.intelReviseV2(challengeId, attemptId, payload);
    }
    if (method === "intel_retract") {
      return await this.intelRetractV2(challengeId, attemptId, payload);
    }
    if (method === "ask_skeptic") {
      return this.runSkeptic(attemptId) as unknown as Record<string, unknown>;
    }
    if (method === "set_room_deadline") {
      const handler = this.roomDeadlineHandlers.get(challengeId);
      if (!handler) throw new Error("room deadline control is not available for this challenge");
      const deadlineAtMs = Number(payload.deadlineAtMs);
      if (!Number.isFinite(deadlineAtMs)) throw new Error("set_room_deadline requires numeric deadlineAtMs");
      return handler(deadlineAtMs);
    }
    throw new Error(`unsupported method ${method}`);
  }

  /**
   * C1: deterministic Room Projection index on room_info.
   * Uses RoomProjectionBinding only — never formal Member binding.
   * Product key is memberId; attemptId/sessionId are runtime bindings only.
   */
  private roomProjectionChallengeInfoSlice(challengeId: string, attemptId: string): Record<string, unknown> {
    if (this.officialTeamGates.has(challengeId)) return {};
    const binding = this.roomProjectionBindings.get(challengeId);
    if (!binding) return {};
    if (!binding.memberIdForAttempt(attemptId)) return {};
    const projection = this.rebuildRoomProjection(challengeId);
    if (!projection) return {};
    const live = this.live.get(attemptId);
    const attemptArtifactsRoot = live ? path.join(live.workspace, "artifacts") : projection.attemptArtifactsRoot;
    const slice = roomProjectionChallengeInfo({
      ...projection,
      ...(attemptArtifactsRoot ? { attemptArtifactsRoot } : {}),
    });
    return { roomProjection: slice };
  }

  private rebuildRoomProjection(challengeId: string): RoomProjection | undefined {
    const binding = this.roomProjectionBindings.get(challengeId);
    if (!binding) return undefined;
    const facts = this.collectRoomProjectionFacts(challengeId);
    if (!facts) return undefined;
    const prior = this.roomProjectionPriors.get(challengeId);
    const input = foldRoomProjectionFacts(facts, {
      ...(prior?.version ? { priorVersion: prior.version } : {}),
      ...(prior?.sectionDigests ? { priorSectionDigests: prior.sectionDigests } : {}),
    });
    const latestCheckpoint = this.projectRooms.get(challengeId)?.latestCheckpoint();
    const projection = buildRoomProjection({
      ...input,
      ...(latestCheckpoint
        ? {
            latestCheckpoint: {
              confirmedFacts: latestCheckpoint.confirmedFacts,
              triedScope: latestCheckpoint.triedScope,
              failedHypothesis: latestCheckpoint.failedHypothesis,
              likelyRoute: latestCheckpoint.likelyRoute,
              nextVariables: latestCheckpoint.nextVariables,
              messageId: latestCheckpoint.messageId,
              createdAt: latestCheckpoint.createdAt,
            },
          }
        : {}),
    });
    this.roomProjectionPriors.set(challengeId, {
      version: projection.version,
      sectionDigests: projection.sectionDigests,
    });
    return projection;
  }

  private collectRoomProjectionFacts(challengeId: string): RoomProjectionFact[] | undefined {
    const binding = this.roomProjectionBindings.get(challengeId);
    if (!binding) return undefined;
    const liveForArtifacts = this.liveFor(challengeId)[0];
    const attemptArtifactsRoot = liveForArtifacts ? path.join(liveForArtifacts.workspace, "artifacts") : undefined;
    const facts: RoomProjectionFact[] = [
      {
        kind: "meta",
        roomId: binding.roomId,
        challengeId,
        objective: `solve ${challengeId}`,
        ...(attemptArtifactsRoot ? { attemptArtifactsRoot } : {}),
      },
    ];

    const clock = readRoomClock(roomClockPath(binding.roomClockDir, binding.roomId));
    if (clock) {
      const nowMs = Date.now();
      facts.push({
        kind: "deadline",
        startedAt: clock.startedAt,
        deadlineAt: clock.deadlineAt,
        budgetMs: clock.budgetMs,
        remainingMs: Math.max(0, Date.parse(clock.deadlineAt) - nowMs),
        expired: Date.parse(clock.deadlineAt) <= nowMs,
        ...(clock.unbounded ? { unbounded: true as const } : {}),
        updatedAt: clock.deadlineAt,
      });
    }

    const platformSnap = binding.platformSnapshot?.();
    if (platformSnap) {
      facts.push({
        kind: "platform",
        status: mapProjectRuntimeStatusToPlatform(String(platformSnap.status)),
        ...(platformSnap.reason ? { reason: platformSnap.reason } : {}),
      });
    } else {
      // Binding present but no Host surface yet — active only. Never invent completed from Ledger flags.
      facts.push({ kind: "platform", status: "active" });
    }

    const rosterFile = readRoomMembers(roomMembersPath(binding.roomClockDir, challengeId));
    const byMemberId = new Map((rosterFile?.members ?? []).map((row) => [row.memberId, row]));
    const room = this.projectRoom(challengeId);
    const liveAttempts = this.liveFor(challengeId);
    const siblingIds = liveAttempts.map((row) => row.attemptId);
    const statusByAttempt = new Map(
      (room?.statusCards(siblingIds) ?? []).map((row) => [row.attemptId, row] as const),
    );

    for (const snap of binding.membersSnapshot()) {
      const durable = byMemberId.get(snap.memberId);
      const attemptId =
        snap.attemptId ??
        durable?.attemptId ??
        liveAttempts.find((row) => binding.memberIdForAttempt(row.attemptId) === snap.memberId)?.attemptId;
      const sessionId = snap.dshSessionId ?? durable?.dshSessionId;
      const statusCard = attemptId ? statusByAttempt.get(attemptId) : undefined;
      const updatedAt = snap.updatedAt ?? durable?.updatedAt ?? statusCard?.updatedAt;
      const memberFact: Extract<RoomProjectionFact, { kind: "member" }> = {
        kind: "member",
        memberId: snap.memberId,
        role: snap.role,
        status: snap.status,
      };
      if (attemptId) memberFact.attemptId = attemptId;
      if (sessionId) memberFact.sessionId = sessionId;
      if (statusCard?.approach) memberFact.approach = statusCard.approach;
      if (statusCard?.lastTool) memberFact.lastTool = statusCard.lastTool;
      if (updatedAt) memberFact.updatedAt = updatedAt;
      facts.push(memberFact);
    }

    const v2 = this.publicIntelStore(challengeId);
    for (const row of v2.list(challengeId)) {
      const current =
        row.versions.find((version) => version.version === row.currentVersion) ??
        row.versions[row.versions.length - 1];
      const artifactRef =
        current?.evidence.find((ev) => ev.kind === "artifact")?.ref ??
        current?.evidence[0]?.ref ??
        `intel/${row.intelId}`;
      const producerMemberId =
        row.authorMemberId ??
        binding.memberIdForAttempt(row.authorAttemptId) ??
        row.authorAttemptId;
      facts.push({
        kind: "evidence",
        intelId: row.intelId,
        evidenceKind: row.legacy?.kind ?? "observation",
        artifactRef,
        producerMemberId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }

    for (const row of this.candidateRecords(challengeId)) {
      facts.push({
        kind: "candidate",
        fingerprint: row.fingerprint,
        oracle: row.oracle,
        ...(row.submission ? { submission: row.submission } : {}),
        ...(row.evidenceRef ? { evidenceRef: row.evidenceRef } : {}),
      });
    }

    for (const row of this.platformReviewRecords(challengeId)) {
      facts.push({
        kind: "review",
        fingerprint: row.fingerprint,
        status: row.status,
        reviewedAt: row.reviewedAt,
        ...(row.submittedByMemberId ? { submittedByMemberId: row.submittedByMemberId } : {}),
        ...(row.candidateId ? { candidateId: row.candidateId } : {}),
        ...(row.awarded !== undefined ? { awarded: row.awarded } : {}),
        ...(row.correctFlagCount !== undefined ? { correctFlagCount: row.correctFlagCount } : {}),
        ...(row.totalFlagCount !== undefined ? { totalFlagCount: row.totalFlagCount } : {}),
        ...(row.platformCompleted !== undefined ? { platformCompleted: row.platformCompleted } : {}),
        ...(row.artifactRef ? { artifactRef: row.artifactRef } : {}),
        ...(row.priorStatus ? { priorStatus: row.priorStatus } : {}),
      });
    }

    return facts;
  }

  private authorContext(challengeId: string, attemptId: string, member?: NativeSessionMember): {
    authorAttemptId: string;
    authorMemberId?: string;
  } {
    if (member) {
      return { authorAttemptId: member.sessionId, authorMemberId: member.memberId };
    }
    const authorMemberId =
      this.roomMemberBindings.get(challengeId)?.memberIdForAttempt(attemptId) ??
      this.roomProjectionBindings.get(challengeId)?.memberIdForAttempt(attemptId);
    return {
      authorAttemptId: attemptId,
      ...(authorMemberId ? { authorMemberId } : {}),
    };
  }

  private readerPrincipal(challengeId: string, attemptId: string): {
    kind: "member" | "group";
    id: string;
    attemptId: string;
  } {
    const memberId = this.roomMemberBindings.get(challengeId)?.memberIdForAttempt(attemptId);
    if (memberId) return { kind: "member", id: memberId, attemptId };
    return { kind: "group", id: attemptId, attemptId };
  }

  private parseEvidence(raw: unknown): PublicIntelEvidenceRef[] {
    if (!Array.isArray(raw)) return [];
    const out: PublicIntelEvidenceRef[] = [];
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const kind = String((row as { kind?: string }).kind ?? "").trim();
      const ref = String((row as { ref?: string }).ref ?? "").trim();
      if ((kind === "artifact" || kind === "tool_call" || kind === "path") && ref) {
        out.push({ kind, ref });
      }
    }
    return out;
  }

  private parseIntelLinks(raw: unknown): PublicIntelLink[] {
    if (!Array.isArray(raw)) return [];
    const out: PublicIntelLink[] = [];
    const seen = new Set<string>();
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const intelId = String((row as { intelId?: string }).intelId ?? "").trim();
      const relation = String((row as { relation?: string }).relation ?? "").trim();
      const key = `${intelId}\u0000${relation}`;
      if (!intelId || !relation || seen.has(key)) continue;
      seen.add(key);
      out.push({ intelId, relation });
    }
    return out;
  }

  private parseIntelTags(raw: unknown, maxTags = 3): PublicIntelTag[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Error("intel tags must be an array");
    const allowed = new Set<PublicIntelTag>(["asset", "identity", "access", "capability"]);
    const tags = [...new Set(raw.map((value) => String(value).trim()).filter(Boolean))];
    if (tags.length > maxTags) throw new Error(`intel tags supports at most ${maxTags} labels`);
    for (const tag of tags) {
      if (!allowed.has(tag as PublicIntelTag)) throw new Error(`unknown intel tag ${tag}`);
    }
    return tags as PublicIntelTag[];
  }

  private assertIntelLinks(
    store: PublicIntelStore,
    challengeId: string,
    links: readonly PublicIntelLink[],
    selfIntelId?: string,
  ): void {
    for (const link of links) {
      if (link.intelId === selfIntelId) throw new Error("intel link cannot point to itself");
      const target = store.get(link.intelId);
      if (!target || target.challengeId !== challengeId) {
        throw new Error(`intel link target not found in this room: ${link.intelId}`);
      }
    }
  }

  /**
   * Bind producer-local evidence into a room-shared intel/evidence path so other members
   * can re-read the same bytes via read_artifact / bash without borrowing private cwd.
   */
  private bindEvidenceForPublish(
    challengeId: string,
    attemptId: string,
    evidence: PublicIntelEvidenceRef[],
  ): PublicIntelEvidenceRef[] {
    if (evidence.length === 0) return evidence;
    const live = this.live.get(attemptId);
    const spec = this.requireChallengeSpec(challengeId);
    const challengeRoot = fs.realpathSync(spec.workspace);
    const intelDir = directoryWithin(challengeRoot, path.join(challengeRoot, "intel"));
    const sharedDir = directoryWithin(challengeRoot, path.join(intelDir, "evidence"));
    const allowedRoots = [challengeRoot];
    if (live) {
      const attemptRoot = fs.realpathSync(live.workspace);
      if (!pathIsWithin(challengeRoot, attemptRoot)) {
        throw new Error("intel evidence producer attempt workspace escapes the challenge workspace");
      }
      allowedRoots.unshift(attemptRoot);
    }
    const out: PublicIntelEvidenceRef[] = [];
    for (const row of evidence) {
      if (row.kind === "tool_call") {
        out.push(row);
        continue;
      }
      const mappedRef = mapCellArtifactRef(row.ref, challengeRoot);
      const candidates = path.isAbsolute(mappedRef)
        ? [mappedRef]
        : [
            live ? path.resolve(live.workspace, mappedRef) : "",
            path.resolve(challengeRoot, mappedRef),
            live ? path.resolve(live.workspace, "artifacts", path.basename(mappedRef)) : "",
          ].filter(Boolean);
      let source: string | undefined;
      for (const candidate of candidates) {
        try {
          const resolved = fs.realpathSync(candidate);
          if (fs.statSync(resolved).isFile() && allowedRoots.some((root) => pathIsWithin(root, resolved))) {
            source = resolved;
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (!source) {
        throw new Error(
          `intel evidence not found under the producer attempt or challenge workspace for ${row.kind}:${row.ref}`,
        );
      }
      let sourceFd: number | undefined;
      let sourceBytes: Buffer;
      try {
        sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(sourceFd);
        const resolved = fs.realpathSync(source);
        const current = fs.statSync(resolved);
        if (
          !opened.isFile() ||
          !allowedRoots.some((root) => pathIsWithin(root, resolved)) ||
          opened.dev !== current.dev ||
          opened.ino !== current.ino
        ) {
          throw new Error("intel evidence changed while it was being bound");
        }
        sourceBytes = fs.readFileSync(sourceFd);
      } finally {
        if (sourceFd !== undefined) fs.closeSync(sourceFd);
      }
      const digest = createHash("sha256").update(sourceBytes).digest("hex").slice(0, 24);
      const destName = `${digest}-${path.basename(source)}`;
      const dest = path.join(sharedDir, destName);
      try {
        fs.writeFileSync(dest, sourceBytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = fs.realpathSync(dest);
        if (!pathIsWithin(sharedDir, existing) || !fs.statSync(existing).isFile()) {
          throw new Error("intel evidence destination escapes the shared evidence directory");
        }
        if (!fs.readFileSync(existing).equals(sourceBytes)) {
          throw new Error("intel evidence destination does not match the bound evidence");
        }
      }
      out.push({
        kind: "artifact",
        ref: path.relative(challengeRoot, dest).split(path.sep).join("/"),
      });
    }
    return out;
  }

  private async intelPublishV2(
    challengeId: string,
    attemptId: string,
    payload: Record<string, unknown>,
    member?: NativeSessionMember,
  ): Promise<Record<string, unknown>> {
    const observation = String(payload.observation ?? "").trim();
    const explicitPolarity =
      member || payload.polarity === undefined ? undefined : String(payload.polarity).trim();
    const rawEvidence = this.parseEvidence(payload.evidence);
    const evidence = this.bindEvidenceForPublish(challengeId, attemptId, rawEvidence);
    const toolCallId = evidence.find((row) => row.kind === "tool_call")?.ref;
    const artifactRef = evidence.find((row) => row.kind === "artifact" || row.kind === "path")?.ref;
    const gate = promoteGate({
      source: "member_publish",
      text: observation,
      ...(artifactRef ? { artifactRef } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    });
    if (!gate.ok) throw new Error(`intel_publish rejected: ${gate.reason}`);
    const polarityRaw = explicitPolarity ?? "uncertain";
    const polarity = (
      polarityRaw === "positive" || polarityRaw === "negative" || polarityRaw === "uncertain"
        ? polarityRaw
        : "uncertain"
    ) as IntelPolarity;
    const author = member
      ? { authorAttemptId: member.sessionId, authorMemberId: member.memberId }
      : this.authorContext(challengeId, attemptId);
    const store = this.publicIntelStore(challengeId);
    const tags = this.parseIntelTags(payload.tags);
    const links = this.parseIntelLinks(payload.links);
    this.assertIntelLinks(store, challengeId, links);
    const formalMemberIds = this.officialTeamMemberIds(challengeId);
    const eligibleMemberIds = formalMemberIds.length > 0
      ? formalMemberIds
      : (this.roomMemberBindings.get(challengeId)?.membersSnapshot() ?? [])
          .filter(
            (row) =>
              row.status !== "terminal" &&
              row.status !== "interrupted" &&
              row.status !== "blocked" &&
              row.status !== "stopped",
          )
          .map((row) => row.memberId);
    const notifyMemberIds = author.authorMemberId
      ? eligibleMemberIds.filter((memberId) => memberId !== author.authorMemberId)
      : [];
    const result = store.publish({
      challengeId,
      ...author,
      observation,
      ...(tags.length ? { tags } : {}),
      ...(String(payload.conditions ?? "").trim()
        ? { conditions: String(payload.conditions).trim() }
        : {}),
      evidence,
      ...(links.length ? { links } : {}),
      polarity,
      ...(String(payload.clientRequestId ?? "").trim()
        ? { clientRequestId: String(payload.clientRequestId).trim() }
        : {}),
      ...(notifyMemberIds.length > 0 ? { notifyMemberIds } : {}),
    });
    if (!result.ok) throw new Error(`intel_publish failed: ${result.reason}`);
    const officialIntel = this.officialTeamGates.has(challengeId);
    const teamNotice = officialIntel
      ? this.officialIntelTeamNotice(challengeId, result.record.intelId, author.authorMemberId)
      : undefined;
    if (!result.duplicate && notifyMemberIds.length > 0) {
      this.emitIntelChangeNotices(challengeId, result.record.intelId);
    }
    // Note even on duplicate so a prior C2 write failure can be repaired by retry.
    await this.noteConvergenceTrigger(challengeId, {
      eventId: `intel_changed:${result.record.intelId}:v${result.record.currentVersion}`,
      kind: "intel_changed",
      subjectRef: result.record.intelId,
      version: String(result.record.currentVersion),
    });
    // Structured progress resets only the legacy non-formal stall lease.
    if (!result.duplicate) this.noteStallLeaseProgress(challengeId, "intel");
    return {
      saved: true,
      duplicate: result.duplicate,
      ...store.projectCurrent(result.record),
      evidenceBound: evidence,
      ...(teamNotice ? { teamNotice } : {}),
    };
  }

  private intelCommentV2(
    challengeId: string,
    attemptId: string,
    payload: Record<string, unknown>,
    member?: NativeSessionMember,
  ): Record<string, unknown> {
    const author = this.authorContext(challengeId, attemptId, member);
    const store = this.publicIntelStore(challengeId);
    const notifyMemberIds = author.authorMemberId
      ? this.officialTeamMemberIds(challengeId).filter((memberId) => memberId !== author.authorMemberId)
      : [];
    const aboutVersion = Number(payload.aboutVersion);
    const markChallenged = payload.action === "challenge";
    const evidence = this.bindEvidenceForPublish(challengeId, attemptId, this.parseEvidence(payload.evidence));
    const result = store.comment({
      challengeId,
      intelId: String(payload.intelId ?? "").trim(),
      body: String(payload.body ?? ""),
      ...author,
      ...(Number.isFinite(aboutVersion) ? { aboutVersion } : {}),
      evidence,
      ...(markChallenged ? { markChallenged: true } : {}),
      ...(String(payload.clientRequestId ?? "").trim()
        ? { clientRequestId: String(payload.clientRequestId).trim() }
        : {}),
      ...(notifyMemberIds.length ? { notifyMemberIds } : {}),
    });
    if (!result.ok) throw new Error(`intel_${markChallenged ? "challenge" : "comment"} failed: ${result.reason}`);
    const officialIntel = this.officialTeamGates.has(challengeId);
    const teamNotice = officialIntel
      ? this.officialIntelCommentTeamNotice(
          challengeId,
          result.record.intelId,
          result.comment.commentId,
          author.authorMemberId,
        )
      : undefined;
    return {
      saved: true,
      duplicate: result.duplicate,
      commentId: result.comment.commentId,
      intelId: result.record.intelId,
      aboutVersion: result.comment.aboutVersion,
      status: result.record.status,
      note: markChallenged
        ? "Evidence-backed challenge saved; the observation remains readable but disputed until its author revises or retracts it"
        : "Comment saved; does not edit the observation body or change platform accepted",
      ...(teamNotice ? { teamNotice } : {}),
    };
  }

  /** Thin model-surface router; storage, authorization, receipts, and notices stay on the existing operations. */
  private async intelUpdateV2(
    challengeId: string,
    attemptId: string,
    payload: Record<string, unknown>,
    member?: NativeSessionMember,
  ): Promise<Record<string, unknown>> {
    const action = String(payload.action ?? "").trim();
    if (action === "comment" || action === "challenge") return this.intelCommentV2(challengeId, attemptId, payload, member);
    if (action === "revise") return this.intelReviseV2(challengeId, attemptId, payload, member);
    if (action === "retract") return this.intelRetractV2(challengeId, attemptId, payload, member);
    throw new Error("intel_update requires action=comment|challenge|revise|retract");
  }

  private async intelReviseV2(
    challengeId: string,
    attemptId: string,
    payload: Record<string, unknown>,
    member?: NativeSessionMember,
  ): Promise<Record<string, unknown>> {
    const explicitPolarity =
      member || payload.polarity === undefined ? undefined : String(payload.polarity).trim();
    const author = this.authorContext(challengeId, attemptId, member);
    const store = this.publicIntelStore(challengeId);
    const expectedVersion = Number(payload.expectedVersion);
    if (!Number.isFinite(expectedVersion)) throw new Error("intel_revise requires expectedVersion");
    const tags = payload.tags === undefined ? undefined : this.parseIntelTags(payload.tags);
    const links = payload.links === undefined ? undefined : this.parseIntelLinks(payload.links);
    if (links) this.assertIntelLinks(store, challengeId, links, String(payload.intelId ?? "").trim());
    const result = store.revise({
      challengeId,
      intelId: String(payload.intelId ?? "").trim(),
      expectedVersion,
      reason: String(payload.reason ?? ""),
      ...author,
      ...(String(payload.observation ?? "").trim()
        ? { observation: String(payload.observation).trim() }
        : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(String(payload.conditions ?? "").trim()
        ? { conditions: String(payload.conditions).trim() }
        : {}),
      ...(payload.evidence !== undefined
        ? {
            evidence: this.bindEvidenceForPublish(
              challengeId,
              attemptId,
              this.parseEvidence(payload.evidence),
            ),
          }
        : {}),
      ...(links !== undefined ? { links } : {}),
      ...(explicitPolarity
        ? {
            polarity: (["positive", "negative", "uncertain"].includes(explicitPolarity)
              ? explicitPolarity
              : "uncertain") as IntelPolarity,
          }
        : {}),
      ...(String(payload.clientRequestId ?? "").trim()
        ? { clientRequestId: String(payload.clientRequestId).trim() }
        : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        ...(result.record
          ? {
              currentVersion: result.record.currentVersion,
              current: store.projectCurrent(result.record),
            }
          : {}),
      };
    }
    const officialIntel = this.officialTeamGates.has(challengeId);
    const teamNotice = officialIntel
      ? this.officialIntelTeamNotice(challengeId, result.record.intelId, author.authorMemberId)
      : undefined;
    if (!result.duplicate) this.emitIntelChangeNotices(challengeId, result.record.intelId);
    // Note even on duplicate so a prior C2 write failure can be repaired by retry.
    await this.noteConvergenceTrigger(challengeId, {
      eventId: `intel_changed:${result.record.intelId}:v${result.record.currentVersion}`,
      kind: "intel_changed",
      subjectRef: result.record.intelId,
      version: String(result.record.currentVersion),
    });
    if (!result.duplicate) this.noteStallLeaseProgress(challengeId, "intel");
    return {
      saved: true,
      duplicate: result.duplicate,
      ...store.projectCurrent(result.record),
      ...(teamNotice ? { teamNotice } : {}),
    };
  }

  private async intelRetractV2(
    challengeId: string,
    attemptId: string,
    payload: Record<string, unknown>,
    member?: NativeSessionMember,
  ): Promise<Record<string, unknown>> {
    const author = this.authorContext(challengeId, attemptId, member);
    const store = this.publicIntelStore(challengeId);
    const expectedVersion = Number(payload.expectedVersion);
    if (!Number.isFinite(expectedVersion)) throw new Error("intel_retract requires expectedVersion");
    const result = store.retract({
      challengeId,
      intelId: String(payload.intelId ?? "").trim(),
      expectedVersion,
      reason: String(payload.reason ?? ""),
      ...author,
      ...(String(payload.clientRequestId ?? "").trim()
        ? { clientRequestId: String(payload.clientRequestId).trim() }
        : {}),
    });
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        ...(result.record
          ? {
              currentVersion: result.record.currentVersion,
              current: store.projectCurrent(result.record),
            }
          : {}),
      };
    }
    const officialIntel = this.officialTeamGates.has(challengeId);
    const teamNotice = officialIntel
      ? this.officialIntelTeamNotice(challengeId, result.record.intelId, author.authorMemberId)
      : undefined;
    if (!result.duplicate) this.emitIntelChangeNotices(challengeId, result.record.intelId);
    // Note even on duplicate so a prior C2 write failure can be repaired by retry.
    await this.noteConvergenceTrigger(challengeId, {
      eventId: `intel_changed:${result.record.intelId}:v${result.record.currentVersion}`,
      kind: "intel_changed",
      subjectRef: result.record.intelId,
      version: String(result.record.currentVersion),
    });
    return {
      saved: true,
      duplicate: result.duplicate,
      ...store.projectCurrent(result.record),
      ...(teamNotice ? { teamNotice } : {}),
    };
  }

  /**
   * Persist a C2 trigger as a replayable projection of an already-committed Host fact.
   * Callers must invoke this on both first-write and idempotent-duplicate paths so a
   * prior C2 failure can be repaired. Failures propagate — never fire-and-forget.
   */
  private async noteConvergenceTrigger(
    challengeId: string,
    trigger: {
      eventId: string;
      kind: ConvergenceTriggerKind;
      subjectRef?: string;
      version?: string;
    },
  ): Promise<void> {
    const binding = this.roomConvergenceBindings.get(challengeId);
    if (!binding) return;
    if (this.officialTeamGates.has(challengeId)) return;
    const noted = await noteRoomConvergenceTrigger({
      roomClockDir: binding.roomClockDir,
      roomId: binding.roomId,
      challengeId,
      trigger,
    });
    if (!noted.ok) {
      throw new Error(`convergence trigger refused: ${noted.reason}`);
    }
    if (
      trigger.kind === "platform_verdict_changed" &&
      (noted.outcome === "minted" || noted.outcome === "merged" || noted.outcome === "queued_for_next")
    ) {
      binding.onTriggerNoted?.({ kind: trigger.kind, outcome: noted.outcome });
    }
  }

  /** Official Team unread notice. No-op without the RPC gate, so solo/race stay on their own paths. */
  private notifySocial(challengeId: string, notice: RoomSocialNotice): void {
    if (!this.officialTeamGates.has(challengeId)) return;
    try {
      this.roomConvergenceBindings.get(challengeId)?.onSocialNotice?.({
        kind: notice.kind,
        ...(notice.exceptMemberId ? { exceptMemberId: notice.exceptMemberId } : {}),
        ...(notice.relay ? { relay: true } : {}),
      });
    } catch {
      /* the durable Feed/Intel/review already landed */
    }
  }

  /** Legacy non-formal stall lease progress. Official Teams coordinate through DSH Team events. */
  private noteStallLeaseProgress(challengeId: string, kind: string): void {
    if (this.officialTeamGates.has(challengeId)) return;
    if (!isStallProgress(kind)) return;
    this.roomConvergenceBindings.get(challengeId)?.onStallProgress?.(kind);
  }

  private officialIntelTeamNotice(
    challengeId: string,
    intelId: string,
    authorMemberId?: string,
  ): OfficialIntelTeamNotice | undefined {
    const store = this.publicIntelStore(challengeId);
    const record = store.get(intelId);
    if (!record) return undefined;
    const pending = new Set(store.memberIdsNeedingNotice(challengeId, intelId));
    // Intel stays durable and unread for every member. The DSH plugin may put a
    // no-wake marker into a currently resident member's next ordinary step;
    // Host does not judge relevance or route changes through the Lead.
    const pendingMemberIds = this.officialTeamMemberIds(challengeId).filter(
      (memberId) => memberId !== authorMemberId && pending.has(memberId),
    );
    return pendingMemberIds.length > 0
      ? {
          kind: "intel",
          pendingMemberIds,
          change: officialIntelNoticeChange(
            record,
            record.status === "retracted"
              ? "retracted"
              : record.status === "challenged"
                ? "challenged"
              : record.currentVersion === 1
                ? "published"
                : "revised",
          ),
        }
      : undefined;
  }

  private officialIntelCommentTeamNotice(
    challengeId: string,
    intelId: string,
    commentId: string,
    authorMemberId?: string,
  ): OfficialIntelTeamNotice | undefined {
    const store = this.publicIntelStore(challengeId);
    const record = store.get(intelId);
    const comment = record?.comments.find((row) => row.commentId === commentId);
    if (!record || !comment) return undefined;
    const pending = new Set(store.memberIdsNeedingCommentNotice(challengeId, intelId, commentId));
    const pendingMemberIds = this.officialTeamMemberIds(challengeId).filter(
      (memberId) => memberId !== authorMemberId && pending.has(memberId),
    );
    return pendingMemberIds.length > 0
      ? {
          kind: "intel",
          pendingMemberIds,
          change: officialIntelNoticeChange(record, comment.kind === "challenge" ? "challenged" : "commented", comment),
        }
      : undefined;
  }

  private emitIntelChangeNotices(challengeId: string, intelId: string): void {
    // Official Team delivery uses the typed DSH mailbox. Intel remains the
    // durable unread source; the legacy callback is for non-formal rooms.
    if (this.officialTeamGates.has(challengeId)) return;
    const binding = this.roomMemberBindings.get(challengeId);
    const store = this.publicIntelStore(challengeId);
    const record = store.get(intelId);
    if (!binding?.onIntelChange || !record) return;
    const memberIds = store.memberIdsNeedingNotice(challengeId, intelId);
    if (memberIds.length === 0) return;
    const notices = memberIds.flatMap((memberId) =>
      store.pendingNoticesForMember(challengeId, memberId).filter((row) => row.intelId === intelId),
    );
    // Dedupe notice payloads by member list; pass one notice shape per intel.
    const notice = {
      intelId: record.intelId,
      previousVersion: Math.min(...notices.map((row) => row.previousVersion)),
      currentVersion: record.currentVersion,
      status: record.status,
      kind:
        notices.some((row) => row.kind === "published")
          ? "published"
          : record.status === "retracted"
            ? "retracted"
            : "revised",
    };
    binding.onIntelChange({
      challengeId,
      intelId,
      memberIds,
      notices: [notice],
    });
  }

  pendingIntelNotices(challengeId: string, memberId: string) {
    return this.publicIntelStore(challengeId).pendingNoticesForMember(challengeId, memberId);
  }

  private intelReadV2(
    challengeId: string,
    attemptId: string,
    payload: Record<string, unknown>,
    member?: NativeSessionMember,
  ): Record<string, unknown> {
    const store = this.publicIntelStore(challengeId);
    const intelId = String(payload.intelId ?? "").trim();
    const includeRetracted = payload.includeRetracted === true;
    const includeHistory = payload.includeHistory === true;
    if (!intelId) {
      const query = String(payload.query ?? "").trim().toLowerCase();
      const tags = this.parseIntelTags(payload.tags, 4);
      const limit = payload.limit === undefined ? undefined : Number(payload.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
        throw new Error("intel_read limit must be an integer from 1 to 50");
      }
      const matched = store.list(challengeId, { includeRetracted }).filter((record) => {
        const projected = store.projectCurrent(record);
        const recordTags = Array.isArray(projected.tags) ? projected.tags : [];
        if (tags.length > 0 && !tags.some((tag) => recordTags.includes(tag))) return false;
        if (!query) return true;
        return JSON.stringify(projected).toLowerCase().includes(query);
      });
      const records = limit === undefined
        ? matched
        : [...matched]
            .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
            .slice(-limit);
      if (member) {
        for (const record of records) this.markNativeIntelRead(store, challengeId, record.intelId, record.currentVersion, member);
      }
      return {
        items: records.map((row) =>
          this.projectIntelForReader(challengeId, attemptId, store.projectCurrent(row)),
        ),
        legacyAutoItems: records
          .filter((row) => row.legacy)
          .map((row) => this.projectIntelForReader(challengeId, attemptId, store.projectCurrent(row))),
        totalMatched: matched.length,
        returned: records.length,
        hasMore: matched.length > records.length,
        note: limit === undefined
          ? "Listed matching summaries; use query/tags/limit or pass intelId for detail/history. Current status is v2-only. Not platform accepted."
          : "Listed the most recently updated matching summaries; narrow query/tags or pass intelId for detail/history. Current status is v2-only. Not platform accepted.",
      };
    }
    const record = store.get(intelId);
    if (!record || record.challengeId !== challengeId) throw new Error(`unknown intelId ${intelId}`);
    if (member) {
      this.markNativeIntelRead(
        store,
        challengeId,
        intelId,
        record.currentVersion,
        member,
        record.comments.map((comment) => comment.commentId),
      );
    } else {
      store.markRead({
        challengeId,
        intelId,
        version: record.currentVersion,
        reader: this.readerPrincipal(challengeId, attemptId),
        attemptId,
      });
    }
    const comments = record.comments.map(({ notifyMemberIds: _delivery, ...comment }) => comment);
    const related = store
      .list(challengeId)
      .filter((candidate) => {
        const current = candidate.versions.find((row) => row.version === candidate.currentVersion);
        if (candidate.intelId === intelId) return false;
        if (current?.links?.some((link) => link.intelId === intelId)) return true;
        const selected = record.versions.find((row) => row.version === record.currentVersion);
        return selected?.links?.some((link) => link.intelId === candidate.intelId) ?? false;
      })
      .map((candidate) =>
        this.projectIntelForReader(challengeId, attemptId, store.projectCurrent(candidate)),
      );
    return {
      current: this.projectIntelForReader(challengeId, attemptId, store.projectCurrent(record)),
      related,
      ...(includeHistory
        ? {
            history: record.versions.map(({ polarity: _polarity, ...version }) =>
              this.projectIntelForReader(challengeId, attemptId, version),
            ),
            comments: comments.map((comment) =>
              this.projectIntelForReader(challengeId, attemptId, comment),
            ),
          }
        : {
            comments: comments.map((comment) =>
              this.projectIntelForReader(challengeId, attemptId, comment),
            ),
          }),
      note: "Attribution is provenance, not a vote. Re-check before use.",
    };
  }

  /**
   * Keep durable Intel evidence in the Room, but give each reader an ordinary
   * attempt-local artifact locator. read_artifact remains jailed to the current
   * attempt and does not gain a second trust root.
   */
  private projectIntelForReader(
    challengeId: string,
    attemptId: string,
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!Array.isArray(value.evidence)) return value;
    return {
      ...value,
      evidence: this.materializeIntelEvidenceForReader(
        challengeId,
        attemptId,
        value.evidence as PublicIntelEvidenceRef[],
      ),
    };
  }

  private materializeIntelEvidenceForReader(
    challengeId: string,
    attemptId: string,
    evidence: PublicIntelEvidenceRef[],
  ): PublicIntelEvidenceRef[] {
    const live = this.live.get(attemptId);
    if (!live) return evidence;
    const spec = this.requireChallengeSpec(challengeId);
    const challengeRoot = fs.realpathSync(spec.workspace);
    const sharedRoot = path.join(challengeRoot, "intel", "evidence");
    if (!fs.existsSync(sharedRoot)) return evidence;
    const resolvedSharedRoot = fs.realpathSync(sharedRoot);
    const readerRoot = path.join(live.workspace, "artifacts", "intel-evidence");
    fs.mkdirSync(readerRoot, { recursive: true });
    const resolvedReaderRoot = fs.realpathSync(readerRoot);

    return evidence.map((row) => {
      if (row.kind === "tool_call") return row;
      const candidate = path.isAbsolute(row.ref)
        ? row.ref
        : path.resolve(challengeRoot, mapCellArtifactRef(row.ref, challengeRoot));
      let source: string;
      try {
        source = fs.realpathSync(candidate);
        if (!pathIsWithin(resolvedSharedRoot, source) || !fs.statSync(source).isFile()) return row;
      } catch {
        return row;
      }
      const destination = path.join(resolvedReaderRoot, path.basename(source));
      if (!pathIsWithin(resolvedReaderRoot, destination)) return row;
      try {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = fs.realpathSync(destination);
        if (!pathIsWithin(resolvedReaderRoot, existing) || !fs.statSync(existing).isFile()) {
          throw new Error("reader Intel evidence destination escapes the attempt artifact directory");
        }
      }
      return { ...row, ref: destination };
    });
  }

  private markNativeIntelRead(
    store: PublicIntelStore,
    challengeId: string,
    intelId: string,
    version: number,
    member: NativeSessionMember,
    commentIds: string[] = [],
  ): void {
    store.markRead({
      challengeId,
      intelId,
      version,
      memberId: member.memberId,
      attemptId: member.sessionId,
      reader: { kind: "member", id: member.memberId, attemptId: member.sessionId },
      commentIds,
    });
  }

}

function compact(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}...`;
}

function compactSkillDescription(text: string): string {
  return compact(text, 112);
}

export function mapCellArtifactRef(ref: string, cellHostRoot: string): string {
  const posix = ref.replaceAll("\\", "/");
  if (posix === "/work" || posix.startsWith("/work/")) {
    const rel = posix.slice("/work".length).replace(/^\//, "");
    return rel ? path.join(cellHostRoot, ...rel.split("/")) : cellHostRoot;
  }
  return ref;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function directoryWithin(root: string, candidate: string): string {
  if (!fs.existsSync(candidate)) fs.mkdirSync(candidate);
  const resolved = fs.realpathSync(candidate);
  if (!fs.statSync(resolved).isDirectory() || !pathIsWithin(root, resolved)) {
    throw new Error("intel evidence directory escapes the challenge workspace");
  }
  return resolved;
}

function artifactsRootFor(live: LiveAttempt, mappedRef: string): string {
  const cellArtifacts = path.join(live.spec.workspace, "workspace", "artifacts");
  const attemptArtifacts = path.join(live.workspace, "artifacts");
  const resolved = path.resolve(mappedRef);
  const cellRoot = path.resolve(cellArtifacts);
  if (resolved === cellRoot || resolved.startsWith(cellRoot + path.sep)) return cellArtifacts;
  return attemptArtifacts;
}

/**
 * Official Team DSH bash may write relative `artifacts/` under the Lead attempt,
 * `.silver-dsh`, or a teammate workspace inside the same attempt tree. Verify
 * must use the artifacts directory that actually contains the file.
 */
function officialTeamArtifactsRoot(live: LiveAttempt, mappedRef: string): string {
  const fallback = artifactsRootFor(live, mappedRef);
  const fileName = path.posix.basename(mappedRef.replaceAll("\\", "/"));
  if (!fileName || fileName === "." || fileName === "..") return fallback;
  const roots = [
    fallback,
    path.join(live.workspace, "artifacts"),
    path.join(live.workspace, ".silver-dsh", "artifacts"),
    path.join(live.workspace, ".home", "artifacts"),
    path.join(live.spec.workspace, "workspace", "artifacts"),
  ];
  for (const root of roots) {
    if (artifactInAttemptRoot(mappedRef, root)) return root;
  }
  const found = findAttemptArtifactsFile(live.workspace, fileName);
  return found ?? fallback;
}

function findAttemptArtifactsFile(attemptRoot: string, fileName: string): string | undefined {
  const skip = new Set(["node_modules", ".git", ".tmp"]);
  const walk = (dir: string, depth: number): string | undefined => {
    if (depth > 5) return undefined;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const artifacts = path.join(dir, "artifacts", fileName);
    try {
      const st = fs.lstatSync(artifacts);
      if (st.isFile() && !st.isSymbolicLink()) return path.join(dir, "artifacts");
    } catch {
      /* missing */
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".silver-dsh" && entry.name !== ".home") continue;
      const hit = walk(path.join(dir, entry.name), depth + 1);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(attemptRoot, 0);
}

function implantFromPayload(payload: Record<string, unknown>): AwdImplantSpec | undefined {
  const token = String(payload.token ?? "").trim();
  if (!token) return undefined;
  const channel = String(payload.channel ?? "").trim();
  const implant: AwdImplantSpec = {
    stealth: payload.stealth === undefined ? true : Boolean(payload.stealth),
    token,
  };
  if (channel) implant.channel = channel;
  const durability = String(payload.durability ?? "");
  if (isImplantDurability(durability)) implant.durability = durability;
  return implant;
}

const OFFICIAL_TEAM_RPC_METHODS = new Set<HostRpcMethod>([
  "room_info",
  "challenge_info",
  "intel_publish",
  "intel_update",
  // Hidden legacy RPC aliases for an already-running pre-migration plugin.
  "intel_comment",
  "intel_revise",
  "intel_retract",
  "intel_read",
  "graph_overview",
  "graph_query",
  "intel_record",
  "exploration_update",
  "room_feed_post",
  "room_feed_read",
  "room_status_set",
  "room_status_read",
  "verify_candidate",
  "submit_candidate",
  "request_hint",
]);

const CTF_SUBMIT_METHODS = new Set<HostRpcMethod>([
  "verify_candidate",
  "submit_candidate",
  "request_hint",
  "restart_challenge",
]);

function acceptanceKindOf(spec: ChallengeSpec): RoomDomain {
  if (spec.acceptanceKind) return spec.acceptanceKind;
  if (spec.track === "awd" || spec.track === "agent-awd") return "awd";
  if (spec.track === "pentest" || spec.track === "koh" || spec.track === "vuln") return spec.track;
  return "ctf";
}

function ctfSubmitBlocked(spec: ChallengeSpec, method: string): Record<string, unknown> | undefined {
  if (!CTF_SUBMIT_METHODS.has(method as HostRpcMethod)) return undefined;
  if (acceptanceKindOf(spec) === "ctf") return undefined;
  return { error: "capability_not_available", capability: method };
}

function scopesForPreset(
  preset: ToolPreset,
  track?: TrackKind,
  opts?: {
    swarmRoom?: boolean;
    acceptanceKind?: RoomDomain;
    contestSubmit?: boolean;
    contestVerify?: boolean;
    contestRestart?: boolean;
    hint?: boolean;
    roomGraph?: boolean;
  },
): RpcScope[] {
  if (preset === "commander") {
    return [
      "contest_list",
      "contest_start",
      "queue_target",
      "mission_status",
      "review_room_allocation",
      "record_target_result",
      "resolve_room_request",
      "mission_done",
    ];
  }
  // Room budget changes are Host/operator controls, not default Solver scopes.
  const scopes: RpcScope[] = [
    "challenge_info",
    "snapshot",
    ...(opts?.roomGraph
      ? (["graph_overview", "graph_query", "intel_record", "exploration_update"] as RpcScope[])
      : (["intel_read", "intel_publish", "intel_update"] as RpcScope[])),
    "room_status_set",
    "room_status_read",
  ];
  if (opts?.swarmRoom) {
    scopes.push("room_feed_post", "room_feed_read");
  }
  if (opts?.acceptanceKind === "ctf" && opts.contestVerify) scopes.push("verify_candidate");
  if (opts?.acceptanceKind === "ctf" && opts.contestSubmit) scopes.push("submit_candidate");
  if (opts?.acceptanceKind === "ctf" && opts.hint) scopes.push("request_hint");
  if (opts?.acceptanceKind === "ctf" && opts.contestRestart) scopes.push("restart_challenge");
  if (preset === "internal") {
    scopes.push("ask_skeptic", "verify_candidate", "submit_candidate", "request_hint");
  }
  return scopes;
}

function availableCapabilitiesFor(
  sharedRoom: boolean,
  contestSubmit = false,
  contestVerify = false,
  hint = false,
  roomGraph = false,
  contestRestart = false,
): string[] {
  const caps = [
    "room_info",
    "read_artifact",
    "grep_artifacts",
    ...(roomGraph
      ? ["graph_overview", "graph_query", "intel_record", "exploration_update"]
      : ["intel_publish", "intel_read", "intel_update"]),
  ];
  if (sharedRoom) caps.push("room_feed_post", "room_feed_read");
  if (sharedRoom) caps.push("room_status_set");
  if (contestVerify) caps.push("verify_candidate");
  if (contestSubmit) caps.push("submit_candidate");
  if (hint) caps.push("request_hint");
  if (contestRestart) caps.push("restart_challenge");
  return caps;
}

function acceptanceContractFor(spec: ChallengeSpec): {
  kind: RoomDomain;
  success: string;
} {
  const kind = acceptanceKindOf(spec);
  if (kind !== "ctf") {
    return {
      kind,
      success: "completion condition in the Commander Task is satisfied",
    };
  }
  return {
    kind: "ctf",
    success: "completion condition in the Commander Task is satisfied",
  };
}

function withSlice(base: AttemptSpec, slice: AttemptSlice | undefined): AttemptSpec {
  if (!slice) return base;
  const next: AttemptSpec = { ...base };
  if (slice.presentation !== undefined) next.presentation = slice.presentation;
  if (slice.model !== undefined) next.model = slice.model;
  if (slice.effort !== undefined) next.effort = slice.effort;
  if (slice.seed !== undefined) next.seed = slice.seed;
  if (slice.provider !== undefined) next.provider = slice.provider;
  if (slice.baseUrl !== undefined) next.baseUrl = slice.baseUrl;
  if (slice.apiKeyRef !== undefined) next.apiKeyRef = slice.apiKeyRef;
  if (slice.profile !== undefined) next.profile = slice.profile;
  if (slice.role !== undefined) next.role = slice.role;
  return next;
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}
