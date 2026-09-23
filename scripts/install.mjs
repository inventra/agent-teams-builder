#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MINIMUMS = { node: "18.0.0", codex: "0.148.0", claude: "2.1.265" };
export const UPDATE_SOURCE = {
  repository: "inventra/agent-teams-builder",
  branch: "main",
  apiBase: "https://api.github.com"
};
const PLUGIN = "agent-teams-builder";
const MARKETPLACE = "agent-teams-local";
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

function parseVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

export function versionAtLeast(actualText, minimum) {
  const actual = parseVersion(actualText);
  const required = parseVersion(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return true;
    if (actual[index] < required[index]) return false;
  }
  return true;
}

export function buildRuntimeVersion(baseVersion, revision, now = new Date()) {
  const base = String(baseVersion || "0.0.0").split("+")[0];
  if (!revision || revision === "bundled") return base;
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error("Invalid source revision for runtime version");
  const timestamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${base}+codex.${timestamp}-${revision.slice(0, 12).toLowerCase()}`;
}

function commandResult(command, args = [], options = {}) {
  const throughCmd = process.platform === "win32" && /\.cmd$/i.test(command);
  const executable = throughCmd ? (process.env.ComSpec || "cmd.exe") : command;
  const commandArgs = throughCmd ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    ...options
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || null
  };
}

function interactiveCommand(command, args = []) {
  const throughCmd = process.platform === "win32" && /\.cmd$/i.test(command);
  const executable = throughCmd ? (process.env.ComSpec || "cmd.exe") : command;
  const commandArgs = throughCmd ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    shell: false,
    windowsHide: false,
    stdio: "inherit"
  });
  return { ok: result.status === 0, status: result.status, error: result.error?.message || null };
}

function hostCommand(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function available(command) {
  const probe = commandResult(command, ["--version"]);
  return probe.ok ? probe.stdout || probe.stderr : null;
}

function codexAuthStatus() {
  const check = commandResult(hostCommand("codex"), ["login", "status"]);
  const method = check.ok ? (check.stdout.match(/Logged in using\s+(.+)/i)?.[1]?.trim() || "ChatGPT") : null;
  return { loggedIn: check.ok, method, command: "codex login status" };
}

function claudeAuthStatus() {
  const check = commandResult(hostCommand("claude"), ["auth", "status", "--json"]);
  let parsed = null;
  try { parsed = JSON.parse(check.stdout); } catch {}
  return {
    loggedIn: parsed?.loggedIn === true,
    method: parsed?.loggedIn ? (parsed.authMethod || "Claude account") : null,
    command: "claude auth status --json"
  };
}

function ensureHostAuthentication(host, { skipLogin = false } = {}) {
  const status = host === "codex" ? codexAuthStatus : claudeAuthStatus;
  const before = status();
  if (before.loggedIn) return { ...before, loginRequired: false, loginAttempted: false, skipped: false };
  if (skipLogin) return { ...before, loginRequired: true, loginAttempted: false, skipped: true };

  const loginCommand = host === "codex"
    ? { command: hostCommand("codex"), args: ["login"], display: "codex login" }
    : { command: hostCommand("claude"), args: ["auth", "login", "--claudeai"], display: "claude auth login --claudeai" };
  console.log(`\n${host === "codex" ? "Codex" : "Claude Code"} 尚未登入。即將執行 ${loginCommand.display}；請在開啟的瀏覽器中完成帳號登入。\n`);
  const login = interactiveCommand(loginCommand.command, loginCommand.args);
  const after = status();
  return {
    loggedIn: after.loggedIn,
    method: after.method,
    command: before.command,
    loginRequired: true,
    loginAttempted: true,
    loginCommand: loginCommand.display,
    loginProcessSucceeded: login.ok,
    skipped: false,
    error: after.loggedIn ? null : (login.error || "Browser login was not completed successfully")
  };
}

export function detectDesktopApps(platform = process.platform, env = process.env) {
  if (platform === "darwin") {
    const roots = ["/Applications", path.join(os.homedir(), "Applications")];
    const exists = (name) => roots.some((root) => fs.existsSync(path.join(root, name)));
    return { codex: exists("Codex.app"), chatgpt: exists("ChatGPT.app"), claude: exists("Claude.app") };
  }
  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean);
    const contains = (names) => roots.some((root) => names.some((name) => fs.existsSync(path.join(root, name))));
    return {
      codex: contains(["Codex", "OpenAI\\Codex"]),
      chatgpt: contains(["ChatGPT", "OpenAI\\ChatGPT"]),
      claude: contains(["Claude", "AnthropicClaude"])
    };
  }
  return { codex: false, chatgpt: false, claude: false };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function patchJsonVersion(file, version, marketplace = false) {
  const value = readJson(file);
  if (marketplace) {
    const entry = value.plugins?.find((item) => item.name === PLUGIN);
    if (!entry) throw new Error(`Plugin entry not found in ${file}`);
    entry.version = version;
  } else {
    value.version = version;
    if (value.packages?.[""]) value.packages[""].version = version;
  }
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function applyRuntimeVersion(stagedMarketplace, version) {
  const pluginRoot = path.join(stagedMarketplace, "plugins", PLUGIN);
  for (const relative of ["package.json", "package-lock.json", "plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    patchJsonVersion(path.join(pluginRoot, relative), version);
  }
  patchJsonVersion(path.join(stagedMarketplace, ".claude-plugin", "marketplace.json"), version, true);
}

function runtimePlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") return `macos-${arch === "x64" ? "x64" : "arm64"}`;
  if (platform === "win32") return "windows-x64";
  return null;
}

function runtimePaths(root, key) {
  if (!key) return null;
  const directory = path.join(root, key);
  const windows = key.startsWith("windows-");
  return {
    directory,
    node: path.join(directory, windows ? "node.exe" : "node"),
    npmCli: windows
      ? path.join(directory, "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(directory, "lib", "node_modules", "npm", "bin", "npm-cli.js")
  };
}

function installBundledRuntime(sourceRoot, agentTeamsRoot) {
  const key = runtimePlatformKey();
  const source = runtimePaths(path.join(sourceRoot, "runtime"), key);
  const installedRoot = path.join(agentTeamsRoot, ".system", "runtime");
  const installed = runtimePaths(installedRoot, key);
  if (source && fs.existsSync(source.node) && fs.existsSync(source.npmCli)) {
    const staged = `${installed.directory}.tmp-${process.pid}-${Date.now()}`;
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.cpSync(source.directory, staged, { recursive: true });
    fs.rmSync(installed.directory, { recursive: true, force: true });
    fs.renameSync(staged, installed.directory);
    if (process.platform !== "win32") fs.chmodSync(installed.node, 0o755);
    return { ...installed, bundled: true, key };
  }
  if (installed && fs.existsSync(installed.node) && fs.existsSync(installed.npmCli)) {
    return { ...installed, bundled: true, key };
  }
  return { node: process.execPath, npmCli: null, directory: path.dirname(process.execPath), bundled: false, key: null };
}

function patchMcpRuntime(stagedMarketplace, runtimeNode) {
  const file = path.join(stagedMarketplace, "plugins", PLUGIN, ".mcp.json");
  const value = readJson(file);
  if (!value.mcpServers?.["agent-teams"]) throw new Error("agent-teams MCP configuration is missing");
  value.mcpServers["agent-teams"].command = runtimeNode;
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function moveDirectoryAcrossVolumes(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function copyRelease(sourceRoot, targetMarketplace, skipNpm, runtimeVersion, runtime) {
  const sourcePlugin = path.join(sourceRoot, "plugins", PLUGIN);
  if (!fs.existsSync(path.join(sourcePlugin, "package.json"))) throw new Error(`Plugin source not found: ${sourcePlugin}`);
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-teams-install-"));
  const stagedMarketplace = path.join(stagingRoot, "marketplace");
  const stagedPlugin = path.join(stagedMarketplace, "plugins", PLUGIN);
  fs.mkdirSync(path.dirname(stagedPlugin), { recursive: true });
  const packagedDependencies = fs.existsSync(path.join(sourceRoot, "runtime")) && fs.existsSync(path.join(sourcePlugin, "node_modules"));
  fs.cpSync(sourcePlugin, stagedPlugin, {
    recursive: true,
    filter: (source) => packagedDependencies || (!source.includes(`${path.sep}node_modules${path.sep}`) && !source.endsWith(`${path.sep}node_modules`))
  });
  fs.mkdirSync(path.join(stagedMarketplace, ".agents", "plugins"), { recursive: true });
  fs.mkdirSync(path.join(stagedMarketplace, ".claude-plugin"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, ".agents", "plugins", "marketplace.json"), path.join(stagedMarketplace, ".agents", "plugins", "marketplace.json"));
  fs.copyFileSync(path.join(sourceRoot, ".claude-plugin", "marketplace.json"), path.join(stagedMarketplace, ".claude-plugin", "marketplace.json"));
  applyRuntimeVersion(stagedMarketplace, runtimeVersion);
  patchMcpRuntime(stagedMarketplace, runtime.node);
  if (!skipNpm && !packagedDependencies) {
    const npmCommand = runtime.npmCli ? runtime.node : (process.platform === "win32" ? "npm.cmd" : "npm");
    const npmArgs = runtime.npmCli
      ? [runtime.npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund"]
      : ["ci", "--omit=dev", "--no-audit", "--no-fund"];
    const npm = commandResult(npmCommand, npmArgs, { cwd: stagedPlugin, stdio: ["ignore", "pipe", "pipe"] });
    if (!npm.ok) throw new Error(`Runtime dependency installation failed: ${npm.stderr || npm.error}`);
  }
  fs.mkdirSync(path.dirname(targetMarketplace), { recursive: true });
  let backup = null;
  if (fs.existsSync(targetMarketplace)) {
    backup = `${targetMarketplace}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.renameSync(targetMarketplace, backup);
  }
  try {
    moveDirectoryAcrossVolumes(stagedMarketplace, targetMarketplace);
  } catch (error) {
    fs.rmSync(targetMarketplace, { recursive: true, force: true });
    if (backup && fs.existsSync(backup)) fs.renameSync(backup, targetMarketplace);
    throw error;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
  return { backup, installedVersion: runtimeVersion };
}

function configureCodex(marketplaceRoot) {
  const codex = hostCommand("codex");
  const addMarket = commandResult(codex, ["plugin", "marketplace", "add", marketplaceRoot, "--json"]);
  const marketOkay = addMarket.ok || /already|exists|configured/i.test(`${addMarket.stdout}\n${addMarket.stderr}`);
  if (!marketOkay) return { installed: false, error: addMarket.stderr || addMarket.error || addMarket.stdout };
  const addPlugin = commandResult(codex, ["plugin", "add", `${PLUGIN}@${MARKETPLACE}`, "--json"]);
  return { installed: addPlugin.ok, output: addPlugin.stdout, error: addPlugin.ok ? null : addPlugin.stderr || addPlugin.error };
}

function configureClaude(marketplaceRoot) {
  const claude = hostCommand("claude");
  const addMarket = commandResult(claude, ["plugin", "marketplace", "add", marketplaceRoot]);
  const marketOkay = addMarket.ok || /already|exists|configured/i.test(`${addMarket.stdout}\n${addMarket.stderr}`);
  if (!marketOkay) return { installed: false, error: addMarket.stderr || addMarket.error || addMarket.stdout };
  let install = commandResult(claude, ["plugin", "install", `${PLUGIN}@${MARKETPLACE}`, "--scope", "user"]);
  if (/already installed/i.test(`${install.stdout}\n${install.stderr}`)) {
    install = commandResult(claude, ["plugin", "update", `${PLUGIN}@${MARKETPLACE}`]);
  }
  return { installed: install.ok, output: install.stdout, error: install.ok ? null : install.stderr || install.error };
}

function installDashboardLaunchers(agentTeamsRoot, pluginRoot, runtimeNode) {
  const embedScript = path.join(pluginRoot, "scripts", "vixo-codex-embed.mjs");
  const macLauncher = path.join(agentTeamsRoot, "Open VIXO Agents.command");
  const windowsLauncher = path.join(agentTeamsRoot, "Open VIXO Agents.cmd");
  fs.writeFileSync(macLauncher, [
    "#!/bin/bash",
    `exec ${JSON.stringify(runtimeNode)} ${JSON.stringify(embedScript)} open`,
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o755 });
  fs.writeFileSync(windowsLauncher, [
    "@echo off",
    `"${runtimeNode}" "${embedScript}" open`,
    "if errorlevel 1 pause",
    ""
  ].join("\r\n"), "utf8");
  return { mac: macLauncher, windows: windowsLauncher };
}

function stopInstalledRuntimes(agentTeamsRoot, marketplaceRoot, runtimeNode = process.execPath) {
  const existingPlugin = path.join(marketplaceRoot, "plugins", PLUGIN);
  const env = { ...process.env, AGENT_TEAMS_HOME: agentTeamsRoot };
  const embed = path.join(existingPlugin, "scripts", "vixo-codex-embed.mjs");
  const dashboard = path.join(existingPlugin, "scripts", "vixo-agents-dashboard.mjs");
  if (fs.existsSync(embed)) commandResult(runtimeNode, [embed, "stop"], { env });
  if (fs.existsSync(dashboard)) commandResult(runtimeNode, [dashboard, "stop"], { env });
}

function launchDashboard(agentTeamsRoot, pluginRoot, runtimeNode, { open = true, restart = false } = {}) {
  if (process.env.AGENT_TEAMS_SKIP_DASHBOARD === "1" || process.env.AGENT_TEAMS_SKIP_NPM === "1") {
    return { started: false, skipped: true };
  }
  const script = path.join(pluginRoot, "scripts", "vixo-agents-dashboard.mjs");
  if (!fs.existsSync(script)) return { started: false, error: "Dashboard runtime is not installed" };
  if (restart) commandResult(runtimeNode, [script, "stop"], { env: { ...process.env, AGENT_TEAMS_HOME: agentTeamsRoot } });
  const result = commandResult(runtimeNode, [script, open ? "open" : "start"], {
    env: { ...process.env, AGENT_TEAMS_HOME: agentTeamsRoot }
  });
  let runtime = null;
  try { runtime = JSON.parse(result.stdout); } catch {}
  return { started: result.ok, runtime, error: result.ok ? null : result.stderr || result.error || result.stdout };
}

function launchCodexEmbed(agentTeamsRoot, pluginRoot, runtimeNode) {
  if (
    process.env.AGENT_TEAMS_SKIP_EMBED === "1"
    || process.env.AGENT_TEAMS_SKIP_DASHBOARD === "1"
    || process.env.AGENT_TEAMS_SKIP_NPM === "1"
  ) return { started: false, skipped: true };
  const script = path.join(pluginRoot, "scripts", "vixo-codex-embed.mjs");
  if (!fs.existsSync(script)) return { started: false, error: "Codex embed runtime is not installed" };
  const result = commandResult(runtimeNode, [script, "open"], {
    env: { ...process.env, AGENT_TEAMS_HOME: agentTeamsRoot }
  });
  let runtime = null;
  try { runtime = JSON.parse(result.stdout); } catch {}
  return { started: result.ok, runtime, error: result.ok ? null : result.stderr || result.error || result.stdout };
}

export function install(options = {}) {
  const sourceRoot = options.sourceRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const agentTeamsRoot = path.resolve(options.agentTeamsRoot || process.env.AGENT_TEAMS_INSTALL_ROOT || path.join(os.homedir(), "Downloads", "Agent Teams"));
  const marketplaceRoot = path.join(agentTeamsRoot, ".system", "marketplace");
  fs.mkdirSync(agentTeamsRoot, { recursive: true });
  const nodeVersion = process.version;
  if (!versionAtLeast(nodeVersion, MINIMUMS.node)) throw new Error(`Node.js ${MINIMUMS.node}+ is required; found ${nodeVersion}`);
  const detected = {
    desktopApps: detectDesktopApps(),
    codexCli: available(hostCommand("codex")),
    claudeCli: available(hostCommand("claude"))
  };
  if (!detected.codexCli && !detected.claudeCli) {
    throw new Error("Neither Codex CLI nor Claude Code was found. Install at least one supported host, then run this installer again.");
  }
  const compatibility = {
    node: { version: nodeVersion, compatible: versionAtLeast(nodeVersion, MINIMUMS.node) },
    codex: detected.codexCli ? { version: detected.codexCli, compatible: versionAtLeast(detected.codexCli, MINIMUMS.codex) } : null,
    claude: detected.claudeCli ? { version: detected.claudeCli, compatible: versionAtLeast(detected.claudeCli, MINIMUMS.claude) } : null
  };
  const compatibleHost = compatibility.codex?.compatible || compatibility.claude?.compatible;
  if (!compatibleHost) throw new Error(`Installed hosts are too old. Minimums: Codex ${MINIMUMS.codex}, Claude Code ${MINIMUMS.claude}`);
  const skipLogin = options.skipLogin || process.env.AGENT_TEAMS_SKIP_LOGIN === "1";
  const skipNpm = options.skipNpm || process.env.AGENT_TEAMS_SKIP_NPM === "1";
  const sourceRevision = options.sourceRevision || process.env.AGENT_TEAMS_SOURCE_REVISION || "bundled";
  const baseVersion = readJson(path.join(sourceRoot, "plugins", PLUGIN, "package.json")).version;
  const runtimeVersion = options.runtimeVersion || buildRuntimeVersion(baseVersion, sourceRevision, options.now || new Date());
  const authentication = {};
  if (compatibility.codex?.compatible) authentication.codex = ensureHostAuthentication("codex", { skipLogin });
  if (compatibility.claude?.compatible) authentication.claude = ensureHostAuthentication("claude", { skipLogin });
  const runtime = installBundledRuntime(sourceRoot, agentTeamsRoot);
  stopInstalledRuntimes(agentTeamsRoot, marketplaceRoot, runtime.node);
  const copied = copyRelease(sourceRoot, marketplaceRoot, skipNpm, runtimeVersion, runtime);
  const results = {};
  if (compatibility.codex?.compatible) {
    results.codex = authentication.codex.loggedIn || authentication.codex.skipped
      ? configureCodex(marketplaceRoot)
      : { installed: false, error: "Codex login was not completed; run codex login and retry." };
  }
  if (compatibility.claude?.compatible) {
    results.claude = authentication.claude.loggedIn || authentication.claude.skipped
      ? configureClaude(marketplaceRoot)
      : { installed: false, error: "Claude Code login was not completed; run claude auth login --claudeai and retry." };
  }
  const pluginRoot = path.join(marketplaceRoot, "plugins", PLUGIN);
  const dashboardLaunchers = installDashboardLaunchers(agentTeamsRoot, pluginRoot, runtime.node);
  let doctor = { ok: false, error: "skipped" };
  if (!skipNpm) {
    const check = commandResult(runtime.node, [path.join(pluginRoot, "scripts", "agent-teams-cli.mjs"), "doctor"], { env: { ...process.env, AGENT_TEAMS_HOME: agentTeamsRoot } });
    if (check.ok) {
      try { doctor = JSON.parse(check.stdout); }
      catch { doctor = { ok: false, error: "Doctor returned invalid JSON" }; }
    } else {
      doctor = { ok: false, error: check.stderr || check.error };
    }
  }
  const allHostsInstalled = Object.values(results).length > 0 && Object.values(results).every((item) => item.installed);
  const installationHealthy = allHostsInstalled && (doctor.ok || skipNpm);
  let backupRemoved = false;
  if (copied.backup && installationHealthy) {
    fs.rmSync(copied.backup, { recursive: true, force: true });
    backupRemoved = true;
  }
  const dashboard = installationHealthy
    ? launchDashboard(agentTeamsRoot, pluginRoot, runtime.node, { open: false, restart: true })
    : { started: false, error: "Plugin installation is not healthy" };
  const codexEmbed = installationHealthy && dashboard.started
    ? launchCodexEmbed(agentTeamsRoot, pluginRoot, runtime.node)
    : { started: false, error: "Dashboard is not healthy" };
  const report = {
    installedAt: new Date().toISOString(),
    installedVersion: copied.installedVersion,
    sourceRevision,
    sourceCommitDate: options.sourceCommitDate || process.env.AGENT_TEAMS_SOURCE_COMMIT_DATE || null,
    archiveSha256: options.archiveSha256 || process.env.AGENT_TEAMS_ARCHIVE_SHA256 || null,
    agentTeamsRoot,
    marketplaceRoot,
    pluginRoot,
    backup: copied.backup,
    backupRemoved,
    detected,
    compatibility,
    authentication,
    results,
    doctor,
    dashboard,
    codexEmbed,
    dashboardLaunchers,
    runtime: { bundled: runtime.bundled, key: runtime.key, node: runtime.node },
    notes: [
      "Claude Desktop is detected separately; Claude Code CLI is the supported local plugin host used by this installer.",
      "ChatGPT Desktop and Codex share the public plugin directory, but local CLI marketplace installation requires Codex CLI.",
      "Agent execution always uses the current Codex or Claude Code host. No Anthropic/OpenAI model API key is used by the plugin.",
      "VIXO Agents Dashboard runs only on 127.0.0.1 and uses a random local bearer token for its API.",
      "When Codex exposes a trusted loopback CDP renderer, the launcher adds a VIXO Agents sidebar entry; otherwise it opens the Dashboard in Codex's native browser panel.",
      "Start a new Claude Code/Codex session after installation."
    ]
  };
  fs.writeFileSync(path.join(agentTeamsRoot, "installation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (installationHealthy) {
    writeJson(path.join(agentTeamsRoot, ".system", "update-state.json"), {
      repository: UPDATE_SOURCE.repository,
      branch: UPDATE_SOURCE.branch,
      revision: sourceRevision,
      commitDate: report.sourceCommitDate,
      archiveSha256: report.archiveSha256,
      installedVersion: report.installedVersion,
      updatedAt: report.installedAt
    });
  }
  return report;
}

export function extractArchive(archivePath, destination, platform = process.platform) {
  if (platform === "win32") {
    const escapedArchive = archivePath.replace(/'/g, "''");
    const escapedDestination = destination.replace(/'/g, "''");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`], {
      encoding: "utf8",
      shell: false,
      windowsHide: true
    });
    if (result.status !== 0) throw new Error(`Unable to extract update: ${(result.stderr || result.error?.message || "PowerShell failed").trim()}`);
    return;
  }
  if (platform === "darwin") {
    const result = spawnSync("ditto", ["-x", "-k", archivePath, destination], { encoding: "utf8", shell: false });
    if (result.status !== 0) throw new Error(`Unable to extract update: ${(result.stderr || result.error?.message || "ditto failed").trim()}`);
    return;
  }
  const result = spawnSync("unzip", ["-q", archivePath, "-d", destination], { encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`Unable to extract update: ${(result.stderr || result.error?.message || "unzip failed").trim()}`);
}

export function findSourceRoot(extractedRoot) {
  const candidates = [extractedRoot, ...fs.readdirSync(extractedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extractedRoot, entry.name))];
  const found = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "scripts", "install.mjs")) &&
    fs.existsSync(path.join(candidate, "plugins", PLUGIN, "package.json")) &&
    fs.existsSync(path.join(candidate, ".agents", "plugins", "marketplace.json"))
  );
  if (!found) throw new Error("Downloaded update does not contain the expected Agent Teams Builder layout");
  return found;
}

function runUpdatedInstaller(sourceRoot, env) {
  const result = spawnSync(process.execPath, [path.join(sourceRoot, "scripts", "install.mjs")], {
    cwd: sourceRoot,
    env,
    stdio: "inherit",
    shell: false
  });
  return { ok: result.status === 0, status: result.status, error: result.error?.message || null };
}

function readUpdateState(stateFile) {
  try {
    const state = readJson(stateFile);
    return state.repository === UPDATE_SOURCE.repository ? state : null;
  } catch {
    return null;
  }
}

export function sameFile(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function maybeRunSelfUpdate(options = {}) {
  const env = options.env || process.env;
  if (options.skipUpdate || env.AGENT_TEAMS_SKIP_UPDATE === "1") return { handled: false, status: "skipped" };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return { handled: false, status: "fetch-unavailable" };
  const agentTeamsRoot = path.resolve(options.agentTeamsRoot || env.AGENT_TEAMS_INSTALL_ROOT || path.join(os.homedir(), "Downloads", "Agent Teams"));
  const stateFile = path.join(agentTeamsRoot, ".system", "update-state.json");
  const stateExists = fs.existsSync(stateFile);
  const state = readUpdateState(stateFile);
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Agent-Teams-Builder-Updater",
    "Cache-Control": "no-cache"
  };
  let remote;
  try {
    const commitUrl = `${UPDATE_SOURCE.apiBase}/repos/${UPDATE_SOURCE.repository}/commits/${UPDATE_SOURCE.branch}?cache_bust=${Date.now()}`;
    const response = await fetchWithTimeout(fetchImpl, commitUrl, { headers }, options.timeoutMs || 15000);
    if (!response.ok) throw new Error(`GitHub commit check returned HTTP ${response.status}`);
    remote = await response.json();
    if (!/^[0-9a-f]{40}$/i.test(remote?.sha || "")) throw new Error("GitHub returned an invalid commit SHA");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (stateExists) {
      console.warn(`\n無法檢查 GitHub 更新，保留目前已安裝版本，不會用舊 ZIP 覆蓋：${message}\n`);
      return { handled: true, ok: true, status: "offline-current", error: message, state };
    }
    console.warn(`\n無法檢查 GitHub 更新，將使用 ZIP 內附版本完成第一次安裝：${message}\n`);
    return { handled: false, status: "offline-first-install", error: message };
  }

  if (state?.revision === remote.sha) {
    console.log(`\nAgent Teams Builder 已是 GitHub main 最新版本（${remote.sha.slice(0, 12)}），不需重裝。\n`);
    return { handled: true, ok: true, status: "up-to-date", revision: remote.sha, state };
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-teams-update-"));
  const archivePath = path.join(temporary, "update.zip");
  const extractedRoot = path.join(temporary, "source");
  fs.mkdirSync(extractedRoot, { recursive: true });
  try {
    console.log(`\n發現 GitHub 新版本 ${remote.sha.slice(0, 12)}，正在安全下載並更新…\n`);
    const archiveUrl = `${UPDATE_SOURCE.apiBase}/repos/${UPDATE_SOURCE.repository}/zipball/${remote.sha}`;
    const response = await fetchWithTimeout(fetchImpl, archiveUrl, { headers, redirect: "follow" }, options.timeoutMs || 30000);
    if (!response.ok) throw new Error(`GitHub archive download returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (declaredLength > MAX_ARCHIVE_BYTES) throw new Error("GitHub update archive is larger than the 50 MB safety limit");
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) throw new Error("GitHub update archive is empty or exceeds the 50 MB safety limit");
    const archiveSha256 = crypto.createHash("sha256").update(archive).digest("hex");
    fs.writeFileSync(archivePath, archive);
    (options.extractArchiveImpl || extractArchive)(archivePath, extractedRoot, options.platform || process.platform);
    const downloadedSource = findSourceRoot(extractedRoot);
    const childEnv = {
      ...env,
      AGENT_TEAMS_SKIP_UPDATE: "1",
      AGENT_TEAMS_INSTALL_ROOT: agentTeamsRoot,
      AGENT_TEAMS_SOURCE_REVISION: remote.sha,
      AGENT_TEAMS_SOURCE_COMMIT_DATE: remote.commit?.committer?.date || remote.commit?.author?.date || "",
      AGENT_TEAMS_ARCHIVE_SHA256: archiveSha256
    };
    const run = (options.runChildImpl || runUpdatedInstaller)(downloadedSource, childEnv);
    if (!run.ok) throw new Error(run.error || `Updated installer exited with status ${run.status}`);
    const installedState = readUpdateState(stateFile);
    if (installedState?.revision !== remote.sha) {
      throw new Error("Updated installer exited without recording the expected GitHub commit; the update is not considered successful");
    }
    return { handled: true, ok: true, status: "updated", revision: remote.sha, archiveSha256 };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const update = await maybeRunSelfUpdate();
    if (update.handled) {
      if (["up-to-date", "offline-current"].includes(update.status)) {
        const agentRoot = path.resolve(process.env.AGENT_TEAMS_INSTALL_ROOT || path.join(os.homedir(), "Downloads", "Agent Teams"));
        const installedPlugin = path.join(agentRoot, ".system", "marketplace", "plugins", PLUGIN);
        const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
        const runtime = installBundledRuntime(sourceRoot, agentRoot);
        const dashboard = launchDashboard(agentRoot, installedPlugin, runtime.node, { open: false });
        const embed = dashboard.started ? launchCodexEmbed(agentRoot, installedPlugin, runtime.node) : { started: false };
        if (embed.started) console.log("VIXO Agents 已在 Codex 側欄或原生面板中開啟。");
      }
      if (update.ok === false) process.exitCode = 1;
      return;
    }
    const report = install();
    console.log("\nAgent Teams Builder 安裝完成。\n");
    console.log(JSON.stringify(report, null, 2));
    console.log("\nVIXO Agents 已在 Codex 側欄或原生面板中開啟。也可隨時雙擊下載/Agent Teams 內的 Open VIXO Agents 啟動檔。\n");
    console.log("請開啟新的 Claude Code／Codex Session，然後說：列出我的 VIXO Agents。\n");
    if (Object.values(report.results).some((item) => !item.installed) || (!report.doctor.ok && process.env.AGENT_TEAMS_SKIP_NPM !== "1")) process.exitCode = 1;
  } catch (error) {
    console.error(`\n安裝／更新失敗：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && sameFile(fileURLToPath(import.meta.url), process.argv[1])) await main();
