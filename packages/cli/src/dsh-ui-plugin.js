import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  readOperatorCommanderAcknowledgment,
  withdrawOperatorCommanderMessage,
  writeOperatorCommanderMessage,
} from "./operator-commander-message.ts";

export const inject = ["connection"];

function repoRoot() {
  const root = process.env.SILVER_REPO_ROOT;
  if (!root || !fs.existsSync(path.join(root, "packages/cli/src/main.ts"))) {
    throw new Error("Silver UI requires SILVER_REPO_ROOT from `silver ui`");
  }
  return root;
}

function missionDir(root, id) {
  if (typeof id !== "string" || !/^ui-[0-9a-f-]{36}$/.test(id)) throw new Error("invalid Mission id");
  return path.join(root, ".silver-tmp", "missions", id);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

const configNames = {
  ctf: ["silver.local.yaml", "silver.local.yml", "silver.config.yaml"],
};

function configChoices(root) {
  return Object.entries(configNames).flatMap(([mode, names]) => names
    .filter((name) => fs.existsSync(path.join(root, name)))
    .map((name) => ({ id: name, mode, label: name })));
}

function configFile(root, id, mode) {
  const choice = configChoices(root).find((item) => item.id === id && (!mode || item.mode === mode));
  if (!choice) throw new Error("select an existing Silver configuration for this mode");
  return path.join(root, choice.id);
}

function defaultConfigId(root, mode) {
  return configChoices(root).find((item) => item.mode === mode)?.id;
}

async function configState(root, id) {
  const file = configFile(root, id);
  const text = fs.readFileSync(file, "utf8");
  const { parseSilverConfig } = await import("@silver/host");
  const config = parseSilverConfig(text, "yaml");
  const provider = config.agents["ctf-solver"]?.provider ?? config.defaults.provider;
  const model = config.agents["ctf-solver"]?.model ?? config.defaults.model;
  return {
    id,
    text,
    revision: createHash("sha256").update(text).digest("hex"),
    summary: {
      model: `${config.agents["ctf-solver"]?.provider ?? config.defaults.provider} / ${config.agents["ctf-solver"]?.model ?? config.defaults.model}`,
      workers: `${config.swarm.initialWorkers} / ${config.swarm.maxWorkers}`,
      rooms: config.competition.maxConcurrentRooms,
      execution: config.runtime.executionProfile,
    },
    settings: {
      providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) =>
        [name, Object.keys(provider.models ?? {})])),
      modelContextWindows: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) =>
        [name, Object.fromEntries(Object.entries(provider.models ?? {}).map(([modelName, modelConfig]) =>
          [modelName, modelConfig.contextWindow ?? null]))])),
      provider,
      model,
      contextWindow: config.providers[provider]?.models?.[model]?.contextWindow ?? null,
      effort: config.agents["ctf-solver"]?.effort ?? config.defaults.effort,
      initialWorkers: config.swarm.initialWorkers,
      maxWorkers: config.swarm.maxWorkers,
      maxConcurrentRooms: config.competition.maxConcurrentRooms,
      timeoutMs: config.live.timeoutMs,
      maxTurns: config.live.maxTurns,
      executionProfile: config.runtime.executionProfile,
      externalSearch: config.runtime.externalSearch,
      nativeAssistants: config.nativeAssistants.enabled,
      maxAssistants: config.nativeAssistants.maxPerMember,
      maxAssistantDepth: config.nativeAssistants.maxDepth,
      maxModelLoops: config.runtime.maxModelLoops,
      feedEnabled: config.swarm.chat.enabled,
      feedDelivery: config.swarm.chat.delivery,
      skillRoots: config.skills.roots,
      hintPolicy: config.competition.hintPolicy,
      autonomy: config.competition.autonomy,
      workerRoles: config.swarm.workerRoles,
    },
  };
}

const editablePaths = new Set([
  "defaults.provider", "defaults.model", "defaults.effort",
  "agents.ctf-solver.provider", "agents.ctf-solver.model", "agents.ctf-solver.effort",
  "swarm.initialWorkers", "swarm.maxWorkers", "swarm.workerRoles",
  "competition.maxConcurrentRooms", "competition.hintPolicy", "competition.autonomy",
  "live.timeoutMs", "live.maxTurns",
  "runtime.externalSearch", "nativeAssistants.enabled", "nativeAssistants.maxPerMember",
  "nativeAssistants.maxDepth", "runtime.maxModelLoops", "swarm.chat.enabled",
  "swarm.chat.delivery", "skills.roots",
]);

const selectedModelContextWindowPath = "selectedModel.contextWindow";

async function updateConfig(root, payload) {
  const current = await configState(root, payload?.id);
  if (current.revision !== payload?.revision) throw new Error("configuration changed on disk; reload before saving");
  if (!Array.isArray(payload?.changes) || payload.changes.length === 0 || payload.changes.length > 24) {
    throw new Error("select configuration values to update");
  }
  const document = parseDocument(current.text);
  if (document.errors.length) throw new Error("configuration YAML is invalid");
  const selectedProvider = payload.changes.find((change) => change?.path === "agents.ctf-solver.provider")?.value
    ?? current.settings.provider;
  const selectedModel = payload.changes.find((change) => change?.path === "agents.ctf-solver.model")?.value
    ?? current.settings.model;
  for (const change of payload.changes) {
    if (change?.path === selectedModelContextWindowPath) {
      if (typeof selectedProvider !== "string" || !selectedProvider ||
        typeof selectedModel !== "string" || !selectedModel) {
        throw new Error("select a provider and model before setting the context window");
      }
      if (!Object.hasOwn(current.settings.providers, selectedProvider)) {
        throw new Error("select a configured provider before setting the context window");
      }
      const modelPath = ["providers", selectedProvider, "models", selectedModel, "contextWindow"];
      if (change.value === null) document.deleteIn(modelPath);
      else {
        if (!Number.isInteger(change.value) || change.value <= 0) {
          throw new Error("context window must be a positive integer");
        }
        document.setIn(modelPath, change.value);
      }
      continue;
    }
    if (!editablePaths.has(change?.path)) throw new Error("unsupported configuration field");
    const value = change.value;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" &&
      !(Array.isArray(value) && value.every((item) => typeof item === "string"))) {
      throw new Error("invalid configuration value");
    }
    document.setIn(change.path.split("."), value);
  }
  return saveConfig(root, { id: payload.id, revision: current.revision, text: String(document) });
}

function recentMissionActivity(file) {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  const length = Math.min(size, 128 * 1024);
  const fd = fs.openSync(file, "r");
  let chunk;
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    chunk = buffer.toString("utf8");
  } finally { fs.closeSync(fd); }
  const lines = chunk.split("\n");
  if (size > length) lines.shift();
  const allowed = new Set([
    "queue-target", "worker-start", "worker-end", "submit", "target-result-recorded",
    "room-control-request", "room-control-resolved", "commander-transport-waiting",
    "commander-transport-resume", "mission-done", "mission-failed", "interrupt",
  ]);
  return lines.flatMap((line) => {
    try {
      const event = JSON.parse(line);
      if (!allowed.has(event.type)) return [];
      return [{
        at: event.ts,
        type: event.type,
        targetId: typeof event.targetId === "string" ? event.targetId : null,
        outcome: typeof event.outcome === "string" ? event.outcome : null,
        decision: typeof event.decision === "string" ? event.decision : null,
        correct: typeof event.correct === "boolean" ? event.correct : null,
        count: Number.isInteger(event.correctFlagCount) ? event.correctFlagCount : null,
        total: Number.isInteger(event.totalFlagCount) ? event.totalFlagCount : null,
      }];
    } catch { return []; }
  }).slice(-40).reverse();
}

function recentOperatorMessages(file) {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  const length = Math.min(size, 128 * 1024);
  const fd = fs.openSync(file, "r");
  let chunk;
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    chunk = buffer.toString("utf8");
  } finally { fs.closeSync(fd); }
  const lines = chunk.split("\n");
  if (size > length) lines.shift();
  return lines.slice(-40).flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return typeof row.text === "string" && typeof row.at === "string" ? [row] : [];
    } catch { return []; }
  });
}

function recordOperatorMessage(dir, row) {
  fs.appendFileSync(path.join(dir, "ui-messages.jsonl"), `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

async function saveConfig(root, payload) {
  const file = configFile(root, payload?.id);
  if (typeof payload.text !== "string" || Buffer.byteLength(payload.text) > 1024 * 1024) throw new Error("configuration is too large");
  const current = await configState(root, payload.id);
  if (current.revision !== payload.revision) throw new Error("configuration changed on disk; reload before saving");
  const { parseSilverConfig } = await import("@silver/host");
  parseSilverConfig(payload.text, "yaml");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, payload.text, { mode: fs.statSync(file).mode & 0o777 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return configState(root, payload.id);
}

function missionState(root, id) {
  const dir = missionDir(root, id);
  const processState = readJson(path.join(dir, "mission-process.json"));
  if (!processState) throw new Error("Mission is not available");
  const session = readJson(path.join(dir, "mission-session-state.json"));
  const projects = Array.isArray(session?.projects) ? session.projects : [];
  const results = Array.isArray(session?.results) ? session.results : [];
  const reviews = Array.isArray(session?.targetReviews) ? session.targetReviews : [];
  const solved = new Set(results.filter((item) => item.outcome === "solved").map((item) => item.targetId));
  for (const review of reviews) if (review.status === "completed") solved.add(review.targetId);
  return {
    id,
    configId: readJson(path.join(dir, "ui-launch.json"))?.configId ?? null,
    status: processState.status ?? "launched",
    pid: processState.pid ?? null,
    startedAt: processState.startedAt ?? null,
    updatedAt: processState.updatedAt ?? null,
    terminalKind: session?.terminalKind ?? null,
    mode: readJson(path.join(dir, "ui-launch.json"))?.mode ?? null,
    solvedRooms: solved.size,
    discoveredRooms: Array.isArray(session?.discoveredTargetIds) ? session.discoveredTargetIds.length : null,
    activity: recentMissionActivity(path.join(dir, "mission-events.jsonl")),
    messages: recentOperatorMessages(path.join(dir, "ui-messages.jsonl")),
    projects: projects.map((item) => ({ challengeId: item.challengeId, status: item.status,
      platformCompleted: reviews.some((review) => review.targetId === item.challengeId && review.status === "completed") }))
      .filter((item) => typeof item.challengeId === "string"),
  };
}

async function runCli(root, args) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(root, "packages/cli/src/main.ts"), ...args], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { error += chunk.toString(); });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  if (code !== 0) throw new Error(error.trim() || `Silver exited with status ${code}`);
  return output;
}

async function start(root, payload) {
  if (payload?.mode !== "ctf") throw new Error("choose the long-task collaboration mode");
  if (typeof payload.mission !== "string" || !payload.mission.trim()) throw new Error("Mission is required");
  if (Buffer.byteLength(payload.mission) > 1024 * 1024) throw new Error("Mission is too large");
  const configId = payload.configId ?? defaultConfigId(root, payload.mode);
  const configPath = configFile(root, configId, payload.mode);
  const id = `ui-${randomUUID()}`;
  const dir = missionDir(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const missionFile = path.join(dir, "operator-mission.md");
  fs.writeFileSync(missionFile, payload.mission, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "ui-launch.json"), JSON.stringify({ mode: payload.mode, configId }), { mode: 0o600 });
  try {
    await runCli(root, ["run", missionFile, "--config", configPath, "--detach", "--replay", dir]);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return missionState(root, id);
}

async function commanderMessage(root, payload) {
  const state = missionState(root, payload?.id);
  if (state.status !== "running" && state.status !== "launched") throw new Error("Mission is not running");
  const dir = missionDir(root, payload.id);
  const request = writeOperatorCommanderMessage(dir, payload.message, payload.mode);
  for (let i = 0; i < 150; i += 1) {
    if (readOperatorCommanderAcknowledgment(dir, request.requestId)) {
      recordOperatorMessage(dir, { target: "commander", mode: request.mode, text: request.message });
      return { accepted: true, mode: request.mode };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  withdrawOperatorCommanderMessage(dir, request.requestId);
  throw new Error("Commander did not accept the message within 15 seconds");
}

function roomWorkDirFor(root, payload) {
  const dir = missionDir(root, payload?.id);
  const state = missionState(root, payload.id);
  if (typeof payload.challengeId !== "string" || !state.projects.some((item) => item.challengeId === payload.challengeId)) {
    throw new Error("select a Room from this Mission");
  }
  const targetsDir = path.join(dir, "targets");
  const roomWorkDir = path.resolve(targetsDir, payload.challengeId);
  if (!roomWorkDir.startsWith(`${targetsDir}${path.sep}`) || !fs.existsSync(roomWorkDir)) throw new Error("Room workspace is unavailable");
  return { dir, state, roomWorkDir };
}

function roomOverview(root, payload) {
  const { roomWorkDir } = roomWorkDirFor(root, payload);
  const live = readJson(path.join(roomWorkDir, "live-session-state.json"));
  if (typeof live?.cwd !== "string") return { feed: [], statuses: [], intel: [] };
  const workspace = path.resolve(live.cwd, "../..");
  const runtimeDir = path.join(roomWorkDir, ".silver-runtime");
  if (!workspace.startsWith(`${runtimeDir}${path.sep}`) || path.basename(workspace) !== payload.challengeId) {
    throw new Error("Room workspace is unavailable");
  }
  const room = readJson(path.join(workspace, "room/state.json"));
  const feed = Array.isArray(room?.messages) ? room.messages.slice(-30).reverse().map((item) => ({
    messageId: item.messageId, seq: item.seq, type: item.type, text: item.text,
    authorAttemptId: item.authorAttemptId, createdAt: item.createdAt,
  })) : [];
  const statuses = Object.entries(room?.statuses ?? {}).map(([memberId, item]) => ({
    memberId, approach: item.approach, updatedAt: item.updatedAt,
  }));
  const intelFile = path.join(workspace, "intel/records-v2.jsonl");
  const intel = [];
  if (fs.existsSync(intelFile)) {
    for (const line of fs.readFileSync(intelFile, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record.challengeId !== payload.challengeId) continue;
        const version = record.versions?.find((item) => item.version === record.currentVersion);
        if (!version) continue;
        intel.push({
          intelId: record.intelId, status: record.status, observation: version.observation,
          tags: version.tags ?? [], conditions: version.conditions ?? null,
          evidence: version.evidence ?? [], comments: (record.comments ?? []).slice(-3).map((item) => ({
            body: item.body, authorMemberId: item.authorMemberId, createdAt: item.createdAt,
          })), updatedAt: record.updatedAt,
        });
      } catch { /* Ignore an incomplete final JSONL row while the room is writing. */ }
    }
  }
  return { feed, feedTotal: room?.messages?.length ?? 0, statuses, intel: intel.slice(-30).reverse(), intelTotal: intel.length };
}

async function message(root, payload) {
  const { dir, state, roomWorkDir } = roomWorkDirFor(root, payload);
  if (state.status !== "running" && state.status !== "launched") throw new Error("Mission is not running");
  if (typeof payload.message !== "string" || !payload.message.trim()) throw new Error("message is required");
  if (Buffer.byteLength(payload.message) > 8192) throw new Error("message is too large");
  if (!["queue", "steer", "interrupt"].includes(payload.mode)) throw new Error("invalid delivery mode");
  const file = path.join(dir, `operator-message-${randomUUID()}.txt`);
  fs.writeFileSync(file, payload.message, { mode: 0o600 });
  try {
    const output = await runCli(root, ["room", "message", "--room-work-dir", roomWorkDir, "--challenge", payload.challengeId, "--mode", payload.mode, "--message-file", file]);
    const result = JSON.parse(output);
    recordOperatorMessage(dir, { target: payload.challengeId, mode: payload.mode, text: payload.message });
    return result;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function apply(ctx) {
  const root = repoRoot();
  ctx.effect(() => ctx.connection.rpc.intercept("/api", (endpoint) => endpoint.startsWith("silver/"), async (rawEndpoint, payload) => {
    const endpoint = rawEndpoint.slice("silver/".length);
    try {
      if (endpoint === "missions/list") {
        const base = path.join(root, ".silver-tmp", "missions");
        const ids = fs.existsSync(base) ? fs.readdirSync(base).filter((id) => /^ui-[0-9a-f-]{36}$/.test(id)) : [];
        return { ok: true, value: ids.map((id) => {
          try { return missionState(root, id); } catch { return null; }
        }).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 30) };
      }
      if (endpoint === "missions/start") return { ok: true, value: await start(root, payload) };
      if (endpoint === "missions/get") return { ok: true, value: missionState(root, payload?.id) };
      if (endpoint === "commander/message") return { ok: true, value: await commanderMessage(root, payload) };
      if (endpoint === "configs/list") return { ok: true, value: configChoices(root) };
      if (endpoint === "configs/get") return { ok: true, value: await configState(root, payload?.id) };
      if (endpoint === "configs/save") return { ok: true, value: await saveConfig(root, payload) };
      if (endpoint === "configs/update") return { ok: true, value: await updateConfig(root, payload) };
      if (endpoint === "rooms/status") {
        const { roomWorkDir } = roomWorkDirFor(root, payload);
        const output = await runCli(root, ["room", "status", "--room-work-dir", roomWorkDir, "--challenge", payload.challengeId]);
        return { ok: true, value: JSON.parse(output) };
      }
      if (endpoint === "rooms/overview") return { ok: true, value: roomOverview(root, payload) };
      if (endpoint === "rooms/message") return { ok: true, value: await message(root, payload) };
      throw new Error("unknown Silver action");
    } catch (error) {
      return { ok: false, error: { code: "silver_action_failed", message: error instanceof Error ? error.message : String(error), details: {} } };
    }
  }));
}
