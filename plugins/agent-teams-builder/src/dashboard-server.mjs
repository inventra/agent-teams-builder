#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentTeamsRoot, ensureAgentTeamsRoot, getAgent, listAgents, prepareWorkflowRun } from "./store.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(packageRoot, "web");
const systemRoot = () => path.join(ensureAgentTeamsRoot(), ".system");
const runtimeFile = () => path.join(systemRoot(), "dashboard-runtime.json");
const schedulesFile = () => path.join(systemRoot(), "schedules.json");
const runsRoot = () => path.join(systemRoot(), "runs");
const defaultPort = Number(process.env.VIXO_AGENTS_PORT || 47824);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function bodyJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy(new Error("Request body is too large"));
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Request body must be valid JSON")); }
    });
    request.on("error", reject);
  });
}

function send(response, status, value, headers = {}) {
  const payload = typeof value === "string" ? value : JSON.stringify(value);
  response.writeHead(status, {
    "content-type": typeof value === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(payload);
}

function authOkay(request, token) {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  return bearer.length === token.length && crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(token));
}

function availableHost(host) {
  const report = readJson(path.join(agentTeamsRoot(), "installation-report.json"), {});
  return report.results?.[host]?.installed === true;
}

function chooseHost(requested) {
  if (requested === "codex" || requested === "claude") {
    if (!availableHost(requested)) throw new Error(`${requested} is not installed and signed in according to installation-report.json`);
    return requested;
  }
  if (availableHost("codex")) return "codex";
  if (availableHost("claude")) return "claude";
  throw new Error("No installed and signed-in Codex or Claude Code host is available");
}

function runFile(id) { return path.join(runsRoot(), `${id}.json`); }

export function startWorkflowRun({ agent, workflow, task, host }) {
  const prepared = prepareWorkflowRun({ agent, workflow, task: task || "執行這個 Workflow" });
  const selectedHost = chooseHost(host);
  const id = crypto.randomUUID();
  const agentDirectory = path.join(agentTeamsRoot(), prepared.agent.id);
  const logFile = path.join(runsRoot(), `${id}.log`);
  fs.mkdirSync(runsRoot(), { recursive: true });
  const record = {
    id,
    agentId: prepared.agent.id,
    agentName: prepared.agent.displayName,
    workflowId: prepared.workflow.id,
    workflowName: prepared.workflow.name,
    host: selectedHost,
    task: prepared.task,
    status: "running",
    approvalExpected: prepared.execution.requiresApprovalNodes,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    logFile
  };
  writeJson(runFile(id), record);
  const output = fs.openSync(logFile, "a", 0o600);
  const command = process.platform === "win32" ? `${selectedHost}.cmd` : selectedHost;
  const args = selectedHost === "codex"
    ? ["exec", "--skip-git-repo-check", "-C", agentDirectory, "--sandbox", "workspace-write", "-"]
    : ["-p", "--permission-mode", "dontAsk", "--output-format", "text"];
  const throughCmd = process.platform === "win32";
  const executable = throughCmd ? (process.env.ComSpec || "cmd.exe") : command;
  const commandArgs = throughCmd ? ["/d", "/s", "/c", command, ...args] : args;
  const child = spawn(executable, commandArgs, {
    cwd: agentDirectory,
    detached: false,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", output, output]
  });
  child.stdin.end(prepared.prompt);
  child.on("error", (error) => {
    fs.closeSync(output);
    writeJson(runFile(id), { ...record, status: "failed", finishedAt: new Date().toISOString(), error: error.message });
  });
  child.on("close", (code) => {
    try { fs.closeSync(output); } catch {}
    writeJson(runFile(id), {
      ...record,
      status: code === 0 ? (record.approvalExpected ? "waiting-approval" : "completed") : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: code
    });
  });
  return record;
}

function recentRuns() {
  fs.mkdirSync(runsRoot(), { recursive: true });
  return fs.readdirSync(runsRoot())
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(runsRoot(), name), null))
    .filter(Boolean)
    .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
    .slice(0, 30);
}

function dashboardState() {
  return {
    product: "VIXO Agents",
    root: ensureAgentTeamsRoot(),
    agents: listAgents().map((summary) => getAgent(summary.id)),
    schedules: readJson(schedulesFile(), []),
    runs: recentRuns(),
    hosts: { codex: availableHost("codex"), claude: availableHost("claude") },
    refreshedAt: new Date().toISOString()
  };
}

function upsertSchedule(input) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || "")) throw new Error("time must use 24-hour HH:MM format");
  const prepared = prepareWorkflowRun({ agent: input.agentId, workflow: input.workflowId, task: input.task || "依排程執行 Workflow" });
  const host = chooseHost(input.host);
  const schedules = readJson(schedulesFile(), []);
  const id = input.id || crypto.randomUUID();
  const existing = schedules.find((item) => item.id === id);
  const schedule = {
    id,
    agentId: prepared.agent.id,
    workflowId: prepared.workflow.id,
    workflowName: prepared.workflow.name,
    task: prepared.task,
    host,
    time: input.time,
    enabled: input.enabled !== false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    lastRunDate: existing?.lastRunDate || null,
    updatedAt: new Date().toISOString()
  };
  const next = schedules.filter((item) => item.id !== id);
  next.push(schedule);
  writeJson(schedulesFile(), next);
  return schedule;
}

function deleteSchedule(id) {
  const schedules = readJson(schedulesFile(), []);
  const next = schedules.filter((item) => item.id !== id);
  if (next.length === schedules.length) throw new Error("Schedule not found");
  writeJson(schedulesFile(), next);
}

function processSchedules(now = new Date()) {
  const schedules = readJson(schedulesFile(), []);
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  let changed = false;
  for (const schedule of schedules) {
    if (!schedule.enabled || schedule.time !== time || schedule.lastRunDate === date) continue;
    schedule.lastRunDate = date;
    schedule.updatedAt = new Date().toISOString();
    changed = true;
    try { startWorkflowRun({ agent: schedule.agentId, workflow: schedule.workflowId, task: schedule.task, host: schedule.host }); }
    catch (error) {
      const id = crypto.randomUUID();
      writeJson(runFile(id), {
        id,
        agentId: schedule.agentId,
        workflowId: schedule.workflowId,
        workflowName: schedule.workflowName,
        host: schedule.host,
        status: "failed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  if (changed) writeJson(schedulesFile(), schedules);
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

export function createDashboardServer({ token = crypto.randomBytes(32).toString("hex") } = {}) {
  return {
    token,
    server: http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (url.pathname === "/health") return send(response, 200, { status: "ok", product: "vixo-agents", pid: process.pid });
        if (url.pathname.startsWith("/api/") && !authOkay(request, token)) return send(response, 401, { error: "Unauthorized" });
        if (request.method === "GET" && url.pathname === "/api/state") return send(response, 200, dashboardState());
        if (request.method === "POST" && url.pathname === "/api/runs") return send(response, 202, startWorkflowRun(await bodyJson(request)));
        if (request.method === "POST" && url.pathname === "/api/schedules") return send(response, 200, upsertSchedule(await bodyJson(request)));
        if (request.method === "DELETE" && url.pathname.startsWith("/api/schedules/")) {
          deleteSchedule(decodeURIComponent(url.pathname.slice("/api/schedules/".length)));
          return send(response, 200, { ok: true });
        }
        const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        const file = path.resolve(webRoot, relative);
        if (!file.startsWith(`${webRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(response, 404, "Not found");
        response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store", "x-content-type-options": "nosniff" });
        fs.createReadStream(file).pipe(response);
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    })
  };
}

export async function serve({ port = defaultPort } = {}) {
  ensureAgentTeamsRoot();
  fs.mkdirSync(systemRoot(), { recursive: true });
  const { server, token } = createDashboardServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  writeJson(runtimeFile(), { pid: process.pid, port: actualPort, token, url: `http://127.0.0.1:${actualPort}/?token=${token}`, startedAt: new Date().toISOString() });
  processSchedules();
  const timer = setInterval(() => processSchedules(), 30_000);
  const stop = () => {
    clearInterval(timer);
    try { fs.unlinkSync(runtimeFile()); } catch {}
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return { server, token, port: actualPort };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await serve();
}
