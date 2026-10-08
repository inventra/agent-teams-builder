import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { install, repairHostRegistrations, versionAtLeast, ensureLegacyOwnerSnapshot } from "../scripts/install.mjs";

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
if (name === "codex" && args[0] === "plugin" && args[1] === "list") {
  console.log(JSON.stringify({ installed: [{ pluginId: "agent-teams-builder@agent-teams-local", version: "1.6.1", installed: true, enabled: true }] }));
  process.exit(0);
}
if (name === "claude" && args[0] === "plugin" && args[1] === "list") {
  console.log(JSON.stringify([{ id: "agent-teams-builder@agent-teams-local", version: "1.6.1", enabled: true }]));
  process.exit(0);
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
    const agentTeamsRoot = path.join(temporary, 'Agent Teams');
    const oldPlugin = path.join(agentTeamsRoot, '.system', 'marketplace', 'plugins', 'agent-teams-builder');
    fs.mkdirSync(path.join(oldPlugin, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(oldPlugin, 'package.json'), JSON.stringify({ version: '1.11.0' }));
    fs.mkdirSync(path.join(agentTeamsRoot, '.system', 'cloud'));
    fs.writeFileSync(path.join(agentTeamsRoot, '.system', 'cloud', 'session.json'), JSON.stringify({ user: { id: '10000000-0000-4000-8000-000000000001' }, user_verified_at: 1, access_token: 'private-fixture' }));
    const employee = path.join(agentTeamsRoot, 'legacy-agent'); fs.mkdirSync(employee);
    fs.writeFileSync(path.join(employee, 'agent.json'), JSON.stringify({ id: 'legacy-agent' }));
    const sop = 'Keep the original local SOP exactly.\n'; fs.writeFileSync(path.join(employee, 'AGENT.md'), sop);
    const stoppedSnapshot = path.join(temporary, 'snapshot-at-stop.json');
    fs.writeFileSync(path.join(oldPlugin, 'scripts', 'vixo-agents-dashboard.mjs'), `import fs from 'node:fs';fs.copyFileSync(${JSON.stringify(path.join(agentTeamsRoot, '.system', 'cloud', 'legacy-owner.json'))},${JSON.stringify(stoppedSnapshot)});`);
    const report = install({ sourceRoot, agentTeamsRoot, skipNpm: true });
    const snapshot = JSON.parse(fs.readFileSync(stoppedSnapshot, 'utf8'));
    assert.equal(snapshot.userId, '10000000-0000-4000-8000-000000000001');
    assert.deepEqual(snapshot.agentIds, ['legacy-agent']);
    assert.equal(fs.readFileSync(path.join(employee, 'AGENT.md'), 'utf8'), sop);
    assert.doesNotMatch(JSON.stringify(snapshot), /private-fixture|access_token/);
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
    assert.ok(fs.existsSync(report.updaterScript));
    assert.equal(fs.readFileSync(report.updaterScript, "utf8"), fs.readFileSync(path.join(sourceRoot, "scripts", "install.mjs"), "utf8"));
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

test('legacy ownership snapshot is immutable across signins and keeps existing local files untouched', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vixo-legacy-owner-'));
  try {
    const root = path.join(temporary, 'Agent Teams');
    const cloud = path.join(root, '.system', 'cloud'); fs.mkdirSync(cloud, { recursive: true });
    const plugin = path.join(root, '.system', 'marketplace', 'plugins', 'agent-teams-builder'); fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ version: '1.11.0+codex.fixture' }));
    const agent = path.join(root, 'legacy-agent'); fs.mkdirSync(agent); fs.writeFileSync(path.join(agent, 'agent.json'), '{"id":"legacy-agent"}');
    fs.writeFileSync(path.join(agent, 'AGENT.md'), 'Private original SOP');
    const session = path.join(cloud, 'session.json');
    fs.writeFileSync(session, JSON.stringify({ user: { id: '10000000-0000-4000-8000-000000000001' }, user_verified_at: Date.now(), access_token: 'never-copy-access', refresh_token: 'never-copy-refresh' }));
    const made = ensureLegacyOwnerSnapshot(root); assert.equal(made.created, true);
    const content = fs.readFileSync(made.path, 'utf8'); const record = JSON.parse(content);
    assert.deepEqual(Object.keys(record).sort(), ['agentIds', 'createdAt', 'formatVersion', 'userId']);
    assert.deepEqual(record.agentIds, ['legacy-agent']); assert.equal(record.formatVersion, 1); assert.ok(Number.isFinite(Date.parse(record.createdAt)));
    assert.doesNotMatch(content, /access_token|refresh_token|never-copy|Private original/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(made.path).mode & 0o777, 0o600);
    fs.writeFileSync(session, JSON.stringify({ user: { id: '20000000-0000-4000-8000-000000000001' }, user_verified_at: Date.now() }));
    assert.equal(ensureLegacyOwnerSnapshot(root).created, false);
    assert.equal(fs.readFileSync(made.path, 'utf8'), content);
    assert.equal(fs.readFileSync(path.join(agent, 'AGENT.md'), 'utf8'), 'Private original SOP');
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('fresh, unverified, and new-version roots stay unassigned, including after a later login', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vixo-unassigned-owner-'));
  try {
    for (const [name, version, verified] of [['fresh', null, true], ['unverified', '1.11.0', false], ['current', '1.12.0', true], ['disconnected', '1.11.0', null]]) {
      const root = path.join(temporary, name); const cloud = path.join(root, '.system', 'cloud'); fs.mkdirSync(cloud, { recursive: true });
      if (version) fs.writeFileSync(path.join(root, '.system', 'update-state.json'), JSON.stringify({ installedVersion: version }));
      const session = path.join(cloud, 'session.json');
      if (verified !== null) fs.writeFileSync(session, JSON.stringify({ user: { id: '10000000-0000-4000-8000-000000000001' }, ...(verified ? { user_verified_at: 1 } : {}) }));
      const made = ensureLegacyOwnerSnapshot(root); const initial = fs.readFileSync(made.path, 'utf8');
      assert.equal(JSON.parse(initial).userId, null); assert.deepEqual(JSON.parse(initial).agentIds, []);
      fs.writeFileSync(session, JSON.stringify({ user: { id: '20000000-0000-4000-8000-000000000001' }, user_verified_at: Date.now() }));
      ensureLegacyOwnerSnapshot(root); assert.equal(fs.readFileSync(made.path, 'utf8'), initial);
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('legacy migration rejects symlink roots, credential paths, marker files, and employee files', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vixo-owner-symlink-'));
  try {
    const outside = path.join(temporary, 'outside'); fs.mkdirSync(outside);
    const probe = path.join(temporary, 'probe');
    try { fs.symlinkSync(outside, probe, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symlink creation unavailable'); return; } throw error;
    }
    assert.throws(() => ensureLegacyOwnerSnapshot(probe), /real directory/);
    for (const name of ['system', 'cloud', 'marker', 'session', 'employee']) {
      const root = path.join(temporary, name); const cloud = path.join(root, '.system', 'cloud'); fs.mkdirSync(cloud, { recursive: true });
      if (name === 'system' || name === 'cloud') {
        const target = name === 'system' ? path.join(root, '.system') : cloud;
        fs.rmSync(target, { recursive: true }); fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        const target = name === 'marker' ? path.join(cloud, 'legacy-owner.json') : name === 'session' ? path.join(cloud, 'session.json') : path.join(root, 'legacy-agent', 'agent.json');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // A directory junction also exercises special-file rejection on Windows.
        fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
      }
      assert.throws(() => ensureLegacyOwnerSnapshot(root), /symlinks or special files/);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
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

test("one-click rerun repairs and verifies Codex and Claude Code even when the installed release is current", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-installer-repair-test-"));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "calls.log");
  const agentTeamsRoot = path.join(temporary, "Agent Teams");
  fs.mkdirSync(bin);
  createFakeHost(bin, "codex", "codex-cli 0.148.0", log);
  createFakeHost(bin, "claude", "2.1.270 (Claude Code)", log, { alreadyInstalled: true });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  process.env.AGENT_TEAMS_SKIP_NPM = "1";
  try {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    install({ sourceRoot, agentTeamsRoot, skipNpm: true });
    fs.writeFileSync(log, "", "utf8");
    const repair = repairHostRegistrations({ agentTeamsRoot });
    const calls = fs.readFileSync(log, "utf8");
    assert.equal(repair.healthy, true);
    assert.equal(repair.results.codex.verification.verified, true);
    assert.equal(repair.results.claude.verification.verified, true);
    assert.match(calls, /codex plugin marketplace add/);
    assert.match(calls, /codex plugin list --json/);
    assert.match(calls, /claude plugin marketplace add/);
    assert.match(calls, /claude plugin update agent-teams-builder@agent-teams-local/);
    assert.match(calls, /claude plugin list --json/);
    const report = JSON.parse(fs.readFileSync(path.join(agentTeamsRoot, "installation-report.json"), "utf8"));
    assert.equal(report.hostRegistrationCheck.healthy, true);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.AGENT_TEAMS_SKIP_NPM;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
