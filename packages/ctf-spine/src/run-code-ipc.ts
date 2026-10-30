export const SOLVER_RUN_CODE_TOOLS = [
  "http_request",
  "read_artifact",
  "grep_artifacts",
  "fs_read",
  "fs_write",
  "fs_list",
  "fs_grep",
  "room_info",
  "challenge_info",
  "request_hint",
  "terminal_open",
  "terminal_send",
  "terminal_read",
  "terminal_close",
  "terminal_list",
] as const;

export const INTERNAL_RUN_CODE_TOOLS = [
  "notebook_write",
  "notebook_read",
  "intel_read",
  "ask_skeptic",
] as const;

export const RUN_CODE_TOOLS = [
  ...SOLVER_RUN_CODE_TOOLS,
  ...INTERNAL_RUN_CODE_TOOLS,
] as const;

export type RunCodeToolName = (typeof RUN_CODE_TOOLS)[number];

export function isRunCodeTool(name: string): name is RunCodeToolName {
  return (RUN_CODE_TOOLS as readonly string[]).includes(name);
}

export type ChildToParent =
  | { op: "tool"; id: string; name: string; args: Record<string, unknown> }
  | { op: "log"; text: string }
  | { op: "done"; logs: string[]; result?: unknown; error?: string };

export type ParentToChild =
  | { op: "eval"; source: string; tools: string[] }
  | { op: "tool_result"; id: string; data?: Record<string, unknown>; error?: string };

export function decodeChildLine(line: string): ChildToParent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { op?: unknown };
    if (parsed.op === "tool" || parsed.op === "log" || parsed.op === "done") return parsed as ChildToParent;
    return undefined;
  } catch {
    return undefined;
  }
}
