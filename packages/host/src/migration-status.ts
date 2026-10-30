import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SILVER_ROOM_CORE_TOOLS,
  SILVER_FS_LEAVES,
  SILVER_IAT_LEAVES,
} from "@silver/ctf-spine";
import { assertLiveDshRuntimeReady, describeOfficialDshRuntime, type DshRuntimeFingerprint } from "./dsh-native-tools.ts";
import { livePersonaPatchYaml } from "./live-dsh.ts";

export interface SilverMigrationStatus {
  schema: "silver.migration-status.v1";
  completionPercent: number;
  dsh: {
    auditedVersion: string;
    installedVersion: string | null;
    kernel: "official-dsh";
    liveReady: boolean;
    liveReadyError?: string;
  };
  solverSurface: {
    dshGenericTools: string[];
    silverContractTools: string[];
    hintTools: string[];
    internalCompatibilityTools: string[];
  };
  coordination: {
    officialAgentTeams: "available" | "unavailable";
    officialSubagents: "available" | "unavailable";
    defaultLiveMode: "independent-root-sessions";
    adoptionGate: string;
  };
  migrated: string[];
  remaining: string[];
  nextGates: string[];
}

export function collectSilverMigrationStatus(repoRoot: string): SilverMigrationStatus {
  const runtime = liveRuntimeFingerprint(repoRoot);
  const liveReady = checkLiveReady(runtime);
  const dshStatus: SilverMigrationStatus["dsh"] = {
    auditedVersion: "0.2.0-rc.2",
    installedVersion: runtime.version,
    kernel: runtime.kernel,
    liveReady: liveReady.ok,
  };
  if (!liveReady.ok) dshStatus.liveReadyError = liveReady.error;
  return {
    schema: "silver.migration-status.v1",
    completionPercent: 97,
    dsh: dshStatus,
    solverSurface: {
      dshGenericTools: ["bash", "read", "write", "edit", "grep", "glob", "todo_write"],
      silverContractTools: [...SILVER_ROOM_CORE_TOOLS],
      hintTools: [],
      internalCompatibilityTools: [...SILVER_FS_LEAVES, ...SILVER_IAT_LEAVES],
    },
    coordination: collectCoordinationStatus(repoRoot),
    migrated: [
      "official DSH owns the live agent loop and ACP session lifecycle",
      "official DSH owns generic bash, file, grep/glob, todo, storage, projection, token meter, compaction, and tool-result pruning",
      "Silver ctf-spine registers only CTF contract leaves by default",
      "Host owns challenge scope, oracle, CAS, candidate reports, replay ledgers, and contest scheduling",
      "LLM broker passes through OpenAI-compatible and Anthropic-compatible routes without protocol conversion",
      "official DSH authorization seam is mounted for pi-ai subscription catalog routes",
      "official pi-ai device OAuth login is exposed and verified for the xAI subscription route",
      "fresh-root factual handoff is bounded and replay-visible",
      "official ACP sessions, DSH storage, and Host CAS ledger resume from an identity-bound replay checkpoint",
      "black-box live CLI recovery resumes the same official ACP session after process interruption",
    ],
    remaining: [
      "broad paid benchmark evidence for solve rate, cost, and stall profile",
      "replay-tuned fresh-root recovery policy",
      "cross-machine recovery beyond the same Host replay directory",
      "official-agent-team-qualification: 0.2.0-rc.2 ACP+JSONL+Team completes session.new and session.prompt; production adoption remains gated by Room qualification",
      "operator UI as a Host RPC client",
      "long-run validation of optional Docker --isolate",
    ],
    nextGates: [
      "run a repeatable 3-10 challenge benchmark sample with DeepSeek V4 Flash",
      "classify every failure by replay diagnostics before changing harness policy",
      "upgrade DSH only on the single runtime train and rerun full gates",
    ],
  };
}

export function formatSilverMigrationStatus(status: SilverMigrationStatus): string {
  return `${[
    `silver-migration-status ${status.completionPercent}%`,
    `dsh=${status.dsh.installedVersion ?? "unknown"} audited=${status.dsh.auditedVersion} liveReady=${status.dsh.liveReady}`,
    `dshGenericTools=${status.solverSurface.dshGenericTools.join(",")}`,
    `silverContractTools=${status.solverSurface.silverContractTools.join(",")}`,
    `hintTools=${status.solverSurface.hintTools.join(",") || "-"}`,
    `internalCompatibilityTools=${status.solverSurface.internalCompatibilityTools.join(",") || "-"}`,
    `coordination=${status.coordination.defaultLiveMode} teams=${status.coordination.officialAgentTeams} subagents=${status.coordination.officialSubagents}`,
    status.dsh.liveReadyError ? `liveReadyError=${status.dsh.liveReadyError}` : undefined,
  ]
    .filter(Boolean)
    .join("\n")}\n${JSON.stringify({ migration: status }, null, 2)}\n`;
}

function collectCoordinationStatus(repoRoot: string): SilverMigrationStatus["coordination"] {
  const hasAgentTeam =
    packageExists(repoRoot, "@deepseek-ai/dsh-experimental-agent-team") &&
    packageExists(repoRoot, "@deepseek-ai/dsh-experimental-tool-agent-team") &&
    packageExists(repoRoot, "@deepseek-ai/dsh-experimental-agent-team-profile");
  const hasSubagents =
    packageExists(repoRoot, "@deepseek-ai/dsh-subagent") &&
    packageExists(repoRoot, "@deepseek-ai/dsh-tool-subagent") &&
    packageExists(repoRoot, "@deepseek-ai/dsh-tool-subagent-control");
  return {
    officialAgentTeams: hasAgentTeam ? "available" : "unavailable",
    officialSubagents: hasSubagents ? "available" : "unavailable",
    defaultLiveMode: "independent-root-sessions",
    adoptionGate:
      "official-agent-team-qualification: 0.2.0-rc.2 session.new/prompt pass; Room adoption remains gated by product qualification.",
  };
}

function packageExists(repoRoot: string, name: string): boolean {
  return fs.existsSync(path.join(repoRoot, "node_modules", ...name.split("/"), "package.json"));
}

function liveRuntimeFingerprint(repoRoot: string): DshRuntimeFingerprint {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "silver-migration-status-"));
  try {
    const persona = path.join(dir, "persona.patch.yml");
    fs.writeFileSync(persona, livePersonaPatchYaml());
    return describeOfficialDshRuntime({
      repoRoot,
      patches: [path.join(repoRoot, "packages", "ctf-spine", "cordis.patch.yml"), persona],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function checkLiveReady(runtime: DshRuntimeFingerprint): { ok: true } | { ok: false; error: string } {
  try {
    assertLiveDshRuntimeReady(runtime);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
