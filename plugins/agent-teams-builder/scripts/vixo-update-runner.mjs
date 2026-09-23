#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(process.env.AGENT_TEAMS_INSTALL_ROOT || process.env.AGENT_TEAMS_HOME || path.join(os.homedir(), "Downloads", "Agent Teams"));
const systemRoot = path.join(root, ".system");
const operationFile = path.join(systemRoot, "update-runtime.json");
const updater = path.resolve(process.env.VIXO_UPDATER_SCRIPT || path.join(systemRoot, "updater", "install.mjs"));
const logFile = path.join(systemRoot, "update.log");

function write(value) {
  fs.mkdirSync(systemRoot, { recursive: true });
  const temporary = `${operationFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, operationFile);
}

const startedAt = new Date().toISOString();
write({ status: "running", pid: process.pid, startedAt, updater });
let output;
try {
  if (!fs.existsSync(updater)) throw new Error("Installed updater script is missing");
  output = fs.openSync(logFile, "a", 0o600);
  fs.writeSync(output, `\n[${startedAt}] VIXO Agents update started\n`);
  const result = spawnSync(process.execPath, [updater], {
    cwd: root,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", output, output],
    env: { ...process.env, AGENT_TEAMS_HOME: root, AGENT_TEAMS_INSTALL_ROOT: root }
  });
  if (result.status !== 0) throw new Error(result.error?.message || `Updater exited with status ${result.status}`);
  const state = JSON.parse(fs.readFileSync(path.join(systemRoot, "update-state.json"), "utf8"));
  write({ status: "succeeded", pid: process.pid, startedAt, finishedAt: new Date().toISOString(), installedVersion: state.installedVersion, revision: state.revision });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  try { if (output !== undefined) fs.writeSync(output, `[${new Date().toISOString()}] ${message}\n`); } catch {}
  write({ status: "failed", pid: process.pid, startedAt, finishedAt: new Date().toISOString(), error: message, logFile });
  process.exitCode = 1;
} finally {
  try { if (output !== undefined) fs.closeSync(output); } catch {}
}
