import fs from "node:fs";
import path from "node:path";
import { artifactInAttemptRoot } from "@silver/oracle";
import { promoteGate, type IntelKind } from "./promote-gate.ts";

export interface IntelItem {
  id: string;
  challengeId: string;
  producerAttempt: string;
  kind: IntelKind;
  observation: string;
  artifactRef: string;
  exactFields: Record<string, unknown>;
  reproHint: string;
  nextObjectiveCheck: string;
  alsoSeenBy: string[];
  createdAt: string;
  dedupeKey: string;
}

export interface IntelViewItem {
  id: string;
  kind: IntelKind;
  observation: string;
  artifactRef: string;
  reproHint: string;
  nextObjectiveCheck: string;
}

export class IntelPool {
  private readonly file: string;
  private items: IntelItem[] = [];
  private seq = 0;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.load();
  }

  ingest(input: {
    challengeId: string;
    producerAttempt: string;
    kind: IntelKind;
    observation: string;
    artifactRef: string;
    exactFields: Record<string, unknown>;
    reproHint: string;
    nextObjectiveCheck: string;
    dedupeKey: string;
    artifactsRoot: string;
  }): { ok: true; id: string; duplicate: boolean } | { ok: false; reason: string } {
    const bounded = artifactInAttemptRoot(input.artifactRef, input.artifactsRoot);
    if (!bounded) return { ok: false, reason: "artifact_ref_escapes_attempt" };
    const gate = promoteGate({
      artifactRef: bounded,
      text: input.observation,
      nextObjectiveCheck: input.nextObjectiveCheck,
      polarity: "positive",
      source: "tool_pipeline",
    });
    if (!gate.ok) return { ok: false, reason: gate.reason };
    const existing = this.items.find((row) => row.challengeId === input.challengeId && row.dedupeKey === input.dedupeKey);
    if (existing) {
      if (!existing.alsoSeenBy.includes(input.producerAttempt)) {
        existing.alsoSeenBy.push(input.producerAttempt);
        this.persist();
      }
      return { ok: true, id: existing.id, duplicate: true };
    }
    const item: IntelItem = {
      id: `i${(this.seq += 1)}`,
      challengeId: input.challengeId,
      producerAttempt: input.producerAttempt,
      kind: input.kind,
      observation: input.observation,
      artifactRef: bounded,
      exactFields: input.exactFields,
      reproHint: input.reproHint,
      nextObjectiveCheck: input.nextObjectiveCheck,
      alsoSeenBy: [input.producerAttempt],
      createdAt: new Date().toISOString(),
      dedupeKey: input.dedupeKey,
    };
    this.items.push(item);
    this.persist();
    return { ok: true, id: item.id, duplicate: false };
  }

  /** Model-visible projection: insertion order, no also_seen_by, no producer, no votes. */
  view(challengeId: string): IntelViewItem[] {
    return this.items
      .filter((row) => row.challengeId === challengeId)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        observation: row.observation,
        artifactRef: row.artifactRef,
        reproHint: row.reproHint,
        nextObjectiveCheck: row.nextObjectiveCheck,
      }));
  }

  internal(challengeId: string): IntelItem[] {
    return this.items.filter((row) => row.challengeId === challengeId);
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    this.items = fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as IntelItem);
    this.seq = this.items.length;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body = this.items.map((row) => JSON.stringify(row)).join("\n");
    fs.writeFileSync(this.file, body ? `${body}\n` : "");
  }
}

export function poolPath(workspace: string): string {
  return path.join(workspace, "intel", "pool.jsonl");
}
