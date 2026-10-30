import http from "node:http";
import type { DirtyKind, ImplantDurability } from "@silver/protocol";


export type PlatformMode = "normal" | "crash-after-accept" | "reject";

export class PlatformCrash extends Error {
  constructor() {
    super("platform accepted but response lost");
    this.name = "PlatformCrash";
  }
}

export interface MockChallengeFile {
  contentType: string;
  body: string;
}

export interface AwdStatus {
  round: number;
  rotateEveryMs: number;
  patched: boolean;
  slaAlive: boolean;
  foothold: boolean;
  sniffing: boolean;
  implantDurability?: ImplantDurability;
}

export interface AwdImplant {
  stealth: boolean;
  token: string;
  channel?: string;
  durability?: ImplantDurability;
}

export interface TrafficFrame {
  ts: string;
  src: string;
  path: string;
  note: string;
  round: number;
}

interface AwdService {
  patched: boolean;
  raceOpen: boolean;
  secretPath: boolean;
  poison: boolean;
  foothold: boolean;
  sniffing: boolean;
  implant?: AwdImplant;
  honeypot?: string;
  tap: TrafficFrame[];
}

export interface MockChallenge {
  id: string;
  flagCount: number;
  flags: string[];
  html: string;
  files?: Record<string, MockChallengeFile>;
  /** Rotating AWD flags. Submit only the current round's token. */
  awd?: { rotateEveryMs?: number };
  /** Rival agent for agent-awd. Prompt injection via POST /agent/:id leaks systemPrompt. */
  agent?: { systemPrompt: string };
  /** Host-gated platform hints. Never put the flag here. */
  hints?: string[];
}

export interface SubmitResult {
  status: "accepted" | "rejected";
  slot?: number;
}

/**
 * In-memory contest platform. Models the crash window: the platform may
 * accept internally while the HTTP response never returns (unknown on host).
 */
export class MockPlatform {
  mode: PlatformMode = "normal";
  readonly accepted = new Map<string, Set<string>>();
  readonly received = new Map<string, string[]>();
  private server: http.Server | undefined;
  private readonly challenges: MockChallenge[];
  private readonly awdRounds = new Map<string, number>();
  private readonly awdServices = new Map<string, AwdService>();
  private readonly hintCursor = new Map<string, number>();
  /** DEF CON-style PCAP delay in ticks. 0 = immediate (tests). Finals default 1. */
  pcapDelayTicks = 0;
  port = 0;

  constructor(challenges: MockChallenge[]) {
    this.challenges = challenges;
  }

  challenge(id: string): MockChallenge {
    const found = this.challenges.find((c) => c.id === id);
    if (!found) throw new Error(`unknown challenge ${id}`);
    return found;
  }

  html(id: string): string {
    return this.renderPage(id, { implant: false });
  }

  requestHint(id: string): { ok: true; hint: string; remaining: number } | { ok: false; error: "no_hints" } {
    const hints = this.challenge(id).hints ?? [];
    const used = this.hintCursor.get(id) ?? 0;
    const text = hints[used];
    if (!text) return { ok: false, error: "no_hints" };
    this.hintCursor.set(id, used + 1);
    return { ok: true, hint: text, remaining: hints.length - used - 1 };
  }

  applyPatch(challengeId: string): void {
    const state = this.requireAwd(challengeId);
    state.patched = true;
    state.foothold = false;
    if (state.implant?.durability === "hidden") delete state.implant;
  }

  applyFoothold(challengeId: string): void {
    this.requireAwd(challengeId).foothold = true;
  }

  applySniff(challengeId: string): void {
    const state = this.requireAwd(challengeId);
    if (!state.foothold && state.implant?.durability !== "immortal") {
      throw new Error("foothold required for sniff");
    }
    state.sniffing = true;
  }

  applyImplant(challengeId: string, implant: AwdImplant): void {
    if (!implant.token.trim()) throw new Error("implant token required");
    const state = this.requireAwd(challengeId);
    if (implant.durability && !state.foothold) throw new Error("foothold required for host implant");
    state.implant = {
      stealth: implant.stealth,
      token: implant.token,
      ...(implant.channel ? { channel: implant.channel } : {}),
      ...(implant.durability ? { durability: implant.durability } : {}),
    };
  }

  applyHoneypot(challengeId: string, fake: string): void {
    if (!fake.trim()) throw new Error("honeypot flag required");
    this.requireAwd(challengeId).honeypot = fake;
  }

  applyDirty(challengeId: string, kind: DirtyKind): void {
    const state = this.requireAwd(challengeId);
    if (kind === "checker-race") {
      state.raceOpen = true;
      return;
    }
    if (kind === "patch-secret-path") {
      state.patched = true;
      state.secretPath = true;
      return;
    }
    if (kind === "wipe-hidden") {
      if (state.implant?.durability === "hidden") delete state.implant;
      if (state.implant?.durability !== "immortal") state.sniffing = false;
      return;
    }
    if (kind === "clean-immortal") {
      delete state.implant;
      state.sniffing = false;
      state.foothold = false;
      return;
    }
    state.poison = true;
  }

  traffic(challengeId: string): TrafficFrame[] {
    return [...(this.awdServices.get(challengeId)?.tap ?? [])];
  }

  /** Delayed, origin-stripped PCAP drop. src is always `peer`. */
  releasedTraffic(challengeId: string): TrafficFrame[] {
    const now = this.round(challengeId);
    const delay = Math.max(0, this.pcapDelayTicks);
    return this.traffic(challengeId)
      .filter((row) => now - row.round >= delay)
      .map((row) => ({ ...row, src: "peer" }));
  }

  simulateRivalHarvest(challengeId: string): TrafficFrame {
    const flag = this.currentFlag(challengeId);
    return this.recordTap(challengeId, {
      src: "rival-b",
      path: `/challenge/${challengeId}`,
      note: `GET scorebot flag=${flag}`,
    });
  }

  honeypotFlag(challengeId: string): string | undefined {
    return this.awdServices.get(challengeId)?.honeypot;
  }

  submit(challengeId: string, flag: string): SubmitResult {
    const challenge = this.challenge(challengeId);
    const log = this.received.get(challengeId) ?? [];
    log.push(flag);
    this.received.set(challengeId, log);
    if (this.mode === "reject") return { status: "rejected" };
    const slot = challenge.awd ? (flag === this.currentFlag(challengeId) ? this.round(challengeId) : -1) : challenge.flags.indexOf(flag);
    if (slot < 0) return { status: "rejected" };
    const got = this.accepted.get(challengeId) ?? new Set();
    got.add(flag);
    this.accepted.set(challengeId, got);
    if (challenge.awd) {
      this.recordTap(challengeId, { src: "submit", path: "/submit", note: `POST flag=${flag}` });
    }
    if (this.mode === "crash-after-accept") {
      throw new PlatformCrash();
    }
    return { status: "accepted", slot };
  }

  currentFlag(challengeId: string): string {
    const challenge = this.challenge(challengeId);
    const round = this.round(challengeId);
    return challenge.flags[round % challenge.flags.length] ?? "";
  }

  round(challengeId: string): number {
    return this.awdRounds.get(challengeId) ?? 0;
  }

  tick(challengeId: string): AwdStatus {
    const challenge = this.challenge(challengeId);
    if (!challenge.awd) throw new Error(`challenge ${challengeId} is not awd`);
    const next = this.round(challengeId) + 1;
    this.awdRounds.set(challengeId, next);
    this.simulateRivalHarvest(challengeId);
    return this.awdStatus(challengeId) ?? {
      round: next,
      rotateEveryMs: challenge.awd.rotateEveryMs ?? 60_000,
      patched: false,
      slaAlive: true,
      foothold: false,
      sniffing: false,
    };
  }

  awdStatus(challengeId: string): AwdStatus | undefined {
    const challenge = this.challenges.find((row) => row.id === challengeId);
    if (!challenge?.awd) return undefined;
    const state = this.ensureAwd(challengeId);
    const status: AwdStatus = {
      round: this.round(challengeId),
      rotateEveryMs: challenge.awd.rotateEveryMs ?? 60_000,
      patched: state.patched,
      slaAlive: this.slaAlive(challengeId),
      foothold: state.foothold,
      sniffing: state.sniffing,
    };
    if (state.implant?.durability) status.implantDurability = state.implant.durability;
    return status;
  }

  async listen(host = "127.0.0.1"): Promise<number> {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname.startsWith("/agent/")) {
        this.handleAgent(req, res, url);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/challenge/")) {
        const parts = url.pathname.split("/").filter(Boolean);
        const id = parts[1];
        if (!id) {
          res.writeHead(404);
          res.end("missing");
          return;
        }
        if (parts[2] === "redir") {
          res.writeHead(302, { location: `/challenge/${id}` });
          res.end();
          return;
        }
        if (parts[2] === "check") {
          const status = this.awdStatus(id);
          if (!status) {
            res.writeHead(404);
            res.end("missing");
            return;
          }
          this.closeCheckerRace(id);
          res.writeHead(200, { "content-type": "application/json", "x-challenge-id": id });
          res.end(JSON.stringify({ alive: status.slaAlive, round: status.round, rotateEveryMs: status.rotateEveryMs }));
          return;
        }
        if (parts[2] === "host") {
          const implant = this.implantAuthorized(id, req, url);
          const state = this.awdServices.get(id);
          if (!implant && !state?.foothold) {
            res.writeHead(403);
            res.end("no shell");
            return;
          }
          const flag = this.currentFlag(id);
          this.recordTap(id, { src: implant ? "implant" : "foothold", path: `/challenge/${id}/host`, note: `cat /root/flag ${flag}` });
          res.writeHead(200, { "content-type": "text/plain", "x-challenge-id": id });
          res.end(`uid=0(root)\n/root/flag ${flag}\n`);
          return;
        }
        if (parts[2] === "honeypot") {
          const fake = this.honeypotFlag(id);
          if (!fake) {
            res.writeHead(404);
            res.end("missing");
            return;
          }
          res.writeHead(200, { "content-type": "text/plain", "x-challenge-id": id });
          res.end(fake);
          return;
        }
        try {
          const challenge = this.challenge(id);
          const implant = this.implantAuthorized(id, req, url);
          const fileName = parts[2];
          if (fileName === "debug") {
            const state = this.awdServices.get(id);
            if (!state?.secretPath && !implant) {
              res.writeHead(404);
              res.end("missing");
              return;
            }
            res.writeHead(200, { "content-type": "text/plain", "x-challenge-id": id });
            res.end(this.currentFlag(id));
            return;
          }
          if (fileName) {
            const file = challenge.files?.[fileName];
            if (!file) {
              res.writeHead(404);
              res.end("missing");
              return;
            }
            const flag = implant || this.publicFlagVisible(id) ? this.currentFlag(id) : "";
            res.writeHead(200, { "content-type": file.contentType, "x-challenge-id": id });
            res.end(renderTemplate(challenge, file.body, flag));
            return;
          }
          let body = this.renderPage(id, { implant });
          if (url.searchParams.get("variant") === "alt") body += "<!-- alt-surface -->";
          const liveFlag = this.currentFlag(id);
          if (liveFlag && body.includes(liveFlag)) {
            this.recordTap(id, { src: implant ? "implant" : "public", path: `/challenge/${id}`, note: `GET html flag=${liveFlag}` });
          }
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "x-challenge-id": id,
            "set-cookie": "session=super-secret-cookie",
          });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end("missing");
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/submit") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c as Buffer));
        req.on("end", () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            challengeId: string;
            flag: string;
          };
          try {
            const verdict = this.submit(payload.challengeId, payload.flag);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(verdict));
          } catch (err) {
            if (err instanceof PlatformCrash) {
              req.socket.destroy();
              return;
            }
            throw err;
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("no");
    });
    await new Promise<void>((resolve) => this.server?.listen(0, host, () => resolve()));
    const addr = this.server.address();
    if (!addr || typeof addr === "string") throw new Error("failed to bind mock platform");
    this.port = addr.port;
    return this.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (!err || (err as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }
        reject(err);
      });
    });
  }

  origin(host = "127.0.0.1"): string {
    return `http://${host}:${this.port}`;
  }

  private renderPage(id: string, access: { implant: boolean }): string {
    const challenge = this.challenge(id);
    if (!challenge.awd) return challenge.html;
    const flag = access.implant || this.publicFlagVisible(id) ? this.currentFlag(id) : "";
    let body = renderTemplate(challenge, challenge.html, flag);
    const state = this.ensureAwd(id);
    if (state.poison) body += `<!-- ${state.honeypot ?? "flag{poison}"} -->`;
    return body;
  }

  private requireAwd(challengeId: string): AwdService {
    const challenge = this.challenge(challengeId);
    if (!challenge.awd) throw new Error(`challenge ${challengeId} is not awd`);
    return this.ensureAwd(challengeId);
  }

  private ensureAwd(challengeId: string): AwdService {
    const existing = this.awdServices.get(challengeId);
    if (existing) return existing;
    const created: AwdService = {
      patched: false,
      raceOpen: false,
      secretPath: false,
      poison: false,
      foothold: false,
      sniffing: false,
      tap: [],
    };
    this.awdServices.set(challengeId, created);
    return created;
  }

  private publicFlagVisible(challengeId: string): boolean {
    const state = this.awdServices.get(challengeId);
    if (!state) return true;
    return !state.patched || state.raceOpen;
  }

  private slaAlive(challengeId: string): boolean {
    const implant = this.awdServices.get(challengeId)?.implant;
    if (!implant) return true;
    if (!implant.stealth) return false;
    return !NOISY_IMPLANT.test(`${implant.channel ?? ""} ${implant.token}`);
  }

  private implantAuthorized(challengeId: string, req: http.IncomingMessage, url: URL): boolean {
    const implant = this.awdServices.get(challengeId)?.implant;
    if (!implant) return false;
    const header = req.headers["x-awd-token"];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const token = String(url.searchParams.get("token") ?? fromHeader ?? "");
    return token === implant.token;
  }

  private recordTap(challengeId: string, frame: Omit<TrafficFrame, "ts" | "round">): TrafficFrame {
    const row: TrafficFrame = { ...frame, ts: new Date().toISOString(), round: this.round(challengeId) };
    this.ensureAwd(challengeId).tap.push(row);
    return row;
  }

  private closeCheckerRace(challengeId: string): void {
    const state = this.awdServices.get(challengeId);
    if (state) state.raceOpen = false;
  }

  private handleAgent(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const id = url.pathname.split("/").filter(Boolean)[1];
    if (!id) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    let challenge: MockChallenge;
    try {
      challenge = this.challenge(id);
    } catch {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    const agent = challenge.agent;
    if (!agent) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "x-challenge-id": id });
      res.end(JSON.stringify({ status: "ready" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("method");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const prompt = promptFromBody(Buffer.concat(chunks).toString("utf8"));
      const leaked = looksLikePromptInjection(prompt);
      const payload = leaked
        ? { reply: agent.systemPrompt, leaked: true }
        : { reply: "Happy to help with the current contest task.", leaked: false };
      res.writeHead(200, { "content-type": "application/json", "x-challenge-id": id });
      res.end(JSON.stringify(payload));
    });
  }
}

const NOISY_IMPLANT = /backdoor|webshell|shell|eval|cmd|php\?|\/bin\/sh/i;

function renderTemplate(challenge: MockChallenge, body: string, flag: string): string {
  if (!challenge.awd) return body;
  return body.replaceAll("{{FLAG}}", flag);
}

function promptFromBody(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const candidate = rec.prompt ?? rec.message ?? rec.input;
      if (typeof candidate === "string") return candidate;
    }
  } catch {
    /* raw prompt */
  }
  return text;
}

function looksLikePromptInjection(prompt: string): boolean {
  return /ignore\b[\s\S]{0,40}\b(previous|prior|above)|system prompt|hidden (task|instruction)|repeat (your |the )?(instructions|prompt)|dump\b[\s\S]{0,40}\b(memory|context|task)|task (data|secret)|reveal[\s\S]{0,20}secret/i.test(
    prompt,
  );
}
