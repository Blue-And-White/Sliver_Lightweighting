import fs from "node:fs";
import path from "node:path";

export type OperatorRoomLiveState = {
  schema: "silver.operator-room-live.v1";
  updatedAt: string;
  agents: Array<{
    id: string;
    status: string;
    queued: number;
    steering: number;
    lastTool?: string;
    lastActivityAt?: string;
    lastUpdate?: string;
  }>;
};

const FILE = "operator-room-live.json";

export function readOperatorRoomLive(dir: string): OperatorRoomLiveState | undefined {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8")) as OperatorRoomLiveState;
    return state.schema === "silver.operator-room-live.v1" && Array.isArray(state.agents) ? state : undefined;
  } catch {
    return undefined;
  }
}

export function writeOperatorRoomLive(dir: string, state: OperatorRoomLiveState): void {
  const file = path.join(dir, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}
