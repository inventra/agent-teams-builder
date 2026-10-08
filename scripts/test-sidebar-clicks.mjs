// Exercises the real injector in isolated HTML, never the Codex App or its CDP port.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(process.env.WORKBENCH_BROWSER_PACKAGE_ROOT ||
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json"));
const { chromium } = require("playwright");
const injection = fs.readFileSync(path.join(repo, "plugins/agent-teams-builder/inject/vixo-agents.user.js"), "utf8");
const browser = await chromium.launch({ headless: true, executablePath: process.env.WORKBENCH_CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const checks = [];
const errors = [];
const server = http.createServer((request, response) => response.end("<!doctype html><html><body></body></html>"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const rail = (id, attributes = "") => '<nav id="' + id + '" data-app-navigation-rail ' + attributes + '>' +
  '<button data-sidebar-destination="builtin:codex" aria-label="Codex 首頁"><svg></svg><span class="sr-only">Codex</span></button>' +
  '<button data-sidebar-destination="builtin:projects" aria-label="專案"><svg></svg><span class="sr-only">專案</span></button></nav>';
const surface = (id, attributes = "") => '<main id="' + id + '" data-app-shell-main-surface="default" ' + attributes + '>' +
  '<header>合成宿主畫面，不是真實 Codex</header><div data-app-shell-main-content-layout="thread"><div>合成對話</div></div></main>';
async function fixture(body) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.setContent('<!doctype html><html><head><style>' +
    'body{margin:0;display:flex;height:100vh}nav{width:65px;display:flex;flex-direction:column;gap:10px}' +
    'button{width:50px;height:50px}main{flex:1;position:relative;min-width:0;height:100vh}' +
    '[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}' +
    '</style></head><body>' + body + '</body></html>');
  await page.addScriptTag({ content: 'window.__VIXO_AGENTS_DASHBOARD_URL__="http://127.0.0.1:47824/?token=fixture-only";' +
    'window.__VIXO_AGENTS_SOURCE_HASH__="fixture-only";' + injection });
  return page;
}
try {
  let page = await fixture(rail("active-rail") + surface("active-surface"));
  const entry = page.getByRole("button", { name: "開啟 VIXO Agents", exact: true });
  await entry.click();
  assert.equal(await page.locator("#vixo-agents-codex-page").isVisible(), true, "click must open the page");
  assert.deepEqual(await page.evaluate(() => {
    const status = window.__vixoAgentsInjection__.status();
    return [status.entryVisible, status.mountAvailable, status.pageVisible];
  }), [true, true, true]);
  await page.getByRole("button", { name: "Codex 首頁", exact: true }).click();
  assert.equal(await page.locator("#vixo-agents-codex-page").isVisible(), false);
  await entry.click();
  assert.equal(await page.locator("#vixo-agents-codex-page").isVisible(), true);
  checks.push("visible rail entry opens, closes and reopens by actual pointer clicks");
  await page.close();

  page = await fixture(rail("stale-rail", "hidden") + rail("active-rail") + surface("active-surface"));
  assert.equal(await page.locator("#active-rail #vixo-agents-sidebar-entry").count(), 1,
    "icon must mount in the visible rail, not an inactive shell");
  await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).click();
  assert.equal(await page.locator("#active-surface #vixo-agents-codex-page").isVisible(), true,
    "click must mount in the active main surface");
  checks.push("hidden stale navigation cannot capture the icon");
  await page.close();

  page = await fixture(rail("active-rail") + surface("stale-surface", "hidden") + surface("active-surface"));
  await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).click();
  assert.equal(await page.locator("#active-surface #vixo-agents-codex-page").isVisible(), true,
    "page must not mount in a hidden viewport");
  checks.push("hidden stale viewport cannot capture the page");
  await page.close();

  page = await fixture(rail("active-rail") + surface("active-surface"));
  await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).click();
  await page.evaluate(() => {
    const nav = document.querySelector("#active-rail");
    nav.innerHTML = '<button data-sidebar-destination="builtin:projects" aria-label="專案"><svg></svg><span class="sr-only">專案</span></button>';
    const old = document.querySelector("#active-surface");
    const next = document.createElement("main");
    next.id = "active-surface";
    next.setAttribute("data-app-shell-main-surface", "default");
    next.innerHTML = '<div data-app-shell-main-content-layout="thread">重新渲染的合成對話</div>';
    old.replaceWith(next);
  });
  await page.locator("#active-rail #vixo-agents-sidebar-entry").waitFor({ state: "visible" });
  await page.locator("#active-surface #vixo-agents-codex-page").waitFor({ state: "visible" });
  assert.equal(await page.locator("#vixo-agents-sidebar-entry").count(), 1);
  await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).click();
  checks.push("native shell rerender restores one clickable entry and the open page");
  const frame = page.frames().find((item) => item.name().startsWith("vixo-agents-"));
  await frame.setContent('<!doctype html><html><body><h1>合成 Docs 內容</h1><script>parent.postMessage({type:"vixo-agents:ready",requestId:' + JSON.stringify(frame.name()) + '},"*")</script></body></html>');
  await page.waitForFunction(() => window.__vixoAgentsInjection__.status().frameLoaded);
  assert.equal(await page.frameLocator("#vixo-agents-codex-frame").getByRole("heading", { name: "合成 Docs 內容" }).isVisible(), true);
  checks.push("isolated sandbox frame becomes visibly ready (mock frame loader, not desktop E2E)");
  await page.close();

  const lazySource = fs.readFileSync(process.env.LAZYOFFICE_INJECTION_FIXTURE_SOURCE ||
    path.join(os.homedir(), "Desktop/LazyOffice/lazyoffice agent/plugins/lazyoffice-agent-teams/inject/lazyoffice-agents.user.js"), "utf8");
  page = await fixture(rail("active-rail") + surface("active-surface"));
  await page.addScriptTag({ content: 'window.__LAZYOFFICE_AGENTS_DASHBOARD_URL__="http://127.0.0.1:47825/?token=fixture-only";' +
    'window.__LAZYOFFICE_AGENTS_SOURCE_HASH__="fixture-only";' + lazySource });
  const order = () => page.locator("#active-rail > [data-vixo-agents-owned], #active-rail > [data-lazyoffice-agents-owned]")
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  assert.deepEqual(await order(), ["vixo-agents-sidebar-entry", "lazyoffice-agents-sidebar-entry"]);
  await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).click();
  assert.equal(await page.locator("#vixo-agents-codex-page").isVisible(), true);
  await page.getByRole("button", { name: "開啟 LazyOffice Agents", exact: true }).click();
  assert.equal(await page.locator("#vixo-agents-codex-page").isVisible(), false);
  assert.equal(await page.locator("#lazyoffice-agents-codex-page").isVisible(), true);
  await page.getByRole("button", { name: "開啟 VIXO Agents", exact: true }).click();
  assert.equal(await page.locator("#vixo-agents-codex-page").isVisible(), true);
  assert.equal(await page.locator("#lazyoffice-agents-codex-page").isVisible(), false);
  await page.waitForTimeout(350);
  assert.deepEqual(await order(), ["vixo-agents-sidebar-entry", "lazyoffice-agents-sidebar-entry"]);
  checks.push("VIXO and LazyOffice coexist in fixed order and switch without overlapping pages");
  await page.getByRole("button", { name: "開啟 LazyOffice Agents", exact: true }).click();
  await page.evaluate(() => window.__vixoAgentsInjection__.open());
  assert.equal(await page.locator("#vixo-agents-codex-page").isVisible(), true,
    "launcher-style programmatic open must show VIXO while LazyOffice is active");
  assert.equal(await page.evaluate(() => window.__lazyofficeAgentsInjection__.status().pageVisible), false,
    "the other plugin page must be closed, not merely hidden by a second overlay");
  await page.evaluate(() => window.__lazyofficeAgentsInjection__.open());
  await page.locator("#lazyoffice-agents-codex-page").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => window.__vixoAgentsInjection__.status().pageVisible), false);
  checks.push("launcher-style opens switch both ways without mutually hidden overlays");
  await page.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, fixtureOnly: true }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ pageErrors: errors, completedChecks: checks }, null, 2));
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
