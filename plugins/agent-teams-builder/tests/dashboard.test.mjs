import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardServer } from "../src/dashboard-server.mjs";
import { commitPreview, createPreview } from "../src/store.mjs";

test("dashboard is loopback-only, token protected, and exposes Agent workflows", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-dashboard-test-"));
  process.env.AGENT_TEAMS_HOME = temporary;
  const preview = createPreview({ action: "create", spec: {
    id: "finance-helper", displayName: "財務小幫手", aliases: [], description: "處理財務整理", purpose: "整理財務資料", systemPrompt: "不得自行付款。", memory: "空",
    skills: [{ id: "reconcile", name: "對帳", description: "整理差異", triggers: ["對帳"], allowedTools: [], steps: ["讀取資料"], successCriteria: ["列出差異"] }],
    workflows: [{ id: "monthly-close", name: "月結", description: "月結對帳", triggers: ["月結"], nodes: [{ id: "reconcile-node", name: "對帳", type: "skill", skillId: "reconcile", instructions: "執行對帳" }] }]
  }});
  commitPreview({ token: preview.token, userConfirmation: "確認" });
  fs.writeFileSync(path.join(temporary, "installation-report.json"), `${JSON.stringify({ results: { codex: { installed: true } } })}\n`);
  const bin = path.join(temporary, "bin");
  fs.mkdirSync(bin);
  const fake = path.join(bin, "fake-codex.mjs");
  fs.writeFileSync(fake, "process.stdin.resume(); process.stdin.on('end', () => { console.log('fake codex completed'); });\n");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "codex.cmd"), `@echo off\r\nnode "${fake}"\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec node "${fake}"\n`);
    fs.chmodSync(path.join(bin, "codex"), 0o755);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const { server, token } = createDashboardServer({ token: "a".repeat(64) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(allowed.status, 200);
    const state = await allowed.json();
    assert.equal(state.agents[0].workflows[0].id, "monthly-close");
    assert.equal(state.hosts.codex, true);
    const started = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "finance-helper", workflow: "monthly-close", task: "測試執行", host: "codex" })
    });
    assert.equal(started.status, 202);
    const run = await started.json();
    const runFile = path.join(temporary, ".system", "runs", `${run.id}.json`);
    const deadline = Date.now() + 3000;
    let finalRun;
    while (Date.now() < deadline) {
      finalRun = JSON.parse(fs.readFileSync(runFile, "utf8"));
      if (finalRun.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(finalRun.status, "completed");
    const scheduled = await fetch(`http://127.0.0.1:${port}/api/schedules`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "finance-helper", workflowId: "monthly-close", task: "每日測試", host: "codex", time: "08:00" })
    });
    assert.equal(scheduled.status, 200);
    assert.equal((await scheduled.json()).time, "08:00");
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await page.text(), /VIXO Agents/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
    delete process.env.AGENT_TEAMS_HOME;
    process.env.PATH = oldPath;
  }
});
