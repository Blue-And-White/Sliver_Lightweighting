/**
 * Official DSH Agent Team wiring used by production swarm rooms and product tests.
 * Silver adds room contracts around it; it does not implement a second Team runtime.
 * The official profile disables one-shot tool-subagent. Do not re-enable those tools.
 * Team still needs the subagent service providers that the live solver overlay disables,
 * so the narrow service patch below restores only those providers.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const OFFICIAL_AGENT_TEAM_PACKAGES = [
  "@deepseek-ai/dsh-experimental-agent-team",
  "@deepseek-ai/dsh-experimental-tool-agent-team",
  "@deepseek-ai/dsh-experimental-agent-team-profile",
] as const;

export const OFFICIAL_AGENT_TEAM_TOOLS = [
  "spawn_teammate",
  "send_message",
  "list_agents",
  "wait_agent",
  "interrupt_agent",
  "team_task_create",
  "team_task_list",
  "team_task_get",
  "team_task_update",
] as const;

export function officialAgentTeamProfilePatchPath(): string {
  return require.resolve("@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml");
}

/**
 * Apply after the live persona patch and the official Team profile.
 * Re-enables only the subagent service providers required by Team.
 */
export function officialAgentTeamServicePatchYaml(): string {
  return [
    "# Silver live overlay disables subagent. Official Team requires that service;",
    "# without it, agent-team and tool-agent-team stay pending and Team tools never reach the model.",
    "# tool-subagent* stay disabled; only native Team tools are exposed.",
    "- id: subagent",
    "  disabled: false",
    "- id: subagent-spawn-in-process",
    "  disabled: false",
    "- id: subagent-fork-in-process",
    "  disabled: false",
    "",
  ].join("\n");
}

/**
 * Restore DSH's native one-shot workflow for the Team Lead's Reason pass.
 * One workflow run may start exactly one fresh child; Team workers remain the
 * only long-lived executors.
 */
export function officialTeamReasonWorkflowPatchYaml(): string {
  return [
    "# One fresh Reason child per planning pass. The workflow stays foreground-only.",
    "- id: workflow-ptc",
    "  disabled: false",
    "  config:",
    "    provider: spawn",
    "    maxConcurrentAgents: 1",
    "    maxTotalAgents: 1",
    "- id: tool-workflow",
    "  disabled: false",
    "  config:",
    "    maxResultChars: 20000",
    "    enableRunInBackground: false",
    "",
  ].join("\n");
}

/**
 * Overlay after the official Team profile. DSH maxMembers caps teammates and
 * excludes the Lead; Host enforces a separate full-roster cap.
 */
export function officialTeamMaxMembersPatchYaml(maxMembers: number): string {
  if (!Number.isInteger(maxMembers) || maxMembers < 1) {
    throw new Error("official team maxMembers is invalid");
  }
  return [
    "# DSH maxMembers counts teammates and excludes the Lead.",
    "# Silver derives this teammate cap from the Room cap.",
    "# Host separately caps the full roster, including the Lead.",
    "- id: agent-team",
    "  config:",
    `    maxMembers: ${maxMembers}`,
    "    maxTasks: 256",
    "    maxPendingMessagesPerMember: 64",
    "    maxMessageBytes: 65536",
    "    disposalTimeoutMs: 5000",
    "",
  ].join("\n");
}
