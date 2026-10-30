import { readFileSync } from "node:fs";

export const ROLE_PROMPT_MODES = ["ctf", "awd", "koh", "pentest", "vuln"] as const;

export type RolePromptMode = (typeof ROLE_PROMPT_MODES)[number];
export type StaticRole = "commander" | "room" | "lead" | "worker";

const PROMPT_ROOT = new URL("../role-prompts/", import.meta.url);

export function isRolePromptMode(mode: unknown): mode is RolePromptMode {
  return typeof mode === "string" && ROLE_PROMPT_MODES.includes(mode as RolePromptMode);
}

function assertMode(mode: string): asserts mode is RolePromptMode {
  if (!isRolePromptMode(mode)) {
    throw new Error(`Unsupported role prompt mode: ${mode}`);
  }
}

function readPrompt(relativePath: string): string {
  const file = new URL(relativePath, PROMPT_ROOT);
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new Error(`Unable to load required role prompt: ${relativePath}`, { cause: error });
  }
  if (text.length === 0) {
    throw new Error(`Required role prompt is empty: ${relativePath}`);
  }
  return text;
}

export function loadCommanderRolePrompt(mode: string): string {
  assertMode(mode);
  return readPrompt("collaboration/commander.md");
}

export function loadRoomSharedPrompt(mode: string): string {
  assertMode(mode);
  return readPrompt("collaboration/room.md");
}

export function loadLeadRolePrompt(mode: string): string {
  assertMode(mode);
  return readPrompt("collaboration/lead.md");
}

export function loadWorkerRolePrompt(mode: string): string {
  assertMode(mode);
  return readPrompt("collaboration/executor.md");
}

export function loadWholeRacerRolePrompt(): string {
  return readPrompt("collaboration/end-to-end-executor.md");
}

export function loadBreadthReconRolePrompt(): string {
  return readPrompt("collaboration/explorer.md");
}

export function loadRotatingWorkerRolePrompt(): string {
  return readPrompt("collaboration/task-executor.md");
}

export function loadRoundAuditorRolePrompt(): string {
  return readPrompt("collaboration/round-auditor.md");
}

export function loadRolePrompt(role: StaticRole, mode: string): string {
  switch (role) {
    case "commander":
      return loadCommanderRolePrompt(mode);
    case "room":
      return loadRoomSharedPrompt(mode);
    case "lead":
      return loadLeadRolePrompt(mode);
    case "worker":
      return loadWorkerRolePrompt(mode);
    default: {
      const exhaustive: never = role;
      throw new Error(`Unsupported static role: ${String(exhaustive)}`);
    }
  }
}

export function loadRoomRolePrompts(mode: string): {
  shared: string;
  lead: string;
  worker: string;
} {
  assertMode(mode);
  return {
    shared: loadRoomSharedPrompt(mode),
    lead: loadLeadRolePrompt(mode),
    worker: loadWorkerRolePrompt(mode),
  };
}
