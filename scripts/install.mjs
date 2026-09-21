#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MINIMUMS = { node: "18.0.0", codex: "0.148.0", claude: "2.1.265" };
const PLUGIN = "agent-teams-builder";
const MARKETPLACE = "agent-teams-local";

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

function commandResult(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
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

function hostCommand(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function available(command) {
  const probe = commandResult(command, ["--version"]);
  return probe.ok ? probe.stdout || probe.stderr : null;
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

function copyRelease(sourceRoot, targetMarketplace, skipNpm) {
  const sourcePlugin = path.join(sourceRoot, "plugins", PLUGIN);
  if (!fs.existsSync(path.join(sourcePlugin, "package.json"))) throw new Error(`Plugin source not found: ${sourcePlugin}`);
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-teams-install-"));
  const stagedMarketplace = path.join(stagingRoot, "marketplace");
  const stagedPlugin = path.join(stagedMarketplace, "plugins", PLUGIN);
  fs.mkdirSync(path.dirname(stagedPlugin), { recursive: true });
  fs.cpSync(sourcePlugin, stagedPlugin, { recursive: true, filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.endsWith(`${path.sep}node_modules`) });
  fs.mkdirSync(path.join(stagedMarketplace, ".agents", "plugins"), { recursive: true });
  fs.mkdirSync(path.join(stagedMarketplace, ".claude-plugin"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, ".agents", "plugins", "marketplace.json"), path.join(stagedMarketplace, ".agents", "plugins", "marketplace.json"));
  fs.copyFileSync(path.join(sourceRoot, ".claude-plugin", "marketplace.json"), path.join(stagedMarketplace, ".claude-plugin", "marketplace.json"));
  if (!skipNpm) {
    const npm = commandResult(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: stagedPlugin, stdio: ["ignore", "pipe", "pipe"] });
    if (!npm.ok) throw new Error(`Runtime dependency installation failed: ${npm.stderr || npm.error}`);
  }
  fs.mkdirSync(path.dirname(targetMarketplace), { recursive: true });
  let backup = null;
  if (fs.existsSync(targetMarketplace)) {
    backup = `${targetMarketplace}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.renameSync(targetMarketplace, backup);
  }
  fs.renameSync(stagedMarketplace, targetMarketplace);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  return backup;
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
  const backup = copyRelease(sourceRoot, marketplaceRoot, options.skipNpm || process.env.AGENT_TEAMS_SKIP_NPM === "1");
  const results = {};
  if (compatibility.codex?.compatible) results.codex = configureCodex(marketplaceRoot);
  if (compatibility.claude?.compatible) results.claude = configureClaude(marketplaceRoot);
  const pluginRoot = path.join(marketplaceRoot, "plugins", PLUGIN);
  let doctor = { ok: false, error: "skipped" };
  if (!(options.skipNpm || process.env.AGENT_TEAMS_SKIP_NPM === "1")) {
    const check = commandResult("node", [path.join(pluginRoot, "scripts", "agent-teams-cli.mjs"), "doctor"], { env: { ...process.env, AGENT_TEAMS_HOME: agentTeamsRoot } });
    doctor = check.ok ? JSON.parse(check.stdout) : { ok: false, error: check.stderr || check.error };
  }
  const allHostsInstalled = Object.values(results).length > 0 && Object.values(results).every((item) => item.installed);
  let backupRemoved = false;
  if (backup && allHostsInstalled && doctor.ok) {
    fs.rmSync(backup, { recursive: true, force: true });
    backupRemoved = true;
  }
  const report = {
    installedAt: new Date().toISOString(),
    agentTeamsRoot,
    marketplaceRoot,
    pluginRoot,
    backup,
    backupRemoved,
    detected,
    compatibility,
    results,
    doctor,
    notes: [
      "Claude Desktop is detected separately; Claude Code CLI is the supported local plugin host used by this installer.",
      "ChatGPT Desktop and Codex share the public plugin directory, but local CLI marketplace installation requires Codex CLI.",
      "Start a new Claude Code/Codex session after installation."
    ]
  };
  fs.writeFileSync(path.join(agentTeamsRoot, "installation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const report = install();
    console.log("\nAgent Teams Builder 安裝完成。\n");
    console.log(JSON.stringify(report, null, 2));
    console.log("\n請開啟新的 Claude Code／Codex Session，然後說：列出我的 Agent Teams。\n");
    if (Object.values(report.results).some((item) => !item.installed)) process.exitCode = 1;
  } catch (error) {
    console.error(`\n安裝失敗：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
