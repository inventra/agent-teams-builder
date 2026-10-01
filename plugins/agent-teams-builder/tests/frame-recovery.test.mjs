import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { embedRuntimeNeedsRefresh, reconcileDashboardFrame, sourceBundle } from "../src/codex-embed.mjs";

test("web-only changes invalidate the injected page, while unchanged assets remain stable", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-web-revision-"));
  const injectionPath = path.join(temporary, "inject.js"), webDirectory = path.join(temporary, "web");
  fs.mkdirSync(webDirectory);
  fs.writeFileSync(injectionPath, "isolated injection fixture");
  fs.writeFileSync(path.join(webDirectory, "app.js"), 'let selected = "all";');
  fs.writeFileSync(path.join(webDirectory, "styles.css"), "body{color:black}");
  try {
    const before = sourceBundle({ injectionPath, webDirectory });
    assert.equal(sourceBundle({ injectionPath, webDirectory }).sourceHash, before.sourceHash);
    fs.writeFileSync(path.join(webDirectory, "app.js"), 'let selected = "docs";');
    const after = sourceBundle({ injectionPath, webDirectory });
    assert.notEqual(after.sourceHash, before.sourceHash, "a new default homepage must replace the old iframe");
    assert.equal(after.source, before.source, "the injector itself is unchanged in this regression");
    assert.equal(embedRuntimeNeedsRefresh({ mode: "codex-sidebar", ...before }, after), true);
    fs.writeFileSync(path.join(webDirectory, "styles.css"), "body{color:white}");
    const styled = sourceBundle({ injectionPath, webDirectory });
    assert.notEqual(styled.sourceHash, after.sourceHash);
    fs.writeFileSync(path.join(webDirectory, "icons.js"), "export const icon = () => '<svg></svg>'; ");
    assert.notEqual(sourceBundle({ injectionPath, webDirectory }).sourceHash, styled.sourceHash,
      "adding a new local icon module must also invalidate the old document");
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("a transient frame load failure remains retryable on the next reconciliation", async () => {
  const record = { connection: {}, loadedFrameName: "" };
  let attempts = 0;
  const options = {
    readStatus: async () => ({ pageVisible: true, frameLoaded: false, frameName: "fixture-frame" }),
    loadFrame: async () => { if (++attempts === 1) throw new Error("fixture temporary load failure"); },
  };
  await assert.rejects(reconcileDashboardFrame(record, "http://127.0.0.1:12345", options), /temporary/);
  assert.equal(record.loadedFrameName, "", "failure must not acknowledge frame delivery");
  assert.equal(await reconcileDashboardFrame(record, "http://127.0.0.1:12345", options), true);
  assert.equal(attempts, 2);
  assert.equal(record.loadedFrameName, "fixture-frame");
  assert.equal(await reconcileDashboardFrame(record, "http://127.0.0.1:12345", options), false);
});

test("hidden pages and ready frames are not rewritten", async () => {
  for (const status of [
    { pageVisible: false, frameLoaded: false, frameName: "fixture-frame" },
    { pageVisible: true, frameLoaded: true, frameName: "fixture-frame" },
  ]) {
    const record = { connection: {}, loadedFrameName: "" };
    assert.equal(await reconcileDashboardFrame(record, "http://127.0.0.1:12345", {
      readStatus: async () => status,
      loadFrame: async () => assert.fail("must not rewrite an inactive or ready frame"),
    }), false);
  }
});

test("launcher detects updated injection, bridge code, and dashboard binding", () => {
  const current = { sourceHash: "injection-2", bridgeSourceHash: "bridge-2", dashboardUrl: "http://127.0.0.1:12345/?token=fixture" };
  const runtime = { mode: "codex-sidebar", ...current };
  assert.equal(embedRuntimeNeedsRefresh(runtime, current), false);
  assert.equal(embedRuntimeNeedsRefresh({ ...runtime, sourceHash: "old-injection" }, current), true);
  assert.equal(embedRuntimeNeedsRefresh({ ...runtime, bridgeSourceHash: undefined }, current), true);
  assert.equal(embedRuntimeNeedsRefresh({ ...runtime, bridgeSourceHash: "old-bridge" }, current), true);
  assert.equal(embedRuntimeNeedsRefresh({ ...runtime, dashboardUrl: "http://127.0.0.1:12346/" }, current), true);
});

test("missing runtime and external-browser fallbacks are not treated as live sidebar daemons", () => {
  const current = { sourceHash: "injection-2", bridgeSourceHash: "bridge-2" };
  assert.equal(embedRuntimeNeedsRefresh(null, current), false);
  assert.equal(embedRuntimeNeedsRefresh({ mode: "codex-browser-panel" }, current), false);
});
