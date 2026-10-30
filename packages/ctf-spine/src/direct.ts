import fs from "node:fs";
import path from "node:path";
import { compileFlagPolicy, scopeRules, type FlagPolicy, type TrackKind } from "@silver/protocol";
import { CookieJar } from "./cookie-jar.ts";
import { TerminalHub } from "./terminal.ts";
import { logToolCall, logToolResult } from "./tool-log.ts";
import { getTool } from "./tools.ts";
import type { HostBridge, Presentation, SessionEvent, ToolContext, ToolPreset, ToolResult } from "./types.ts";

/** Direct leaf-tool event log. This is not a DSH Session or an agent loop. */
export class JsonlSession {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  append(type: string, payload: Record<string, unknown>): void {
    const event: SessionEvent = { ts: new Date().toISOString(), type, payload };
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`);
  }

  events(): SessionEvent[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent);
  }
}

export interface SpineRun {
  session: JsonlSession;
  ctx: ToolContext;
}

export function createSpine(input: {
  cwd: string;
  sessionFile: string;
  challengeId: string;
  attemptId: string;
  host: HostBridge;
  presentation?: Presentation;
  flagPolicy?: FlagPolicy;
  track?: TrackKind;
  targetUrl?: string;
  inScopeUrls?: string[];
  inScopeAgentUrls?: string[];
  toolsPreset?: ToolPreset;
  onToolResult?: (name: string, args: Record<string, unknown>, result: ToolResult) => void;
}): SpineRun {
  const session = new JsonlSession(input.sessionFile);
  const ctx: ToolContext = {
    cwd: input.cwd,
    challengeId: input.challengeId,
    attemptId: input.attemptId,
    host: input.host,
    presentation: input.presentation ?? "native",
    httpBaseline: new Map(),
    terminals: new TerminalHub(input.cwd),
    session,
    flagPolicy: input.flagPolicy ?? compileFlagPolicy(),
    cookies: new CookieJar(),
    track: input.track ?? "jeopardy",
    toolsPreset: input.toolsPreset ?? "internal",
  };
  if (input.targetUrl) ctx.targetUrl = input.targetUrl;
  const scoped = scopeRules({
    ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
    ...(input.inScopeUrls ? { inScopeUrls: input.inScopeUrls } : {}),
    ...(input.inScopeAgentUrls ? { inScopeAgentUrls: input.inScopeAgentUrls } : {}),
  });
  if (scoped.length > 0) ctx.inScopeUrls = scoped;
  if (input.inScopeAgentUrls) ctx.inScopeAgentUrls = input.inScopeAgentUrls;
  if (input.onToolResult) ctx.onToolResult = input.onToolResult;
  return { session, ctx };
}

export async function disposeSpine(spine: SpineRun): Promise<void> {
  await spine.ctx.terminals.closeAll();
}

export async function callTool(
  spine: SpineRun,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = getTool(name, spine.ctx.presentation, spine.ctx.track, spine.ctx.toolsPreset ?? "internal");
  if (!tool) throw new Error(`unknown tool ${name}`);
  logToolCall(spine.ctx, name, args);
  let result: ToolResult;
  try {
    result = await tool.execute(args, spine.ctx);
  } catch (err) {
    result = { ok: false, data: { error: err instanceof Error ? err.message : String(err) } };
  }
  logToolResult(spine.ctx, name, result);
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result.data)}`);
  return result.data;
}
