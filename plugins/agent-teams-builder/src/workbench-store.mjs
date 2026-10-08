import fs from "node:fs";
import path from "node:path";
import { normalizePreferences } from "../web/workbench-model.js";

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function periodBounds(period, now = new Date()) {
  if (!["today", "week", "month"].includes(period)) throw new Error("period must be today, week, or month");
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === "month") start.setDate(1);
  const end = new Date(start);
  if (period === "month") end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + (period === "week" ? 7 : 1));
  return { start: start.toISOString(), end: end.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function safeText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [已遮蔽]")
    .replace(/((?:access_token|refresh_token|api[_-]?key|token)\s*[=:]\s*)[^\s&"'<>]+/gi, "$1[已遮蔽]")
    .slice(0, 12000);
}

// Deliberately whitelist fields. Do not send raw log files, prompts or credentials.
export function safeWorkbenchRun(record) {
  if (!record || typeof record.id !== "string") return null;
  const result = {};
  for (const key of ["id", "agentId", "agentName", "workflowId", "workflowName", "host", "task",
    "status", "executionMode", "approvalMode", "pendingNodeId", "pendingNodeName", "projectId",
    "projectName", "startedAt", "finishedAt", "dispatchedAt", "lastMessage", "error", "rejectionReason"]) {
    if (record[key] != null) result[key] = safeText(record[key]);
  }
  result.threadId = record.executionMode === "codex-app" ? record.sessionId || record.threadId || null : null;
  result.resumable = Boolean(record.sessionId || record.resumable);
  result.approvalNodes = (Array.isArray(record.approvalNodes) ? record.approvalNodes : [])
    .map((node) => ({ id: safeText(node.id), name: safeText(node.name) }));
  return result;
}

export function allWorkbenchRuns(root, visibleRecord = () => true) {
  const directory = path.join(root, ".system", "runs");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^[a-zA-Z0-9-]+\.json$/.test(name))
    .map((name) => readJson(path.join(directory, name), null))
    .filter((record) => record && visibleRecord(record))
    .map(safeWorkbenchRun)
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function getWorkbenchRun(root, id, visibleRecord = () => true) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid run id");
  const record = readJson(path.join(root, ".system", "runs", id + ".json"), null);
  if (!record || !visibleRecord(record)) return null;
  const run = safeWorkbenchRun(record);
  if (!run || run.id !== id) return null;
  return run;
}

export function workbenchState(root, { period = "today", now = new Date(), agents = [], schedules = [], visibleRecord = () => true } = {}) {
  const range = periodBounds(period, now);
  const all = allWorkbenchRuns(root, visibleRecord);
  const runs = all.filter((run) => {
    const timestamp = Date.parse(run.startedAt);
    return Number.isFinite(timestamp) && timestamp >= Date.parse(range.start) && timestamp < Date.parse(range.end);
  });
  const counts = {};
  for (const run of runs) counts[run.status] = (counts[run.status] || 0) + 1;
  const approvals = all.filter((run) => ["waiting-input", "waiting-approval"].includes(run.status));
  const alerts = all.filter((run) => ["failed", "waiting-input", "waiting-approval"].includes(run.status));
  const active = all.filter((run) => ["running", "dispatching", "waiting-input", "waiting-approval"].includes(run.status));
  const agentActivity = agents.map((agent) => ({
    agentId: agent.id,
    latestRun: active.find((run) => run.agentId === agent.id) || all.find((run) => run.agentId === agent.id) || null,
    hasActiveRun: active.some((run) => run.agentId === agent.id)
  }));
  return {
    workspace: "vixo", period, range, refreshedAt: now.toISOString(),
    summary: {
      agents: agents.length, skills: agents.reduce((sum, agent) => sum + agent.skills.length, 0),
      workflows: agents.reduce((sum, agent) => sum + (agent.workflows || []).length, 0),
      enabledSchedules: schedules.filter((schedule) => schedule.enabled).length,
      totalRuns: runs.length, completedRuns: counts.completed || 0, counts,
      pendingApprovals: approvals.length, timeSaved: null, cost: null
    },
    runs, approvals, alerts, agentActivity,
    integrations: ["Outlook Calendar", "Outlook Mail", "Planner", "Teams", "SharePoint / OneDrive", "ERP / BI",
      "LINE Messaging API", "企業身分與權限"].map((name) => ({ name, status: "not-connected" }))
  };
}

export function readWorkbenchPreferences(root) {
  return normalizePreferences(readJson(path.join(root, ".system", "workbench-preferences.json"), null));
}

export function saveWorkbenchPreferences(root, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Preferences must be an object");
  const value = normalizePreferences(input);
  const file = path.join(root, ".system", "workbench-preferences.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp-" + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
  return value;
}
