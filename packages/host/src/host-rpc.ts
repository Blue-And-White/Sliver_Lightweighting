import { spawn } from "node:child_process";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { HostRpcRequest, HostRpcResponse } from "@silver/protocol";
import { cellBrokerBind } from "./llm-broker.ts";

export const HOST_RPC_PATH = "/rpc";
export const HOST_CAPABILITY_ENV = "SILVER_HOST_CAPABILITY";
export const HOST_RPC_ENV = "SILVER_HOST_RPC";
export const HOST_MODE_ENV = "SILVER_HOST_MODE";
const MAX_HOST_RPC_BODY_BYTES = 1024 * 1024;

class HostRpcBodyTooLargeError extends Error {}

export interface HostRpcHandle {
  origin: string;
  listenHost: string;
  advertisedHost: string;
  port: number;
  close(): Promise<void>;
}

export interface ListenHostRpcOptions {
  dispatch: (request: HostRpcRequest) => Promise<HostRpcResponse>;
  listenHost?: string;
  advertisedHost?: string;
}

/**
 * Loopback stays in-process for unit tests.
 * Cell-reachable binds run the HTTP server in a child: this sandbox's
 * in-process 127.0.0.1 is not reachable from IsolationHost cells or from a
 * reverse-proxy child on the host network. Dispatch stays in the parent via IPC.
 */
export async function listenHostRpc(options: ListenHostRpcOptions): Promise<HostRpcHandle> {
  const bind = options.listenHost
    ? { listenHost: options.listenHost, advertisedHost: options.advertisedHost ?? options.listenHost }
    : { listenHost: "127.0.0.1", advertisedHost: "127.0.0.1" };
  if (bind.listenHost === "127.0.0.1" || bind.listenHost === "::1") {
    const inner = await bindHostRpc(options.dispatch, "127.0.0.1", "127.0.0.1");
    return {
      ...inner,
      advertisedHost: bind.advertisedHost === "0.0.0.0" ? "127.0.0.1" : bind.advertisedHost,
      origin: `http://127.0.0.1:${inner.port}`,
    };
  }
  return spawnHostRpcChild({
    dispatch: options.dispatch,
    listenHost: bind.listenHost,
    advertisedHost: bind.advertisedHost,
  });
}

export function liveHostRpcBind(): { listenHost: string; advertisedHost: string } {
  return cellBrokerBind();
}

function bindHostRpc(
  dispatch: ListenHostRpcOptions["dispatch"],
  listenHost: string,
  advertisedHost: string,
): Promise<HostRpcHandle> {
  const server = http.createServer((req, res) => {
    void handleRpc(req, res, dispatch);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, listenHost, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("host rpc failed to bind a TCP port"));
        return;
      }
      resolve({
        origin: `http://${advertisedHost}:${address.port}`,
        listenHost,
        advertisedHost,
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

async function handleRpc(
  req: IncomingMessage,
  res: ServerResponse,
  dispatch: ListenHostRpcOptions["dispatch"],
): Promise<void> {
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
  try {
    const result = await dispatch(request);
    json(res, result.ok ? 200 : 403, result);
  } catch (err) {
    json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function spawnHostRpcChild(input: {
  dispatch: ListenHostRpcOptions["dispatch"];
  listenHost: string;
  advertisedHost: string;
}): Promise<HostRpcHandle> {
  const childPath = fileURLToPath(new URL("./host-rpc-child.ts", import.meta.url));
  const args = childPath.endsWith(".ts")
    ? ["--experimental-strip-types", "--no-warnings", childPath]
    : [childPath];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      SILVER_RPC_LISTEN_HOST: input.listenHost,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(err);
    };
    const handleLine = (line: string) => {
      if (line.startsWith("silver-host-rpc-ready ")) {
        if (settled) return;
        settled = true;
        try {
          const ready = JSON.parse(line.slice("silver-host-rpc-ready ".length)) as { port: number };
          resolve({
            origin: `http://${input.advertisedHost}:${ready.port}`,
            listenHost: input.listenHost,
            advertisedHost: input.advertisedHost,
            port: ready.port,
            close: () =>
              new Promise((done) => {
                child.once("exit", () => done());
                child.kill("SIGTERM");
              }),
          });
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      if (!line.startsWith("silver-host-rpc-req ")) return;
      const rest = line.slice("silver-host-rpc-req ".length);
      const space = rest.indexOf(" ");
      if (space <= 0) return;
      const id = rest.slice(0, space);
      void (async () => {
        let response: HostRpcResponse;
        try {
          const request = JSON.parse(rest.slice(space + 1)) as HostRpcRequest;
          response = await input.dispatch(request);
        } catch (err) {
          response = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (!child.stdin?.writable) return;
        child.stdin.write(`silver-host-rpc-res ${id} ${JSON.stringify(response)}\n`);
      })();
    };
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const parts = stdout.split("\n");
      stdout = parts.pop() ?? "";
      for (const line of parts) handleLine(line);
    });
    child.once("error", (err) => fail(err));
    child.once("exit", (code) => {
      if (!settled) fail(new Error(`host rpc child exited ${String(code)}: ${stderr || stdout}`));
    });
  });
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
