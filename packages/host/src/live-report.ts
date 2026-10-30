import fs from "node:fs";
import path from "node:path";
import type { ProgressSnapshot } from "./progress.ts";
import { deriveFindingLedger, mergeAuthoredFindingsIntoLedger, type FindingLedgerEntry } from "./finding-ledger.ts";
import { deriveMemoryLedger, type MemoryLedger } from "./memory-ledger.ts";
import { redactLiveReportValue } from "./live-dsh.ts";
import type { LiveRunLedger, LiveRunStopReason } from "./live-run-ledger.ts";

export type LiveContestReportOutcome = "accepted" | "partial" | "wrong" | "stalled" | "failed";

export interface LiveContestReportFinal {
  outcome: LiveContestReportOutcome;
  platformCorrect: number;
  platformWrong: number;
  awarded: number;
  cumulativeScore: number;
  platformCompleted: boolean;
  verdictCount: number;
  submittedAfterSolver: number;
  stopReason?: string;
}

export interface LiveCandidateReport {
  schema: "silver.candidate-report.v1";
  caseId: string;
  entry: LiveRunLedger["entry"];
  acceptanceMode: LiveRunLedger["acceptanceMode"];
  outcome: LiveRunLedger["outcome"];
  firstTool: string | null;
  promptSkillGestures: string[];
  promptSkillGestureCount: number;
  skillCalls: number;
  turns: number;
  toolCalls: number;
  noToolTurns: number;
  maxNoToolStreak: number;
  lengthStops: number;
  assistantTextBytes: number;
  maxAssistantTextBytes: number;
  stopReason: LiveRunStopReason | null;
  acpStopReason?: string;
  wallTimeMs: number;
  dshStatus: number;
  dshSessionId?: string;
  dshProcessRestarts?: number;
  dshSessionResumes?: number;
  timeoutMs: number;
  maxTurns: number;
  usage?: LiveRunLedger["usage"];
  dshRuntime?: LiveRunLedger["dshRuntime"];
  dshSession?: LiveRunLedger["dshSession"];
  dshStorage?: LiveRunLedger["dshStorage"];
  wire?: LiveRunLedger["wire"];
  progress: ProgressSnapshot;
  candidates: Array<{
    fingerprint: string;
    oracle: string;
    submission?: string;
    oracleAttempts?: Array<{ candidateRef: string; oracle: string; evidenceRef: string | null }>;
  }>;
  artifacts: Array<{ locator: string; kind: string }>;
  evidence?: LiveEvidenceMirror;
  contest?: LiveContestReportFinal;
}

export interface LiveEvidenceMirror {
  session?: string;
  artifacts?: string;
}

export function candidateReportPaths(ledgerPath: string): { json: string; md: string; memory: string } {
  const dir = path.dirname(ledgerPath);
  return {
    json: path.join(dir, "candidate-report.json"),
    md: path.join(dir, "candidate-report.md"),
    memory: path.join(dir, "memory-ledger.json"),
  };
}

export function buildLiveCandidateReport(input: {
  ledger: LiveRunLedger;
  progress?: Partial<ProgressSnapshot>;
  /** Member-authored Finding ledger rows (source:"authored"); not merged by title with progress. */
  authoredFindings?: readonly FindingLedgerEntry[];
  candidates?: Array<{
    fingerprint?: unknown;
    oracle?: unknown;
    submission?: unknown;
    oracleAttempts?: unknown;
  }>;
  timeoutMs: number;
  maxTurns: number;
  evidence?: LiveEvidenceMirror;
}): LiveCandidateReport {
  const progressBase: ProgressSnapshot = {
    summary: input.progress?.summary ?? "",
    focus: input.progress?.focus ?? {
      state: input.progress?.workMemory?.state ?? "initial",
      objective: input.progress?.workMemory?.nextChecks?.[0]?.objective ?? "",
      reason: input.progress?.workMemory?.nextChecks?.[0]?.reason ?? "",
      expectedObservation: input.progress?.workMemory?.nextChecks?.[0]?.expectedObservation ?? "",
      ...(input.progress?.workMemory?.nextChecks?.[0]?.artifactRef
        ? { artifactRef: input.progress.workMemory.nextChecks[0].artifactRef }
        : {}),
    },
    surfaces: input.progress?.surfaces ?? [],
    confirmed: input.progress?.confirmed ?? [],
    candidates: input.progress?.candidates ?? [],
    candidateEvidence: input.progress?.candidateEvidence ?? [],
    open: input.progress?.open ?? [],
    findings: input.progress?.findings ?? [],
    artifacts: input.progress?.artifacts ?? [],
    todos: input.progress?.todos ?? [],
    testedAxes: input.progress?.testedAxes ?? [],
    attempted: input.progress?.attempted ?? [],
    offTargetProbes: input.progress?.offTargetProbes ?? [],
    hostFileProbes: input.progress?.hostFileProbes ?? [],
    fileLineage: input.progress?.fileLineage ?? [],
    workCycle: input.progress?.workCycle ?? [],
    workMemory: input.progress?.workMemory ?? {
      state: "initial",
      now: "",
      evidence: [],
      activeHypotheses: [],
      nextChecks: [],
      notes: [],
    },
    assetMemory: input.progress?.assetMemory ?? {
      counts: { url: 0, host: 0, file: 0, credential: 0, foothold: 0 },
      assets: [],
    },
    explorationMemory: input.progress?.explorationMemory ?? {
      goals: [],
      attemptedAxes: [],
      findings: [],
      openObservations: [],
    },
    findingLedger: input.progress?.findingLedger ?? deriveFindingLedger({ findings: input.progress?.findings ?? [] }),
    ...(input.progress?.navigation ? { navigation: input.progress.navigation } : {}),
  };
  const progress: ProgressSnapshot = {
    ...progressBase,
    findingLedger:
      input.authoredFindings && input.authoredFindings.length > 0
        ? mergeAuthoredFindingsIntoLedger(progressBase.findingLedger, input.authoredFindings)
        : progressBase.findingLedger,
  };
  const candidates = (input.candidates ?? []).map((row) => {
    const out: LiveCandidateReport["candidates"][number] = {
      fingerprint: String(row.fingerprint ?? ""),
      oracle: String(row.oracle ?? ""),
    };
    if (typeof row.submission === "string") out.submission = row.submission;
    if (Array.isArray(row.oracleAttempts)) {
      out.oracleAttempts = row.oracleAttempts.map((attempt) => {
        const rec = attempt as { candidateRef?: unknown; oracle?: unknown; evidenceRef?: unknown };
        return {
          candidateRef: String(rec.candidateRef ?? ""),
          oracle: String(rec.oracle ?? ""),
          evidenceRef: typeof rec.evidenceRef === "string" ? rec.evidenceRef : null,
        };
      });
    }
    return out;
  });
  return redactLiveReportValue({
    schema: "silver.candidate-report.v1",
    caseId: input.ledger.caseId,
    entry: input.ledger.entry,
    acceptanceMode: input.ledger.acceptanceMode,
    outcome: input.ledger.outcome,
    firstTool: input.ledger.firstTool,
    promptSkillGestures: input.ledger.promptSkillGestures ?? [],
    promptSkillGestureCount: (input.ledger.promptSkillGestures ?? []).length,
    skillCalls: input.ledger.skillCalls,
    turns: input.ledger.turns.length,
    toolCalls: input.ledger.toolCalls,
    noToolTurns: input.ledger.noToolTurns,
    maxNoToolStreak: input.ledger.maxNoToolStreak,
    lengthStops: input.ledger.lengthStops ?? 0,
    assistantTextBytes: input.ledger.assistantTextBytes ?? 0,
    maxAssistantTextBytes: input.ledger.maxAssistantTextBytes ?? 0,
    stopReason: input.ledger.stopReason ?? null,
    ...(input.ledger.acpStopReason ? { acpStopReason: input.ledger.acpStopReason } : {}),
    wallTimeMs: input.ledger.wallTimeMs,
    dshStatus: input.ledger.dshStatus,
    ...(input.ledger.dshSessionId ? { dshSessionId: input.ledger.dshSessionId } : {}),
    ...(input.ledger.dshProcessRestarts ? { dshProcessRestarts: input.ledger.dshProcessRestarts } : {}),
    ...(input.ledger.dshSessionResumes ? { dshSessionResumes: input.ledger.dshSessionResumes } : {}),
    timeoutMs: input.timeoutMs,
    maxTurns: input.maxTurns,
    ...(input.ledger.usage ? { usage: input.ledger.usage } : {}),
    ...(input.ledger.dshRuntime ? { dshRuntime: input.ledger.dshRuntime } : {}),
    ...(input.ledger.dshSession ? { dshSession: input.ledger.dshSession } : {}),
    ...(input.ledger.dshStorage ? { dshStorage: input.ledger.dshStorage } : {}),
    ...(input.ledger.wire ? { wire: input.ledger.wire } : {}),
    progress,
    candidates,
    artifacts: progress.artifacts.map((row) => ({ locator: row.locator, kind: row.kind })),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  }) as LiveCandidateReport;
}

export function formatLiveCandidateReportMd(report: LiveCandidateReport): string {
  const lines = [
    `# Silver live candidate report`,
    "",
    `- case: ${report.caseId}`,
    `- entry: ${report.entry}`,
    `- outcome: ${report.outcome}`,
    `- firstTool: ${report.firstTool ?? "-"}`,
    `- promptSkillGestures: ${report.promptSkillGestures.length ? report.promptSkillGestures.join(",") : "-"}`,
    `- promptSkillGestureCount: ${report.promptSkillGestureCount}`,
    `- skillCalls: ${report.skillCalls}`,
    `- turns: ${report.turns}`,
    `- toolCalls: ${report.toolCalls}`,
    `- noToolTurns: ${report.noToolTurns}`,
    `- maxNoToolStreak: ${report.maxNoToolStreak}`,
    `- lengthStops: ${report.lengthStops}`,
    `- assistantTextBytes: ${report.assistantTextBytes}`,
    `- maxAssistantTextBytes: ${report.maxAssistantTextBytes}`,
    `- stopReason: ${report.stopReason ?? "-"}`,
    `- acpStopReason: ${report.acpStopReason ?? "-"}`,
    `- wallTimeMs: ${report.wallTimeMs}`,
    `- dshSessionId: ${report.dshSessionId ?? "-"}`,
    `- dshProcessRestarts: ${report.dshProcessRestarts ?? 0}`,
    `- dshSessionResumes: ${report.dshSessionResumes ?? 0}`,
    `- timeoutMs: ${report.timeoutMs}`,
    `- maxTurns: ${report.maxTurns}`,
    `- acceptanceMode: ${report.acceptanceMode}`,
    `- promptTokens: ${report.usage?.promptTokens ?? "-"}`,
    `- completionTokens: ${report.usage?.completionTokens ?? "-"}`,
    `- totalTokens: ${report.usage?.totalTokens ?? "-"}`,
    `- dshVersion: ${report.dshRuntime?.version ?? "-"}`,
    `- dshSessionLogs: ${report.dshSession?.logCount ?? "-"}`,
    `- dshSessionBytes: ${report.dshSession?.totalBytes ?? "-"}`,
    `- dshStorageFiles: ${report.dshStorage?.fileCount ?? "-"}`,
    `- dshStorageBytes: ${report.dshStorage?.totalBytes ?? "-"}`,
    ...(report.contest
      ? [
          `- contestOutcome: ${report.contest.outcome}`,
          `- platformCorrect: ${report.contest.platformCorrect}`,
          `- platformWrong: ${report.contest.platformWrong}`,
          `- platformCompleted: ${report.contest.platformCompleted}`,
          `- verdictCount: ${report.contest.verdictCount}`,
          `- submittedAfterSolver: ${report.contest.submittedAfterSolver}`,
          `- awarded: ${report.contest.awarded}`,
          `- cumulativeScore: ${report.contest.cumulativeScore}`,
        ]
      : []),
    `- wireRequests: ${report.wire?.requests ?? "-"}`,
    `- wireFailures: ${report.wire?.failedRequests ?? "-"}`,
    `- wireCompactionRequests: ${report.wire?.compactionRequests ?? "-"}`,
    `- wireThinkingEnabledRequests: ${report.wire?.thinkingRequests ?? "-"}`,
    `- wireThinkingDisabledRequests: ${report.wire?.thinkingDisabledRequests ?? "-"}`,
    `- wireThinkingUnknownRequests: ${report.wire?.thinkingUnknownRequests ?? "-"}`,
    `- wireMaxBodyBytes: ${report.wire?.maxBodyBytes ?? "-"}`,
    `- wireMaxMessageCount: ${report.wire?.maxMessageCount ?? "-"}`,
    "",
  ];
  if (report.dshRuntime?.featurePlugins) {
    lines.push("## DSH Runtime Features", "");
    for (const [id, state] of Object.entries(report.dshRuntime.featurePlugins)) {
      lines.push(`- ${id}: ${state}`);
    }
    lines.push("");
  }
  lines.push("## Progress", "", report.progress.summary || "(empty)", "", "### Current checklist", "");
  if (report.progress.todos.length === 0) lines.push("(none)", "");
  else {
    for (const row of report.progress.todos) lines.push(`- [${row.status}] ${row.content}`);
    lines.push("");
  }
  lines.push("### Work memory", "");
  lines.push(`- focus: ${report.progress.focus.objective || "-"}`);
  if (report.progress.focus.reason) lines.push(`- focusReason: ${report.progress.focus.reason}`);
  if (report.progress.focus.expectedObservation) lines.push(`- focusExpect: ${report.progress.focus.expectedObservation}`);
  if (report.progress.focus.artifactRef) lines.push(`- focusArtifact: ${report.progress.focus.artifactRef}`);
  lines.push(`- state: ${report.progress.workMemory.state}`);
  if (report.progress.workMemory.now) lines.push(`- now: ${report.progress.workMemory.now}`);
  for (const row of report.progress.workMemory.evidence) lines.push(`- evidence: ${row}`);
  for (const row of report.progress.workMemory.activeHypotheses) lines.push(`- hypothesis: ${row}`);
  for (const row of report.progress.workMemory.nextChecks) {
    const artifact = row.artifactRef ? ` artifact=${row.artifactRef}` : "";
    lines.push(`- next: ${row.objective}; reason=${row.reason}; expect=${row.expectedObservation}${artifact}`);
  }
  for (const row of report.progress.workMemory.notes) lines.push(`- note: ${row}`);
  lines.push("");
  lines.push("### Asset memory", "");
  const assetCounts = report.progress.assetMemory.counts;
  lines.push(
    `- counts: urls=${assetCounts.url} hosts=${assetCounts.host} files=${assetCounts.file} credentials=${assetCounts.credential} footholds=${assetCounts.foothold}`,
  );
  if (report.progress.assetMemory.assets.length === 0) lines.push("- examples: none");
  else {
    for (const row of report.progress.assetMemory.assets) {
      const artifact = row.artifactRef ? ` artifact=${row.artifactRef}` : "";
      const evidence = row.evidence ? ` evidence=${row.evidence}` : "";
      lines.push(`- ${row.kind}: ${row.value}${artifact}${evidence}`);
    }
  }
  lines.push("");
  lines.push("### Exploration memory", "");
  if (report.progress.explorationMemory.goals.length === 0) lines.push("- goals: none");
  else for (const row of report.progress.explorationMemory.goals) lines.push(`- goal: ${row}`);
  lines.push(`- attemptedAxes: ${report.progress.explorationMemory.attemptedAxes.length}`);
  lines.push(`- findings: ${report.progress.explorationMemory.findings.length}`);
  lines.push(`- openObservations: ${report.progress.explorationMemory.openObservations.length}`);
  lines.push("");
  lines.push("### Finding ledger", "");
  const findingCounts = report.progress.findingLedger.counts;
  const findingKindCounts = report.progress.findingLedger.kindCounts;
  lines.push(
    `- statusCounts: confirmed=${findingCounts.confirmed} candidate=${findingCounts.candidate} uncertain=${findingCounts.uncertain} not_observed=${findingCounts.not_observed}`,
  );
  lines.push(
    `- kindCounts: flag=${findingKindCounts.flag} vulnerability=${findingKindCounts.vulnerability} credential=${findingKindCounts.credential} foothold=${findingKindCounts.foothold} observation=${findingKindCounts.observation}`,
  );
  if (report.progress.findingLedger.entries.length === 0) lines.push("- entries: none");
  else {
    for (const row of report.progress.findingLedger.entries) {
      const artifact = row.artifactRef ? ` artifact=${row.artifactRef}` : "";
      const evidence = row.evidence ? ` evidence=${row.evidence}` : "";
      const version = row.currentVersion !== undefined ? ` v${row.currentVersion}` : "";
      const author =
        row.authorMemberId || row.authorAttemptId
          ? ` author=${row.authorMemberId ?? row.authorAttemptId}`
          : "";
      const conditions = row.conditions ? ` conditions=${row.conditions}` : "";
      lines.push(
        `- ${row.id}${version} [${row.status}] source=${row.source} ${row.kind}/${row.sourceKind}: ${row.title}${author}${conditions}${artifact}${evidence}`,
      );
      if (row.directEvidence?.length) {
        for (const ev of row.directEvidence.slice(0, 4)) {
          lines.push(`  - evidence ${ev.kind}:${ev.ref}`);
        }
      }
      if (row.intelRefs?.length) {
        for (const ref of row.intelRefs.slice(0, 8)) {
          const change =
            ref.sourceChanged || ref.sourceStatus === "retracted"
              ? ` sourceStatus=${ref.sourceStatus ?? "unknown"} sourceChanged=${ref.sourceChange ?? "changed"} latest=v${ref.sourceCurrentVersion ?? "?"}`
              : ` sourceStatus=${ref.sourceStatus ?? "active"}`;
          lines.push(
            `  - intelRef intelId=${ref.intelId} pinned=v${ref.version}${change}; re-read via intel_read({intelId})`,
          );
        }
      }
    }
  }
  lines.push("");
  lines.push("### Tested axes", "");
  if (report.progress.testedAxes.length === 0) lines.push("(none)", "");
  else {
    for (const row of report.progress.testedAxes) {
      const artifact = row.artifactRef ? ` artifact=${row.artifactRef}` : "";
      lines.push(`- [${row.status}] ${row.axis} attempts=${row.attempts} latest=${row.latest}${artifact}`);
    }
    lines.push("");
  }
  lines.push("### File lineage", "");
  if (report.progress.fileLineage.length === 0) lines.push("(none)", "");
  else {
    for (const row of report.progress.fileLineage) {
      lines.push(`- ${row.kind}: ${row.path} <= ${row.source} artifact=${row.artifactRef}`);
    }
    lines.push("");
  }
  if (report.progress.navigation) {
    lines.push("### Navigation", "");
    lines.push(`- state: ${report.progress.navigation.state}`);
    for (const row of report.progress.navigation.observations) lines.push(`- observation: ${row}`);
    for (const row of report.progress.navigation.repeatedAxes) {
      const artifact = row.artifactRef ? ` artifact=${row.artifactRef}` : "";
      lines.push(`- repeated: ${row.axis} attempts=${row.attempts} latest=${row.latest}${artifact}`);
    }
    for (const row of report.progress.navigation.questions) lines.push(`- question: ${row}`);
    lines.push("");
  }
  lines.push("### Recent attempts", "");
  if (report.progress.attempted.length === 0) lines.push("(none)", "");
  else {
    for (const row of report.progress.attempted) {
      const artifact = row.artifactRef ? ` artifact=${row.artifactRef}` : "";
      lines.push(`- [${row.status}] ${row.tool}: ${row.summary}${artifact}`);
    }
    lines.push("");
  }
  lines.push("### Candidate evidence", "");
  if (report.progress.candidateEvidence.length === 0) lines.push("(none)", "");
  else {
    for (const row of report.progress.candidateEvidence) {
      const evidence = row.evidence ? ` evidence=${row.evidence}` : "";
      lines.push(`- ${row.kind}: ${row.title} artifact=${row.artifactRef} action=${row.action}${evidence}`);
    }
    lines.push("");
  }
  lines.push("### Findings", "");
  if (report.progress.findings.length === 0) lines.push("(none)", "");
  else {
    for (const row of report.progress.findings) {
      const artifact = row.artifactRef ? ` artifact=${row.artifactRef}` : "";
      const evidence = row.evidence ? ` evidence=${row.evidence}` : "";
      lines.push(`- [${row.status}] ${row.kind}: ${row.title}${artifact}${evidence}`);
    }
    lines.push("");
  }
  lines.push(
    "### Artifacts",
    "",
  );
  if (report.artifacts.length === 0) lines.push("(none)", "");
  else {
    for (const row of report.artifacts) lines.push(`- ${row.kind}: ${row.locator}`);
    lines.push("");
  }
  if (report.evidence?.session || report.evidence?.artifacts) {
    lines.push("### Mirrored Evidence", "");
    if (report.evidence.session) lines.push(`- session: ${report.evidence.session}`);
    if (report.evidence.artifacts) lines.push(`- artifacts: ${report.evidence.artifacts}`);
    lines.push("");
  }
  lines.push("### Candidate fingerprints", "");
  if (report.candidates.length === 0) lines.push("(none)", "");
  else {
    for (const row of report.candidates) {
      const sub = row.submission ? ` submission=${row.submission}` : "";
      lines.push(`- ${row.fingerprint} oracle=${row.oracle}${sub}`);
      for (const attempt of row.oracleAttempts ?? []) {
        lines.push(`  - attempt oracle=${attempt.oracle}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function updateLiveCandidateReportContest(
  reportPath: string,
  contest: LiveContestReportFinal,
): LiveCandidateReport {
  const jsonPath = path.resolve(reportPath);
  const report = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as LiveCandidateReport;
  const updated = redactLiveReportValue({ ...report, contest }) as LiveCandidateReport;
  fs.writeFileSync(jsonPath, `${JSON.stringify(updated, null, 2)}\n`);
  fs.writeFileSync(path.join(path.dirname(jsonPath), "candidate-report.md"), formatLiveCandidateReportMd(updated));
  writeMemoryLedger(path.join(path.dirname(jsonPath), "memory-ledger.json"), deriveMemoryLedger(updated.progress));
  return updated;
}

export function writeLiveCandidateReport(ledgerPath: string, report: LiveCandidateReport): { json: string; md: string; memory: string } {
  const paths = candidateReportPaths(ledgerPath);
  fs.mkdirSync(path.dirname(paths.json), { recursive: true });
  fs.writeFileSync(paths.json, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(paths.md, formatLiveCandidateReportMd(report));
  writeMemoryLedger(paths.memory, deriveMemoryLedger(report.progress));
  return paths;
}

export function writeMemoryLedger(file: string, ledger: MemoryLedger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

export function mirrorLiveEvidence(evidenceRoot: string, ledgerPath: string): LiveEvidenceMirror | undefined {
  const root = path.resolve(evidenceRoot);
  const outDir = path.dirname(path.resolve(ledgerPath));
  const evidence: LiveEvidenceMirror = {};
  const session = path.join(root, "session.jsonl");
  if (isRegularFile(session)) {
    const dest = path.join(outDir, "session.jsonl");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(session, dest);
    evidence.session = dest;
  }
  const artifacts = path.join(root, "artifacts");
  if (isDirectory(artifacts)) {
    const dest = path.join(outDir, "artifacts");
    copyRegularTree(artifacts, dest);
    evidence.artifacts = dest;
  }
  return evidence.session || evidence.artifacts ? evidence : undefined;
}

function copyRegularTree(src: string, dest: string): void {
  const st = safeLstat(src);
  if (!st || st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRegularTree(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function isRegularFile(file: string): boolean {
  const st = safeLstat(file);
  return Boolean(st?.isFile()) && !st!.isSymbolicLink();
}

function isDirectory(file: string): boolean {
  const st = safeLstat(file);
  return Boolean(st?.isDirectory()) && !st!.isSymbolicLink();
}

function safeLstat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}
