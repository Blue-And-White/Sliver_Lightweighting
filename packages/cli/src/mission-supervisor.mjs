#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [replayPath, entry, ...missionArgs] = process.argv.slice(2);
if (!replayPath || !entry) throw new Error("mission supervisor requires a replay directory and CLI entry");

const stateFile = path.join(replayPath, "mission-session-state.json");
const supervisorFile = path.join(replayPath, "mission-supervisor.json");
const finalKinds = new Set(["all_completed", "sample_completed"]);
let child;
let stopping = false;
let restarts = 0;
let stopTimer;

function signalMissionGroup(pid, signal) {
  if (process.platform === "win32" || !pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function cleanMissionGroup(pid) {
  if (process.platform === "win32" || !pid) return;
  signalMissionGroup(pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 250));
  signalMissionGroup(pid, "SIGKILL");
}

function writeState(status, extra = {}) {
  const temp = `${supervisorFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({
    schema: "silver.mission-supervisor.v1",
    pid: process.pid,
    childPid: child?.pid ?? null,
    restarts,
    status,
    updatedAt: new Date().toISOString(),
    ...extra,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, supervisorFile);
}

function isTerminal() {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return state.status === "terminal" && state.missionDone === true && finalKinds.has(state.terminalKind);
  } catch {
    return false;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    if (child) {
      const active = child;
      active.kill("SIGINT");
      stopTimer ??= setTimeout(() => {
        if (child === active) {
          active.kill("SIGKILL");
          signalMissionGroup(active.pid, "SIGKILL");
        }
      }, 30_000);
    }
  });
}

writeState(isTerminal() ? "terminal" : "starting");
while (!stopping && !isTerminal()) {
  child = spawn(process.execPath, [...process.execArgv, entry, ...missionArgs], {
    cwd: process.cwd(),
    env: { ...process.env, SILVER_MISSION_SUPERVISED: "1" },
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  writeState("running");
  const exited = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = undefined;
  await cleanMissionGroup(child.pid);
  child = undefined;
  if (stopping || isTerminal()) {
    writeState(stopping ? "stopped" : "terminal", { lastExit: exited });
    break;
  }
  restarts += 1;
  writeState("restarting", { lastExit: exited });
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
if (stopping) writeState("stopped");
