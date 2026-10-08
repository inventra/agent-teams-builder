import { approvedAccountFixture } from './approved-account-fixture.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../src/dashboard-server.mjs";
import { allWorkbenchRuns, getWorkbenchRun, periodBounds, readWorkbenchPreferences, safeWorkbenchRun,
  saveWorkbenchPreferences, workbenchState } from "../src/workbench-store.mjs";
import { CARD_LIBRARY, defaultPreferences, normalizePreferences, officePositions, searchWorkbench } from "../web/workbench-model.js";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = { id: "test-agent", displayName: "測試員工", description: "測試用，不是真實員工", purpose: "測試",
  version: 1, skills: [{ id: "test-skill", name: "測試技能", description: "讀資料" }],
  workflows: [{ id: "test-workflow", name: "測試流程", description: "確認資料", nodes: [] }] };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-workbench-test-"));
  fs.mkdirSync(path.join(root, ".system", "runs"), { recursive: true });
  return root;
}
function writeRun(root, record) {
  fs.writeFileSync(path.join(root, ".system", "runs", record.id + ".json"), JSON.stringify(record));
}

test("period ranges are local days, Monday weeks and calendar months", () => {
  const now = new Date(2026, 9, 1, 12);
  for (const [period, start, end] of [
    ["today", new Date(2026, 9, 1), new Date(2026, 9, 2)],
    ["week", new Date(2026, 8, 28), new Date(2026, 9, 5)],
    ["month", new Date(2026, 9, 1), new Date(2026, 10, 1)]
  ]) {
    const range = periodBounds(period, now);
    assert.equal(range.start, start.toISOString());
    assert.equal(range.end, end.toISOString());
  }
  assert.equal(periodBounds("week", new Date(2026, 9, 4)).start, new Date(2026, 8, 28).toISOString());
  assert.throws(() => periodBounds("year", now), /period/);
});

test("workbench aggregates all records beyond 30 and never counts native launch as completion", () => {
  const root = fixture();
  try {
    const now = new Date(2026, 9, 1, 12);
    for (let i = 0; i < 45; i++) writeRun(root, {
      id: "run-" + i, agentId: agent.id, status: "completed", startedAt: new Date(2026, 9, 1, 9, i).toISOString()
    });
    writeRun(root, { id: "native", agentId: agent.id, status: "opened-in-codex", executionMode: "codex-app",
      startedAt: now.toISOString(), sessionId: "22222222-2222-4222-8222-222222222222" });
    writeRun(root, { id: "pending", agentId: agent.id, status: "waiting-approval", startedAt: new Date(2026, 8, 27).toISOString() });
    writeRun(root, { id: "invalid-time", status: "completed", startedAt: "bad-date" });
    writeRun(root, { id: "next-day", status: "completed", startedAt: new Date(2026, 9, 2).toISOString() });
    fs.writeFileSync(path.join(root, ".system", "runs", "corrupt.json"), "{");
    const result = workbenchState(root, { now, agents: [agent], schedules: [{ enabled: true }, { enabled: false }] });
    assert.equal(result.runs.length, 46);
    assert.equal(result.summary.totalRuns, 46);
    assert.equal(result.summary.completedRuns, 45);
    assert.equal(result.summary.counts["opened-in-codex"], 1);
    assert.equal(result.summary.pendingApprovals, 1);
    assert.equal(result.summary.enabledSchedules, 1);
    assert.equal(result.agentActivity[0].latestRun.id, "pending");
    assert.equal(result.summary.timeSaved, null);
    assert.equal(result.summary.cost, null);
    assert.ok(result.integrations.every((item) => item.status === "not-connected"));
    assert.equal(allWorkbenchRuns(root).length, 49);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("preferences preserve all cards, enforce valid identities and persist only within selected root", () => {
  const root = fixture(), otherRoot = fixture();
  try {
    const value = saveWorkbenchPreferences(root, { skin: "office", theme: "dark", period: "month",
      favorites: ["test-agent/test-workflow", "test-agent/test-workflow", "../secret"],
      cards: [{ id: "agents", width: 8, height: 4, tint: "iris" }, { id: "agents", width: 4 },
        { id: "not-real", width: 12 }, { id: "health", width: 99, height: -1, tint: "bad" }],
      token: "must-not-persist" });
    assert.deepEqual(readWorkbenchPreferences(root), value);
    assert.equal(value.cards.length, 2);
    assert.equal(value.cards[0].width, 8);
    assert.equal(value.cards[1].width, 4);
    assert.equal(value.cards[1].tint, "none");
    assert.deepEqual(value.favorites, ["test-agent/test-workflow"]);
    assert.equal(value.token, undefined);
    assert.deepEqual(readWorkbenchPreferences(otherRoot), defaultPreferences());
    assert.equal(saveWorkbenchPreferences(root, { cards: [] }).cards.length, 0);
    assert.throws(() => saveWorkbenchPreferences(root, []), /object/);
    assert.equal(normalizePreferences({ skin: "gpt" }).skin, "classic");
    assert.equal(Object.keys(CARD_LIBRARY).length, 14);
  } finally {
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("safe execution details exclude paths, prompts, tokens and reject path traversal", () => {
  const root = fixture();
  try {
    const record = { id: "safe-run", status: "failed", task: "Bearer sensitive-value token=secret access_token=private",
      logFile: "/private/internal.log", lastMessageFile: "/private/output", agentDirectory: "/private/agent",
      workspacePath: "/private/project", token: "secret", prompt: "secret prompt", sessionId: "private-session",
      approvalNodes: [{ id: "approve", name: "確認", secret: "private" }] };
    writeRun(root, record);
    const safe = safeWorkbenchRun(record);
    for (const key of ["token", "prompt", "sessionId", "workspacePath", "logFile", "lastMessageFile", "agentDirectory"])
      assert.equal(safe[key], undefined);
    assert.doesNotMatch(safe.task, /sensitive-value|secret|private/);
    assert.deepEqual(safe.approvalNodes, [{ id: "approve", name: "確認" }]);
    assert.equal(getWorkbenchRun(root, "safe-run").id, "safe-run");
    assert.equal(getWorkbenchRun(root, "missing"), null);
    assert.throws(() => getWorkbenchRun(root, "../private"), /Invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("new API endpoints require auth, persist preferences and return safe details", async () => {
  const root = fixture(), previousRoot = process.env.AGENT_TEAMS_HOME;
  process.env.AGENT_TEAMS_HOME = root;
  fs.mkdirSync(path.join(root, agent.id));
  fs.writeFileSync(path.join(root, agent.id, "agent.json"), JSON.stringify(agent));
  writeRun(root, { id: "api-run", agentId: agent.id, status: "completed", startedAt: new Date().toISOString(), logFile: "/private/log" });
  const restoreAccount = approvedAccountFixture(root);
  const { server, token } = createDashboardServer({ token: "test-workbench-token" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
  try {
    for (const url of ["/api/workbench", "/api/preferences/workbench", "/api/runs/api-run"])
      assert.equal((await fetch(base + url)).status, 401);
    const response = await fetch(base + "/api/workbench", { headers });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.workspace, "vixo");
    assert.equal(state.summary.agents, 1);
    assert.equal(state.summary.skills, 1);
    assert.equal(state.summary.workflows, 1);
    assert.equal((await fetch(base + "/api/workbench?period=unsupported", { headers })).status, 400);
    const saved = await fetch(base + "/api/preferences/workbench", {
      method: "POST", headers, body: JSON.stringify({ ...defaultPreferences(), skin: "office", theme: "dark" })
    });
    assert.equal(saved.status, 200);
    assert.equal((await (await fetch(base + "/api/preferences/workbench", { headers })).json()).skin, "office");
    const detail = await (await fetch(base + "/api/runs/api-run", { headers })).json();
    assert.equal(detail.logFile, undefined);
    assert.equal((await fetch(base + "/api/runs/missing", { headers })).status, 404);
    assert.equal((await fetch(base + "/api/runs/%2E%2E%2Fprivate", { headers })).status, 400);
    const staticPage = await (await fetch(base + "/")).text();
    assert.match(staticPage, /id="workbench"/);
    assert.match(staticPage, /workbench.css/);
    const trace = await (await fetch(base + "/workbench-capabilities.json")).json();
    assert.equal(trace.count, 173);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreAccount();
    if (previousRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pixel identity is stable across API ordering and search uses only supplied real records", () => {
  const agents = [{ ...agent, id: "xiao-cai" }, { ...agent, id: "xiao-pei" }];
  assert.deepEqual(officePositions(agents), officePositions([...agents].reverse()));
  assert.equal(new Set(officePositions(agents).map((position) => position.x + "/" + position.y)).size, 2);
  assert.deepEqual(officePositions([]), []);
  const results = searchWorkbench({ agents }, [{ id: "search-run", agentId: "xiao-cai",
    status: "opened-in-codex", agentName: "測試員工", workflowName: "測試流程", task: "安全查詢" }], "測試");
  assert.ok(results.some((entry) => entry.type === "agent"));
  assert.ok(results.some((entry) => entry.type === "skill"));
  assert.ok(results.some((entry) => entry.type === "workflow"));
  assert.ok(results.some((entry) => entry.type === "run"));
  assert.equal(searchWorkbench({ agents }, [], "不存在的 ERP 資料").length, 0);
});

test("complete source trace has 173 unique nodes and 15 modules with explicit evidence boundaries", () => {
  const trace = JSON.parse(fs.readFileSync(path.join(pluginRoot, "web", "workbench-capabilities.json"), "utf8"));
  assert.equal(trace.modules.length, 15);
  assert.equal(trace.nodes.length, 173);
  assert.equal(new Set(trace.nodes.map((node) => node.id)).size, 173);
  assert.equal(trace.nodes.filter((node) => node.kind === "ui").length, 79);
  assert.equal(trace.nodes.filter((node) => node.kind === "fn").length, 94);
  assert.ok(trace.nodes.every((node) => ["首版完成", "後續規劃", "待串接"].includes(node.status)));
  assert.match(trace.nodes.find((node) => node.id === "n110").source, /LINE Messaging API/);
  assert.match(trace.nodes.find((node) => node.id === "n147").notes, /週排程後續/);
});

test("saved seats survive colliding new identities and overflow into additional office workspaces", () => {
  const original = officePositions([{ id: "xiao-cai" }, { id: "xiao-pei" }]);
  const saved = Object.fromEntries(original.map((position) => [position.agentId, position.slot]));
  const many = Array.from({ length: 40 }, (_, index) => ({ id: "new-agent-" + index }));
  const expanded = officePositions([...many, { id: "xiao-cai" }, { id: "xiao-pei" }], saved);
  assert.deepEqual(expanded.filter((position) => ["xiao-cai", "xiao-pei"].includes(position.agentId)), original);
  assert.equal(new Set(expanded.map((position) => position.slot)).size, 42);
  assert.ok(expanded.some((position) => position.floor > 0));
  assert.ok(expanded.every((position) => position.x >= 20 && position.x <= 80 && position.y >= 35 && position.y <= 75));
  const value = normalizePreferences({ officeSeats: { a: 0, b: 0, c: -1, d: 99999, "../x": 2 } });
  assert.deepEqual(value.officeSeats, { a: 0 });
});
