import { boundUnderRoot } from "./artifacts.ts";

export const COMMANDER_DISCOVERY_PATH_REFUSED =
  "Commander file discovery is confined to its workspace; use mission-brief.md or another path under the Commander cwd";

const COMMANDER_FILE_DISCOVERY_TOOLS = new Set(["read", "grep", "glob"]);

export function refuseCommanderDiscoveryPath(input: {
  tool: string;
  args?: Record<string, unknown>;
  cwd: string;
}): string | undefined {
  if (!COMMANDER_FILE_DISCOVERY_TOOLS.has(input.tool)) return undefined;
  const raw = input.tool === "read" ? input.args?.file_path : input.args?.path;
  const presented = raw === undefined ? "." : typeof raw === "string" ? raw.trim() : "";
  if (!presented || !boundUnderRoot(presented, input.cwd)) return COMMANDER_DISCOVERY_PATH_REFUSED;
  return undefined;
}
