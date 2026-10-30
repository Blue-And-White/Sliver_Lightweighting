import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import readline from "node:readline";
import type { HostRpcRequest, HostRpcResponse } from "@silver/protocol";

const HOST_RPC_PATH = "/rpc";
const MAX_HOST_RPC_BODY_BYTES = 1024 * 1024;

class HostRpcBodyTooLargeError extends Error {}

const listenHost = process.env.SILVER_RPC_LISTEN_HOST ?? "0.0.0.0";
let nextId = 1;
const pending = new Map<string, ServerResponse>();

const server = http.createServer((req, res) => {
  void handleHttp(req, res);
});

server.listen(0, listenHost, () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("host rpc child failed to bind");
  process.stdout.write(`silver-host-rpc-ready ${JSON.stringify({ port: address.port })}\n`);
});

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.startsWith("silver-host-rpc-res ")) return;
  const rest = line.slice("silver-host-rpc-res ".length);
  const space = rest.indexOf(" ");
  if (space <= 0) return;
  const id = rest.slice(0, space);
  const res = pending.get(id);
  pending.delete(id);
  if (!res) return;
  try {
    const body = JSON.parse(rest.slice(space + 1)) as HostRpcResponse;
    json(res, body.ok ? 200 : 403, body);
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://silver-host-rpc.invalid");
  if (req.method !== "POST" || url.pathname !== HOST_RPC_PATH) {
    json(res, 404, { ok: false, error: "not found" });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof HostRpcBodyTooLargeError) {
      json(res, 413, { ok: false, error: "request body too large" });
      return;
    }
    throw err;
  }
  let request: HostRpcRequest;
  try {
    request = JSON.parse(raw) as HostRpcRequest;
  } catch {
    json(res, 400, { ok: false, error: "invalid json" });
    return;
  }
  if (!request || typeof request.method !== "string") {
    json(res, 400, { ok: false, error: "method required" });
    return;
  }
  if (typeof request.capability !== "string" || !request.capability.trim()) {
    json(res, 401, { ok: false, error: "missing capability" });
    return;
  }
  if (!request.payload || typeof request.payload !== "object") request.payload = {};
  const id = String(nextId++);
  pending.set(id, res);
  process.stdout.write(`silver-host-rpc-req ${id} ${JSON.stringify(request)}\n`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_HOST_RPC_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        req.resume();
        reject(new HostRpcBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
  res.end(payload);
}

const stop = () => {
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
