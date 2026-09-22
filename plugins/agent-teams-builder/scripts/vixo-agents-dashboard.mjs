#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureAgentTeamsRoot } from "../src/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(here, "..", "src", "dashboard-server.mjs");
const runtimeFile = path.join(ensureAgentTeamsRoot(), ".system", "dashboard-runtime.json");
const command = process.argv[2] || "open";

function runtime() {
  try { return JSON.parse(fs.readFileSync(runtimeFile, "utf8")); }
  catch { return null; }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function healthy(value) {
  if (!value?.port || !pidAlive(value.pid)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${value.port}/health`, { signal: AbortSignal.timeout(1000) });
    const body = await response.json();
    return response.ok && body.product === "vixo-agents";
  } catch { return false; }
}

async function start() {
  const current = runtime();
  if (await healthy(current)) return current;
  try { fs.unlinkSync(runtimeFile); } catch {}
  const dashboardSystemRoot = path.join(ensureAgentTeamsRoot(), ".system");
  fs.mkdirSync(dashboardSystemRoot, { recursive: true });
  const output = fs.openSync(path.join(dashboardSystemRoot, "dashboard.log"), "a", 0o600);
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output, output],
    env: { ...process.env, AGENT_TEAMS_HOME: ensureAgentTeamsRoot() }
  });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const value = runtime();
    if (await healthy(value)) return value;
  }
  throw new Error("VIXO Agents Dashboard did not start; check .system/dashboard.log");
}

function openUrl(url) {
  const platform = process.platform;
  const executable = platform === "darwin" ? "open" : platform === "win32" ? "cmd.exe" : "xdg-open";
  const args = platform === "darwin" ? [url] : platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(executable, args, { detached: true, windowsHide: true, stdio: "ignore" });
  child.unref();
}

if (command === "serve") {
  const module = await import(serverScript);
  await module.serve();
} else if (command === "status") {
  const value = runtime();
  process.stdout.write(`${JSON.stringify({ running: await healthy(value), ...value }, null, 2)}\n`);
} else if (command === "stop") {
  const value = runtime();
  if (value?.pid && pidAlive(value.pid)) process.kill(value.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (value?.pid && pidAlive(value.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { fs.unlinkSync(runtimeFile); } catch {}
  process.stdout.write("VIXO Agents Dashboard stopped.\n");
} else {
  const value = await start();
  if (command === "open") openUrl(value.url);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
