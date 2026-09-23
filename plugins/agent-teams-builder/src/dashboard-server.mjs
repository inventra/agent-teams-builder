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
    "access-control-allow-origin": "null",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
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

const RUN_STATE_MARKER = /VIXO_RUN_STATE:\s*(COMPLETED|WAITING_INPUT|WAITING_APPROVAL)(?:\s*:\s*([a-z0-9-]+))?/i;

function cleanLastMessage(value) {
  return String(value || "").replace(RUN_STATE_MARKER, "").trim().slice(-12_000);
}

export function classifyRunOutcome({ exitCode, lastMessage, approvalMode = "manual", remainingApprovals = 0 }) {
  if (exitCode !== 0) return { status: "failed", pendingNodeId: null };
  const text = String(lastMessage || "").trim();
  const marker = text.match(RUN_STATE_MARKER);
  if (marker?.[1]?.toUpperCase() === "WAITING_INPUT") return { status: "waiting-input", pendingNodeId: null };
  if (marker?.[1]?.toUpperCase() === "WAITING_APPROVAL") {
    return approvalMode === "auto"
      ? { status: "waiting-input", pendingNodeId: marker[2] || null }
      : { status: "waiting-approval", pendingNodeId: marker[2] || null };
  }
  if (marker?.[1]?.toUpperCase() === "COMPLETED") return { status: "completed", pendingNodeId: null };
  if (/(?:請問|請提供|請指定|需要您提供|[?？])\s*$/u.test(text)) {
    return { status: "waiting-input", pendingNodeId: null };
  }
  if (approvalMode === "manual" && remainingApprovals > 0 && /(?:請|是否).{0,30}(?:確認|核准|同意|同步)/u.test(text)) {
    return { status: "waiting-approval", pendingNodeId: null };
  }
  return { status: "completed", pendingNodeId: null };
}

function executionProtocol(approvalMode) {
  return [
    "",
    "VIXO Dashboard 執行狀態協定：",
    "- 需要使用者補充查詢條件、帳號選擇或其他資料時，停下並在最後一行輸出 VIXO_RUN_STATE: WAITING_INPUT。",
    approvalMode === "auto"
      ? "- 本次已自動核准 Workflow 內建的 approval 節點，不要因這些節點停下；但仍須遵守宿主工具的權限與安全規則。"
      : "- 到達 Workflow approval 節點時，停下並在最後一行輸出 VIXO_RUN_STATE: WAITING_APPROVAL:<node-id>。",
    "- 所有節點完成時，在最後一行輸出 VIXO_RUN_STATE: COMPLETED。",
    "- 狀態行前先用繁體中文回報已完成範圍、等待的資料或核准內容。"
  ].join("\n");
}

function parseCodexEvent(line, record) {
  try {
    const event = JSON.parse(line);
    const sessionId = event.thread_id || event.threadId || event.session_id || event.sessionId;
    if (typeof sessionId === "string" && sessionId) record.sessionId = sessionId;
  } catch {}
}

function spawnWorkflowTurn(record, prompt, { resume = false } = {}) {
  const output = fs.openSync(record.logFile, "a", 0o600);
  const command = process.platform === "win32" ? `${record.host}.cmd` : record.host;
  const lastMessageFile = path.join(runsRoot(), `${record.id}.last.txt`);
  record.lastMessageFile = lastMessageFile;
  const args = record.host === "codex"
    ? resume
      ? ["exec", "resume", "--json", "--skip-git-repo-check", "-o", lastMessageFile, record.sessionId, "-"]
      : ["exec", "--skip-git-repo-check", "-C", record.agentDirectory, "--sandbox", "workspace-write", "--json", "-o", lastMessageFile, "-"]
    : resume
      ? ["-p", "--resume", record.sessionId, "--permission-mode", "dontAsk", "--output-format", "json"]
      : ["-p", "--session-id", record.sessionId, "--permission-mode", "dontAsk", "--output-format", "json"];
  const throughCmd = process.platform === "win32";
  const executable = throughCmd ? (process.env.ComSpec || "cmd.exe") : command;
  const commandArgs = throughCmd ? ["/d", "/s", "/c", command, ...args] : args;
  const child = spawn(executable, commandArgs, {
    cwd: record.agentDirectory,
    detached: false,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdoutText = "";
  let codexBuffer = "";
  let finalized = false;
  const append = (chunk) => {
    try { fs.writeSync(output, chunk); } catch {}
  };
  child.stdout.on("data", (chunk) => {
    append(chunk);
    stdoutText = `${stdoutText}${chunk}`.slice(-4_000_000);
    if (record.host === "codex") {
      codexBuffer += chunk.toString("utf8");
      const lines = codexBuffer.split(/\r?\n/);
      codexBuffer = lines.pop() || "";
      lines.forEach((line) => parseCodexEvent(line, record));
    }
  });
  child.stderr.on("data", append);
  child.stdin.end(prompt);
  const finalize = (code, error = null) => {
    if (finalized) return;
    finalized = true;
    if (codexBuffer) parseCodexEvent(codexBuffer, record);
    try { fs.closeSync(output); } catch {}
    let lastMessage = "";
    if (record.host === "codex") {
      try { lastMessage = fs.readFileSync(lastMessageFile, "utf8"); } catch {}
    } else {
      try {
        const parsed = JSON.parse(stdoutText);
        lastMessage = parsed.result || parsed.message || "";
        record.sessionId = parsed.session_id || parsed.sessionId || record.sessionId;
      } catch { lastMessage = stdoutText; }
    }
    const remainingApprovals = Math.max(0, record.approvalNodes.length - record.approvalIndex);
    const outcome = error
      ? { status: "failed", pendingNodeId: null }
      : classifyRunOutcome({ exitCode: code, lastMessage, approvalMode: record.approvalMode, remainingApprovals });
    const current = readJson(runFile(record.id), record);
    const pendingNode = outcome.pendingNodeId
      ? record.approvalNodes.find((node) => node.id === outcome.pendingNodeId)
      : record.approvalNodes[record.approvalIndex] || null;
    writeJson(runFile(record.id), {
      ...current,
      sessionId: record.sessionId || current.sessionId || null,
      status: outcome.status,
      pendingNodeId: outcome.status === "waiting-approval" ? pendingNode?.id || null : null,
      pendingNodeName: outcome.status === "waiting-approval" ? pendingNode?.name || null : null,
      lastMessage: cleanLastMessage(lastMessage),
      finishedAt: new Date().toISOString(),
      exitCode: code,
      error: error?.message || null
    });
  };
  child.on("error", (error) => finalize(null, error));
  child.on("close", (code) => finalize(code));
}

export function startWorkflowRun({ agent, workflow, task, host, approvalMode = "manual" }) {
  const prepared = prepareWorkflowRun({ agent, workflow, task: task || "執行這個 Workflow", approvalMode });
  const selectedHost = chooseHost(host);
  const id = crypto.randomUUID();
  const agentDirectory = path.join(agentTeamsRoot(), prepared.agent.id);
  const logFile = path.join(runsRoot(), `${id}.log`);
  fs.mkdirSync(runsRoot(), { recursive: true });
  const approvalNodes = prepared.workflow.nodes
    .filter((node) => node.requiresApproval)
    .map((node) => ({ id: node.id, name: node.name }));
  const record = {
    id,
    agentId: prepared.agent.id,
    agentName: prepared.agent.displayName,
    workflowId: prepared.workflow.id,
    workflowName: prepared.workflow.name,
    host: selectedHost,
    task: prepared.task,
    status: "running",
    approvalMode,
    approvalExpected: approvalNodes.length > 0,
    approvalNodes,
    approvalIndex: approvalMode === "auto" ? approvalNodes.length : 0,
    pendingNodeId: null,
    pendingNodeName: null,
    sessionId: selectedHost === "claude" ? crypto.randomUUID() : null,
    agentDirectory,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    logFile
  };
  writeJson(runFile(id), record);
  spawnWorkflowTurn(record, `${prepared.prompt}${executionProtocol(approvalMode)}`);
  return record;
}

function resumeWorkflowRun(id, { action, message }) {
  const file = runFile(id);
  const record = readJson(file, null);
  if (!record) throw new Error("Run not found");
  const expected = action === "approve" ? "waiting-approval" : "waiting-input";
  if (record.status !== expected) throw new Error(`Run is ${record.status}, not ${expected}`);
  if (!record.sessionId) throw new Error("這是舊版本建立的執行紀錄，無法續跑。請用新版 Play 重新執行。");
  const input = String(message || "").trim();
  if (!input) throw new Error(action === "approve" ? "請提供核准說明" : "請輸入要回覆 Agent 的內容");
  if (action === "approve") record.approvalIndex = Math.min(record.approvalNodes.length, record.approvalIndex + 1);
  record.status = "running";
  record.pendingNodeId = null;
  record.pendingNodeName = null;
  record.lastMessage = null;
  record.finishedAt = null;
  record.resumedAt = new Date().toISOString();
  writeJson(file, record);
  const continuation = action === "approve"
    ? `使用者已明確核准目前的 Workflow 節點並回覆：${input}\n請從目前停下的節點後繼續，不要重做已完成的節點。`
    : `使用者回覆：${input}\n請使用這份資料從目前停下處繼續，不要重做已完成的節點。`;
  spawnWorkflowTurn(record, `${continuation}${executionProtocol(record.approvalMode)}`, { resume: true });
  return record;
}

function rejectWorkflowRun(id, message = "使用者拒絕這個核准節點") {
  const file = runFile(id);
  const record = readJson(file, null);
  if (!record) throw new Error("Run not found");
  if (!["waiting-approval", "waiting-input"].includes(record.status)) throw new Error(`Run is ${record.status} and cannot be rejected`);
  const next = { ...record, status: "rejected", rejectionReason: String(message).trim(), finishedAt: new Date().toISOString() };
  writeJson(file, next);
  return next;
}

function publicRun(record) {
  const { logFile: _logFile, lastMessageFile: _lastMessageFile, agentDirectory: _agentDirectory, sessionId, ...safe } = record;
  return { ...safe, resumable: Boolean(sessionId) };
}

function recentRuns() {
  fs.mkdirSync(runsRoot(), { recursive: true });
  return fs.readdirSync(runsRoot())
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(runsRoot(), name), null))
    .filter(Boolean)
    .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
    .slice(0, 30)
    .map(publicRun);
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
    approvalMode: input.approvalMode === "auto" ? "auto" : "manual",
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
    try {
      startWorkflowRun({
        agent: schedule.agentId,
        workflow: schedule.workflowId,
        task: schedule.task,
        host: schedule.host,
        approvalMode: schedule.approvalMode || "manual"
      });
    }
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
        if (request.method === "OPTIONS") return send(response, 204, "");
        if (url.pathname === "/health") return send(response, 200, { status: "ok", product: "vixo-agents", pid: process.pid });
        if (url.pathname.startsWith("/api/") && !authOkay(request, token)) return send(response, 401, { error: "Unauthorized" });
        if (request.method === "GET" && url.pathname === "/api/state") return send(response, 200, dashboardState());
        if (request.method === "POST" && url.pathname === "/api/runs") return send(response, 202, publicRun(startWorkflowRun(await bodyJson(request))));
        const runAction = url.pathname.match(/^\/api\/runs\/([^/]+)\/(approve|reply|reject)$/);
        if (request.method === "POST" && runAction) {
          const id = decodeURIComponent(runAction[1]);
          const action = runAction[2];
          const body = await bodyJson(request);
          if (action === "reject") return send(response, 200, publicRun(rejectWorkflowRun(id, body.message)));
          return send(response, 202, publicRun(resumeWorkflowRun(id, { action, message: body.message })));
        }
        if (request.method === "POST" && url.pathname === "/api/schedules") return send(response, 200, upsertSchedule(await bodyJson(request)));
        if (request.method === "DELETE" && url.pathname.startsWith("/api/schedules/")) {
          deleteSchedule(decodeURIComponent(url.pathname.slice("/api/schedules/".length)));
          return send(response, 200, { ok: true });
        }
        const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        const file = path.resolve(webRoot, relative);
        if (!file.startsWith(`${webRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(response, 404, "Not found");
        response.writeHead(200, {
          "content-type": contentType(file),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "access-control-allow-origin": "null"
        });
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
