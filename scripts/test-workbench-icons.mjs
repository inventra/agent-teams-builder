// Own isolated Dashboard + synthetic employee only; never connects to desktop CDP.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../plugins/agent-teams-builder/src/dashboard-server.mjs";
import { createPreview, commitPreview, getAgent } from "../plugins/agent-teams-builder/src/store.mjs";
import { listPublicSkills } from "../plugins/agent-teams-builder/src/public-skills.mjs";
import { workbenchState } from "../plugins/agent-teams-builder/src/workbench-store.mjs";
import { M365SyncStore } from "../plugins/agent-teams-builder/src/m365-sync.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(process.env.WORKBENCH_BROWSER_PACKAGE_ROOT ||
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json"));
const { chromium } = require("playwright");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-icons-test-"));
const previousRoot = process.env.AGENT_TEAMS_HOME;
process.env.AGENT_TEAMS_HOME = temporary;
const preview = createPreview({ action: "create", spec: {
  id: "icon-fixture", displayName: "圖示測試員工", description: "隔離測試，不是真實員工", purpose: "測試圖示",
  systemPrompt: "只用於隔離測試", memory: "無", aliases: [],
  skills: [{ id: "icon-skill", name: "測試技能", description: "圖示測試", triggers: ["測試"], allowedTools: [],
    steps: ["檢查圖示"], successCriteria: ["可見"] }],
  workflows: [{ id: "icon-flow", name: "測試流程", description: "不執行此流程", triggers: ["測試"],
    nodes: [{ id: "icon-node", name: "檢查", type: "skill", skillId: "icon-skill", instructions: "只用於測試" }] }]
} });
commitPreview({ token: preview.token, userConfirmation: "確認" });
const fixtureAgent = { ...getAgent("icon-fixture"), id: "legacy:icon-fixture", source: "local", syncMode: "local-only", syncState: "local", assetId: null };
const fixtureSession = { connected: true, user: { id: "isolated-icon-user", username: "icon_fixture", accountConfigured: true }, access: { userId: "isolated-icon-user", status: "approved", isAdmin: false }, offline: false, source: "hybrid" };
const fixtureState = { agents: [fixtureAgent], library: [{ id: fixtureAgent.id, kind: "agent", title: fixtureAgent.displayName, syncMode: "local-only", syncState: "local", assetId: null }], publicSkills: listPublicSkills(), sync: { pendingCount: 0, conflictCount: 0 }, hosts: { codex: true, claude: false }, codexProjects: [], runs: [], schedules: [], update: null };
const fixtureM365 = new M365SyncStore(temporary);
let preferences = {};
const { server, token } = createDashboardServer({ token: "isolated-icon-test" });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.WORKBENCH_CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], external = [], unexpectedApi = [], checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (["data:", "blob:"].includes(url.protocol)) return route.continue();
  if (url.origin !== base) { external.push(url.origin); return route.abort(); }
  // This visual fixture bypasses cloud authentication only in the browser's
  // synthetic API. No real session, cloud request or business action is used.
  const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  if (url.pathname === "/api/session") return json(fixtureSession);
  if (url.pathname === "/api/state") return json(fixtureState);
  if (url.pathname === "/api/sync") return json({ state: "idle" });
  if (url.pathname === "/api/workbench") return json(workbenchState(temporary, { agents: [fixtureAgent], schedules: [], period: url.searchParams.get("period") || "today" }));
  if (url.pathname === "/api/m365/status") return json(fixtureM365.status(fixtureSession.user.id));
  if (url.pathname === "/api/preferences/workbench") {
    if (route.request().method() === "POST") preferences = route.request().postDataJSON();
    return json(preferences);
  }
  if (url.pathname.startsWith("/api/")) { unexpectedApi.push(url.pathname); return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Unexpected fixture API" }) }); }
  return route.continue();
});
async function visibleIcons(selector, minimum) {
  const nodes = page.locator(selector);
  assert.ok(await nodes.count() >= minimum, selector + " missing elements");
  const missing = await nodes.evaluateAll((elements) => elements.flatMap((element) => {
    const svg = element.querySelector("svg.vixo-icon");
    const box = svg?.getBoundingClientRect(), style = svg && getComputedStyle(svg);
    return !svg || !svg.querySelector("path,rect,circle,line,ellipse,polyline") || box.width < 14 || box.height < 14 ||
      style.display === "none" || style.visibility !== "visible" || style.stroke === "none" ||
      svg.getAttribute("aria-hidden") !== "true" || svg.getAttribute("focusable") !== "false"
      ? [(element.getAttribute("aria-label") || element.textContent).trim().slice(0, 70)] : [];
  }));
  assert.deepEqual(missing, [], "missing/hidden SVG icons in " + selector);
}
try {
  await page.goto(base + "/?token=" + token);
  await page.locator('[data-id="docs"]').click();
  await page.locator(".wb-core").waitFor();
  await visibleIcons("#agent-nav button", 9);
  await visibleIcons(".wb-card-icon", 9);
  await visibleIcons('.wb-toolbar button,.wb-search-label,[data-wb="layout"],.wb-drag,.wb-resize,.wb-card-head>.wb-btn', 30);
  checks.push("local SVG icons in every sidebar entry, nine cards, toolbar, drag and resize controls");
  await page.locator('[data-wb="layout"]').click();
  await visibleIcons(".wb-layout-row h4", 9);
  await visibleIcons('.wb-layout-row button,.wb-layout-row label,#wb-layout .wb-dialog-heading button,[data-wb="card-add"]', 59);
  assert.equal(await page.locator('[data-wb="card-up"]').first().isDisabled(), true);
  const output = path.join(repo, "output", "local-first-verification");
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, "fixture-icons-layout.png") });
  await page.getByRole("button", { name: "關閉卡片配置", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#wb-layout").evaluate((node) => node.open), false);
  checks.push("configuration icons, disabled move control and keyboard dialog close");
  await page.locator('[data-wb="theme"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.wbTheme === "dark");
  await visibleIcons("#agent-nav button", 9);
  await visibleIcons(".wb-card-icon", 9);
  assert.notEqual(await page.locator('#agent-nav svg').first().evaluate((svg) => getComputedStyle(svg).stroke), "rgb(92, 102, 116)");
  await page.locator('[data-wb="layout"]').click();
  await visibleIcons(".wb-layout-row h4,.wb-layout-row button", 36);
  await page.getByRole("button", { name: "關閉卡片配置", exact: true }).click();
  checks.push("dark-theme currentColor icons and configuration");
  await page.locator('[data-view="office"]').click();
  await page.locator('.wb-person').click();
  await visibleIcons('#wb-detail [data-wb="play"],#wb-detail [data-wb="schedule"],#wb-detail [data-wb="favorite"],#wb-detail [data-wb="close-detail"]', 4);
  await page.getByRole("button", { name: "關閉詳情", exact: true }).click();
  await page.locator('[data-view="home"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await visibleIcons("#agent-nav button", 9);
  await visibleIcons(".wb-card-icon", 9);
  await page.locator('[data-wb="layout"]').click();
  await visibleIcons(".wb-layout-row h4,.wb-layout-row button", 36);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "narrow viewport overflows");
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], "icons must work without external fonts or CDN");
  assert.deepEqual(unexpectedApi, [], "every visual fixture API must be explicitly synthetic");
  checks.push("employee actions, 390px viewport and no external icon/font requests or JavaScript errors");
  console.log(JSON.stringify({ passed: checks.length, checks, fixtureOnly: true, desktopControlled: false }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  if (previousRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = previousRoot;
  fs.rmSync(temporary, { recursive: true, force: true });
}
