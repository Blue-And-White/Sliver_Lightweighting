import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type OperatorCommanderMessage = {
  requestId: string;
  message: string;
  mode: "queue" | "interrupt";
};

const requestPath = (dir: string): string => path.join(dir, "operator-commander-request.json");
const resultPath = (dir: string, id: string): string => path.join(dir, `operator-commander-result-${id}.json`);

export function writeOperatorCommanderMessage(dir: string, message: string, mode: "queue" | "interrupt"): OperatorCommanderMessage {
  if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message, "utf8") > 8192) {
    throw new Error("message must be 1–8192 bytes");
  }
  if (mode !== "queue" && mode !== "interrupt") throw new Error("choose queued or interrupt delivery");
  const request: OperatorCommanderMessage = { requestId: randomUUID(), message, mode };
  const temporary = path.join(dir, `operator-commander-${request.requestId}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(request), { mode: 0o600 });
  try {
    fs.linkSync(temporary, requestPath(dir));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return request;
}

export function consumeOperatorCommanderMessage(dir: string): OperatorCommanderMessage | undefined {
  const file = requestPath(dir);
  if (!fs.existsSync(file)) return undefined;
  const request = JSON.parse(fs.readFileSync(file, "utf8")) as OperatorCommanderMessage;
  fs.rmSync(file, { force: true });
  if (typeof request.requestId !== "string" || typeof request.message !== "string" ||
      (request.mode !== "queue" && request.mode !== "interrupt")) return undefined;
  return request;
}

export function acknowledgeOperatorCommanderMessage(dir: string, requestId: string): void {
  fs.writeFileSync(resultPath(dir, requestId), JSON.stringify({ requestId, accepted: true }), { mode: 0o600 });
}

export function readOperatorCommanderAcknowledgment(dir: string, requestId: string): boolean {
  const file = resultPath(dir, requestId);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function withdrawOperatorCommanderMessage(dir: string, requestId: string): void {
  const file = requestPath(dir);
  if (fs.existsSync(file) && (JSON.parse(fs.readFileSync(file, "utf8")) as OperatorCommanderMessage).requestId === requestId) {
    fs.rmSync(file, { force: true });
  }
}
