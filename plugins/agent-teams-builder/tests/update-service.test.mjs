import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkForUpdate, resetUpdateCacheForTests, startUpdate } from "../src/update-service.mjs";

const CURRENT = "1111111111111111111111111111111111111111";
const LATEST = "2222222222222222222222222222222222222222";

function response(value) {
  return { ok: true, status: 200, json: async () => value };
}

test("dashboard update check compares the installed commit and reads the remote version", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-update-check-"));
  fs.mkdirSync(path.join(root, ".system"), { recursive: true });
  fs.writeFileSync(path.join(root, ".system", "update-state.json"), `${JSON.stringify({ revision: CURRENT, installedVersion: "1.5.0" })}\n`);
  const urls = [];
  resetUpdateCacheForTests();
  try {
    const update = await checkForUpdate({
      agentTeamsRoot: root,
      now: Date.parse("2026-09-24T08:00:00Z"),
      fetchImpl: async (url) => {
        urls.push(url);
        return urls.length === 1 ? response({ sha: LATEST }) : response({ version: "1.6.0" });
      }
    });
    assert.equal(update.available, true);
    assert.equal(update.currentVersion, "1.5.0");
    assert.equal(update.latestVersion, "1.6.0");
    assert.equal(update.latestRevision, LATEST);
    assert.match(urls[0], /commits\/main\?cache_bust=/);
    assert.match(urls[1], new RegExp(`${LATEST}/package\\.json$`));
  } finally {
    resetUpdateCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard update starts only the installed updater through the fixed runner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-update-start-"));
  const updater = path.join(root, ".system", "updater", "install.mjs");
  const runner = path.join(root, "runner.mjs");
  fs.mkdirSync(path.dirname(updater), { recursive: true });
  fs.writeFileSync(updater, "");
  fs.writeFileSync(runner, "");
  let invocation;
  try {
    const result = startUpdate({
      agentTeamsRoot: root,
      runner,
      spawnImpl: (command, args, options) => {
        invocation = { command, args, options };
        return { pid: 4321, unref() {} };
      }
    });
    assert.equal(result.status, "queued");
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [runner]);
    assert.equal(invocation.options.env.VIXO_UPDATER_SCRIPT, updater);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".system", "update-runtime.json"), "utf8")).status, "queued");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard invalidates its version cache when installation state changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-update-cache-"));
  const stateFile = path.join(root, ".system", "update-state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ revision: CURRENT, installedVersion: "1.5.0" })}\n`);
  let requests = 0;
  const fetchImpl = async (url) => {
    requests += 1;
    return url.includes("package.json") ? response({ version: "1.6.0" }) : response({ sha: LATEST });
  };
  resetUpdateCacheForTests();
  try {
    assert.equal((await checkForUpdate({ agentTeamsRoot: root, fetchImpl })).available, true);
    fs.writeFileSync(stateFile, `${JSON.stringify({ revision: LATEST, installedVersion: "1.6.0" })}\n`);
    const refreshed = await checkForUpdate({ agentTeamsRoot: root, fetchImpl });
    assert.equal(refreshed.available, false);
    assert.equal(refreshed.currentVersion, "1.6.0");
    assert.equal(requests, 4);
  } finally {
    resetUpdateCacheForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
