import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("SessionStart onboarding is emitted once per plugin data directory", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "agent-onboarding-test-"));
  const hook = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "session-start.mjs");
  const invoke = () => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: data }
  });
  try {
    const first = invoke();
    assert.equal(first.status, 0);
    const payload = JSON.parse(first.stdout);
    assert.match(payload.hookSpecificOutput.additionalContext, /你好，我是 Agent Builder 插件/);
    const second = invoke();
    assert.equal(second.status, 0);
    assert.equal(second.stdout, "");
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});
