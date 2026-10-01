// Isolated UI regression: synthetic Agents and fake CLI only. Never launches user workflows.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../plugins/agent-teams-builder/src/dashboard-server.mjs";
import { createPreview, commitPreview } from "../plugins/agent-teams-builder/src/store.mjs";
import { defaultPreferences } from "../plugins/agent-teams-builder/web/workbench-model.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(process.env.WORKBENCH_BROWSER_PACKAGE_ROOT ||
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json"));
const { chromium } = require("playwright");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-workbench-browser-"));
const oldRoot = process.env.AGENT_TEAMS_HOME, oldPath = process.env.PATH, oldCodexHome = process.env.CODEX_HOME;
const checks = [], screenshots = path.join(repo, "docs", "screenshots");
fs.mkdirSync(screenshots, { recursive: true });
process.env.AGENT_TEAMS_HOME = temporary;
process.env.CODEX_HOME = path.join(temporary, "codex-home");
fs.mkdirSync(process.env.CODEX_HOME);
fs.writeFileSync(path.join(process.env.CODEX_HOME, ".codex-global-state.json"), JSON.stringify({
  "local-projects": { "fixture-project": { name: "隔離測試工作區", rootPaths: [temporary] } },
  "project-order": ["fixture-project"]
}));
function addAgent(id, name) {
  const preview = createPreview({ action: "create", spec: {
    id, displayName: name, description: "隔離測試角色，不是真實員工", purpose: "UI 模擬測試",
    systemPrompt: "此角色只用於隔離測試。", memory: "無", aliases: [],
    skills: [{ id: "fixture-skill", name: "測試技能", description: "只測試 UI", triggers: ["測試"],
      allowedTools: [], steps: ["整理測試"], successCriteria: ["完成測試"] }],
    workflows: [{ id: "fixture-flow", name: "測試流程", description: "隔離測試流程", triggers: ["測試"], nodes: [
      { id: "fixture-node", name: "整理測試", type: "skill", skillId: "fixture-skill", instructions: "只處理測試" },
      { id: "approval-node", name: "人工確認", type: "approval", instructions: "等待確認", requiresApproval: true }
    ] }]
  } });
  commitPreview({ token: preview.token, userConfirmation: "確認" });
}
addAgent("fixture-a", "測試甲"); addAgent("fixture-b", "測試乙");
fs.writeFileSync(path.join(temporary, "installation-report.json"), JSON.stringify({ results: { codex: { installed: true } } }));
const bin = path.join(temporary, "bin");
fs.mkdirSync(bin);
const fake = path.join(bin, "fake-codex.mjs");
fs.writeFileSync(fake, [
  'import fs from "node:fs";',
  'const args=process.argv.slice(2);let prompt="";process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",chunk=>prompt+=chunk);process.stdin.on("end",()=>{',
  'const resumed=args.includes("resume");',
  'const message=!resumed&&prompt.includes("TEST_WAIT_INPUT")?"請提供測試資料\\nVIXO_RUN_STATE: WAITING_INPUT":',
  '!resumed&&prompt.includes("[approval]")?"請核准\\nVIXO_RUN_STATE: WAITING_APPROVAL:approval-node":"測試完成\\nVIXO_RUN_STATE: COMPLETED";',
  'const index=args.indexOf("-o");if(index>=0)fs.writeFileSync(args[index+1],message);',
  'console.log(JSON.stringify({thread_id:"11111111-1111-4111-8111-111111111111"}));});'
].join("\n"));
fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexec node " + JSON.stringify(fake) + ' "$@"\n');
fs.chmodSync(path.join(bin, "codex"), 0o755);
process.env.PATH = bin + path.delimiter + oldPath;
const runsRoot = path.join(temporary, ".system", "runs");
fs.mkdirSync(runsRoot, { recursive: true });
function seedRun(id, status, extra = {}) {
  fs.writeFileSync(path.join(runsRoot, id + ".json"), JSON.stringify({
    id, agentId: "fixture-a", agentName: "測試甲", workflowId: "fixture-flow", workflowName: "測試流程",
    host: "codex", task: "隔離測試", status, startedAt: new Date().toISOString(),
    approvalMode: "manual", approvalNodes: [{ id: "approval-node", name: "人工確認" }], approvalIndex: 0,
    pendingNodeId: "approval-node", pendingNodeName: "人工確認",
    sessionId: "11111111-1111-4111-8111-111111111111", agentDirectory: path.join(temporary, "fixture-a"),
    logFile: path.join(runsRoot, id + ".log"), ...extra
  }));
}
seedRun("fixture-approval", "waiting-approval");
seedRun("fixture-reject", "waiting-approval");
seedRun("fixture-input", "waiting-input");
seedRun("fixture-native", "opened-in-codex", { executionMode: "codex-app", lastMessage: "已建立任務，不代表完成" });
seedRun("fixture-failed", "failed", { error: "範例錯誤 <img src=x onerror=alert(1)>", lastMessage: null });
for (let i = 0; i < 35; i++) seedRun("fixture-completed-" + i, "completed", { lastMessage: "隔離測試成功" });

const { server, token } = createDashboardServer({ token: "isolated-browser-test" });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const api = async (url, options = {}) => {
  const response = await fetch(base + url, { ...options, headers });
  assert.ok(response.ok, url + " HTTP " + response.status);
  return response.json();
};
const browser = await chromium.launch({ headless: true, executablePath: process.env.WORKBENCH_CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const poll = async (predicate, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error("Timed out waiting for fixture state");
};
const openDocs = async () => {
  await page.getByRole("button", { name: "Docs 首頁與像素工作台", exact: true }).click();
  await page.locator(".wb-core").waitFor();
};
const showSeed = async (id) => {
  await page.locator('[data-wb="run"][data-id="' + id + '"]').first().click();
  await page.locator("#wb-detail").waitFor();
};
try {
  await page.goto(base + "/?token=" + token);
  await page.locator(".wb-core").waitFor();
  assert.equal(await page.locator('#agent-nav [data-id="docs"]').getAttribute("class"), "nav-item active");
  assert.equal(await page.locator("main>header").isVisible(), false);
  checks.push("fresh VIXO entry defaults to Docs, not the legacy employee overview");
  assert.equal(await page.locator(".wb-card").count(), 9);
  assert.equal((await api("/api/workbench")).summary.completedRuns, 35);
  checks.push("nine cards, complete >30 aggregation, native launch not completed");
  await page.screenshot({ path: path.join(screenshots, "fixture-home.png"), fullPage: true });

  await showSeed("fixture-approval");
  await page.locator("#wb-run-message").fill("確認測試，繼續");
  await page.waitForTimeout(5400);
  assert.equal(await page.locator("#wb-run-message").inputValue(), "確認測試，繼續");
  await page.getByRole("button", { name: "核准並繼續", exact: true }).click();
  await poll(async () => (await api("/api/runs/fixture-approval")).status === "completed");
  await page.getByRole("button", { name: "重新整理", exact: true }).click();
  await showSeed("fixture-input"); await page.locator("#wb-run-message").fill("資料已補充");
  await page.getByRole("button", { name: "回覆並繼續", exact: true }).click();
  await poll(async () => (await api("/api/runs/fixture-input")).status === "completed");
  await page.getByRole("button", { name: "重新整理", exact: true }).click();
  await showSeed("fixture-reject"); await page.locator("#wb-run-message").fill("拒絕測試");
  await page.getByRole("button", { name: "拒絕／停止", exact: true }).click();
  await poll(async () => (await api("/api/runs/fixture-reject")).status === "rejected");
  checks.push("approval / reply / reject UI + preserving typed response across polling");

  await page.locator('[data-wb="play"][data-agent="fixture-a"]').first().click();
  await page.locator('#run-form [name="task"]').fill("TEST_WAIT_INPUT");
  await page.waitForTimeout(5400);
  assert.equal(await page.locator('#run-form [name="task"]').inputValue(), "TEST_WAIT_INPUT");
  await page.getByRole("button", { name: "開始執行", exact: true }).click();
  await poll(async () => (await api("/api/workbench")).runs.some((run) => run.task === "TEST_WAIT_INPUT" && run.status === "waiting-input"));
  checks.push("Play runs fake CLI and preserves form across polling");

  await page.getByRole("button", { name: "像素辦公室", exact: true }).click();
  await page.getByRole("button", { name: "查看 測試甲 詳情", exact: true }).click();
  await page.getByRole("button", { name: "設定每日排程", exact: true }).click();
  await page.locator('#schedule-form [name="time"]').fill("09:35");
  await page.locator('#schedule-form [name="task"]').fill("只測試排程保存，不執行");
  await page.getByRole("button", { name: "儲存排程", exact: true }).click();
  await poll(async () => (await api("/api/state")).schedules.some((item) => item.time === "09:35"));
  checks.push("pixel employee details and daily schedule persistence");
  const before = await page.locator(".wb-person").evaluateAll((nodes) => nodes.map((node) => [node.dataset.id, node.style.left, node.style.top]));
  addAgent("fixture-c", "測試丙");
  await page.getByRole("button", { name: "重新整理", exact: true }).click();
  await page.getByRole("button", { name: "查看 測試丙 詳情", exact: true }).waitFor();
  const after = await page.locator(".wb-person").evaluateAll((nodes) => nodes.map((node) => [node.dataset.id, node.style.left, node.style.top]));
  assert.deepEqual(after.filter((row) => row[0] !== "fixture-c"), before);
  assert.equal(await page.locator(".wb-person").count(), 3);
  checks.push("new Agent appears automatically; existing seats remain stable");

  await page.getByRole("button", { name: "L1　首頁總覽", exact: true }).click();
  await page.getByRole("button", { name: "自訂首頁", exact: true }).click();
  const first = page.locator(".wb-layout-row").first();
  await first.locator('[data-setting="width"]').selectOption("6");
  await first.locator('[data-setting="height"]').selectOption("4");
  await first.locator('[data-setting="tint"]').selectOption("violet");
  await page.getByRole("button", { name: "向後移動 今日工作", exact: true }).click();
  await page.getByRole("button", { name: "會議紀錄", exact: true }).click();
  await page.getByRole("button", { name: "關閉卡片配置", exact: true }).click();
  await page.getByRole("button", { name: "切換明暗主題", exact: true }).click();
  await poll(async () => (await api("/api/preferences/workbench")).theme === "dark");
  await page.reload(); await openDocs();
  assert.equal(await page.locator(".wb-card").count(), 10);
  assert.equal(await page.locator(".wb-card").first().getAttribute("data-card"), "agents");
  assert.equal(await page.locator('[data-card="today"].wb-card').getAttribute("style"), "--wb-width:6;--wb-height:4");
  assert.equal(await page.locator("html").getAttribute("data-wb-theme"), "dark");
  const sourceCard = page.locator('[data-card="today"].wb-card');
  await sourceCard.locator(".wb-drag").dragTo(page.locator('[data-card="approvals"].wb-card'));
  await poll(async () => (await api("/api/preferences/workbench")).cards.findIndex((card) => card.id === "today") === 2);
  await sourceCard.locator(".wb-resize").scrollIntoViewIfNeeded();
  const resizeHandle = await sourceCard.locator(".wb-resize").boundingBox();
  await page.mouse.move(resizeHandle.x + resizeHandle.width / 2, resizeHandle.y + resizeHandle.height / 2);
  await page.mouse.down(); await page.mouse.move(resizeHandle.x + resizeHandle.width / 2 + 85, resizeHandle.y + resizeHandle.height / 2 + 84);
  await page.mouse.up();
  await poll(async () => {
    const card = (await api("/api/preferences/workbench")).cards.find((item) => item.id === "today");
    return card.width === 7 && card.height === 5;
  });
  await page.getByRole("searchbox").fill("fixture-a");
  assert.ok(await page.getByRole("button", { name: "測試甲", exact: true }).count() > 0);
  await page.getByRole("searchbox").fill('<img src=x onerror=alert(1)>');
  assert.equal(await page.locator("#wb-stage img").count(), 0);
  await page.getByRole("searchbox").fill("");
  checks.push("card sizing / tint / reorder / add persist; physical drag / pointer resize; search and XSS safety");

  await page.getByRole("button", { name: "L2　功能層", exact: true }).click();
  assert.equal(await page.locator(".wb-feature").count(), 15);
  await page.getByRole("button", { name: "L3　系統層", exact: true }).click();
  assert.equal(await page.locator(".wb-unavailable").count(), 8);
  await page.getByRole("button", { name: "像素辦公室", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshots, "fixture-mobile-office.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "員工總覽 3 位員工", exact: true }).click();
  assert.equal(await page.locator("#workbench").isVisible(), false);
  await page.getByRole("button", { name: "Docs 首頁與像素工作台", exact: true }).click();
  await page.locator(".wb-person").first().waitFor();
  checks.push("15-module roadmap, honest integrations, responsive office, return/reopen");

  // Mock the existing desktop bridge in a separate iframe. No Codex app is controlled.
  const embedded = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await api("/api/preferences/workbench", { method: "POST", body: JSON.stringify(defaultPreferences()) });
  await embedded.setContent('<iframe sandbox="allow-scripts allow-forms allow-modals allow-downloads" style="width:1400px;height:950px" src="' + base + '/?token=' + token + '"></iframe>');
  await embedded.evaluate(() => {
    window.addEventListener("message", (event) => {
      if (event.data?.type === "vixo-agents:create-codex-thread") {
        event.source.postMessage({ type: "vixo-agents:thread-created", payload: {
          runId: event.data.payload.runId, threadId: "22222222-2222-4222-8222-222222222222"
        } }, "*");
      }
    });
  });
  const frame = embedded.frameLocator("iframe");
  await frame.getByRole("button", { name: "Docs 首頁與像素工作台", exact: true }).click();
  await frame.locator('[data-wb="play"][data-agent="fixture-a"]').first().click();
  await frame.locator('#run-form [name="task"]').fill("原生任務橋接測試");
  await frame.getByRole("button", { name: "開始執行", exact: true }).click();
  await poll(async () => (await api("/api/workbench")).runs.some((run) => run.task === "原生任務橋接測試" && run.status === "opened-in-codex"));
  checks.push("native iframe message protocol + truthful opened-in-codex status (mock bridge)");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, pageErrors: errors, screenshots, fixtureOnly: true }, null, 2));
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve));
  if (oldRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = oldRoot;
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
  process.env.PATH = oldPath;
  fs.rmSync(temporary, { recursive: true, force: true });
}
