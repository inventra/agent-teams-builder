import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyRunOutcome, createDashboardServer, listCodexProjects } from "../src/dashboard-server.mjs";
import { commitPreview, createPreview } from "../src/store.mjs";

test("dashboard is loopback-only, token protected, and exposes Agent workflows", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-dashboard-test-"));
  process.env.AGENT_TEAMS_HOME = temporary;
  const oldCodexHome = process.env.CODEX_HOME;
  const codexHome = path.join(temporary, "codex-home");
  const projectRoot = path.join(temporary, "sample-project");
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), `${JSON.stringify({
    "local-projects": { "project-1": { id: "project-1", name: "範例專案", rootPaths: [projectRoot] } },
    "project-order": ["project-1"],
    "selected-project": { type: "local", projectId: "project-1" }
  })}\n`);
  const preview = createPreview({ action: "create", spec: {
    id: "finance-helper", displayName: "財務小幫手", aliases: [], description: "處理財務整理", purpose: "整理財務資料", systemPrompt: "不得自行付款。", memory: "空",
    skills: [{ id: "reconcile", name: "對帳", description: "整理差異", triggers: ["對帳"], allowedTools: [], steps: ["讀取資料"], successCriteria: ["列出差異"] }],
    workflows: [
      { id: "monthly-close", name: "月結", description: "月結對帳", triggers: ["月結"], nodes: [{ id: "reconcile-node", name: "對帳", type: "skill", skillId: "reconcile", instructions: "執行對帳" }] },
      { id: "approved-close", name: "核准後月結", description: "核准後才完成", triggers: ["核准月結"], nodes: [
        { id: "reconcile-first", name: "先對帳", type: "skill", skillId: "reconcile", instructions: "先執行對帳" },
        { id: "approval-node", name: "人工核准", type: "approval", skillId: null, instructions: "等待使用者核准", requiresApproval: true }
      ] }
    ]
  }});
  commitPreview({ token: preview.token, userConfirmation: "確認" });
  fs.writeFileSync(path.join(temporary, "installation-report.json"), `${JSON.stringify({ results: { codex: { installed: true } } })}\n`);
  const bin = path.join(temporary, "bin");
  fs.mkdirSync(bin);
  const fake = path.join(bin, "fake-codex.mjs");
  fs.writeFileSync(fake, `
import fs from "node:fs";
const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const resumed = args.includes("resume");
  const automatic = prompt.includes("本次已自動核准 Workflow");
  const needsInput = prompt.includes("測試等待輸入");
  const approval = prompt.includes("[approval] 人工核准") && !automatic && !resumed;
  const message = needsInput
    ? "請提供行政區\\nVIXO_RUN_STATE: WAITING_INPUT"
    : approval
      ? "請確認是否繼續\\nVIXO_RUN_STATE: WAITING_APPROVAL:approval-node"
      : "執行完成\\nVIXO_RUN_STATE: COMPLETED";
  const outputIndex = args.indexOf("-o");
  if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], message);
  console.log(JSON.stringify({ type: "thread.started", thread_id: "11111111-1111-4111-8111-111111111111" }));
});
`, "utf8");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "codex.cmd"), `@echo off\r\nnode "${fake}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec node "${fake}" "$@"\n`);
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
    assert.deepEqual(state.codexProjects.map(({ id, name, selected, isGitRepository }) => ({ id, name, selected, isGitRepository })), [
      { id: "project-1", name: "範例專案", selected: true, isGitRepository: true }
    ]);
    const nativeStarted = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "finance-helper", workflow: "monthly-close", task: "建立原生任務", host: "codex", executionMode: "codex-app", projectId: "project-1" })
    });
    assert.equal(nativeStarted.status, 202);
    const nativeRun = await nativeStarted.json();
    assert.equal(nativeRun.status, "dispatching");
    assert.equal(nativeRun.nativeLaunch.projectId, "project-1");
    assert.match(nativeRun.nativeLaunch.instruction, /財務小幫手 · 月結/);
    const nativeFinished = await fetch(`http://127.0.0.1:${port}/api/runs/${nativeRun.id}/native-result`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ threadId: "22222222-2222-4222-8222-222222222222" })
    });
    assert.equal(nativeFinished.status, 200);
    const nativeResult = await nativeFinished.json();
    assert.equal(nativeResult.status, "opened-in-codex");
    assert.equal(nativeResult.threadId, "22222222-2222-4222-8222-222222222222");
    const invalidNativeStarted = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "finance-helper", workflow: "monthly-close", task: "驗證 Session ID", host: "codex", executionMode: "codex-app", projectId: "project-1" })
    });
    const invalidNativeRun = await invalidNativeStarted.json();
    const invalidNativeFinished = await fetch(`http://127.0.0.1:${port}/api/runs/${invalidNativeRun.id}/native-result`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ threadId: "client-new-thread-invalid" })
    });
    assert.equal(invalidNativeFinished.status, 400);
    assert.match((await invalidNativeFinished.json()).error, /threadId/);
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
    const manualStarted = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "finance-helper", workflow: "approved-close", task: "測試核准", host: "codex", approvalMode: "manual" })
    });
    const manualRun = await manualStarted.json();
    const manualFile = path.join(temporary, ".system", "runs", `${manualRun.id}.json`);
    let waitingRun;
    while (Date.now() < deadline + 3000) {
      waitingRun = JSON.parse(fs.readFileSync(manualFile, "utf8"));
      if (waitingRun.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(waitingRun.status, "waiting-approval");
    assert.equal(waitingRun.pendingNodeId, "approval-node");
    assert.equal(waitingRun.sessionId, "11111111-1111-4111-8111-111111111111");
    const approved = await fetch(`http://127.0.0.1:${port}/api/runs/${manualRun.id}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "確認繼續" })
    });
    assert.equal(approved.status, 202);
    let approvedRun;
    const approvalDeadline = Date.now() + 3000;
    while (Date.now() < approvalDeadline) {
      approvedRun = JSON.parse(fs.readFileSync(manualFile, "utf8"));
      if (approvedRun.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(approvedRun.status, "completed");
    const autoStarted = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "finance-helper", workflow: "approved-close", task: "測試自動核准", host: "codex", approvalMode: "auto" })
    });
    const autoRun = await autoStarted.json();
    const autoFile = path.join(temporary, ".system", "runs", `${autoRun.id}.json`);
    let autoFinal;
    const autoDeadline = Date.now() + 3000;
    while (Date.now() < autoDeadline) {
      autoFinal = JSON.parse(fs.readFileSync(autoFile, "utf8"));
      if (autoFinal.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(autoFinal.status, "completed");
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
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    process.env.PATH = oldPath;
  }
});

test("Codex projects ignore missing roots and preserve selected project first", () => {
  const existing = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-project-list-"));
  try {
    const projects = listCodexProjects({
      "local-projects": {
        missing: { name: "不存在", rootPaths: [path.join(existing, "missing")] },
        selected: { name: "目前專案", rootPaths: [existing] }
      },
      "project-order": ["missing", "selected"],
      "selected-project": { projectId: "selected" }
    });
    assert.deepEqual(projects.map((item) => item.id), ["selected"]);
  } finally {
    fs.rmSync(existing, { recursive: true, force: true });
  }
});

test("run outcome distinguishes missing input from approval and completion", () => {
  assert.equal(classifyRunOutcome({ exitCode: 0, lastMessage: "請問要查哪個行政區？", remainingApprovals: 1 }).status, "waiting-input");
  assert.equal(classifyRunOutcome({ exitCode: 0, lastMessage: "請核准\nVIXO_RUN_STATE: WAITING_APPROVAL:sync", remainingApprovals: 1 }).status, "waiting-approval");
  assert.equal(classifyRunOutcome({ exitCode: 0, lastMessage: "完成\nVIXO_RUN_STATE: COMPLETED", remainingApprovals: 1 }).status, "completed");
  assert.equal(classifyRunOutcome({ exitCode: 1, lastMessage: "" }).status, "failed");
});
