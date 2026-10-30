export interface CliArgs {
  command: string;
  authAction?: "login" | "status";
  authProvider?: string;
  roomAction?: "set-deadline" | "status" | "message" | "ui";
  missionAction?: "ui";
  configPath?: string;
  profile?: string;
  live?: boolean;
  /** Launch a Mission in a detached child process and return its replay/log paths. */
  detach?: boolean;
  /** IsolationHost Docker cell. Off by default; v1 live uses the host filesystem sandbox. */
  isolate?: boolean;
  unsafeHostfs?: boolean;
  caseName?: string;
  challengeId?: string;
  replayPath?: string;
  mission?: string;
  /** Optional operator-selected contest capability adapter. */
  contestAdapter?: string;
  target?: string;
  timeoutMs?: number;
  maxTurns?: number;
  sampleSize?: number;
  sampleSeed?: string;
  onlyBoardIds?: string[];
  skills?: boolean;
  stagnationCheckpoint?: boolean;
  migrationStatus?: boolean;
  /** Absolute room deadline (ISO or epoch ms). Host operator control. */
  deadlineAt?: string;
  /** Extend the current room deadline by this many ms. */
  extendMs?: number;
  /** Contest slot dir when addressing a contest room control. */
  roomWorkDir?: string;
  /** Operator text delivered by the already-running DSH Team process. */
  operatorMessage?: string;
  /** File containing an operator room message. */
  operatorMessageFile?: string;
  operatorMode?: "queue" | "steer" | "interrupt";
  /**
   * Formal room members, e.g. `lead,worker,worker`.
   * Default (omit): single Lead compat path. Does not use Lead DSH subagents as Workers.
   */
  team?: string;
  /**
   * Experimental Official Team Room. One Lead root; C3 recruit uses D2 permits.
   * Does not replace C6 Host recruit or the default swarm entry.
   */
  officialTeam?: boolean;
  /** Four-seat mock snapshot. Not the AWD room entry. */
  /** Local AWD round/health events. Not a live contest connection. */
  awdEvents?: string;
  /** Official DSH Web UI launch options. */
  uiNoOpen?: boolean;
  uiHost?: string;
  uiPort?: number;
  uiTrustedHosts?: string[];
  operatorStop?: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const tokens = argv.slice(2);
  let command = tokens[0] ?? "help";
  if (command === "--help" || command === "-h") command = "help";
  if (command.startsWith("-")) throw new Error(`unknown flag ${command}`);
  const out: CliArgs = { command };
  const missionCommand = command === "run";
  let firstOption = 1;
  if (command === "auth") {
    const action = tokens[1];
    const provider = tokens[2];
    if (action !== "login" && action !== "status") throw new Error("use silver auth login|status <provider>");
    if (!provider || provider.startsWith("-") || !/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
      throw new Error("silver auth requires an official pi-ai provider id");
    }
    out.authAction = action;
    out.authProvider = provider;
    firstOption = 3;
  }
  if (command === "room") {
    const action = tokens[1];
    if (action !== "set-deadline" && action !== "status" && action !== "message" && action !== "ui") {
      throw new Error("use silver room set-deadline|status|message|ui");
    }
    out.roomAction = action;
    firstOption = 2;
  }
  if (command === "mission") {
    if (tokens[1] !== "ui") throw new Error("use silver mission ui");
    out.missionAction = "ui";
    firstOption = 2;
  }
  for (let i = firstOption; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === "--live") {
      out.live = true;
      continue;
    }
    if (tok === "--detach") {
      out.detach = true;
      continue;
    }
    if (tok === "--isolate") {
      out.isolate = true;
      continue;
    }
    if (tok === "--unsafe-hostfs") {
      out.unsafeHostfs = true;
      continue;
    }
    if (tok === "--skills") {
      out.skills = true;
      continue;
    }
    if (tok === "--official-team") {
      out.officialTeam = true;
      continue;
    }
    if (tok === "--operator-stop") {
      out.operatorStop = true;
      continue;
    }
    if (tok === "--no-open") {
      if (command !== "ui" && out.roomAction !== "ui" && out.missionAction !== "ui") throw new Error("--no-open is only valid with silver ui, room ui, or mission ui");
      out.uiNoOpen = true;
      continue;
    }
    if (tok === "--no-skills") {
      out.skills = false;
      continue;
    }
    if (tok === "--stagnation-checkpoint") {
      out.stagnationCheckpoint = true;
      continue;
    }
    if (tok === "--migration-status") {
      out.migrationStatus = true;
      continue;
    }
    if (
      tok === "--config" ||
      tok === "--profile" ||
      tok === "--challenge" ||
      tok === "--replay" ||
      tok === "--mission" ||
      tok === "--host" ||
      tok === "--port" ||
      tok === "--trusted-host" ||
      tok === "--timeout-ms" ||
      tok === "--max-turns" ||
      tok === "--sample-size" ||
      tok === "--sample-seed" ||
      tok === "--only" ||
      tok === "--deadline-at" ||
      tok === "--extend-ms" ||
      tok === "--room-work-dir" ||
      tok === "--message" ||
      tok === "--message-file" ||
      tok === "--mode" ||
      tok === "--room" ||
      tok === "--team"
    ) {
      if ((tok === "--host" || tok === "--trusted-host") && command !== "ui") {
        throw new Error(`${tok} is only valid with silver ui`);
      }
      if (tok === "--port" && command !== "ui" && out.roomAction !== "ui" && out.missionAction !== "ui") {
        throw new Error("--port is only valid with silver ui, room ui, or mission ui");
      }
      if (tok === "--mode" && out.roomAction !== "message") {
        throw new Error("--mode is only valid with silver room message");
      }
      const value = tokens[i + 1];
      const allowSigned =
        (tok === "--extend-ms" || tok === "--deadline-at") &&
        typeof value === "string" &&
        /^-?\d+(\.\d+)?$/.test(value);
      if (!value || (value.startsWith("-") && !allowSigned)) throw new Error(`${tok} requires a value`);
      if (tok === "--config") out.configPath = value;
      else if (tok === "--profile") out.profile = value;
      else if (tok === "--challenge") out.challengeId = value;
      else if (tok === "--replay") out.replayPath = value;
      else if (tok === "--mission") out.mission = value;
      else if (tok === "--host") out.uiHost = value;
      else if (tok === "--port") out.uiPort = parsePort(value);
      else if (tok === "--trusted-host") out.uiTrustedHosts = [...(out.uiTrustedHosts ?? []), value];
      else if (tok === "--timeout-ms") out.timeoutMs = parseBudgetInt(tok, value);
      else if (tok === "--max-turns") out.maxTurns = parseNonNegativeBudgetInt(tok, value);
      else if (tok === "--sample-size") out.sampleSize = parseBudgetInt(tok, value);
      else if (tok === "--sample-seed") out.sampleSeed = parseSampleSeed(value);
      else if (tok === "--deadline-at") out.deadlineAt = value;
      else if (tok === "--extend-ms") out.extendMs = parseSignedInt(tok, value);
      else if (tok === "--room-work-dir") out.roomWorkDir = value;
      else if (tok === "--message") out.operatorMessage = value;
      else if (tok === "--message-file") out.operatorMessageFile = value;
      else if (tok === "--mode") out.operatorMode = parseOperatorMode(value);
      else if (tok === "--team") out.team = value;
      else out.onlyBoardIds = parseBoardIds(value);
      i += 1;
      continue;
    }
    if (tok.startsWith("--config=")) {
      out.configPath = tok.slice("--config=".length);
      continue;
    }
    if (tok.startsWith("--profile=")) {
      out.profile = tok.slice("--profile=".length);
      continue;
    }
    if (tok.startsWith("--challenge=")) {
      out.challengeId = tok.slice("--challenge=".length);
      continue;
    }
    if (tok.startsWith("--replay=")) {
      out.replayPath = tok.slice("--replay=".length);
      continue;
    }
    if (tok.startsWith("--mission=")) {
      out.mission = tok.slice("--mission=".length);
      continue;
    }
    if (tok.startsWith("--host=")) {
      if (command !== "ui") throw new Error("--host is only valid with silver ui");
      out.uiHost = tok.slice("--host=".length);
      continue;
    }
    if (tok.startsWith("--port=")) {
      if (command !== "ui" && out.roomAction !== "ui" && out.missionAction !== "ui") throw new Error("--port is only valid with silver ui, room ui, or mission ui");
      out.uiPort = parsePort(tok.slice("--port=".length));
      continue;
    }
    if (tok.startsWith("--trusted-host=")) {
      if (command !== "ui") throw new Error("--trusted-host is only valid with silver ui");
      out.uiTrustedHosts = [...(out.uiTrustedHosts ?? []), tok.slice("--trusted-host=".length)];
      continue;
    }
    if (tok.startsWith("--mode=")) {
      if (out.roomAction !== "message") throw new Error("--mode is only valid with silver room message");
      out.operatorMode = parseOperatorMode(tok.slice("--mode=".length));
      continue;
    }
    if (tok.startsWith("--timeout-ms=")) {
      out.timeoutMs = parseBudgetInt("--timeout-ms", tok.slice("--timeout-ms=".length));
      continue;
    }
    if (tok.startsWith("--max-turns=")) {
      out.maxTurns = parseNonNegativeBudgetInt("--max-turns", tok.slice("--max-turns=".length));
      continue;
    }
    if (tok.startsWith("--sample-size=")) {
      out.sampleSize = parseBudgetInt("--sample-size", tok.slice("--sample-size=".length));
      continue;
    }
    if (tok.startsWith("--sample-seed=")) {
      out.sampleSeed = parseSampleSeed(tok.slice("--sample-seed=".length));
      continue;
    }
    if (tok.startsWith("--only=")) {
      out.onlyBoardIds = parseBoardIds(tok.slice("--only=".length));
      continue;
    }
    if (tok.startsWith("--deadline-at=")) {
      out.deadlineAt = tok.slice("--deadline-at=".length);
      continue;
    }
    if (tok.startsWith("--extend-ms=")) {
      out.extendMs = parseSignedInt("--extend-ms", tok.slice("--extend-ms=".length));
      continue;
    }
    if (tok.startsWith("--room-work-dir=")) {
      out.roomWorkDir = tok.slice("--room-work-dir=".length);
      continue;
    }
    if (tok.startsWith("--message=")) {
      out.operatorMessage = tok.slice("--message=".length);
      continue;
    }
    if (tok.startsWith("--message-file=")) {
      out.operatorMessageFile = tok.slice("--message-file=".length);
      continue;
    }
    if (tok.startsWith("--team=")) {
      out.team = tok.slice("--team=".length);
      continue;
    }
    if (missionCommand && !out.mission && !out.target && !tok.startsWith("-")) {
      out.mission = tok;
      out.live = true;
      continue;
    }
    if (tok.startsWith("-")) throw new Error(`unknown flag ${tok}`);
    throw new Error(`unexpected argument ${tok}`);
  }
  if (missionCommand && (out.mission || out.target)) out.live = true;
  return out;
}

function parsePort(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("--port requires an integer from 0 to 65535");
  }
  return value;
}

function parseOperatorMode(raw: string): "queue" | "steer" | "interrupt" {
  if (raw === "queue" || raw === "steer" || raw === "interrupt") return raw;
  throw new Error("--mode requires queue, steer, or interrupt");
}

function parseSampleSeed(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("--sample-seed requires a non-empty value");
  if (value.length > 80) throw new Error("--sample-seed must be 80 characters or fewer");
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error("--sample-seed must be [A-Za-z0-9._:-]+");
  return value;
}

function parseBudgetInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} requires a positive integer`);
  return Math.floor(n);
}

function parseSignedInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) throw new Error(`${flag} requires a non-zero integer`);
  return Math.floor(n);
}

function parseNonNegativeBudgetInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} requires a non-negative integer`);
  return Math.floor(n);
}

function parseBoardIds(raw: string): string[] {
  const out = raw
    .split(/[,，、\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (out.length === 0) throw new Error("--only requires at least one board id");
  for (const code of out) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,64}$/.test(code)) {
      throw new Error(`invalid board id ${code}`);
    }
  }
  return [...new Set(out)];
}
