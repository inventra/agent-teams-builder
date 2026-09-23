import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInjectionSource,
  isCodexRendererTarget,
  isLoopbackDashboardUrl,
  parseDebuggingPorts,
} from "../src/codex-embed.mjs";

test("Codex CDP ports are parsed, validated, and deduplicated", () => {
  assert.deepEqual(
    parseDebuggingPorts("ChatGPT --remote-debugging-port=55064\nCodex --remote-debugging-port 9231\nRenderer --remote-debugging-port=55064"),
    [55064, 9231],
  );
  assert.deepEqual(parseDebuggingPorts("--remote-debugging-port=99999"), []);
});

test("only the primary Codex app renderer is injectable", () => {
  const base = { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1" };
  assert.equal(isCodexRendererTarget({ ...base, url: "app://-/index.html" }), true);
  assert.equal(isCodexRendererTarget({ ...base, url: "app://-/index.html?initialRoute=%2Fdetached-window" }), false);
  assert.equal(isCodexRendererTarget({ ...base, url: "https://example.com" }), false);
  assert.equal(isCodexRendererTarget({ ...base, type: "webview", url: "app://-/index.html" }), false);
});

test("dashboard embedding accepts loopback only and quotes injected values", () => {
  assert.equal(isLoopbackDashboardUrl("http://127.0.0.1:47824/?token=abc"), true);
  assert.equal(isLoopbackDashboardUrl("https://localhost:47824/"), true);
  assert.equal(isLoopbackDashboardUrl("https://agents.example.com/"), false);
  const source = buildInjectionSource("http://127.0.0.1:47824/?token=a%22b", "window.test = true;", "hash");
  assert.match(source, /__VIXO_AGENTS_DASHBOARD_URL__/);
  assert.match(source, /window\.test = true/);
  assert.match(source, /sourceURL=vixo-agents\.user\.js/);
  assert.throws(() => buildInjectionSource("https://example.com", "", "hash"), /loopback/);
});
