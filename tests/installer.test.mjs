import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { install, versionAtLeast } from "../scripts/install.mjs";

function createFakeHost(bin, name, version, log, { alreadyInstalled = false, loggedIn = true, failLogin = false } = {}) {
  const state = path.join(bin, `${name}-logged-in`);
  if (loggedIn) fs.writeFileSync(state, "yes", "utf8");
  const helper = path.join(bin, `${name}-fake.mjs`);
  fs.writeFileSync(helper, `
import fs from "node:fs";
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const state = ${JSON.stringify(state)};
const version = ${JSON.stringify(version)};
const name = ${JSON.stringify(name)};
const alreadyInstalled = ${JSON.stringify(alreadyInstalled)};
const failLogin = ${JSON.stringify(failLogin)};
if (args[0] === "--version") { console.log(version); process.exit(0); }
fs.appendFileSync(log, name + " " + args.join(" ") + "\\n");
if (name === "codex" && args[0] === "login" && args[1] === "status") {
  if (fs.existsSync(state)) { console.log("Logged in using ChatGPT"); process.exit(0); }
  console.error("Not logged in"); process.exit(1);
}
if (name === "codex" && args[0] === "login") {
  if (failLogin) process.exit(1);
  fs.writeFileSync(state, "yes"); console.log("Browser login complete"); process.exit(0);
}
if (name === "claude" && args[0] === "auth" && args[1] === "status") {
  const isLoggedIn = fs.existsSync(state);
  console.log(JSON.stringify({ loggedIn: isLoggedIn, authMethod: isLoggedIn ? "claude.ai" : "none" }));
  process.exit(isLoggedIn ? 0 : 1);
}
if (name === "claude" && args[0] === "auth" && args[1] === "login") {
  if (failLogin) process.exit(1);
  fs.writeFileSync(state, "yes"); console.log("Browser login complete"); process.exit(0);
}
if (alreadyInstalled && name === "claude" && args[0] === "plugin" && args[1] === "install") console.log("Plugin is already installed");
process.exit(0);
`, "utf8");
  if (process.platform === "win32") {
    const executable = path.join(bin, `${name}.cmd`);
    fs.writeFileSync(executable, `@echo off\r\nnode "${helper}" %*\r\nexit /b %errorlevel%\r\n`, "utf8");
    return;
  }
  const executable = path.join(bin, name);
  fs.writeFileSync(executable, `#!/bin/sh\nexec node "${helper}" "$@"\n`, "utf8");
  fs.chmodSync(executable, 0o755);
}

test("semantic version compatibility is numeric", () => {
  assert.equal(versionAtLeast("codex-cli 0.148.0", "0.148.0"), true);
  assert.equal(versionAtLeast("2.1.9", "2.1.265"), false);
  assert.equal(versionAtLeast("v22.3.0", "18.0.0"), true);
});

test("installer configures every detected compatible CLI", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-installer-test-"));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "calls.log");
  fs.mkdirSync(bin);
  createFakeHost(bin, "codex", "codex-cli 0.148.0", log);
  createFakeHost(bin, "claude", "2.1.270 (Claude Code)", log);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  process.env.AGENT_TEAMS_SKIP_NPM = "1";
  try {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const report = install({ sourceRoot, agentTeamsRoot: path.join(temporary, "Agent Teams"), skipNpm: true });
    assert.equal(report.results.codex.installed, true);
    assert.equal(report.results.claude.installed, true);
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /plugin marketplace add/);
    assert.match(calls, /plugin add agent-teams-builder@agent-teams-local/);
    assert.match(calls, /plugin install agent-teams-builder@agent-teams-local/);
    assert.ok(fs.existsSync(report.pluginRoot));
    const macLauncher = fs.readFileSync(report.dashboardLaunchers.mac, "utf8");
    const windowsLauncher = fs.readFileSync(report.dashboardLaunchers.windows, "utf8");
    assert.match(macLauncher, /vixo-codex-embed\.mjs/);
    assert.match(windowsLauncher, /vixo-codex-embed\.mjs/);
    assert.ok(fs.existsSync(path.join(report.pluginRoot, "inject", "vixo-agents.user.js")));
    assert.equal(report.authentication.codex.loggedIn, true);
    assert.equal(report.authentication.claude.loggedIn, true);
    assert.doesNotMatch(calls, /codex login\n/);
    assert.doesNotMatch(calls, /claude auth login/);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.AGENT_TEAMS_SKIP_NPM;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("installer launches browser login for every unauthenticated host", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-installer-login-test-"));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "calls.log");
  fs.mkdirSync(bin);
  createFakeHost(bin, "codex", "codex-cli 0.148.0", log, { loggedIn: false });
  createFakeHost(bin, "claude", "2.1.270 (Claude Code)", log, { loggedIn: false });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  process.env.AGENT_TEAMS_SKIP_NPM = "1";
  try {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const report = install({ sourceRoot, agentTeamsRoot: path.join(temporary, "Agent Teams"), skipNpm: true });
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /codex login status/);
    assert.match(calls, /codex login\n/);
    assert.match(calls, /claude auth status --json/);
    assert.match(calls, /claude auth login --claudeai/);
    assert.equal(report.authentication.codex.loginAttempted, true);
    assert.equal(report.authentication.claude.loginAttempted, true);
    assert.equal(report.authentication.codex.loggedIn, true);
    assert.equal(report.authentication.claude.loggedIn, true);
    assert.equal(report.results.codex.installed, true);
    assert.equal(report.results.claude.installed, true);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.AGENT_TEAMS_SKIP_NPM;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("installer does not claim installation when browser login is unfinished", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-installer-login-fail-test-"));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "calls.log");
  fs.mkdirSync(bin);
  createFakeHost(bin, "codex", "codex-cli 0.148.0", log, { loggedIn: false, failLogin: true });
  createFakeHost(bin, "claude", "2.1.270 (Claude Code)", log, { loggedIn: true });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  process.env.AGENT_TEAMS_SKIP_NPM = "1";
  try {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const report = install({ sourceRoot, agentTeamsRoot: path.join(temporary, "Agent Teams"), skipNpm: true });
    assert.equal(report.authentication.codex.loggedIn, false);
    assert.equal(report.results.codex.installed, false);
    assert.match(report.results.codex.error, /login was not completed/);
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /codex plugin marketplace add/);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.AGENT_TEAMS_SKIP_NPM;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("installer updates Claude when the plugin is already installed", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-installer-update-test-"));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "calls.log");
  fs.mkdirSync(bin);
  createFakeHost(bin, "codex", "codex-cli 0.148.0", log);
  createFakeHost(bin, "claude", "2.1.270 (Claude Code)", log, { alreadyInstalled: true });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  process.env.AGENT_TEAMS_SKIP_NPM = "1";
  try {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    install({ sourceRoot, agentTeamsRoot: path.join(temporary, "Agent Teams"), skipNpm: true });
    assert.match(fs.readFileSync(log, "utf8"), /plugin update agent-teams-builder@agent-teams-local/);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.AGENT_TEAMS_SKIP_NPM;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
