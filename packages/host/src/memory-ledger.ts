import { createHash } from "node:crypto";
import type {
  ProgressAsset,
  ProgressAssetKind,
  ProgressExplorationMemory,
  ProgressFindingStatus,
  ProgressSnapshot,
  ProgressTestedAxis,
} from "./progress.ts";

export interface MemoryLedger {
  schema: "silver.memory-ledger.v1";
  assetGraph: MemoryAssetGraph;
  explorationGraph: MemoryExplorationGraph;
}

export interface MemoryAssetGraph {
  counts: Record<ProgressAssetKind, number>;
  nodes: MemoryAssetNode[];
}

export interface MemoryAssetNode {
  id: string;
  kind: ProgressAssetKind;
  value: string;
  source: "assetMemory";
  artifactRef?: string;
  evidence?: string;
}

export interface MemoryExplorationGraph {
  counts: {
    goals: number;
    attemptedAxes: number;
    confirmed: number;
    candidate: number;
    uncertain: number;
    not_observed: number;
    openObservations: number;
  };
  goals: string[];
  axes: MemoryExplorationAxis[];
  observations: MemoryObservation[];
}

export interface MemoryExplorationAxis {
  id: string;
  axis: string;
  attempts: number;
  status: ProgressTestedAxis["status"];
  latest: string;
  source: "explorationMemory";
  artifactRef?: string;
}

export interface MemoryObservation {
  id: string;
  status: ProgressFindingStatus | "open";
  title: string;
  source: "explorationMemory";
  kind?: string;
  artifactRef?: string;
  evidence?: string;
}

const NODE_CAP = 128;

export function deriveMemoryLedger(progress: ProgressSnapshot): MemoryLedger {
  return {
    schema: "silver.memory-ledger.v1",
    assetGraph: deriveAssetGraph(progress.assetMemory.assets, progress.assetMemory.counts),
    explorationGraph: deriveExplorationGraph(progress.explorationMemory),
  };
}

function deriveAssetGraph(assets: readonly ProgressAsset[], counts: Record<ProgressAssetKind, number>): MemoryAssetGraph {
  const nodes: MemoryAssetNode[] = [];
  const seen = new Set<string>();
  for (const asset of assets) {
    const value = sanitizeMemoryText(asset.value).slice(0, 220);
    if (!value) continue;
    const id = stableId("asset", asset.kind, value);
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({
      id,
      kind: asset.kind,
      value,
      source: "assetMemory",
      ...(asset.artifactRef ? { artifactRef: asset.artifactRef } : {}),
      ...(asset.evidence ? { evidence: sanitizeMemoryText(asset.evidence).slice(0, 220) } : {}),
    });
  }
  return {
    counts: { ...counts },
    nodes: nodes.slice(-NODE_CAP),
  };
}

function deriveExplorationGraph(memory: ProgressExplorationMemory): MemoryExplorationGraph {
  const axes = memory.attemptedAxes.map(axisNode).slice(-NODE_CAP);
  const observations: MemoryObservation[] = [];
  for (const finding of memory.findings) {
    const title = sanitizeMemoryText(finding.title).slice(0, 220);
    if (!title) continue;
    observations.push({
      id: stableId("finding", finding.status, finding.kind, title, finding.artifactRef ?? ""),
      status: finding.status,
      title,
      source: "explorationMemory",
      kind: finding.kind,
      ...(finding.artifactRef ? { artifactRef: finding.artifactRef } : {}),
      ...(finding.evidence ? { evidence: sanitizeMemoryText(finding.evidence).slice(0, 220) } : {}),
    });
  }
  for (const open of memory.openObservations) {
    const title = sanitizeMemoryText(open).slice(0, 220);
    if (!title) continue;
    observations.push({
      id: stableId("open", title),
      status: "open",
      title,
      source: "explorationMemory",
    });
  }
  return {
    counts: explorationCounts(memory),
    goals: memory.goals.map((row) => sanitizeMemoryText(row).slice(0, 220)),
    axes,
    observations: observations.slice(-NODE_CAP),
  };
}

function axisNode(axis: ProgressTestedAxis): MemoryExplorationAxis {
  return {
    id: stableId("axis", axis.axis, axis.status),
    axis: sanitizeMemoryText(axis.axis),
    attempts: axis.attempts,
    status: axis.status,
    latest: sanitizeMemoryText(axis.latest),
    source: "explorationMemory",
    ...(axis.artifactRef ? { artifactRef: axis.artifactRef } : {}),
  };
}

function explorationCounts(memory: ProgressExplorationMemory): MemoryExplorationGraph["counts"] {
  const counts: MemoryExplorationGraph["counts"] = {
    goals: memory.goals.length,
    attemptedAxes: memory.attemptedAxes.length,
    confirmed: 0,
    candidate: 0,
    uncertain: 0,
    not_observed: 0,
    openObservations: memory.openObservations.length,
  };
  for (const finding of memory.findings) counts[finding.status] += 1;
  return counts;
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

function sanitizeMemoryText(value: string): string {
  return value
    .trim()
    .replace(/\b(PHPSESSID|JSESSIONID|session|token|cookie|password|passwd|secret|api[_-]?key|CTF_TOKEN)=\S+/gi, "$1=[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]");
}
