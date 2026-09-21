import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildRuntimeVersion, extractArchive, findSourceRoot, maybeRunSelfUpdate, UPDATE_SOURCE } from "../scripts/install.mjs";

const REVISION = "0123456789abcdef0123456789abcdef01234567";

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

function archiveResponse(bytes = Buffer.from("fake zip")) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.length) },
    arrayBuffer: async () => bytes
  };
}

function writeState(root, revision = REVISION) {
  const file = path.join(root, ".system", "update-state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ repository: UPDATE_SOURCE.repository, branch: "main", revision })}\n`);
}

test("runtime version uses one Codex cachebuster suffix", () => {
  const version = buildRuntimeVersion("1.2.0+codex.old", REVISION, new Date("2026-09-22T12:34:56Z"));
  assert.equal(version, "1.2.0+codex.20260922123456-0123456789ab");
  assert.equal(buildRuntimeVersion("1.2.0", "bundled"), "1.2.0");
});

test("updater downloads the immutable commit archive and delegates installation", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-updater-test-"));
  const calls = [];
  let child = null;
  try {
    const result = await maybeRunSelfUpdate({
      agentTeamsRoot: path.join(temporary, "Agent Teams"),
      env: {},
      fetchImpl: async (url) => {
        calls.push(url);
        return calls.length === 1
          ? jsonResponse({ sha: REVISION, commit: { committer: { date: "2026-09-22T12:34:56Z" } } })
          : archiveResponse();
      },
      extractArchiveImpl: (_archive, destination) => {
        const source = path.join(destination, "inventra-agent-teams-builder-test");
        fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
        fs.mkdirSync(path.join(source, "plugins", "agent-teams-builder"), { recursive: true });
        fs.mkdirSync(path.join(source, ".agents", "plugins"), { recursive: true });
        fs.writeFileSync(path.join(source, "scripts", "install.mjs"), "");
        fs.writeFileSync(path.join(source, "plugins", "agent-teams-builder", "package.json"), "{}");
        fs.writeFileSync(path.join(source, ".agents", "plugins", "marketplace.json"), "{}");
      },
      runChildImpl: (sourceRoot, env) => {
        child = { sourceRoot, env };
        return { ok: true, status: 0 };
      }
    });
    assert.equal(result.status, "updated");
    assert.equal(calls[0], "https://api.github.com/repos/inventra/agent-teams-builder/commits/main");
    assert.equal(calls[1], `https://api.github.com/repos/inventra/agent-teams-builder/zipball/${REVISION}`);
    assert.equal(child.env.AGENT_TEAMS_SOURCE_REVISION, REVISION);
    assert.equal(child.env.AGENT_TEAMS_SKIP_UPDATE, "1");
    assert.match(child.env.AGENT_TEAMS_ARCHIVE_SHA256, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("updater does not reinstall when the recorded commit is current", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-updater-current-test-"));
  const root = path.join(temporary, "Agent Teams");
  writeState(root);
  let childCalled = false;
  try {
    const result = await maybeRunSelfUpdate({
      agentTeamsRoot: root,
      env: {},
      fetchImpl: async () => jsonResponse({ sha: REVISION }),
      runChildImpl: () => { childCalled = true; return { ok: true }; }
    });
    assert.equal(result.status, "up-to-date");
    assert.equal(childCalled, false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("GitHub outage preserves an installed version but permits bundled first install", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-updater-offline-test-"));
  const installedRoot = path.join(temporary, "installed", "Agent Teams");
  const freshRoot = path.join(temporary, "fresh", "Agent Teams");
  writeState(installedRoot, "fedcba9876543210fedcba9876543210fedcba98");
  const unavailable = async () => { throw new Error("network unavailable"); };
  try {
    const installed = await maybeRunSelfUpdate({ agentTeamsRoot: installedRoot, env: {}, fetchImpl: unavailable });
    const fresh = await maybeRunSelfUpdate({ agentTeamsRoot: freshRoot, env: {}, fetchImpl: unavailable });
    assert.equal(installed.status, "offline-current");
    assert.equal(installed.handled, true);
    assert.equal(fresh.status, "offline-first-install");
    assert.equal(fresh.handled, false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("platform archive extractor accepts the updater repository layout", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-updater-archive-test-"));
  const source = path.join(temporary, "source", "repo");
  const archive = path.join(temporary, "update.zip");
  const destination = path.join(temporary, "destination");
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(source, "plugins", "agent-teams-builder"), { recursive: true });
  fs.mkdirSync(path.join(source, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(source, "scripts", "install.mjs"), "");
  fs.writeFileSync(path.join(source, "plugins", "agent-teams-builder", "package.json"), "{}");
  fs.writeFileSync(path.join(source, ".agents", "plugins", "marketplace.json"), "{}");
  fs.mkdirSync(destination);
  try {
    const packed = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${source.replace(/'/g, "''")}\\*' -DestinationPath '${archive.replace(/'/g, "''")}' -Force`], { shell: false })
      : spawnSync("zip", ["-qr", archive, "repo"], { cwd: path.dirname(source), shell: false });
    assert.equal(packed.status, 0, packed.stderr?.toString());
    extractArchive(archive, destination);
    const extractedSource = findSourceRoot(destination);
    assert.equal(fs.existsSync(path.join(extractedSource, "scripts", "install.mjs")), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
