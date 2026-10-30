/**
 * Official DSH model-facing tools for continuable-child collaboration.
 * Silver does not own substitutes for these names.
 *
 * Formal room members each hold their own DSH root and may enable this patch
 * so they can spawn one-level native assistants. Peer formal Workers are not
 * created via Lead's subagent tool.
 */
import fs from "node:fs";
import path from "node:path";
import { SILVER_ASSISTANT_DENY_TOOLS } from "@silver/ctf-spine";
import type { HintPolicy } from "@silver/protocol";

export const DSH_COLLABORATION_TOOLS = [
  "subagent",
  "send_message",
  "interrupt_agent",
  "list_agents",
] as const;

/** Plugins the default live overlay disables and qualification / member roots re-enable. */
export const DSH_COLLABORATION_ENABLE_PLUGINS = [
  "subagent",
  "subagent-spawn-in-process",
  "tool-subagent",
  "tool-subagent-control",
  "tool-subagent-list-agents",
] as const;

/** Fork / report surfaces stay off for the qualification composition. */
export const DSH_COLLABORATION_KEEP_DISABLED_PLUGINS = [
  "tool-subagent-fork",
  "tool-subagent-report",
  "subagent-fork-in-process",
] as const;

/** Parent-only tools. CTF Spine restricts only names mounted in each child Session. */
export const DSH_COLLABORATION_CHILD_DENY_ALWAYS = SILVER_ASSISTANT_DENY_TOOLS;
export const DSH_COLLABORATION_CHILD_DENY_TOOLS = SILVER_ASSISTANT_DENY_TOOLS;

export const DSH_COLLABORATION_MAX_DEPTH = 1;

export type CollaborationPatchOptions = {
  /** Host challenge hint policy, included in the generated patch description. */
  hintPolicy?: HintPolicy;
  /** Whether this room actually mounts the contest submission adapter. */
  contestSubmit?: boolean;
  /** Whether this room actually mounts a contest verification adapter. */
  contestVerify?: boolean;
};

/** CTF Spine intersects this list with tools mounted for each native assistant. */
export function collaborationChildDenyTools(): readonly string[] {
  return SILVER_ASSISTANT_DENY_TOOLS;
}

/**
 * Thin CTF-specific overlay over official DSH continuable subagents.
 * Re-enables the published spawn + control stack after the live persona
 * disables it. CTF Spine applies the child tool policy in its scoped Agent.
 * Does not implement a Silver mailbox, roster, or agent loop.
 */
export function qualificationCollaborationPatchYaml(opts?: CollaborationPatchOptions): string {
  // C0/C1 evidence runs with SILVER_HINT_POLICY=open; default open for that alias.
  return memberCollaborationPatchYaml({ ...opts, hintPolicy: opts?.hintPolicy ?? "open" });
}

/** Formal-member roots: same official one-level assistant policy; deny list matches mounted tools. */
export function memberCollaborationPatchYaml(opts?: CollaborationPatchOptions): string {
  const hintPolicy = opts?.hintPolicy ?? "off";
  const enable = DSH_COLLABORATION_ENABLE_PLUGINS.flatMap((id) => [
    `- id: ${id}`,
    "  disabled: false",
  ]);
  const keepDisabled = DSH_COLLABORATION_KEEP_DISABLED_PLUGINS.flatMap((id) => [
    `- id: ${id}`,
    "  disabled: true",
  ]);
  return [
    "# Silver formal-member / C0: official DSH continuable subagents with CTF child policy.",
    `# hintPolicy=${hintPolicy}; contestSubmit=${String(Boolean(opts?.contestSubmit))}; contestVerify=${String(Boolean(opts?.contestVerify))}; deny only mounted tools.`,
    "# Each formal member is a separate root; assistants stay one level under that root.",
    ...enable,
    ...keepDisabled,
    "- id: tool-subagent",
    "  disabled: false",
    "  config:",
    "    provider: spawn",
    "    toolName: subagent",
    `    maxDepth: ${DSH_COLLABORATION_MAX_DEPTH}`,
    "",
  ].join("\n");
}

export function writeQualificationCollaborationPatch(dir: string, opts?: CollaborationPatchOptions): string {
  return writeMemberCollaborationPatch(dir, { ...opts, hintPolicy: opts?.hintPolicy ?? "open" });
}

export function writeMemberCollaborationPatch(dir: string, opts?: CollaborationPatchOptions): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".silver-dsh-collaboration.patch.yml");
  fs.writeFileSync(file, memberCollaborationPatchYaml(opts));
  return file;
}
