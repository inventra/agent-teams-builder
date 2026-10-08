#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentTeamsRoot, ensureAgentTeamsRoot, getAgent, listAgents, prepareWorkflowRun } from "./store.mjs";
import { checkForUpdate, readUpdateOperation, startUpdate } from "./update-service.mjs";
import { getWorkbenchRun, readWorkbenchPreferences, saveWorkbenchPreferences, workbenchState } from "./workbench-store.mjs";
import { cloudStatus, cloudClient, cloudSync, cloudConnected, cloudPortalUrl, listSourceAgents, prepareSourceRun, previewLocalPublish, commitSourcePreview } from './cloud-service.mjs';
import { renderSharedVideoPolicy } from "./shared-video-policy.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(packageRoot, "web");
const systemRoot = () => path.join(ensureAgentTeamsRoot(), ".system");
const runtimeFile = () => path.join(systemRoot(), "dashboard-runtime.json");
const schedulesFile = () => path.join(systemRoot(), "schedules.json");
const runsRoot = () => path.join(systemRoot(), "runs");
const defaultPort = Number(process.env.VIXO_AGENTS_PORT || 47824);
const codexStateFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), ".codex-global-state.json");

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

// The sandboxed desktop panel cannot open popups. Open only the bundled public
// portal through the OS; never accept a destination or executable from the API.
export async function openCloudPortal({ spawnImpl = spawn, platform = process.platform } = {}) {
  const url = new URL(cloudPortalUrl());
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid cloud portal URL');
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
  return { opened: true };
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

export function listCodexProjects(state = readJson(codexStateFile(), {})) {
  const localProjects = state?.["local-projects"] && typeof state["local-projects"] === "object"
    ? state["local-projects"]
    : {};
  const labels = state?.["electron-workspace-root-labels"] && typeof state["electron-workspace-root-labels"] === "object"
    ? state["electron-workspace-root-labels"]
    : {};
  const order = Array.isArray(state?.["project-order"]) ? state["project-order"] : [];
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  const selectedId = typeof state?.["selected-project"]?.projectId === "string"
    ? state["selected-project"].projectId
    : null;
  return Object.entries(localProjects).flatMap(([id, project]) => {
    const workspacePath = Array.isArray(project?.rootPaths)
      ? project.rootPaths.find((root) => typeof root === "string" && path.isAbsolute(root) && fs.existsSync(root))
      : null;
    if (!id || !workspacePath) return [];
    return [{
      id,
      name: String(project.name || labels[workspacePath] || path.basename(workspacePath)),
      workspacePath,
      selected: id === selectedId,
      isGitRepository: fs.existsSync(path.join(workspacePath, ".git"))
    }];
  }).sort((left, right) => {
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    return (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name, "zh-TW");
  });
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

export function startWorkflowRun({ agent, workflow, task, host, approvalMode = "manual" }, preparedCloud = null) {
  const prepared = preparedCloud || prepareWorkflowRun({ agent, workflow, task: task || "執行這個 Workflow", approvalMode });
  const selectedHost = chooseHost(host);
  const id = crypto.randomUUID();
  const agentDirectory = prepared.cloud?.cacheDirectory || path.join(agentTeamsRoot(), prepared.agent.id);
  const logFile = path.join(runsRoot(), `${id}.log`);
  fs.mkdirSync(runsRoot(), { recursive: true });
  const approvalNodes = prepared.workflow.nodes
    .filter((node) => node.requiresApproval)
    .map((node) => ({ id: node.id, name: node.name }));
  const record = {
    id,
    agentId: prepared.agent.id,
    ...(prepared.cloud ? { cloud: prepared.cloud } : {}),
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

export function prepareNativeCodexRun({ agent, workflow, task, approvalMode = "manual", projectId }, preparedCloud = null) {
  const prepared = preparedCloud || prepareWorkflowRun({ agent, workflow, task: task || "執行這個 Workflow", approvalMode });
  chooseHost("codex");
  const project = listCodexProjects().find((item) => item.id === String(projectId || ""));
  if (!project) throw new Error("請選擇目前 Codex 中可用的專案");
  const id = crypto.randomUUID();
  const approvalNodes = prepared.workflow.nodes
    .filter((node) => node.requiresApproval)
    .map((node) => ({ id: node.id, name: node.name }));
  const record = {
    id,
    agentId: prepared.agent.id,
    ...(prepared.cloud ? { cloud: prepared.cloud } : {}),
    agentName: prepared.agent.displayName,
    workflowId: prepared.workflow.id,
    workflowName: prepared.workflow.name,
    host: "codex",
    task: prepared.task,
    status: "dispatching",
    executionMode: "codex-app",
    approvalMode,
    approvalExpected: approvalNodes.length > 0,
    approvalNodes,
    approvalIndex: approvalMode === "auto" ? approvalNodes.length : 0,
    projectId: project.id,
    projectName: project.name,
    workspacePath: project.workspacePath,
    sessionId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null
  };
  fs.mkdirSync(runsRoot(), { recursive: true });
  writeJson(runFile(id), record);
  return {
    record,
    nativeLaunch: {
      runId: id,
      projectId: project.id,
      projectName: project.name,
      workspacePath: project.workspacePath,
      title: `${prepared.agent.displayName} · ${prepared.workflow.name}`,
      instruction: [
        `VIXO Agents 任務：${prepared.agent.displayName} · ${prepared.workflow.name}`,
        `執行專案：${project.name}`,
        "",
        prepared.prompt,
        executionProtocol(approvalMode)
      ].join("\n")
    }
  };
}

function finishNativeDispatch(id, { threadId, error }) {
  const file = runFile(id);
  const record = readJson(file, null);
  if (!record) throw new Error("Run not found");
  if (record.executionMode !== "codex-app" || record.status !== "dispatching") throw new Error("Run is not waiting for Codex App dispatch");
  const normalizedThreadId = String(threadId || "").trim();
  const normalizedError = String(error || "").trim();
  if (!normalizedThreadId && !normalizedError) throw new Error("threadId or error is required");
  if (normalizedThreadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedThreadId)) {
    throw new Error("Invalid Codex threadId");
  }
  const next = normalizedThreadId
    ? {
        ...record,
        status: "opened-in-codex",
        sessionId: normalizedThreadId,
        dispatchedAt: new Date().toISOString(),
        lastMessage: `已在 Codex 專案「${record.projectName}」建立新任務。執行內容與後續互動請在該任務中查看。`
      }
    : {
        ...record,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: normalizedError
      };
  writeJson(file, next);
  return next;
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
  spawnWorkflowTurn(record, `${renderSharedVideoPolicy()}\n\n${continuation}${executionProtocol(record.approvalMode)}`, { resume: true });
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
  const { cloud, logFile: _logFile, lastMessageFile: _lastMessageFile, agentDirectory: _agentDirectory, workspacePath: _workspacePath, sessionId, ...safe } = record;
  return { ...safe, ...(cloud ? { cloud: { assetId: cloud.assetId, revision: cloud.revision } } : {}), threadId: record.executionMode === "codex-app" ? sessionId || null : null, resumable: Boolean(sessionId) };
}

export function cloudRecordVisible(record, userId = null) {
  const isCloud = Boolean(record?.cloud || String(record?.agentId || '').startsWith('cloud:'));
  return isCloud ? Boolean(userId && record?.cloud?.userId === userId) : !userId;
}
async function visibilityFilter() {
  let userId = null;
  if (cloudConnected()) { const client = cloudClient(); userId = (await client.getUser()).id; await client.requireApproved(); }
  return (record) => cloudRecordVisible(record, userId);
}
function recentRuns(visibleRecord = () => true) {
  fs.mkdirSync(runsRoot(), { recursive: true });
  return fs.readdirSync(runsRoot())
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(runsRoot(), name), null))
    .filter((record) => record && visibleRecord(record))
    .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
    .slice(0, 30)
    .map(publicRun);
}

async function dashboardState(update = null) {
  const codexProjects = availableHost("codex") ? listCodexProjects() : [];
  const visible = await visibilityFilter();
  return {
    product: "VIXO Agents",
    cloud: await cloudStatus(),
    root: ensureAgentTeamsRoot(),
    agents: await listSourceAgents(),
    schedules: readJson(schedulesFile(), []).filter(visible),
    runs: recentRuns(visible),
    hosts: { codex: availableHost("codex"), claude: availableHost("claude") },
    codexProjects,
    update: update ? { ...update, operation: readUpdateOperation(ensureAgentTeamsRoot()) } : null,
    refreshedAt: new Date().toISOString()
  };
}

async function upsertSchedule(input) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || "")) throw new Error("time must use 24-hour HH:MM format");
  const prepared = await prepareSourceRun({ agent: input.agentId, workflow: input.workflowId, task: input.task || "依排程執行 Workflow" }, true);
  const host = chooseHost(input.host);
  const schedules = readJson(schedulesFile(), []);
  const id = input.id || crypto.randomUUID();
  const existing = schedules.find((item) => item.id === id);
  if (existing && !(await visibilityFilter())(existing)) throw new Error("Schedule not found");
  const schedule = {
    id,
    agentId: prepared.agent.id,
    ...(prepared.cloud ? { cloud: prepared.cloud } : {}),
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

async function deleteSchedule(id) {
  const visible = await visibilityFilter();
  const schedules = readJson(schedulesFile(), []);
  if (!schedules.some((item) => item.id === id && visible(item))) throw new Error("Schedule not found");
  const next = schedules.filter((item) => item.id !== id);
  if (next.length === schedules.length) throw new Error("Schedule not found");
  writeJson(schedulesFile(), next);
}

let schedulesProcessing = false;
export async function processSchedules(now = new Date(), { prepareCloud = (input) => prepareSourceRun(input, true), prepareLocal = prepareWorkflowRun, launch = startWorkflowRun } = {}) {
  if (schedulesProcessing) return;
  schedulesProcessing = true;
  try {
  const schedules = readJson(schedulesFile(), []);
  const currentCloudUser = cloudConnected() ? (await cloudClient().getUser()).id : null;
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  for (const schedule of schedules) {
    if (!schedule.enabled || schedule.time !== time || schedule.lastRunDate === date) continue;
    if (String(schedule.agentId).startsWith("cloud:") && (!currentCloudUser || schedule.cloud?.userId !== currentCloudUser)) continue;
    schedule.lastRunDate = date;
    schedule.updatedAt = new Date().toISOString();
    // Persist the daily claim before network access; a slow refresh cannot launch twice.
    const latest = readJson(schedulesFile(), []);
    const current = latest.find((item) => item.id === schedule.id);
    if (!current || !current.enabled || current.lastRunDate === date) continue;
    current.lastRunDate = date; current.updatedAt = schedule.updatedAt;
    writeJson(schedulesFile(), latest);
    try {
      const input = { agent: schedule.agentId, workflow: schedule.workflowId, task: schedule.task, approvalMode: schedule.approvalMode || "manual" };
      const prepared = await (String(schedule.agentId).startsWith("cloud:") ? prepareCloud(input) : prepareLocal(input));
      launch({
        agent: schedule.agentId,
        workflow: schedule.workflowId,
        task: schedule.task,
        host: schedule.host,
        approvalMode: schedule.approvalMode || "manual"
      }, prepared);
    }
    catch (error) {
      const id = crypto.randomUUID();
      writeJson(runFile(id), {
        id,
        agentId: schedule.agentId,
        workflowId: schedule.workflowId,
        workflowName: schedule.workflowName,
        ...(schedule.cloud ? { cloud: schedule.cloud } : {}),
        host: schedule.host,
        status: "failed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  } finally { schedulesProcessing = false; }
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export function createDashboardServer({ token = crypto.randomBytes(32).toString("hex"), updateOptions = {} } = {}) {
  return {
    token,
    server: http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (request.method === "OPTIONS") return send(response, 204, "");
        if (url.pathname === "/health") return send(response, 200, { status: "ok", product: "vixo-agents", pid: process.pid });
        if (url.pathname.startsWith("/api/") && !authOkay(request, token)) return send(response, 401, { error: "Unauthorized" });
        if (url.pathname.startsWith('/api/cloud/')) {
          const route = url.pathname.slice('/api/cloud/'.length);
          if (request.method === 'GET') {
            if (route === 'status') return send(response, 200, await cloudStatus());
            if (route === 'access') return send(response, 200, await cloudClient().getAccess());
            if (route === 'accounts') return send(response, 200, await cloudClient().listAccounts());
            if (route === 'assets') return send(response, 200, await cloudClient().listAssets());
            if (route === 'workspaces') return send(response, 200, await cloudClient().listWorkspaces());
            if (route === 'local-agents') { await cloudClient().requireApproved(); return send(response, 200, listAgents()); }
          }
          if (request.method === 'POST') {
            const input = await bodyJson(request);
            if (route === 'open-portal') return send(response, 200, await openCloudPortal());
            if (route === 'login') return send(response, 200, await cloudClient().signInWithPassword({ username: input.username, password: input.password }));
            if (route === 'register') return send(response, 200, await cloudClient().registerAccount({ username: input.username, password: input.password, displayName: input.displayName }));
            if (route === 'account-status') return send(response, 200, await cloudClient().setAccountStatus(input.userId, input.status));
            if (route === 'setup-account') return send(response, 200, await cloudClient().setupAccount({ username: input.username, password: input.password }));
            if (route === 'pair') return send(response, 200, await cloudClient().pairDevice(input.code));
            if (route === 'disconnect') return send(response, 200, await cloudClient().signOut());
            if (route === 'device-code') return send(response, 200, await cloudClient().createDeviceCode());
            if (route === 'preview-upload') return send(response, 200, await previewLocalPublish(input));
            if (route === 'publish') return send(response, 200, await commitSourcePreview(input));
            if (route === 'pull') return send(response, 200, await cloudSync().pullAsset(input.assetId));
            if (route === 'prepare') return send(response, 200, await cloudSync().prepareAssetRun(input));
          }
          return send(response, 404, { error: 'Unknown cloud operation' });
        }
        if (request.method === "GET" && url.pathname === "/api/state") {
          const update = await checkForUpdate({ agentTeamsRoot: ensureAgentTeamsRoot(), ...updateOptions });
          return send(response, 200, await dashboardState(update));
        }
        if (request.method === "GET" && url.pathname === "/api/workbench") {
          const visible = await visibilityFilter();
          return send(response, 200, workbenchState(ensureAgentTeamsRoot(), {
            visibleRecord: visible,
            period: url.searchParams.get("period") || "today",
            agents: await listSourceAgents(),
            schedules: readJson(schedulesFile(), []).filter(visible)
          }));
        }
        if (url.pathname === "/api/preferences/workbench") {
          if (request.method === "GET") return send(response, 200, readWorkbenchPreferences(ensureAgentTeamsRoot()));
          if (request.method === "POST") return send(response, 200, saveWorkbenchPreferences(ensureAgentTeamsRoot(), await bodyJson(request)));
        }
        const runDetail = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
        if (request.method === "GET" && runDetail) {
          const run = getWorkbenchRun(ensureAgentTeamsRoot(), decodeURIComponent(runDetail[1]), await visibilityFilter());
          return send(response, run ? 200 : 404, run || { error: "Run not found" });
        }
        if (request.method === "POST" && url.pathname === "/api/update/check") {
          const update = await checkForUpdate({ agentTeamsRoot: ensureAgentTeamsRoot(), ...updateOptions, force: true });
          return send(response, 200, { ...update, operation: readUpdateOperation(ensureAgentTeamsRoot()) });
        }
        if (request.method === "POST" && url.pathname === "/api/update/apply") {
          const update = await checkForUpdate({ agentTeamsRoot: ensureAgentTeamsRoot(), ...updateOptions, force: true });
          if (update.error) throw new Error(update.error);
          if (!update.available) return send(response, 200, { status: "up-to-date", update });
          return send(response, 202, startUpdate({ agentTeamsRoot: ensureAgentTeamsRoot(), runner: updateOptions.runner, spawnImpl: updateOptions.spawnImpl }));
        }
        if (request.method === "POST" && url.pathname === "/api/runs") {
          const body = await bodyJson(request);
          if (body.host === "codex" && body.executionMode === "codex-app") {
            const prepared = prepareNativeCodexRun(body, await prepareSourceRun(body, true));
            return send(response, 202, { ...publicRun(prepared.record), nativeLaunch: prepared.nativeLaunch });
          }
          return send(response, 202, publicRun(startWorkflowRun(body, await prepareSourceRun(body, true))));
        }
        const nativeResult = url.pathname.match(/^\/api\/runs\/([^/]+)\/native-result$/);
        if (request.method === "POST" && nativeResult) {
          const record = readJson(runFile(decodeURIComponent(nativeResult[1])), null);
          if (!record || !(await visibilityFilter())(record)) return send(response, 404, { error: "Run not found" });
          return send(response, 200, publicRun(finishNativeDispatch(decodeURIComponent(nativeResult[1]), await bodyJson(request))));
        }
        const runAction = url.pathname.match(/^\/api\/runs\/([^/]+)\/(approve|reply|reject)$/);
        if (request.method === "POST" && runAction) {
          const id = decodeURIComponent(runAction[1]);
          const action = runAction[2];
          const body = await bodyJson(request);
          const visibleRun = readJson(runFile(id), null);
          if (!visibleRun || !(await visibilityFilter())(visibleRun)) return send(response, 404, { error: "Run not found" });
          if (action === "reject") return send(response, 200, publicRun(rejectWorkflowRun(id, body.message)));
          const existing = readJson(runFile(id), null);
          if (existing?.cloud?.assetId) await cloudClient().getAsset(existing.cloud.assetId);
          return send(response, 202, publicRun(resumeWorkflowRun(id, { action, message: body.message })));
        }
        if (request.method === "POST" && url.pathname === "/api/schedules") return send(response, 200, await upsertSchedule(await bodyJson(request)));
        if (request.method === "DELETE" && url.pathname.startsWith("/api/schedules/")) {
          await deleteSchedule(decodeURIComponent(url.pathname.slice("/api/schedules/".length)));
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
        send(response, [400, 401, 403, 404, 409, 429, 503].includes(error?.status) ? error.status : 400, { error: error instanceof Error ? error.message : String(error), ...(error?.code ? { code: error.code } : {}) });
      }
    })
  };
}

export async function serve({ port = defaultPort, token: restartToken } = {}) {
  ensureAgentTeamsRoot();
  fs.mkdirSync(systemRoot(), { recursive: true });
  const { server, token } = createDashboardServer({ token: restartToken });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  writeJson(runtimeFile(), { pid: process.pid, port: actualPort, token, url: `http://127.0.0.1:${actualPort}/?token=${token}`, startedAt: new Date().toISOString() });
  processSchedules().catch((error) => process.stderr.write(`${error.message}\n`));
  const timer = setInterval(() => processSchedules().catch((error) => process.stderr.write(`${error.message}\n`)), 30_000);
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
