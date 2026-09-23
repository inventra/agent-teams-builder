import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const UPDATE_SOURCE = {
  repository: "inventra/agent-teams-builder",
  branch: "main",
  apiBase: "https://api.github.com",
  rawBase: "https://raw.githubusercontent.com"
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const currentPackage = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const CHECK_TTL_MS = 15 * 60 * 1000;
let cached = null;
let pending = null;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function isSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value || ""));
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function installedRoot(explicitRoot) {
  return path.resolve(explicitRoot || process.env.AGENT_TEAMS_HOME || path.join(os.homedir(), "Downloads", "Agent Teams"));
}

export function readUpdateOperation(agentTeamsRoot) {
  const root = installedRoot(agentTeamsRoot);
  const operation = readJson(path.join(root, ".system", "update-runtime.json"), null);
  if (!operation) return null;
  if (operation.status === "running" && Number.isInteger(operation.pid)) {
    try { process.kill(operation.pid, 0); }
    catch { return { ...operation, status: "failed", error: "更新程序已意外停止，請再按一次立即更新。" }; }
  }
  return operation;
}

export async function checkForUpdate(options = {}) {
  const now = options.now || Date.now();
  if (!options.force && cached && now - Date.parse(cached.checkedAt) < CHECK_TTL_MS) return cached;
  if (!options.force && pending) return pending;
  const task = (async () => {
    const root = installedRoot(options.agentTeamsRoot);
    const state = readJson(path.join(root, ".system", "update-state.json"), {});
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "VIXO-Agents-Dashboard-Updater",
      "Cache-Control": "no-cache"
    };
    const checkedAt = new Date(now).toISOString();
    try {
      const fetchImpl = options.fetchImpl || globalThis.fetch;
      if (typeof fetchImpl !== "function") throw new Error("目前執行環境無法連線檢查版本");
      const commitUrl = `${UPDATE_SOURCE.apiBase}/repos/${UPDATE_SOURCE.repository}/commits/${UPDATE_SOURCE.branch}?cache_bust=${now}`;
      const response = await fetchWithTimeout(fetchImpl, commitUrl, { headers }, options.timeoutMs || 12_000);
      if (!response.ok) throw new Error(`GitHub 版本檢查回傳 HTTP ${response.status}`);
      const remote = await response.json();
      if (!isSha(remote?.sha)) throw new Error("GitHub 回傳的 commit SHA 格式不正確");
      let latestVersion = null;
      try {
        const packageUrl = `${UPDATE_SOURCE.rawBase}/${UPDATE_SOURCE.repository}/${remote.sha}/package.json`;
        const versionResponse = await fetchWithTimeout(fetchImpl, packageUrl, { headers: { "Cache-Control": "no-cache" } }, options.timeoutMs || 12_000);
        if (versionResponse.ok) latestVersion = String((await versionResponse.json())?.version || "") || null;
      } catch {}
      cached = {
        available: state.revision !== remote.sha,
        currentVersion: state.installedVersion || currentPackage.version,
        latestVersion,
        currentRevision: state.revision || "bundled",
        latestRevision: remote.sha,
        releaseUrl: `https://github.com/${UPDATE_SOURCE.repository}/commits/${remote.sha}`,
        checkedAt,
        error: null
      };
    } catch (error) {
      cached = {
        available: false,
        currentVersion: state.installedVersion || currentPackage.version,
        latestVersion: null,
        currentRevision: state.revision || "bundled",
        latestRevision: null,
        releaseUrl: null,
        checkedAt,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    return cached;
  })();
  pending = task;
  try { return await task; }
  finally { if (pending === task) pending = null; }
}

export function startUpdate(options = {}) {
  const root = installedRoot(options.agentTeamsRoot);
  const updater = path.join(root, ".system", "updater", "install.mjs");
  const runner = path.resolve(options.runner || path.join(packageRoot, "scripts", "vixo-update-runner.mjs"));
  if (!fs.existsSync(updater)) throw new Error("找不到頁面更新器，請先用最新版安裝包更新一次。之後即可在頁面內更新。");
  if (!fs.existsSync(runner)) throw new Error("找不到更新執行程式，請重新安裝 VIXO Agents。");
  const operationFile = path.join(root, ".system", "update-runtime.json");
  const operation = readUpdateOperation(root);
  if (operation?.status === "running") throw new Error("更新正在執行中");
  writeJson(operationFile, { status: "queued", requestedAt: new Date().toISOString(), pid: null });
  const child = (options.spawnImpl || spawn)(process.execPath, [runner], {
    cwd: root,
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: "ignore",
    env: { ...process.env, AGENT_TEAMS_HOME: root, AGENT_TEAMS_INSTALL_ROOT: root, VIXO_UPDATER_SCRIPT: updater }
  });
  child.once?.("error", (error) => writeJson(operationFile, {
    status: "failed",
    pid: child.pid || null,
    requestedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error)
  }));
  child.unref?.();
  return { status: "queued", pid: child.pid || null, requestedAt: new Date().toISOString() };
}

export function resetUpdateCacheForTests() {
  cached = null;
  pending = null;
}
