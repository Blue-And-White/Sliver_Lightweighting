import fs from "node:fs";
import path from "node:path";
import { liveRoomClockDir } from "@silver/host";

export function roomCommandClockDir(input: {
  challengeId: string;
  replayPath?: string;
  roomWorkDir?: string;
}): string {
  if (input.roomWorkDir) {
    return liveRoomClockDir({ challengeId: input.challengeId, roomWorkDir: input.roomWorkDir });
  }
  if (!input.replayPath) throw new Error("room command requires replayPath or roomWorkDir");

  const targetDir = path.join(path.resolve(input.replayPath), "targets", input.challengeId);
  if (fs.existsSync(path.join(targetDir, ".silver-room"))) {
    return liveRoomClockDir({ challengeId: input.challengeId, roomWorkDir: targetDir });
  }
  return liveRoomClockDir({ challengeId: input.challengeId, replayPath: input.replayPath });
}
