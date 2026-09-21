import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { install, versionAtLeast } from "../scripts/install.mjs";

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
  for (const [name, version] of [["codex", "codex-cli 0.148.0"], ["claude", "2.1.270 (Claude Code)"]]) {
    const executable = path.join(bin, name);
    fs.writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho "${name} $@" >> "${log}"\nexit 0\n`, "utf8");
    fs.chmodSync(executable, 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
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
  const codex = path.join(bin, "codex");
  fs.writeFileSync(codex, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.148.0"; exit 0; fi\nexit 0\n`, "utf8");
  fs.chmodSync(codex, 0o755);
  const claude = path.join(bin, "claude");
  fs.writeFileSync(claude, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.270 (Claude Code)"; exit 0; fi\necho "claude $@" >> "${log}"\nif [ "$1 $2" = "plugin install" ]; then echo "Plugin is already installed"; exit 0; fi\nexit 0\n`, "utf8");
  fs.chmodSync(claude, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
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
