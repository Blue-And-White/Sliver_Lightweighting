import fs from "node:fs";
import path from "node:path";
import type { SessionEvent } from "@silver/ctf-spine";
import { deriveFindingLedger, type FindingLedger } from "./finding-ledger.ts";

const CAP = 8;
const AXIS_CAP = 12;
const SUMMARY_MAX = 240;
const REPEATED_AXIS_THRESHOLD = 3;
const BROAD_SEARCH_ATTEMPT_THRESHOLD = 24;
const MANY_BASH_ATTEMPT_THRESHOLD = 20;

export interface ProgressArtifact {
  locator: string;
  kind: string;
}

export interface ProgressTodo {
  content: string;
  status: string;
}

export interface ProgressAttempt {
  tool: string;
  summary: string;
  status: "ok" | "failed" | "unknown";
  artifactRef?: string;
}

export interface ProgressTestedAxis {
  axis: string;
  attempts: number;
  status: "ok" | "failed" | "mixed" | "unknown";
  latest: string;
  artifactRef?: string;
}

export type ProgressFindingStatus = "confirmed" | "candidate" | "uncertain" | "not_observed";

export interface ProgressFinding {
  kind: string;
  status: ProgressFindingStatus;
  title: string;
  artifactRef?: string;
  evidence?: string;
}

export interface ProgressCandidateEvidence {
  kind: string;
  title: string;
  artifactRef: string;
  evidence?: string;
  action: "verify_candidate_then_submit_candidate";
}

export interface ProgressNavigationAxis {
  axis: string;
  attempts: number;
  latest: string;
  artifactRef?: string;
}

export interface ProgressOffTargetProbe {
  origin: string;
  tool: string;
  artifactRef?: string;
}

export interface ProgressHostFileProbe {
  path: string;
  tool: string;
  artifactRef?: string;
}

export interface ProgressFileLineage {
  path: string;
  kind: "http-body" | "http-headers";
  source: string;
  artifactRef: string;
  url: string;
}

export type ProgressAssetKind = "url" | "host" | "file" | "credential" | "foothold";

export interface ProgressAsset {
  kind: ProgressAssetKind;
  value: string;
  artifactRef?: string;
  evidence?: string;
}

export interface ProgressAssetMemory {
  counts: Record<ProgressAssetKind, number>;
  assets: ProgressAsset[];
}

export interface ProgressExplorationMemory {
  goals: string[];
  attemptedAxes: ProgressTestedAxis[];
  findings: ProgressFinding[];
  openObservations: string[];
}

export interface ProgressNavigation {
  state: "candidate_ready" | "repetition_risk" | "broad_search";
  observations: string[];
  repeatedAxes: ProgressNavigationAxis[];
  questions: string[];
}

export interface ProgressNextCheck {
  objective: string;
  reason: string;
  expectedObservation: string;
  artifactRef?: string;
}

export interface ProgressWorkMemory {
  state: "initial" | "tracking" | ProgressNavigation["state"];
  now: string;
  evidence: string[];
  activeHypotheses: string[];
  nextChecks: ProgressNextCheck[];
  notes: string[];
}

export interface ProgressFocus {
  state: ProgressWorkMemory["state"];
  objective: string;
  reason: string;
  expectedObservation: string;
  artifactRef?: string;
}

export interface ChallengeInfoProgressFocus {
  state: ProgressWorkMemory["state"];
  objective: string;
  reason: string;
}

export interface ChallengeInfoProgressCandidateEvidence {
  title: string;
  artifactRef: string;
}

export interface ChallengeInfoProgressNextCheck {
  objective: string;
  expectedObservation?: string;
}

export interface ChallengeInfoProgressRecentAxis {
  axis: string;
  attempts: number;
  latest: string;
}

export interface ChallengeInfoProgressRecentObservation {
  status: ProgressFindingStatus;
  title: string;
  artifactRef?: string;
}

export interface ChallengeInfoProgressWorkMemory {
  state: ProgressWorkMemory["state"];
  nextChecks: ChallengeInfoProgressNextCheck[];
}

export interface ProgressSnapshot {
  summary: string;
  focus: ProgressFocus;
  surfaces: string[];
  confirmed: string[];
  candidates: string[];
  candidateEvidence: ProgressCandidateEvidence[];
  open: string[];
  findings: ProgressFinding[];
  artifacts: ProgressArtifact[];
  todos: ProgressTodo[];
  testedAxes: ProgressTestedAxis[];
  attempted: ProgressAttempt[];
  offTargetProbes: ProgressOffTargetProbe[];
  hostFileProbes: ProgressHostFileProbe[];
  fileLineage: ProgressFileLineage[];
  workCycle: string[];
  workMemory: ProgressWorkMemory;
  assetMemory: ProgressAssetMemory;
  explorationMemory: ProgressExplorationMemory;
  findingLedger: FindingLedger;
  navigation?: ProgressNavigation;
}

export interface ChallengeInfoProgressSnapshot {
  compact: true;
  summary: string;
  focus: ChallengeInfoProgressFocus;
  surfaces: string[];
  confirmed: string[];
  candidates: string[];
  candidateEvidence: ChallengeInfoProgressCandidateEvidence[];
  open: string[];
  artifacts: ProgressArtifact[];
  recentAxes?: ChallengeInfoProgressRecentAxis[];
  recentObservations?: ChallengeInfoProgressRecentObservation[];
  workMemory: ChallengeInfoProgressWorkMemory;
  counts: {
    surfaces: number;
    findings: number;
    testedAxes: number;
    artifacts: number;
    assets: Partial<Record<ProgressAssetKind, number>>;
    exploration: Partial<{
      confirmed: number;
      candidate: number;
      uncertain: number;
      notObserved: number;
      openObservations: number;
    }>;
  };
}

interface Mutable {
  surfaces: string[];
  confirmed: string[];
  candidates: string[];
  open: string[];
  findings: ProgressFinding[];
  artifacts: ProgressArtifact[];
  todos: ProgressTodo[];
  attempted: ProgressAttempt[];
  offTargetProbes: ProgressOffTargetProbe[];
  hostFileProbes: ProgressHostFileProbe[];
  fileLineage: ProgressFileLineage[];
}

interface ArtifactProjection {
  attemptsByLocator: Map<string, ProgressAttempt>;
}

/** Derived view only. Never writes nogood / dead-path / prune. */
export function deriveProgressSnapshot(input: {
  events?: SessionEvent[];
  artifactsDir?: string;
  targetUrl?: string;
  inScopeUrls?: string[];
}): ProgressSnapshot {
  const events = input.events ?? [];
  const scopeOrigins = deriveScopeOrigins(input.targetUrl, input.inScopeUrls);
  const state: Mutable = {
    surfaces: [],
    confirmed: [],
    candidates: [],
    open: [],
    findings: [],
    artifacts: [],
    todos: [],
    attempted: [],
    offTargetProbes: [],
    hostFileProbes: [],
    fileLineage: [],
  };
  const artifacts = input.artifactsDir
    ? ingestArtifacts(input.artifactsDir, state, { projectAttempts: events.length === 0, scopeOrigins })
    : { attemptsByLocator: new Map<string, ProgressAttempt>() };
  let grepPattern = "";
  for (const event of events) {
    if (event.type === "tool_call" && String(event.payload.name ?? "") === "grep_artifacts") {
      grepPattern = String(asRecord(event.payload.args).pattern ?? "");
      continue;
    }
    ingestEvent(event, state, grepPattern, artifacts, scopeOrigins);
  }
  const testedAxes = deriveTestedAxes(state.attempted);
  const navigation = deriveNavigation(state, testedAxes);
  const workMemory = deriveWorkMemory(state, navigation, scopeOrigins);
  const assetMemory = deriveAssetMemory(state);
  const explorationMemory = deriveExplorationMemory(state, testedAxes, workMemory);
  const findingLedger = deriveFindingLedger({ findings: state.findings });
  const snapshot: ProgressSnapshot = {
    summary: "",
    focus: deriveFocus(workMemory),
    surfaces: cap(state.surfaces),
    confirmed: cap(state.confirmed),
    candidates: cap(state.candidates),
    candidateEvidence: deriveCandidateEvidence(state.findings),
    open: cap(state.open),
    findings: coverageCap(state.findings, CAP),
    artifacts: state.artifacts.slice(-CAP),
    todos: state.todos.slice(-CAP),
    testedAxes,
    attempted: state.attempted.slice(-CAP),
    offTargetProbes: coverageCap(state.offTargetProbes, CAP),
    hostFileProbes: coverageCap(state.hostFileProbes, CAP),
    fileLineage: coverageCap(state.fileLineage, CAP),
    workCycle: workCycleHints(state),
    workMemory,
    assetMemory,
    explorationMemory,
    findingLedger,
    ...(navigation ? { navigation } : {}),
  };
  snapshot.summary = summarize(snapshot);
  return snapshot;
}

export function compactProgressForChallengeInfo(progress: ProgressSnapshot): ChallengeInfoProgressSnapshot {
  const includeRecent = progress.candidateEvidence.length === 0;
  return {
    compact: true,
    summary: compactText(progress.summary, 72),
    focus: {
      state: progress.focus.state,
      objective: compactText(progress.focus.objective, 40),
      reason: compactText(progress.focus.reason, 32),
    },
    surfaces: progress.surfaces.slice(-1).map((row) => compactText(row, 72)),
    confirmed: progress.confirmed.slice(-2).map((row) => compactText(row, 64)),
    candidates: progress.candidates.slice(-1).map((row) => compactText(row, 64)),
    candidateEvidence: progress.candidateEvidence.slice(0, 1).map((row) => ({
      title: compactText(row.title, 40),
      artifactRef: compactLocator(row.artifactRef),
    })),
    open: progress.open.slice(-1).map((row) => compactText(row, 72)),
    artifacts: progress.artifacts.slice(-1).map((row) => ({ ...row, locator: compactLocator(row.locator) })),
    ...(includeRecent
      ? {
          recentAxes: progress.explorationMemory.attemptedAxes.slice(-1).map((row) => ({
            axis: compactText(row.axis, 40),
            attempts: row.attempts,
            latest: compactText(row.latest, 48),
          })),
          recentObservations: progress.explorationMemory.findings.slice(-1).map((row) => ({
            status: row.status,
            title: compactText(row.title, 48),
            ...(row.artifactRef ? { artifactRef: compactLocator(row.artifactRef) } : {}),
          })),
        }
      : {}),
    workMemory: {
      state: progress.workMemory.state,
      nextChecks: progress.workMemory.nextChecks.slice(0, 3).map((row) => ({
        objective: compactText(row.objective, 52),
        expectedObservation: compactText(row.expectedObservation, 32),
      })),
    },
    counts: {
      surfaces: progress.surfaces.length,
      findings: progress.findings.length,
      testedAxes: progress.testedAxes.length,
      artifacts: progress.artifacts.length,
      assets: compactAssetCounts(progress.assetMemory.counts),
      exploration: explorationCounts(progress.explorationMemory),
    },
  };
}

function compactLocator(locator: string): string {
  return path.basename(locator);
}

function compactText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function emptyAssetCounts(): Record<ProgressAssetKind, number> {
  return { url: 0, host: 0, file: 0, credential: 0, foothold: 0 };
}

function compactAssetCounts(counts: Record<ProgressAssetKind, number>): ChallengeInfoProgressSnapshot["counts"]["assets"] {
  const out: ChallengeInfoProgressSnapshot["counts"]["assets"] = {};
  for (const key of Object.keys(counts) as ProgressAssetKind[]) {
    if (counts[key] > 0) out[key] = counts[key];
  }
  return out;
}

function explorationCounts(memory: ProgressExplorationMemory): ChallengeInfoProgressSnapshot["counts"]["exploration"] {
  const counts = {
    confirmed: 0,
    candidate: 0,
    uncertain: 0,
    notObserved: 0,
    openObservations: memory.openObservations.length,
  };
  for (const finding of memory.findings) {
    if (finding.status === "confirmed") counts.confirmed += 1;
    else if (finding.status === "candidate") counts.candidate += 1;
    else if (finding.status === "uncertain") counts.uncertain += 1;
    else if (finding.status === "not_observed") counts.notObserved += 1;
  }
  const out: ChallengeInfoProgressSnapshot["counts"]["exploration"] = {};
  if (counts.confirmed > 0) out.confirmed = counts.confirmed;
  if (counts.candidate > 0) out.candidate = counts.candidate;
  if (counts.uncertain > 0) out.uncertain = counts.uncertain;
  if (counts.notObserved > 0) out.notObserved = counts.notObserved;
  if (counts.openObservations > 0) out.openObservations = counts.openObservations;
  return out;
}

function deriveFocus(workMemory: ProgressWorkMemory): ProgressFocus {
  const next = workMemory.nextChecks[0];
  if (next) {
    return {
      state: workMemory.state,
      objective: next.objective,
      reason: next.reason,
      expectedObservation: next.expectedObservation,
      ...(next.artifactRef ? { artifactRef: next.artifactRef } : {}),
    };
  }
  return {
    state: workMemory.state,
    objective: workMemory.now || "run the smallest target-side probe",
    reason: "derived from private attempt evidence",
    expectedObservation: "one concrete status, file, error, credential, primitive, or candidate",
  };
}

function deriveAssetMemory(state: Mutable): ProgressAssetMemory {
  const assets: ProgressAsset[] = [];
  const counts = emptyAssetCounts();
  const add = (asset: ProgressAsset) => {
    const value = asset.value.trim();
    if (!value) return;
    const next: ProgressAsset = {
      kind: asset.kind,
      value: value.slice(0, 180),
      ...(asset.artifactRef ? { artifactRef: asset.artifactRef } : {}),
      ...(asset.evidence ? { evidence: asset.evidence.slice(0, 160) } : {}),
    };
    if (assets.some((row) => row.kind === next.kind && row.value === next.value)) return;
    assets.push(next);
    counts[next.kind] += 1;
  };

  for (const attempt of state.attempted) {
    for (const url of httpUrls(attempt.summary)) {
      add({ kind: "url", value: url, ...(attempt.artifactRef ? { artifactRef: attempt.artifactRef } : {}), evidence: attempt.summary });
      const origin = safeOrigin(url);
      if (origin) add({ kind: "host", value: origin, ...(attempt.artifactRef ? { artifactRef: attempt.artifactRef } : {}) });
    }
  }
  for (const lineage of state.fileLineage) {
    add({ kind: "file", value: lineage.path, artifactRef: lineage.artifactRef, evidence: `${lineage.kind} from ${lineage.url}` });
  }
  for (const finding of state.findings) {
    if (finding.status === "not_observed") continue;
    const text = `${finding.kind} ${finding.title} ${finding.evidence ?? ""}`;
    if (/\b(credential|creds?|token|session|cookie|password|passwd|secret|key)\b/i.test(text)) {
      add({
        kind: "credential",
        value: "credential-like material observed",
        ...(finding.artifactRef ? { artifactRef: finding.artifactRef } : {}),
        evidence: finding.kind,
      });
    }
    if (/\b(foothold|shell|rce|exec|command execution|initial access|pivot)\b/i.test(text)) {
      add({
        kind: "foothold",
        value: finding.title,
        ...(finding.artifactRef ? { artifactRef: finding.artifactRef } : {}),
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
      });
    }
  }

  return { counts, assets: coverageCap(assets, CAP) };
}

function deriveExplorationMemory(
  state: Mutable,
  testedAxes: ProgressTestedAxis[],
  workMemory: ProgressWorkMemory,
): ProgressExplorationMemory {
  return {
    goals: coverageCap(
      [
        workMemory.now,
        ...workMemory.nextChecks.map((row) => row.objective),
      ].filter((row) => row.trim()),
      4,
    ),
    attemptedAxes: coverageCap(testedAxes, AXIS_CAP),
    findings: coverageCap(state.findings, CAP),
    openObservations: coverageCap(state.open, CAP),
  };
}

function workCycleHints(state: Mutable): string[] {
  if (state.candidates.length > 0) {
    return ["candidate observed: verify_candidate and submit_candidate before more exploration"];
  }
  const repeated = repeatedAttempts(state.attempted);
  if (state.surfaces.length === 0 && state.confirmed.length === 0 && state.open.length === 0) {
    return ["first move: get room_info, then run the smallest target-side probe"];
  }
  const hints = [
    "use room_info plus artifact locators as working memory; keep scratch notes in workspace files only when useful",
    "before repeating an axis, name the new observation expected from the next check",
    "treat open items as uncertain observations, not global exclusion judgments",
  ];
  if (repeated) hints.unshift(`repeated attempt observed: ${repeated}; only repeat it for a named new observation`);
  return hints;
}

function deriveWorkMemory(
  state: Mutable,
  navigation: ProgressNavigation | undefined,
  scopeOrigins: readonly string[],
): ProgressWorkMemory {
  const candidateEvidence = deriveCandidateEvidence(state.findings);
  const lastOffTarget = state.offTargetProbes.at(-1);
  const lastHostFileProbe = state.hostFileProbes.at(-1);
  const workState: ProgressWorkMemory["state"] =
    candidateEvidence.length > 0 ? "candidate_ready" : navigation?.state ?? (state.attempted.length === 0 ? "initial" : "tracking");
  const nextChecks: ProgressNextCheck[] = [];
  const pushCheck = (check: ProgressNextCheck) => {
    const objective = check.objective.trim();
    if (!objective) return;
    if (nextChecks.some((row) => row.objective === objective)) return;
    nextChecks.push({
      objective: objective.slice(0, 160),
      reason: check.reason.slice(0, 180),
      expectedObservation: check.expectedObservation.slice(0, 180),
      ...(check.artifactRef ? { artifactRef: check.artifactRef } : {}),
    });
  };

  for (const candidate of candidateEvidence.slice(0, 2)) {
    pushCheck({
      objective: `verify and submit candidate evidence: ${candidate.title}`,
      reason: "candidate evidence is artifact-backed and should be handled before more exploration",
      expectedObservation:
        "verify_candidate preflight passed and artifact reference valid; platform verdict is the only correctness",
      artifactRef: candidate.artifactRef,
    });
  }
  if (workState === "broad_search") {
    const latest = state.attempted.at(-1);
    pushCheck({
      objective: latest ? "run the cheapest different target-side check from the latest artifact" : "run the cheapest different target-side check",
      reason: workMemoryNow(workState, state, candidateEvidence),
      expectedObservation: "one concrete status, file, error, credential, primitive, or candidate",
      ...(latest?.artifactRef ? { artifactRef: latest.artifactRef } : {}),
    });
  }
  for (const axis of navigation?.repeatedAxes ?? []) {
    pushCheck({
      objective: `before repeating ${axis.axis}, name the new observation expected`,
      reason: `${axis.attempts} attempts already touched this axis`,
      expectedObservation: "a different response, file, error, credential, primitive, or candidate",
      ...(axis.artifactRef ? { artifactRef: axis.artifactRef } : {}),
    });
  }
  for (const item of state.open.slice(-2)) {
    pushCheck({
      objective: `turn open observation into evidence: ${item}`,
      reason: "open observations are local phenomena, not verdicts",
      expectedObservation: "artifact-backed confirmation, candidate evidence, or a bounded not_observed result for this check",
    });
  }
  if (state.offTargetProbes.length > 0) {
    const targetOrigins = scopeOrigins.length > 0 ? ` (${formatScopeOrigins(scopeOrigins)})` : "";
    pushCheck({
      objective: `prefer target-origin evidence for the next HTTP probe${targetOrigins}`,
      reason: `${state.offTargetProbes.length} native HTTP probes were outside the challenge target origin`,
      expectedObservation: "an in-scope artifact that changes the current hypothesis",
      ...(lastOffTarget?.artifactRef ? { artifactRef: lastOffTarget.artifactRef } : {}),
    });
  }
  if (state.hostFileProbes.length > 0) {
    pushCheck({
      objective: "prefer challenge workspace or target evidence for the next file probe",
      reason: `${state.hostFileProbes.length} native file probes touched host/system paths`,
      expectedObservation: "an artifact, source file, binary, or saved response under the attempt workspace",
      ...(lastHostFileProbe?.artifactRef ? { artifactRef: lastHostFileProbe.artifactRef } : {}),
    });
  }
  for (const todo of state.todos.filter((row) => row.status !== "completed").slice(0, 2)) {
    pushCheck({
      objective: todo.content,
      reason: "latest private DSH todo_write checklist item",
      expectedObservation: "new artifact-backed observation or candidate evidence",
    });
  }
  if (workState === "repetition_risk" && candidateEvidence.length === 0 && nextChecks.length < 2) {
    const latest = state.attempted.at(-1);
    pushCheck({
      objective: latest ? "run a different target-side check from the latest artifact" : "run a different target-side check",
      reason: "current repeated axes have not produced candidate evidence",
      expectedObservation: "one concrete status, file, error, credential, primitive, or candidate",
      ...(latest?.artifactRef ? { artifactRef: latest.artifactRef } : {}),
    });
  }
  if (nextChecks.length === 0) {
    const latest = state.attempted.at(-1);
    pushCheck({
      objective: latest ? "run the cheapest different target-side check from the latest artifact" : "run the smallest target-side probe",
      reason: latest ? `latest attempt was ${latest.summary}` : "no tool evidence exists yet",
      expectedObservation: "one concrete status, file, error, credential, primitive, or candidate",
      ...(latest?.artifactRef ? { artifactRef: latest.artifactRef } : {}),
    });
  }

  return {
    state: workState,
    now: workMemoryNow(workState, state, candidateEvidence),
    evidence: coverageCap([...state.confirmed, ...state.candidates, ...lineageEvidence(state.fileLineage)], 4),
    activeHypotheses: activeHypotheses(state),
    nextChecks: nextChecks.slice(0, 5),
    notes: [
      "private derived attempt memory; not a shared blackboard",
      "open and not_observed are uncertain observations, not exclusion verdicts",
      "repeat an axis only for a named new observation",
    ],
  };
}

function formatScopeOrigins(scopeOrigins: readonly string[]): string {
  return `target origins: ${scopeOrigins.slice(0, 3).join(", ")}`;
}

function workMemoryNow(
  state: ProgressWorkMemory["state"],
  progress: Mutable,
  candidateEvidence: readonly ProgressCandidateEvidence[],
): string {
  if (candidateEvidence.length > 0) return "candidate evidence exists; verify and submit before broadening search";
  if (state === "broad_search") return `${progress.attempted.length} tool results without a verified candidate; switch to a different evidence-producing check`;
  if (state === "repetition_risk") return "repeated or uncertain observations need a named expected observation before another repeat";
  if (state === "initial") return "no tool evidence yet; touch the target once and create an artifact";
  return "continue from the latest artifact-backed attempt and keep evidence bounded";
}

function activeHypotheses(state: Mutable): string[] {
  const out: string[] = [];
  for (const finding of state.findings) {
    if (finding.status === "confirmed") continue;
    const ref = finding.artifactRef ? ` artifact=${finding.artifactRef}` : "";
    out.push(`${finding.status}: ${finding.kind}: ${finding.title}${ref}`);
  }
  for (const item of state.open) out.push(`open: ${item}`);
  return coverageCap(out, 5);
}

function ingestEvent(
  event: SessionEvent,
  state: Mutable,
  grepPattern: string,
  artifacts: ArtifactProjection,
  scopeOrigins: readonly string[],
): void {
  const payload = event.payload ?? {};
  const name = String(payload.name ?? "");
  if (event.type === "todo/write") {
    const todos = extractTodoList(eventData(event));
    if (todos.length > 0) state.todos = todos;
    return;
  }
  if (event.type === "native_tool_result") {
    ingestNativeTool(name, payload, state, artifacts, scopeOrigins);
    return;
  }
  if (event.type !== "tool_result") return;
  const ok = payload.ok !== false;
  const data = asRecord(payload.data);
  pushAttempt(state, toolAttempt(name, data, ok, grepPattern));
  if (name === "http_request") ingestHttp(data, state, ok);
  else if (name === "grep_artifacts") ingestGrep(data, state, ok, grepPattern);
  else if (name === "verify_candidate") ingestVerify(data, state, ok);
  else if (name === "submit_candidate") ingestSubmit(data, state, ok);
  else if (name === "terminal_open") ingestTerminal(data, state, ok);
}

function ingestNativeTool(
  name: string,
  payload: Record<string, unknown>,
  state: Mutable,
  artifacts: ArtifactProjection,
  scopeOrigins: readonly string[],
): void {
  if (!name) return;
  const ok = payload.ok !== false;
  const locator = String(payload.locator ?? "");
  if (locator) pushArtifact(state, locator, `dsh-${name}`);
  if (name === "todo_write") {
    const todos = extractTodoList(payload);
    if (todos.length > 0) state.todos = todos;
    return;
  }
  if (name === "bash") {
    const command = nativeCommand(payload);
    const attempt = locator ? artifacts.attemptsByLocator.get(locator) : undefined;
    const surface = attempt?.summary ?? summarizeBashSurface(command, nativePayloadText(payload));
    pushAttempt(state, { tool: name, summary: surface, status: ok ? "ok" : "failed", ...(locator ? { artifactRef: locator } : {}) });
    pushUnique(state.surfaces, surface);
    pushOffTargetProbe(state, command, name, locator, scopeOrigins);
    pushHostFileProbe(state, `${command}\n${nativePayloadText(payload)}`, name, locator);
    if (!ok) pushUnique(state.open, `${surface} failed`);
    return;
  }
  if (name === "read" || name === "grep" || name === "glob" || name === "write" || name === "edit") {
    const attempt = locator ? artifacts.attemptsByLocator.get(locator) : undefined;
    const surface = attempt?.summary ?? `dsh ${name}`;
    pushAttempt(state, { tool: name, summary: surface, status: ok ? "ok" : "failed", ...(locator ? { artifactRef: locator } : {}) });
    pushUnique(state.surfaces, surface);
    pushHostFileProbe(state, nativeFilePathText(asRecord(payload.argsPreview)), name, locator);
    if (!ok) pushUnique(state.open, `${surface} failed`);
  }
}

function nativeCommand(payload: Record<string, unknown>): string {
  const argsPreview = asRecord(payload.argsPreview);
  const text = String(argsPreview.text ?? "");
  if (!text) return "";
  try {
    const parsed = asRecord(JSON.parse(text) as unknown);
    const command = parsed.command ?? parsed.cmd ?? parsed.input;
    if (typeof command === "string") return command;
    const argv = parsed.argv;
    if (Array.isArray(argv)) return argv.map(String).join(" ");
  } catch {
    return text;
  }
  return "";
}

function nativePayloadText(payload: Record<string, unknown>): string {
  const preview = asRecord(payload.contentPreview);
  return String(preview.text ?? "");
}

function summarizeBashSurface(command: string, output = ""): string {
  const trimmed = command.trim();
  if (!trimmed) return "bash";
  const url = firstHttpUrl(trimmed);
  if (url && /\b(curl|http|httpie|wget)\b/.test(trimmed)) {
    const status = extractHttpStatus(output);
    const dataKeys = extractHttpDataKeys(trimmed);
    const method = httpMethod(trimmed, dataKeys.length > 0);
    const parts = [`bash curl ${url}`];
    if (method !== "GET") parts.push(`method=${method}`);
    if (dataKeys.length > 0) parts.push(`data={${dataKeys.join(",")}}`);
    if (status) parts.push(`status=${status}`);
    return parts.join(" ");
  }
  const head = trimmed.split(/\s+/).slice(0, 4).join(" ");
  return `bash ${head}`;
}

function ingestHttp(data: Record<string, unknown>, state: Mutable, ok: boolean): void {
  const method = String(data.method ?? "GET").toUpperCase();
  const url = String(data.url ?? "");
  if (!url) return;
  const status = data.status !== undefined ? Number(data.status) : undefined;
  const surface = status !== undefined && Number.isFinite(status) ? `${method} ${url} status=${status}` : `${method} ${url}`;
  pushUnique(state.surfaces, surface);
  const locator = String(data.locator ?? "");
  if (locator) pushArtifact(state, locator, "http");
  if (!ok) {
    pushUnique(state.open, `${method} ${url} request failed`);
    return;
  }
  const diff = asRecord(data.diff);
  if (diff.hashChanged === true) {
    pushUnique(state.confirmed, `${method} ${url} hash changed`);
    pushFinding(state, {
      kind: "http-diff",
      status: "uncertain",
      title: `${method} response changed`,
      ...(locator ? { artifactRef: locator } : {}),
      evidence: `${url} hash changed vs prior request`,
    });
  } else if (diff.hashChanged === false) {
    pushUnique(state.open, `${method} ${url} hash unchanged vs prior`);
  }
  if (status === 401 || status === 403) {
    pushUnique(state.open, `${method} ${url} auth surface status=${status}`);
    pushFinding(state, {
      kind: "http-auth-surface",
      status: "uncertain",
      title: `${method} ${status} gated surface`,
      ...(locator ? { artifactRef: locator } : {}),
      evidence: url,
    });
  }
  if (data.redirected === true && data.location) {
    pushUnique(state.open, `${method} ${url} redirected ${String(data.location)}`);
    pushFinding(state, {
      kind: "http-redirect",
      status: "uncertain",
      title: `${method} redirect observed`,
      ...(locator ? { artifactRef: locator } : {}),
      evidence: String(data.location).slice(0, 160),
    });
  }
}

function ingestGrep(
  data: Record<string, unknown>,
  state: Mutable,
  ok: boolean,
  grepPattern: string,
): void {
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const pattern = redactFlagShapeValue(String(data.pattern ?? grepPattern).slice(0, 80)).slice(0, 40);
  if (!ok) {
    pushUnique(state.open, pattern ? `grep failed for ${pattern}` : "grep failed");
    return;
  }
  if (matches.length > 0) {
    pushUnique(state.confirmed, pattern ? `grep hit ${pattern} (${matches.length})` : `grep hit (${matches.length})`);
    for (const row of matches.slice(0, 3)) {
      const rec = asRecord(row);
      const locator = String(rec.locator ?? "");
      if (locator) pushArtifact(state, locator, "grep");
    }
    const first = asRecord(matches[0]);
    const locator = String(first.locator ?? "");
    pushFinding(state, {
      kind: "artifact-grep",
      status: "confirmed",
      title: pattern ? `artifact grep hit ${pattern}` : "artifact grep hit",
      ...(locator ? { artifactRef: locator } : {}),
      evidence: `${matches.length} matches`,
    });
    return;
  }
  if (grepMissShouldStayOpen(pattern)) pushUnique(state.open, pattern ? `grep no hit for ${pattern}` : "grep no hit");
  pushFinding(state, {
    kind: "artifact-grep",
    status: "not_observed",
    title: pattern ? `pattern not observed: ${pattern}` : "pattern not observed",
    evidence: "this artifact grep only",
  });
}

function grepMissShouldStayOpen(pattern: string): boolean {
  if (!pattern) return true;
  return !/\bflag\b|flag\{|ctf[_-]?flag/i.test(pattern);
}

function ingestVerify(data: Record<string, unknown>, state: Mutable, ok: boolean): void {
  const id = String(data.candidateId ?? data.id ?? "candidate");
  const oracle = String(data.oracle ?? "");
  const ref = String(data.artifactRef ?? "");
  if (oracle === "pass") {
    pushUnique(state.candidates, `${id} preflight passed`);
    pushFinding(state, {
      kind: "flag-candidate",
      status: "candidate",
      title: `${id} preflight passed`,
      ...(ref ? { artifactRef: ref } : {}),
      evidence: "verify_candidate preflight passed; artifact reference valid",
    });
  }
  else if (oracle === "fail") pushUnique(state.open, `${id} oracle fail`);
  else if (!ok) pushUnique(state.open, `${id} verify failed`);
  else pushUnique(state.open, `${id} oracle ${oracle || "unknown"}`);
  if (ref) pushArtifact(state, ref, "candidate");
}

function ingestSubmit(data: Record<string, unknown>, state: Mutable, ok: boolean): void {
  const status = String(data.status ?? "");
  if (status === "accepted") {
    pushUnique(state.confirmed, "submit accepted");
    pushFinding(state, {
      kind: "flag-submit",
      status: "confirmed",
      title: "platform accepted candidate",
      evidence: "submit_candidate accepted",
    });
  } else if (status === "reported") {
    pushUnique(state.confirmed, "candidate recorded");
    pushFinding(state, {
      kind: "flag-submit",
      status: "confirmed",
      title: "verified candidate recorded",
      evidence: "candidate-report mode",
    });
  }
  else if (status === "rejected") pushUnique(state.open, "submit rejected");
  else if (!ok) pushUnique(state.open, "submit failed");
  else if (status) pushUnique(state.open, `submit ${status}`);
}

function ingestTerminal(data: Record<string, unknown>, state: Mutable, ok: boolean): void {
  const argv = data.argv;
  const bin = Array.isArray(argv) ? String(argv[0] ?? "terminal") : String(data.id ?? "terminal");
  pushUnique(state.surfaces, `terminal ${path.basename(bin)}`);
  if (!ok) pushUnique(state.open, `terminal ${path.basename(bin)} failed`);
}

function ingestArtifacts(
  dir: string,
  state: Mutable,
  options: { projectAttempts: boolean; scopeOrigins: readonly string[] },
): ArtifactProjection {
  const attemptsByLocator = new Map<string, ProgressAttempt>();
  if (!fs.existsSync(dir)) return { attemptsByLocator };
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { attemptsByLocator };
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const locator = path.join(dir, name);
    const kind = name.startsWith("http-") ? "http" : "artifact";
    pushArtifact(state, locator, kind);
    const rec = readJson(locator);
    if (!rec) continue;
    if (String(rec.tool ?? "") === "todo_write") {
      const todos = extractTodoList(rec);
      if (todos.length > 0) state.todos = todos;
      continue;
    }
    const nativeTool = String(rec.tool ?? "");
    if (nativeTool) {
      const attempt = nativeArtifactAttempt(nativeTool, rec, locator, state.fileLineage);
      if (attempt) {
        attemptsByLocator.set(locator, attempt);
        if (options.projectAttempts) pushAttempt(state, attempt);
      }
      ingestNativeArtifact(nativeTool, rec, state, locator, {
        projectAttempt: false,
        scopeOrigins: options.scopeOrigins,
      });
      continue;
    }
    if (kind !== "http") continue;
    const request = asRecord(rec.request);
    const response = asRecord(rec.response);
    const method = String(request.method ?? rec.method ?? "GET").toUpperCase();
    const url = String(request.url ?? rec.url ?? "");
    if (!url) continue;
    const status = response.status ?? rec.status;
    const surface =
      status !== undefined && Number.isFinite(Number(status))
        ? `${method} ${url} status=${Number(status)}`
        : `${method} ${url}`;
    pushUnique(state.surfaces, surface);
  }
  return { attemptsByLocator };
}

function ingestNativeArtifact(
  name: string,
  rec: Record<string, unknown>,
  state: Mutable,
  locator: string,
  options: { projectAttempt: boolean; scopeOrigins: readonly string[] },
): void {
  const attempt = nativeArtifactAttempt(name, rec, locator, state.fileLineage);
  if (!attempt) return;
  if (options.projectAttempt) pushAttempt(state, attempt);
  pushUnique(state.surfaces, attempt.summary);
  if (attempt.status === "failed") pushUnique(state.open, `${attempt.summary} failed`);
  if (name === "bash") {
    ingestBashObservation(rec, state, locator);
    pushOffTargetProbe(state, commandFromArgs(asRecord(rec.arguments)), name, locator, options.scopeOrigins);
    pushHostFileProbe(state, `${commandFromArgs(asRecord(rec.arguments))}\n${resultText(asRecord(rec.result))}`, name, locator);
  } else {
    pushHostFileProbe(state, nativeFilePathText(asRecord(rec.arguments)), name, locator);
  }
}

function nativeArtifactAttempt(
  name: string,
  rec: Record<string, unknown>,
  locator: string,
  fileLineage: readonly ProgressFileLineage[] = [],
): ProgressAttempt | undefined {
  const result = asRecord(rec.result);
  const ok = result.isError !== true;
  const args = asRecord(rec.arguments);
  if (name === "bash") {
    const surface = summarizeBashSurface(commandFromArgs(args), resultText(result));
    return { tool: name, summary: surface, status: ok ? "ok" : "failed", artifactRef: locator };
  }
  if (name === "read" || name === "grep" || name === "glob" || name === "write" || name === "edit") {
    const surface = nativeFileSurface(name, args, fileLineage);
    return { tool: name, summary: surface, status: ok ? "ok" : "failed", artifactRef: locator };
  }
  return undefined;
}

function ingestBashObservation(rec: Record<string, unknown>, state: Mutable, locator: string): void {
  const args = asRecord(rec.arguments);
  const result = asRecord(rec.result);
  const command = commandFromArgs(args);
  const text = resultText(result);
  const url = firstHttpUrl(command) ?? "";
  if (url && /\b(curl|http|httpie|wget)\b/.test(command)) {
    registerCurlSavedFiles(command, state, locator, url);
    const status = extractHttpStatus(text);
    if (status === 401 || status === 403) {
      pushUnique(state.open, `bash curl ${url} auth surface status=${status}`);
      pushFinding(state, {
        kind: "http-auth-surface",
        status: "uncertain",
        title: `curl observed ${status} gated surface`,
        artifactRef: locator,
        evidence: url,
      });
    } else if (status && status >= 500) {
      pushUnique(state.open, `bash curl ${url} server surface status=${status}`);
      pushFinding(state, {
        kind: "http-server-error",
        status: "uncertain",
        title: `curl observed server status ${status}`,
        artifactRef: locator,
        evidence: url,
      });
    }
  }
}

function registerCurlSavedFiles(command: string, state: Mutable, locator: string, url: string): void {
  for (const file of extractCurlSavedFiles(command)) {
    const source = summarizeBashSurface(command);
    const next: ProgressFileLineage = {
      path: file.path,
      kind: file.kind,
      source,
      artifactRef: locator,
      url,
    };
    if (state.fileLineage.some((row) => row.path === next.path && row.kind === next.kind && row.url === next.url)) continue;
    state.fileLineage.push(next);
    pushFinding(state, {
      kind: "http-saved-file",
      status: "confirmed",
      title: `${file.kind} saved to ${file.path}`,
      artifactRef: locator,
      evidence: `${source} saved ${file.path}`,
    });
  }
}

function extractCurlSavedFiles(command: string): Array<{ path: string; kind: ProgressFileLineage["kind"] }> {
  const tokens = shellWords(command);
  const out: Array<{ path: string; kind: ProgressFileLineage["kind"] }> = [];
  const add = (raw: string | undefined, kind: ProgressFileLineage["kind"]) => {
    const file = normalizeSavedPath(raw);
    if (!file) return;
    if (out.some((row) => row.path === file && row.kind === kind)) return;
    out.push({ path: file, kind });
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "-o" || token === "--output") {
      add(tokens[i + 1], "http-body");
      i += 1;
      continue;
    }
    if (token.startsWith("--output=")) {
      add(token.slice("--output=".length), "http-body");
      continue;
    }
    if (token.startsWith("-o") && token.length > 2) {
      add(token.slice(2), "http-body");
      continue;
    }
    if (token === "-D" || token === "--dump-header" || token === "--dump-headers") {
      add(tokens[i + 1], "http-headers");
      i += 1;
      continue;
    }
    if (token.startsWith("--dump-header=")) {
      add(token.slice("--dump-header=".length), "http-headers");
      continue;
    }
    if (token.startsWith("--dump-headers=")) {
      add(token.slice("--dump-headers=".length), "http-headers");
      continue;
    }
    if (token.startsWith("-D") && token.length > 2) {
      add(token.slice(2), "http-headers");
    }
  }
  return out;
}

function shellWords(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | "" = "";
  let escaping = false;
  const push = () => {
    if (!current) return;
    out.push(current);
    current = "";
  };
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
  }
  push();
  return out;
}

function normalizeSavedPath(raw: string | undefined): string {
  const text = String(raw ?? "").trim();
  if (!text || text === "-" || text.startsWith("-") || /^https?:\/\//i.test(text)) return "";
  const normalized = text.replace(/^\.\//, "");
  if (!looksLikeWorkspaceOutputPath(normalized)) return "";
  return normalized.slice(0, 160);
}

function looksLikeWorkspaceOutputPath(value: string): boolean {
  if (!value || value.length < 3) return false;
  if (value.includes(";") || value.includes("|") || value.includes("&") || value.includes(">") || value.includes("<")) return false;
  if (value === "/dev/null" || value.startsWith("/dev/")) return false;
  if (path.isAbsolute(value)) return false;
  if (value.split(/[\\/]/).some((part) => part === "..")) return false;
  if (!/[./]/.test(value)) return false;
  return /^[A-Za-z0-9._/@:+-]+$/.test(value);
}

function toolAttempt(name: string, data: Record<string, unknown>, ok: boolean, grepPattern = ""): ProgressAttempt {
  const summary = summarizeToolAttempt(name, data, grepPattern);
  const ref = String(data.locator ?? data.artifactRef ?? data.evidenceRef ?? "");
  return {
    tool: name || "tool",
    summary,
    status: ok ? "ok" : "failed",
    ...(ref ? { artifactRef: ref } : {}),
  };
}

function summarizeToolAttempt(name: string, data: Record<string, unknown>, grepPattern = ""): string {
  if (name === "http_request") {
    const method = String(data.method ?? "GET").toUpperCase();
    const url = String(data.url ?? "");
    const status = data.status !== undefined ? ` status=${String(data.status)}` : "";
    return `${method} ${url}${status}`.trim();
  }
  if (name === "grep_artifacts") {
    const pattern = redactFlagShapeValue(String(data.pattern ?? grepPattern).slice(0, 80)).slice(0, 60);
    const matches = Array.isArray(data.matches) ? data.matches.length : 0;
    return pattern ? `grep_artifacts ${pattern} matches=${matches}` : `grep_artifacts matches=${matches}`;
  }
  if (name === "verify_candidate") {
    const id = String(data.candidateId ?? data.id ?? "candidate");
    const oracle = String(data.oracle ?? "unknown");
    return `${id} oracle=${oracle}`;
  }
  if (name === "submit_candidate") {
    const status = String(data.status ?? "unknown");
    return `submit_candidate status=${status}`;
  }
  if (name === "terminal_open") {
    const argv = data.argv;
    const bin = Array.isArray(argv) ? String(argv[0] ?? "terminal") : String(data.id ?? "terminal");
    return `terminal ${path.basename(bin)}`;
  }
  return name || "tool";
}

function commandFromArgs(args: Record<string, unknown>): string {
  const command = args.command ?? args.cmd ?? args.input;
  if (typeof command === "string") return command;
  const argv = args.argv;
  if (Array.isArray(argv)) return argv.map(String).join(" ");
  return "";
}

function resultText(result: Record<string, unknown>): string {
  return String(result.contentText ?? result.text ?? result.output ?? "");
}

function extractHttpStatus(text: string): number | undefined {
  const match = text.match(/\bHTTP\/(?:1\.[01]|2|3)\s+([1-5][0-9]{2})\b/i);
  if (!match) return undefined;
  return Number(match[1]);
}

function firstHttpUrl(text: string): string | undefined {
  return httpUrls(text)[0];
}

function httpUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((match) => match[0].replace(/[),;\]]+$/g, ""));
}

function deriveScopeOrigins(targetUrl: string | undefined, inScopeUrls: readonly string[] | undefined): string[] {
  const origins = new Set<string>();
  for (const url of [targetUrl, ...(inScopeUrls ?? [])]) {
    const origin = safeOrigin(url);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

function pushOffTargetProbe(
  state: Mutable,
  command: string,
  tool: string,
  locator: string | undefined,
  scopeOrigins: readonly string[],
): void {
  if (scopeOrigins.length === 0) return;
  for (const url of httpUrls(command)) {
    const origin = safeOrigin(url);
    if (!origin || scopeOrigins.includes(origin)) continue;
    const next: ProgressOffTargetProbe = {
      origin,
      tool,
      ...(locator ? { artifactRef: locator } : {}),
    };
    if (state.offTargetProbes.some((row) => row.origin === next.origin && row.tool === next.tool)) continue;
    state.offTargetProbes.push(next);
  }
}

function safeOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function httpMethod(command: string, hasBody: boolean): string {
  const explicit = command.match(/(?:^|\s)(?:-X|--request)(?:=|\s+)([A-Za-z]+)/);
  if (explicit?.[1]) return explicit[1].toUpperCase();
  return hasBody ? "POST" : "GET";
}

function extractHttpDataKeys(command: string): string[] {
  const out: string[] = [];
  const dataFlag = /(?:^|\s)(?:-d|--data(?:-[A-Za-z-]+)?)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  for (const match of command.matchAll(dataFlag)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    for (const key of dataKeysFromPayload(raw)) {
      if (!out.includes(key)) out.push(key);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function dataKeysFromPayload(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return Object.keys(parsed).slice(0, 6);
    } catch {
      return [];
    }
  }
  return text
    .split(/[&;]/)
    .map((part) => part.split("=")[0]?.trim() ?? "")
    .filter((key) => /^[A-Za-z0-9_.:-]{1,80}$/.test(key))
    .slice(0, 6);
}

function redactFlagShapeValue(text: string): string {
  return text.replace(/flag\{[A-Za-z0-9_.:=+\-/]{8,}[^}\s]{0,200}\}?/gi, "flag{REDACTED}");
}

function nativeFileSurface(name: string, args: Record<string, unknown>, fileLineage: readonly ProgressFileLineage[] = []): string {
  const pathLike = args.path ?? args.file_path ?? args.pattern ?? args.glob ?? args.query;
  const value = typeof pathLike === "string" ? pathLike.trim() : "";
  if (!value) return `dsh ${name}`;
  const lineage = fileLineageForPath(fileLineage, value);
  const base = `dsh ${name} ${value.slice(0, 80)}`;
  return lineage ? `${base} <= ${lineage.source}` : base;
}

function fileLineageForPath(lineage: readonly ProgressFileLineage[], file: string): ProgressFileLineage | undefined {
  const target = comparablePath(file);
  if (!target) return undefined;
  const exact = lineage.find((row) => comparablePath(row.path) === target);
  if (exact) return exact;
  const basename = path.basename(target);
  const basenameMatches = lineage.filter((row) => path.basename(comparablePath(row.path)) === basename);
  return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
}

function lineageEvidence(lineage: ProgressFileLineage[]): string[] {
  return lineage.map((row) => `${row.kind} ${row.path} <= ${row.source}`);
}

function comparablePath(file: string): string {
  return file.trim().replace(/^\.\//, "").replace(/\\/g, "/");
}

function summarize(snapshot: ProgressSnapshot): string {
  if (
    snapshot.surfaces.length === 0 &&
    snapshot.confirmed.length === 0 &&
    snapshot.candidates.length === 0 &&
    snapshot.open.length === 0 &&
    snapshot.findings.length === 0
  ) {
    return "no tool evidence yet; hit the target";
  }
  const parts = [
    snapshot.surfaces.length ? `${snapshot.surfaces.length} surfaces` : "",
    snapshot.confirmed.length ? `${snapshot.confirmed.length} confirmed` : "",
    snapshot.candidates.length ? `${snapshot.candidates.length} candidates` : "",
    snapshot.open.length ? `${snapshot.open.length} open` : "",
    snapshot.findings.length ? `${snapshot.findings.length} findings` : "",
    snapshot.testedAxes.length ? `${snapshot.testedAxes.length} tested axes` : "",
    snapshot.artifacts.length ? `${snapshot.artifacts.length} artifacts` : "",
  ].filter(Boolean);
  const head = snapshot.confirmed[0] ?? snapshot.candidates[0] ?? snapshot.surfaces[0] ?? snapshot.open[0] ?? "";
  const text = head ? `${parts.join("; ")}; ${head}` : parts.join("; ");
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}...`;
}

function pushUnique(list: string[], item: string): void {
  const text = item.trim();
  if (!text || list.includes(text)) return;
  list.push(text);
}

function pushArtifact(state: Mutable, locator: string, kind: string): void {
  if (!locator) return;
  if (state.artifacts.some((row) => row.locator === locator)) return;
  state.artifacts.push({ locator, kind });
}

function pushAttempt(state: Mutable, attempt: ProgressAttempt): void {
  const summary = attempt.summary.trim();
  const tool = attempt.tool.trim() || "tool";
  if (!summary || tool === "todo_write") return;
  const next: ProgressAttempt = {
    tool: tool.slice(0, 80),
    summary: summary.slice(0, 200),
    status: attempt.status,
    ...(attempt.artifactRef ? { artifactRef: attempt.artifactRef } : {}),
  };
  if (
    state.attempted.some(
      (row) =>
        row.tool === next.tool &&
        row.summary === next.summary &&
        row.status === next.status &&
        row.artifactRef === next.artifactRef,
    )
  ) {
    return;
  }
  state.attempted.push(next);
}

function repeatedAttempts(attempts: ProgressAttempt[]): string | undefined {
  const counts = new Map<string, number>();
  for (const row of attempts) {
    const key = `${row.tool} ${row.summary}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of attempts.slice().reverse()) {
    const key = `${row.tool} ${row.summary}`;
    if ((counts.get(key) ?? 0) >= 2) return row.summary;
  }
  return undefined;
}

function deriveNavigation(state: Mutable, testedAxes: ProgressTestedAxis[]): ProgressNavigation | undefined {
  const repeatedAxes = testedAxes
    .filter((row) => row.attempts >= REPEATED_AXIS_THRESHOLD)
    .slice(0, 4)
    .map((row) => ({
      axis: row.axis,
      attempts: row.attempts,
      latest: row.latest,
      ...(row.artifactRef ? { artifactRef: row.artifactRef } : {}),
    }));
  if (state.candidates.length > 0) {
    return {
      state: "candidate_ready",
      observations: ["artifact-backed candidate evidence exists"],
      repeatedAxes,
      questions: ["Which candidate has the strongest artifact provenance for verify_candidate and submit_candidate?"],
    };
  }

  const observations: string[] = [];
  const questions: string[] = [];
  if (repeatedAxes.length > 0) {
    observations.push(`${repeatedAxes.length} repeated axes observed`);
    questions.push("What new observation would another repeat of a listed axis produce?");
  }
  if (state.attempted.length >= BROAD_SEARCH_ATTEMPT_THRESHOLD) {
    observations.push(`${state.attempted.length} tool results without a verified candidate`);
    questions.push("Which untested surface, file, or primitive can create a different artifact?");
  }
  const bashAttempts = state.attempted.filter((row) => row.tool === "bash").length;
  const verifyAttempts = state.attempted.filter((row) => row.tool === "verify_candidate").length;
  if (bashAttempts >= MANY_BASH_ATTEMPT_THRESHOLD && verifyAttempts === 0) {
    observations.push(`${bashAttempts} bash probes and zero verify_candidate calls`);
    questions.push("What evidence would turn the current exploration into a candidate?");
  }
  if (state.open.length >= 3) {
    observations.push(`${state.open.length} open observations remain uncertain`);
    questions.push("Which open observation can be checked cheaply from an artifact or a different probe?");
  }
  if (state.offTargetProbes.length > 0) {
    observations.push(`${state.offTargetProbes.length} native HTTP probes were outside the challenge target origin`);
    questions.push("Which in-target observation requires another off-target lookup?");
  }
  if (state.hostFileProbes.length > 0) {
    observations.push(`${state.hostFileProbes.length} native file probes touched host/system paths`);
    questions.push("Which workspace artifact or target-side file should replace the host/system path probe?");
  }
  if (observations.length === 0) return undefined;
  return {
    state: state.attempted.length >= BROAD_SEARCH_ATTEMPT_THRESHOLD ? "broad_search" : "repetition_risk",
    observations: coverageCap(observations, 5),
    repeatedAxes,
    questions: coverageCap(questions, 5),
  };
}

function nativeFilePathText(args: Record<string, unknown>): string {
  const preview = args.text;
  if (typeof preview === "string") {
    try {
      const parsed = asRecord(JSON.parse(preview) as unknown);
      return nativeFilePathText(parsed);
    } catch {
      return preview;
    }
  }
  const pathLike = args.path ?? args.file_path ?? args.glob ?? args.query ?? args.pattern;
  return typeof pathLike === "string" ? pathLike : "";
}

const HOST_SYSTEM_PATH =
  /(?:^|[\s"'(=])((?:\/(?:Applications|Library|System|Users|Volumes|opt\/homebrew|usr\/local|private\/var\/folders|var\/folders|etc|var\/db|var\/log)\/)[^\s"'<>)]*)/g;

function pushHostFileProbe(
  state: Mutable,
  text: string,
  tool: string,
  locator: string | undefined,
): void {
  const scanText = tool === "bash" ? stripHttpUrls(text) : text;
  for (const raw of hostSystemPaths(scanText)) {
    const next: ProgressHostFileProbe = {
      path: raw.slice(0, 180),
      tool,
      ...(locator ? { artifactRef: locator } : {}),
    };
    if (state.hostFileProbes.some((row) => row.path === next.path && row.tool === next.tool)) continue;
    state.hostFileProbes.push(next);
  }
}

function hostSystemPaths(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(HOST_SYSTEM_PATH)) {
    const value = match[1]?.replace(/[,:;]+$/g, "");
    if (!value || isSilverHostFsPath(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function isSilverHostFsPath(value: string): boolean {
  return (
    (value.startsWith("/private/var/folders/") || value.startsWith("/var/folders/")) &&
    value.includes("/silver-live-hostfs-")
  );
}

function stripHttpUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]*/g, "");
}

function deriveTestedAxes(attempts: ProgressAttempt[]): ProgressTestedAxis[] {
  const byAxis = new Map<
    string,
    {
      axis: string;
      attempts: number;
      statuses: Set<ProgressAttempt["status"]>;
      latest: string;
      artifactRef?: string;
      firstIndex: number;
    }
  >();
  attempts.forEach((attempt, index) => {
    const axis = testedAxisName(attempt);
    if (!axis) return;
    const prev = byAxis.get(axis);
    if (!prev) {
      byAxis.set(axis, {
        axis,
        attempts: 1,
        statuses: new Set<ProgressAttempt["status"]>([attempt.status]),
        latest: attempt.summary,
        firstIndex: index,
        ...(attempt.artifactRef ? { artifactRef: attempt.artifactRef } : {}),
      });
      return;
    }
    prev.attempts += 1;
    prev.statuses.add(attempt.status);
    prev.latest = attempt.summary;
    if (attempt.artifactRef) prev.artifactRef = attempt.artifactRef;
  });
  const axes = [...byAxis.values()]
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((row) => ({
      axis: row.axis,
      attempts: row.attempts,
      status: aggregateStatus(row.statuses),
      latest: row.latest.slice(0, 200),
      ...(row.artifactRef ? { artifactRef: row.artifactRef } : {}),
    }));
  return coverageCap(axes, AXIS_CAP);
}

function deriveCandidateEvidence(findings: ProgressFinding[]): ProgressCandidateEvidence[] {
  const out: ProgressCandidateEvidence[] = [];
  for (const finding of findings) {
    if (finding.status !== "candidate") continue;
    if (!finding.artifactRef) continue;
    if (finding.kind !== "flag-candidate") continue;
    const next: ProgressCandidateEvidence = {
      kind: finding.kind,
      title: redactFlagShapeValue(finding.title),
      artifactRef: finding.artifactRef,
      ...(finding.evidence ? { evidence: finding.evidence } : {}),
      action: "verify_candidate_then_submit_candidate",
    };
    if (out.some((row) => row.kind === next.kind && row.title === next.title && row.artifactRef === next.artifactRef)) {
      continue;
    }
    out.push(next);
  }
  return coverageCap(out, CAP);
}

function testedAxisName(attempt: ProgressAttempt): string {
  const summary = attempt.summary.replace(/\sstatus=[1-5][0-9]{2}\b/g, "").trim();
  if (!summary) return "";
  return summary.slice(0, 180);
}

function aggregateStatus(statuses: Set<ProgressAttempt["status"]>): ProgressTestedAxis["status"] {
  if (statuses.size === 1) return statuses.values().next().value ?? "unknown";
  return "mixed";
}

function pushFinding(state: Mutable, finding: ProgressFinding): void {
  const title = finding.title.trim();
  if (!title) return;
  const next: ProgressFinding = {
    kind: finding.kind.trim() || "observation",
    status: finding.status,
    title: title.slice(0, 160),
    ...(finding.artifactRef ? { artifactRef: finding.artifactRef } : {}),
    ...(finding.evidence ? { evidence: finding.evidence.slice(0, 200) } : {}),
  };
  if (
    state.findings.some(
      (row) => row.kind === next.kind && row.status === next.status && row.title === next.title && row.artifactRef === next.artifactRef,
    )
  ) {
    return;
  }
  state.findings.push(next);
}

function parseTodos(value: unknown): ProgressTodo[] {
  if (!Array.isArray(value)) return [];
  const out: ProgressTodo[] = [];
  for (const row of value) {
    const rec = asRecord(row);
    const content = String(rec.content ?? "").trim();
    if (!content) continue;
    const status = String(rec.status ?? "pending").trim() || "pending";
    out.push({ content: content.slice(0, 200), status: status.slice(0, 40) });
  }
  return out;
}

function extractTodoList(value: unknown): ProgressTodo[] {
  const rec = asRecord(value);
  for (const candidate of [
    rec.todos,
    asRecord(rec.value).todos,
    asRecord(rec.result).todos,
    asRecord(asRecord(rec.result).value).todos,
  ]) {
    const todos = parseTodos(candidate);
    if (todos.length > 0) return todos;
  }
  const previewText = String(asRecord(rec.resultPreview).text ?? "");
  if (!previewText) return [];
  try {
    const parsed = asRecord(JSON.parse(previewText) as unknown);
    return parseTodos(parsed.todos);
  } catch {
    return [];
  }
}

function eventData(event: SessionEvent): Record<string, unknown> {
  const raw = event as unknown as { data?: unknown };
  return asRecord(raw.data ?? event.payload);
}

function cap(list: string[]): string[] {
  return coverageCap(list, CAP);
}

function coverageCap<T>(list: T[], max: number): T[] {
  if (list.length <= max) return [...list];
  const head = Math.min(3, Math.floor(max / 3));
  const tail = max - head;
  return [...list.slice(0, head), ...list.slice(-tail)];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return asRecord(raw);
  } catch {
    return undefined;
  }
}
