import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { ensureAgentTeamsRoot } from "./store.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const embedScript = path.join(packageRoot, "scripts", "vixo-codex-embed.mjs");
const dashboardScript = path.join(packageRoot, "scripts", "vixo-agents-dashboard.mjs");
const injectionFile = path.join(packageRoot, "inject", "vixo-agents.user.js");
const systemRoot = () => path.join(ensureAgentTeamsRoot(), ".system");
const runtimeFile = () => path.join(systemRoot(), "codex-embed-runtime.json");
const dashboardRuntimeFile = () => path.join(systemRoot(), "dashboard-runtime.json");

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

export function parseDebuggingPorts(text) {
  const ports = new Set();
  const pattern = /--remote-debugging-port(?:=|\s+)(\d{1,5})(?=\s|$)/g;
  for (const match of String(text || "").matchAll(pattern)) {
    const port = Number(match[1]);
    if (port > 0 && port <= 65_535) ports.add(port);
  }
  return [...ports];
}

export function isCodexRendererTarget(target) {
  if (target?.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") return false;
  try {
    const url = new URL(target.url);
    if (url.protocol !== "app:") return false;
    if (!url.pathname.endsWith("/index.html")) return false;
    const route = url.searchParams.get("initialRoute") || "";
    return !route.includes("detached-window") && !route.includes("avatar-overlay");
  } catch {
    return false;
  }
}

export function isLoopbackDashboardUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function fetchJson(url, timeout = 1500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function dashboardRuntime() {
  const runtime = readJson(dashboardRuntimeFile());
  if (!runtime?.port || !runtime?.url || !isLoopbackDashboardUrl(runtime.url)) return null;
  try {
    const health = await fetchJson(`http://127.0.0.1:${runtime.port}/health`);
    return health.product === "vixo-agents" ? runtime : null;
  } catch {
    return null;
  }
}

async function ensureDashboard() {
  const current = await dashboardRuntime();
  if (current) return current;
  const result = spawnSync(process.execPath, [dashboardScript, "start"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: { ...process.env, AGENT_TEAMS_HOME: ensureAgentTeamsRoot() },
  });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "Unable to start VIXO Agents Dashboard");
  const started = await dashboardRuntime();
  if (!started) throw new Error("VIXO Agents Dashboard did not become ready");
  return started;
}

function processListing() {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'ChatGPT|Codex' -or $_.CommandLine -match 'ChatGPT|Codex' } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : "";
  }
  const result = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,command="], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0
    ? result.stdout.split("\n").filter((line) => /(?:ChatGPT|Codex)(?:\.app|\.exe|\s)/i.test(line)).join("\n")
    : "";
}

function codexRunning(listing = processListing()) {
  return /(?:ChatGPT|Codex)(?:\.app|\.exe|\s)/i.test(listing);
}

async function targetsForPort(port) {
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    return Array.isArray(targets) ? targets.filter(isCodexRendererTarget) : [];
  } catch {
    return [];
  }
}

async function discoverDebuggingPort(explicitPort = null) {
  const candidates = [];
  if (explicitPort) candidates.push(Number(explicitPort));
  if (process.env.VIXO_CODEX_CDP_PORT) candidates.push(Number(process.env.VIXO_CODEX_CDP_PORT));
  candidates.push(...parseDebuggingPorts(processListing()), 9231, 9229);
  for (const port of [...new Set(candidates.filter((value) => Number.isInteger(value) && value > 0))]) {
    if ((await targetsForPort(port)).length > 0) return port;
  }
  return null;
}

function macCodexApp() {
  const candidates = [
    "/Applications/ChatGPT.app",
    path.join(os.homedir(), "Applications", "ChatGPT.app"),
    "/Applications/Codex.app",
    path.join(os.homedir(), "Applications", "Codex.app"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function launchManagedMacCodex(port) {
  const app = macCodexApp();
  if (!app) return false;
  const profile = path.join(systemRoot(), "codex-profile");
  fs.mkdirSync(profile, { recursive: true });
  const result = spawnSync("/usr/bin/open", [
    "-n", "-a", app, "--args",
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await targetsForPort(port)).length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function launchManagedWindowsCodex(port) {
  const profile = path.join(systemRoot(), "codex-profile");
  fs.mkdirSync(profile, { recursive: true });
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
[ComImport]
[Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
  [PreserveSig] int ActivateApplication(
    [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
    [MarshalAs(UnmanagedType.LPWStr)] string arguments,
    uint options,
    out uint processId);
}
[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}
public static class VixoPackagedAppActivator {
  public static uint Activate(string appUserModelId, string arguments) {
    var manager = (IApplicationActivationManager)new ApplicationActivationManager();
    try {
      uint processId;
      var result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
      if (result < 0) Marshal.ThrowExceptionForHR(result);
      return processId;
    } finally { Marshal.FinalReleaseComObject(manager); }
  }
}
'@
Add-Type -TypeDefinition $source
$candidate = $null
foreach ($package in @(Get-AppxPackage | Where-Object { $_.Name -match 'OpenAI|ChatGPT|Codex' -or $_.PackageFullName -match 'OpenAI|ChatGPT|Codex' })) {
  $manifest = $package | Get-AppxPackageManifest
  foreach ($application in @($manifest.Package.Applications.Application)) {
    $relative = [string]$application.Executable
    if ($relative -match 'ChatGPT|Codex') {
      $candidate = [PSCustomObject]@{ Package = $package; Application = $application }
      break
    }
  }
  if ($null -ne $candidate) { break }
}
if ($null -eq $candidate) { throw 'Unable to find the Microsoft Store Codex application' }
$appUserModelId = $candidate.Package.PackageFamilyName + '!' + $candidate.Application.Id
$profile = $env:VIXO_CODEX_PROFILE.Replace('"', '\"')
$arguments = '--user-data-dir="' + $profile + '"' +
  ' --remote-debugging-address=127.0.0.1' +
  ' --remote-debugging-port=' + $env:VIXO_CODEX_PORT +
  ' --remote-allow-origins=http://127.0.0.1:' + $env:VIXO_CODEX_PORT
$pid = [VixoPackagedAppActivator]::Activate($appUserModelId, $arguments)
[Console]::Out.Write($pid)
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, VIXO_CODEX_PROFILE: profile, VIXO_CODEX_PORT: String(port) },
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.status === 0 && Number(result.stdout.trim()) > 0;
}

async function launchManagedCodex(port) {
  let launched = false;
  if (process.platform === "darwin") launched = await launchManagedMacCodex(port);
  else if (process.platform === "win32") launched = launchManagedWindowsCodex(port);
  if (!launched) return false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await targetsForPort(port)).length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function openCodexBrowserPanel(url) {
  const deepLink = new URL("codex://threads/new");
  deepLink.searchParams.set("browserUrl", url);
  if (process.platform === "darwin") {
    const child = spawn("/usr/bin/open", [deepLink.href], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  }
  if (process.platform === "win32") {
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "start", "", deepLink.href], {
      detached: true, windowsHide: true, stdio: "ignore",
    });
    child.unref();
    return true;
  }
  return false;
}

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP request failed"));
      else pending.resolve(message.result || {});
    });
    this.socket.on("close", () => this.finish(new Error("Codex renderer closed")));
    this.socket.on("error", (error) => this.finish(error));
    return this;
  }

  finish(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(method, params = {}) {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP connection is closed"));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    try { this.socket?.close(); } catch {}
    this.finish(new Error("CDP connection closed"));
  }
}

export function buildInjectionSource(dashboardUrl, source, sourceHash) {
  if (!isLoopbackDashboardUrl(dashboardUrl)) throw new Error("Dashboard URL must use loopback HTTP(S)");
  return [
    `window.__VIXO_AGENTS_DASHBOARD_URL__ = ${JSON.stringify(dashboardUrl)};`,
    `window.__VIXO_AGENTS_SOURCE_HASH__ = ${JSON.stringify(sourceHash)};`,
    source,
    "//# sourceURL=vixo-agents.user.js",
  ].join("\n");
}

async function injectionStatus(connection) {
  const result = await connection.send("Runtime.evaluate", {
    expression: "window.__vixoAgentsInjection__?.status?.() || null",
    returnByValue: true,
  });
  return result.result?.value || null;
}

function findFrameByName(frameTree, frameName) {
  if (frameTree?.frame?.name === frameName) return frameTree.frame;
  for (const child of frameTree?.childFrames || []) {
    const found = findFrameByName(child, frameName);
    if (found) return found;
  }
  return null;
}

async function dashboardDocument(dashboardUrl) {
  const url = new URL(dashboardUrl);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}`);
  const html = await response.text();
  if (!html.includes("<head>")) throw new Error("Dashboard document has no head element");
  const token = url.searchParams.get("token") || "";
  return html.replace(
    "<head>",
    `<head><base href=${JSON.stringify(url.href)}><script>globalThis.__VIXO_AGENTS_EMBED_TOKEN__=${JSON.stringify(token)};</script>`,
  );
}

async function loadDashboardFrame(connection, frameName, dashboardUrl) {
  const html = await dashboardDocument(dashboardUrl);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { frameTree } = await connection.send("Page.getFrameTree");
    const target = findFrameByName(frameTree, frameName);
    if (target) {
      await connection.send("Page.setDocumentContent", { frameId: target.id, html });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the isolated VIXO Agents frame");
}

async function injectTarget(target, dashboardUrl, source, sourceHash, shouldOpen = false) {
  const connection = await new CdpConnection(target.webSocketDebuggerUrl).connect();
  try {
    await connection.send("Page.enable");
    await connection.send("Runtime.enable");
    await connection.send("Page.setBypassCSP", { enabled: true });
    const injection = buildInjectionSource(dashboardUrl, source, sourceHash);
    await connection.send("Page.addScriptToEvaluateOnNewDocument", { source: injection });
    const evaluated = await connection.send("Runtime.evaluate", {
      expression: injection,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || "VIXO injection failed");
    if (shouldOpen) {
      await connection.send("Runtime.evaluate", {
        expression: "window.__vixoAgentsInjection__?.open?.()",
        returnByValue: true,
      });
      await connection.send("Page.bringToFront");
    }
    const deadline = Date.now() + 12_000;
    let status = null;
    let loadedFrameName = "";
    while (Date.now() < deadline) {
      status = await injectionStatus(connection);
      if (shouldOpen && status?.pageVisible && status.frameName && loadedFrameName !== status.frameName) {
        await loadDashboardFrame(connection, status.frameName, dashboardUrl);
        loadedFrameName = status.frameName;
      }
      if (status?.entryMounted && (!shouldOpen || (status.pageVisible && status.frameLoaded))) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { connection, status };
  } catch (error) {
    connection.close();
    throw error;
  }
}

function sourceBundle() {
  const source = fs.readFileSync(injectionFile, "utf8");
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  return { source, sourceHash };
}

async function requestRuntime(action) {
  const runtime = readJson(runtimeFile());
  if (!runtime?.controlPort || !runtime?.controlToken || !pidAlive(runtime.pid)) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.controlPort}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${runtime.controlToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function stopEmbed() {
  const stopped = await requestRuntime("stop");
  if (stopped) return stopped;
  const runtime = readJson(runtimeFile());
  if (runtime?.pid && pidAlive(runtime.pid)) {
    try { process.kill(runtime.pid, "SIGTERM"); } catch {}
  }
  try { fs.unlinkSync(runtimeFile()); } catch {}
  return { stopped: true, forced: Boolean(runtime?.pid) };
}

export async function startEmbed({ explicitPort = null, open = true } = {}) {
  const existing = await requestRuntime(open ? "open" : "status");
  if (existing) return existing;
  const logFile = path.join(systemRoot(), "codex-embed.log");
  fs.mkdirSync(systemRoot(), { recursive: true });
  const output = fs.openSync(logFile, "a", 0o600);
  const args = [embedScript, "daemon"];
  if (explicitPort) args.push("--port", String(explicitPort));
  if (open) args.push("--open");
  const child = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output, output],
    env: { ...process.env, AGENT_TEAMS_HOME: ensureAgentTeamsRoot() },
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const runtime = readJson(runtimeFile());
    if (runtime?.pid === child.pid) {
      if (runtime.mode === "codex-sidebar") {
        const status = await requestRuntime("status");
        if (status) {
          lastStatus = status;
          if (!open || (status.sidebarInjected && status.pageVisible && status.frameLoaded)) return status;
        }
      } else {
        return { ...runtime, controlToken: undefined, dashboardUrl: undefined };
      }
    }
    if (!pidAlive(child.pid)) break;
  }
  if (lastStatus) return lastStatus;
  throw new Error(`VIXO Codex embed did not start; check ${logFile}`);
}

function authorized(request, token) {
  const bearer = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (bearer.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(token));
}

async function runDaemon({ explicitPort = null, shouldOpen = false } = {}) {
  const dashboard = await ensureDashboard();
  const listing = processListing();
  let port = await discoverDebuggingPort(explicitPort);
  if (!port && ["darwin", "win32"].includes(process.platform) && !codexRunning(listing)) {
    const requested = explicitPort || Number(process.env.VIXO_CODEX_CDP_PORT || 9232);
    if (await launchManagedCodex(requested)) port = requested;
  }
  if (!port) {
    const opened = openCodexBrowserPanel(dashboard.url);
    const fallback = {
      pid: process.pid,
      mode: opened ? "codex-browser-panel" : "external-browser-required",
      sidebarInjected: false,
      opened,
      startedAt: new Date().toISOString(),
    };
    writeJson(runtimeFile(), fallback);
    return fallback;
  }

  const { source, sourceHash } = sourceBundle();
  const connections = new Map();
  let openPending = shouldOpen;
  let stopping = false;
  const controlToken = crypto.randomBytes(32).toString("hex");

  async function reconcile() {
    const targets = await targetsForPort(port);
    const liveIds = new Set(targets.map((target) => target.id));
    for (const [id, record] of connections) {
      if (liveIds.has(id) && !record.connection.closed) continue;
      record.connection.close();
      connections.delete(id);
    }
    for (const target of targets) {
      if (connections.has(target.id)) continue;
      try {
        const record = await injectTarget(target, dashboard.url, source, sourceHash, openPending);
        record.loadedFrameName = record.status?.frameLoaded ? record.status?.frameName : "";
        connections.set(target.id, record);
        if (record.status?.pageVisible) openPending = false;
      } catch (error) {
        fs.appendFileSync(path.join(systemRoot(), "codex-embed.log"), `Injection failed for ${target.id}: ${error.message}\n`);
      }
    }
    if (openPending) {
      for (const record of connections.values()) {
        try {
          await record.connection.send("Runtime.evaluate", {
            expression: "window.__vixoAgentsInjection__?.open?.()",
            returnByValue: true,
          });
          await record.connection.send("Page.bringToFront");
          openPending = false;
          break;
        } catch {}
      }
    }
    for (const record of connections.values()) {
      try {
        const status = await injectionStatus(record.connection);
        record.status = status;
        if (
          status?.pageVisible
          && !status.frameLoaded
          && status.frameName
          && record.loadedFrameName !== status.frameName
        ) {
          record.loadedFrameName = status.frameName;
          await loadDashboardFrame(record.connection, status.frameName, dashboard.url);
        }
      } catch {}
    }
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (!authorized(request, controlToken)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/open") {
      openPending = true;
      await reconcile();
    } else if (request.method === "POST" && url.pathname === "/stop") {
      stopping = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ stopped: true }));
      server.close();
      return;
    } else if (!(request.method === "POST" && url.pathname === "/status")) {
      response.writeHead(404).end();
      return;
    }
    const statuses = [];
    for (const [targetId, record] of connections) {
      try { statuses.push({ targetId, ...(await injectionStatus(record.connection)) }); } catch {}
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      running: true,
      mode: "codex-sidebar",
      sidebarInjected: statuses.some((item) => item.entryMounted),
      pageVisible: statuses.some((item) => item.pageVisible),
      frameLoaded: statuses.some((item) => item.frameLoaded),
      cdpPort: port,
      targets: statuses,
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  writeJson(runtimeFile(), {
    pid: process.pid,
    mode: "codex-sidebar",
    cdpPort: port,
    controlPort: address.port,
    controlToken,
    sourceHash,
    dashboardUrl: dashboard.url,
    startedAt: new Date().toISOString(),
  });

  process.on("SIGTERM", () => { stopping = true; server.close(); });
  process.on("SIGINT", () => { stopping = true; server.close(); });
  while (!stopping) {
    await reconcile();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  for (const record of connections.values()) record.connection.close();
  try { fs.unlinkSync(runtimeFile()); } catch {}
  return { stopped: true };
}

export async function runOnce({ explicitPort = null, open = true } = {}) {
  const dashboard = await ensureDashboard();
  const port = await discoverDebuggingPort(explicitPort);
  if (!port) throw new Error("No debuggable Codex renderer was found");
  const targets = await targetsForPort(port);
  const { source, sourceHash } = sourceBundle();
  const records = [];
  for (const target of targets) records.push(await injectTarget(target, dashboard.url, source, sourceHash, open));
  const result = {
    mode: "codex-sidebar",
    cdpPort: port,
    sidebarInjected: records.some((record) => record.status?.entryMounted),
    pageVisible: records.some((record) => record.status?.pageVisible),
    frameLoaded: records.some((record) => record.status?.frameLoaded),
    targets: records.map((record) => record.status),
  };
  for (const record of records) record.connection.close();
  return result;
}

export async function embedStatus() {
  const status = await requestRuntime("status");
  if (status) return status;
  const runtime = readJson(runtimeFile());
  return { running: Boolean(runtime?.pid && pidAlive(runtime.pid)), ...runtime, controlToken: undefined, dashboardUrl: undefined };
}

export async function daemonMain(options) {
  return runDaemon(options);
}
