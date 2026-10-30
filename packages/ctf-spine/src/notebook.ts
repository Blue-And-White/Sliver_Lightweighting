import fs from "node:fs";
import path from "node:path";

export type NotebookZone = "facts" | "local_prune" | "narrative";
export type NotePolarity = "positive" | "negative" | "neutral";

export interface NotebookEntry {
  id: string;
  attemptId: string;
  zone: NotebookZone;
  text: string;
  polarity: NotePolarity;
  createdAt: string;
  artifactRef?: string;
  toolCallId?: string;
}

export class AttemptNotebook {
  private readonly file: string;
  private readonly attemptId: string;
  private seq = 0;

  constructor(file: string, attemptId: string) {
    this.file = file;
    this.attemptId = attemptId;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.seq = this.read().length;
  }

  write(input: {
    zone: NotebookZone;
    text: string;
    polarity?: NotePolarity;
    artifactRef?: string;
    toolCallId?: string;
  }): { ok: true; entry: NotebookEntry } | { ok: false; unsupported_claim: true; error: string } {
    const zone = input.zone;
    const artifactRef = (input.artifactRef ?? "").trim();
    const toolCallId = (input.toolCallId ?? "").trim();
    if (zone === "facts" && !artifactRef && !toolCallId) {
      return { ok: false, unsupported_claim: true, error: "facts zone requires artifact_ref or tool_call_id" };
    }
    const polarity = input.polarity ?? (zone === "local_prune" ? "negative" : zone === "facts" ? "positive" : "neutral");
    const entry: NotebookEntry = {
      id: `n${(this.seq += 1)}`,
      attemptId: this.attemptId,
      zone,
      text: String(input.text ?? ""),
      polarity,
      createdAt: new Date().toISOString(),
    };
    if (artifactRef) entry.artifactRef = artifactRef;
    if (toolCallId) entry.toolCallId = toolCallId;
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    return { ok: true, entry };
  }

  read(): NotebookEntry[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NotebookEntry);
  }
}

export function notebookWrite(args: Record<string, unknown>, ctx: { cwd: string; attemptId: string }): {
  ok: boolean;
  data: Record<string, unknown>;
} {
  const zone = String(args.zone ?? "narrative");
  if (zone !== "facts" && zone !== "local_prune" && zone !== "narrative") {
    return { ok: false, data: { error: "zone must be facts|local_prune|narrative" } };
  }
  const nb = new AttemptNotebook(path.join(ctx.cwd, "notebook.jsonl"), ctx.attemptId);
  const polarityRaw = args.polarity;
  const polarity =
    polarityRaw === "positive" || polarityRaw === "negative" || polarityRaw === "neutral" ? polarityRaw : undefined;
  const written = nb.write({
    zone,
    text: String(args.text ?? ""),
    ...(polarity ? { polarity } : {}),
    ...(typeof args.artifactRef === "string" ? { artifactRef: args.artifactRef } : {}),
    ...(typeof args.toolCallId === "string" ? { toolCallId: args.toolCallId } : {}),
  });
  if (!written.ok) return { ok: false, data: { error: written.error, unsupported_claim: true } };
  return { ok: true, data: written.entry as unknown as Record<string, unknown> };
}

export function notebookRead(_args: Record<string, unknown>, ctx: { cwd: string; attemptId: string }): {
  ok: boolean;
  data: Record<string, unknown>;
} {
  const nb = new AttemptNotebook(path.join(ctx.cwd, "notebook.jsonl"), ctx.attemptId);
  return { ok: true, data: { entries: nb.read() } };
}
