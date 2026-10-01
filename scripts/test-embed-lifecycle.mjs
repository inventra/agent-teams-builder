// Isolated Chromium only: never connects to the Codex desktop or its debugging port.
// Uses the production injector, production frame loader and real Dashboard assets.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../plugins/agent-teams-builder/src/dashboard-server.mjs";
import { buildInjectionSource, reconcileDashboardFrame } from "../plugins/agent-teams-builder/src/codex-embed.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(process.env.WORKBENCH_BROWSER_PACKAGE_ROOT ||
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json"));
const { chromium } = require("playwright");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-embed-lifecycle-"));
const oldRoot = process.env.AGENT_TEAMS_HOME;
process.env.AGENT_TEAMS_HOME = temporary;
const { server, token } = createDashboardServer({ token: "isolated-lifecycle-test" });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const dashboardUrl = "http://127.0.0.1:" + server.address().port + "/?token=" + token;
const surface = '<main data-app-shell-main-surface="default"><div class="workspace-content">' +
  '<div data-app-shell-main-content-layout="thread"><div>合成宿主，非 Codex 桌面</div></div></div></main>';
const hostHtml = '<!doctype html><html><head><style>' +
  'body{margin:0;display:flex;height:100vh}nav{width:65px;display:flex;flex-direction:column}' +
  'button{width:50px;height:50px}main{flex:1;display:flex;flex-direction:column;min-width:0;position:relative}' +
  '.workspace-content{display:flex;flex:1;min-height:0}[data-app-shell-main-content-layout]{flex:1}' +
  '[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}' +
  '</style></head><body><nav data-app-navigation-rail>' +
  '<button data-sidebar-destination="builtin:projects" aria-label="專案"><svg></svg><span class="sr-only">專案</span></button>' +
  '</nav>' + surface + '</body></html>';
const host = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8"); response.end(hostHtml);
});
await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
const hostUrl = "http://127.0.0.1:" + host.address().port;
const injection = buildInjectionSource(dashboardUrl,
  fs.readFileSync(path.join(repo, "plugins/agent-teams-builder/inject/vixo-agents.user.js"), "utf8"), "lifecycle-fixture");
const browser = await chromium.launch({ headless: true, executablePath: process.env.WORKBENCH_CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const passed = [], failures = [];
async function check(name, callback) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try { await callback(page, context, errors); passed.push(name); }
  catch (error) {
    const frame = page.frames().find((candidate) => candidate.name().startsWith("vixo-agents-"));
    failures.push({ name, error: error.message, pageErrors: errors,
      status: await page.evaluate(() => {
        const status = window.__vixoAgentsInjection__?.status?.();
        if (!status) return null;
        return { entryVisible: status.entryVisible, pageVisible: status.pageVisible, frameLoaded: status.frameLoaded };
      }),
      frameEmpty: frame ? await frame.evaluate(() => !document.body?.textContent?.trim()) : null,
      frameHeading: frame ? await frame.evaluate(() => document.querySelector("h1,h2")?.textContent || null) : null });
  }
  finally { await context.close(); }
}
async function assertEmbeddedIcons(frame) {
  await frame.locator(".wb-card").first().waitFor({ timeout: 3000 });
  assert.equal(await frame.locator(".wb-card-icon svg.vixo-icon").count(), 9);
  const invisible = await frame.locator("#agent-nav button,.wb-card-icon").evaluateAll((nodes) => nodes.filter((node) => {
    const svg = node.querySelector("svg.vixo-icon"), box = svg?.getBoundingClientRect();
    return !svg || box.width < 14 || box.height < 14 || getComputedStyle(svg).stroke === "none";
  }).map((node) => node.textContent.trim()));
  assert.deepEqual(invisible, [], "inline vectors must render in the real opaque sandbox document");
}
try {
  await check("document-start injection survives initial load and navigation", async (page, context, errors) => {
    // Page.addScriptToEvaluateOnNewDocument and addInitScript have the same early-DOM seam.
    await context.addInitScript({ content: injection });
    await page.goto(hostUrl);
    await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).waitFor({ timeout: 1800 });
    await page.goto(hostUrl + "/next");
    await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).waitFor({ timeout: 1800 });
    assert.deepEqual(errors, []);
  });
  await check("real about:blank document delivery loads Docs and survives host replacement", async (page, context, errors) => {
    await page.goto(hostUrl);
    const session = await context.newCDPSession(page); // Our private test browser, not the desktop App.
    await session.send("Page.enable");
    await session.send("Page.setBypassCSP", { enabled: true });
    await page.addScriptTag({ content: injection });
    await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).click();
    const record = { connection: session };
    await reconcileDashboardFrame(record, dashboardUrl);
    await page.waitForFunction(() => window.__vixoAgentsInjection__.status().frameLoaded, null, { timeout: 3000 });
    const embedded = page.frameLocator("#vixo-agents-codex-frame");
    // Opening VIXO must land directly on the new homepage, without a Docs click.
    await embedded.locator(".wb-card").first().waitFor({ timeout: 3000 });
    assert.equal(await embedded.locator(".wb-card").count(), 9);
    await assertEmbeddedIcons(embedded);
    assert.deepEqual(errors, []);
    const oldFrameName = await page.evaluate(() => window.__vixoAgentsInjection__.status().frameName);
    await page.evaluate((html) => {
      const fragment = document.createElement("div"); fragment.innerHTML = html;
      document.querySelector("main").replaceWith(fragment.firstElementChild);
    }, surface);
    await page.locator("#vixo-agents-codex-page").waitFor({ state: "visible", timeout: 1800 });
    assert.notEqual(await page.evaluate(() => window.__vixoAgentsInjection__.status().frameName), oldFrameName);
    assert.equal(await page.evaluate(() => window.__vixoAgentsInjection__.status().frameLoaded), false);
    await reconcileDashboardFrame(record, dashboardUrl);
    // The frame document must still be there, not an empty about:blank claiming ready.
    await embedded.getByRole("button", { name: "Docs 首頁與像素工作台", exact: true }).waitFor({ timeout: 1800 });
    await assertEmbeddedIcons(embedded);
    assert.deepEqual(errors, []);
  });
  await check("same bridge connection recovers real Docs through repeated document reloads", async (page, context, errors) => {
    await context.addInitScript({ content: injection });
    const session = await context.newCDPSession(page);
    await session.send("Page.enable");
    await session.send("Page.setBypassCSP", { enabled: true });
    const record = { connection: session };
    let oldFrameName = "";
    for (let iteration = 0; iteration < 3; iteration++) {
      await page.goto(hostUrl + "/reload-" + iteration);
      await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).click();
      assert.equal(await page.locator("#vixo-agents-sidebar-entry").count(), 1);
      assert.equal(await reconcileDashboardFrame(record, dashboardUrl), true);
      await page.waitForFunction(() => window.__vixoAgentsInjection__.status().frameLoaded, null, { timeout: 3000 });
      const name = await page.evaluate(() => window.__vixoAgentsInjection__.status().frameName);
      assert.notEqual(name, oldFrameName); oldFrameName = name;
      const embedded = page.frameLocator("#vixo-agents-codex-frame");
      // A full renderer reload must also land on the new homepage by default.
      await embedded.locator(".wb-card").first().waitFor({ timeout: 3000 });
      assert.equal(await embedded.locator(".wb-card").count(), 9);
      await assertEmbeddedIcons(embedded);
      await page.getByRole("button", { name: "專案", exact: true }).click();
      assert.equal(await page.locator("#vixo-agents-codex-page").isVisible(), false);
      await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).click();
      assert.equal(await reconcileDashboardFrame(record, dashboardUrl), false, "reopen must keep the ready document");
      assert.equal(await embedded.locator(".wb-card").count(), 9);
    }
    assert.deepEqual(errors, []);
  });
  console.log(JSON.stringify({ passed, failures, isolatedBrowserOnly: true }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => host.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  if (oldRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = oldRoot;
  fs.rmSync(temporary, { recursive: true, force: true });
}
