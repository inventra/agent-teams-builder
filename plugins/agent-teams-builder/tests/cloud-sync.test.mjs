import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPreview, commitPreview, getAgent } from "../src/store.mjs";
import { BUNDLE_LIMITS, bundleHash, cloudBundleStorageBytes, exportAgentBundle, exportSkillBundle, exportWorkflowBundle, exportSpecBundle, validateCloudBundle } from "../src/cloud-bundle.mjs";
import { createCloudSync } from "../src/cloud-sync.mjs";
import { createCloudClient } from "../web/cloud-client.mjs";

function spec() {
  return { id: "reviewer", displayName: "審閱員", aliases: ["小雲"], description: "來源整理", purpose: "依來源整理內容", systemPrompt: "按使用者授權處理，不自行提交。", memory: "私人長期記憶，不應共享。",
    skills: [
      { id: "summarize", name: "整理資料", description: "整理來源", triggers: ["整理"], allowedTools: ["Browser"], steps: ["讀取來源", "核對內容"], successCriteria: ["可核對來源"] },
      { id: "compare", name: "比較", description: "比較來源", triggers: ["比較"], allowedTools: [], steps: ["列出差異"], successCriteria: ["保留差異"] }
    ], workflows: [{ id: "review-flow", name: "審閱流程", description: "先整理，再確認", triggers: [], nodes: [
      { id: "read", name: "整理", type: "skill", skillId: "summarize", instructions: "整理本次来源" },
      { id: "approval", name: "核准", type: "approval", instructions: "取得核准", requiresApproval: true }
    ] }] };
}
function tree(root) {
  return fs.readdirSync(root, { recursive: true }).sort().filter((relative) => fs.lstatSync(path.join(root, relative)).isFile()).map((relative) => [relative, fs.readFileSync(path.join(root, relative), "utf8")]);
}
let temporary, oldHome, privateDirectory, source, bundle;
test.beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-cloud-test-"));
  oldHome = process.env.AGENT_TEAMS_HOME;
  process.env.AGENT_TEAMS_HOME = path.join(temporary, "Private employees");
  const preview = createPreview({ action: "create", spec: spec() });
  const saved = commitPreview({ token: preview.token, userConfirmation: "確認" });
  privateDirectory = saved.directory;
  const resource = path.join(privateDirectory, "skills", "summarize");
  fs.mkdirSync(path.join(resource, "references"));
  fs.writeFileSync(path.join(resource, "references", "rules.md"), "Use the supplied source.");
  fs.appendFileSync(path.join(resource, "SKILL.md"), "\n[rules](references/rules.md)\n");
  fs.mkdirSync(path.join(resource, "scripts"));
  fs.writeFileSync(path.join(resource, "scripts", "helper.js"), "globalThis.cloudCodeExecuted = true;\n");
  fs.mkdirSync(path.join(resource, "runs"));
  fs.writeFileSync(path.join(resource, "runs", "request.json"), '{"bank_account":"private account"}');
  fs.writeFileSync(path.join(resource, ".env"), "PRIVATE_PASSWORD=never-export-this");
  fs.writeFileSync(path.join(resource, "MEMORY.md"), "Bearer private-token-01234567890123456789");
  source = getAgent("reviewer");
  bundle = exportAgentBundle({ agent: source, agentDirectory: privateDirectory });
});
test.afterEach(() => {
  if (oldHome === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = oldHome;
  fs.rmSync(temporary, { recursive: true, force: true });
  delete globalThis.cloudCodeExecuted;
});

function fakeCloud() {
  const state = { user: { id: "account-a", email: "test@example.invalid" }, assets: new Map(), revisions: new Map(), saved: [], error: null, shared: true };
  const client = {
    getUser: async () => state.user,
    getAsset: async (id) => {
      if (state.error) throw state.error;
      if (!state.shared && state.user?.id !== "account-a") throw Object.assign(new Error("Access revoked"), { status: 403, code: "forbidden" });
      return structuredClone(state.assets.get(id));
    },
    listRevisions: async (id) => structuredClone(state.revisions.get(id) || []),
    saveAsset: async (input) => {
      state.saved.push(structuredClone(input));
      const id = input.id || "asset-one", current = state.assets.get(id);
      if ((current?.revision || 0) !== input.expectedRevision) throw Object.assign(new Error("Cloud revision changed"), { status: 409, code: "revision_conflict" });
      const asset = { id, kind: input.kind, slug: input.slug, title: input.title, description: input.description, workspaceId: input.workspaceId, revision: (current?.revision || 0) + 1, bundle: structuredClone(input.bundle) };
      state.assets.set(id, asset);
      state.revisions.set(id, [...(state.revisions.get(id) || []), structuredClone(asset)]);
      return structuredClone(asset);
    }
  };
  const sync = createCloudSync({ client, cloudRoot: path.join(temporary, "cloud") });
  return { state, client, sync };
}

test("Agent export preserves portable code/resources and excludes memory, credentials and run data", () => {
  const before = tree(privateDirectory);
  const portable = exportAgentBundle({ agent: getAgent("小雲"), agentDirectory: privateDirectory });
  assert.equal(portable.spec.memory, "");
  assert.ok(portable.files.some((file) => file.path === "skills/summarize/scripts/helper.js"));
  assert.ok(portable.files.some((file) => file.path === "skills/summarize/references/rules.md"));
  assert.ok(portable.files.some((file) => file.path === "workflows/review-flow/WORKFLOW.md"));
  assert.ok(!JSON.stringify(portable).includes("never-export-this"));
  assert.ok(!JSON.stringify(portable).includes("private-token"));
  assert.ok(!portable.files.some((file) => /memory|runs|\.env/i.test(file.path)));
  assert.ok(portable.dependencies.every((item) => item.version === "1" && item.source === "bundle"));
  assert.deepEqual(tree(privateDirectory), before);
  assert.equal(globalThis.cloudCodeExecuted, undefined);
  assert.equal(bundleHash(portable), bundleHash(validateCloudBundle(portable)));
});

test("metadata-first pull reuses immutable revision cache and downloads only the changed bundle", async () => {
  const { client, state, sync } = fakeCloud(); let metadataReads = 0, bundleReads = 0;
  const original = client.getAsset;
  client.getAssetMetadata = async id => { metadataReads++; const { bundle: contents, ...asset } = state.assets.get(id); return structuredClone(asset); };
  client.getAsset = async id => { bundleReads++; return original(id); };
  await sync.pushAsset({ bundle });
  await sync.pullAsset("asset-one"); await sync.pullAsset("asset-one");
  assert.equal(metadataReads, 2); assert.equal(bundleReads, 0);
  state.assets.set("asset-one", { ...state.assets.get("asset-one"), revision: 2 });
  await sync.pullAsset("asset-one"); assert.equal(metadataReads, 3); assert.equal(bundleReads, 1);
  const cached = await sync.pullAsset("asset-one");
  fs.appendFileSync(path.join(cached.cacheDirectory, "skills", "summarize", "SKILL.md"), "tampered");
  await assert.rejects(sync.pullAsset("asset-one"), /cached resource changed/); assert.equal(bundleReads, 1);
});
test("internal library cache demands the explicit bound user and local bundle preparation keeps all kinds local", async () => {
  const { client, state } = fakeCloud(), sync = createCloudSync({ client, cloudRoot: path.join(temporary, "cloud"), userId: "account-a" });
  const push = await sync.pushAsset({ bundle });
  assert.throws(() => sync.readLibraryCache("account-b", "asset-one"), { code: "account_changed" });
  assert.equal(sync.readLibraryCache("account-a", "asset-one", 1).revision, 1);
  const id = "local:10000000-0000-4000-8000-000000000001";
  for (const portable of [bundle, exportSkillBundle({ agent: source, agentDirectory: privateDirectory, skillId: "summarize" }), exportWorkflowBundle({ agent: source, agentDirectory: privateDirectory, workflowId: "review-flow" })]) {
    const prepared = await sync.prepareLocalBundleRun({ bundle: portable, localId: id, task: "整理資料" });
    assert.equal(prepared.cloud, undefined); assert.equal(prepared.local.id, id); assert.equal(prepared.local.userId, "account-a"); assert.equal(prepared.execution.mode, "current-host");
    assert.ok(prepared.resources.every(file => fs.existsSync(file.localPath)));
    if (portable.kind === "workflow") assert.equal(prepared.approvalMode, "manual");
  }
  state.user.id = "account-b";
  await assert.rejects(sync.prepareLocalBundleRun({ bundle, localId: id, task: "整理" }), { code: "account_changed" });
  assert.equal(push.ok, true);
});

test("standalone Skill and Workflow include their actual local dependency files", () => {
  const skill = exportSkillBundle({ agent: source, agentDirectory: privateDirectory, skillId: "summarize" });
  assert.equal(skill.kind, "skill");
  assert.ok(skill.files.some((file) => file.path.endsWith("helper.js")));
  assert.ok(!skill.files.some((file) => file.path.startsWith("skills/compare/") || file.path.startsWith("workflows/")));
  const workflow = exportWorkflowBundle({ agent: source, agentDirectory: privateDirectory, workflowId: "review-flow" });
  assert.deepEqual(workflow.spec.skills.map((item) => item.id), ["summarize"]);
  assert.ok(workflow.files.some((file) => file.path === "skills/summarize/SKILL.md"));
  assert.ok(workflow.spec.nodes.at(-1).requiresApproval);
});

test("cloud training generates fresh SOPs and preserves supporting scripts without changing private definitions", () => {
  const before = tree(privateDirectory), revised = structuredClone(bundle.spec);
  revised.skills = revised.skills.filter((item) => item.id === "summarize");
  revised.skills[0].steps = ["新的雲端 SOP"];
  const next = exportSpecBundle({ kind: "agent", spec: revised, files: bundle.files, dependencies: bundle.dependencies });
  assert.ok(next.files.find((file) => file.path === "skills/summarize/SKILL.md").content.includes("新的雲端 SOP"));
  assert.equal(next.files.find((file) => file.path.endsWith("helper.js")).content, bundle.files.find((file) => file.path.endsWith("helper.js")).content);
  assert.ok(!next.files.some((file) => file.path.startsWith("skills/compare/")));
  const created = exportSpecBundle({ spec: spec(), files: [] });
  assert.equal(created.spec.memory, "");
  assert.equal(created.files.filter((file) => file.path.endsWith("SKILL.md")).length, 2);
  assert.deepEqual(tree(privateDirectory), before);
});

test("bundle validation rejects traversal, duplicate/colliding paths, missing dependencies, limits and private content", () => {
  for (const invalid of ["../escape.py", "/tmp/escape.py", "skills/summarize/../../escape.py", "skills\\summarize\\bad.py", "skills/summarize/con.json", "skills/summarize/.env", "skills/summarize/runs/input.json"]) {
    const bad = structuredClone(bundle); bad.files.push({ path: invalid, content: "code" }); assert.throws(() => validateCloudBundle(bad), /Cloud bundle/);
  }
  const collision = structuredClone(bundle); collision.files.push({ ...collision.files.find((file) => file.path.endsWith("helper.js")), path: "skills/summarize/scripts/HELPER.js" });
  assert.throws(() => validateCloudBundle(collision), /colliding/);
  const ancestor = structuredClone(bundle); ancestor.files.push({ path: "skills/summarize/scripts/helper.js/child.json", content: "{}" });
  assert.throws(() => validateCloudBundle(ancestor), /path collision/);
  const invalidUnicode = structuredClone(bundle); invalidUnicode.files[0].content = "\ud800";
  assert.throws(() => validateCloudBundle(invalidUnicode), /Unicode/);
  const missing = structuredClone(bundle); missing.files = missing.files.filter((file) => file.path !== "skills/summarize/references/rules.md");
  assert.throws(() => validateCloudBundle(missing), /missing relative resource/);
  const missingSkill = structuredClone(bundle); missingSkill.files = missingSkill.files.filter((file) => file.path !== "skills/summarize/SKILL.md");
  assert.throws(() => validateCloudBundle(missingSkill), /missing complete Skill/);
  const large = structuredClone(bundle); large.files.push({ path: "assets/large.json", content: "x".repeat(BUNDLE_LIMITS.fileBytes + 1) });
  assert.throws(() => validateCloudBundle(large), /file exceeds size/);
  const floating = structuredClone(bundle); floating.dependencies[0].version = "latest"; assert.throws(() => validateCloudBundle(floating), /floating/);
  for (const secret of ['password = "never-share-this"', "Bearer 0123456789012345678901234", "/Users/private/Documents/local.json", "C:\\Users\\private\\local.json"]) {
    const bad = structuredClone(bundle); bad.files[0].content = secret; assert.throws(() => validateCloudBundle(bad), /credential|absolute path/);
  }
  const pollution = structuredClone(bundle); pollution.spec = JSON.parse('{"__proto__":{"polluted":true}}'); assert.throws(() => validateCloudBundle(pollution), /unsafe object key/);
});

test("export rejects symbolic-link resources and symbolic-link parent directories", () => {
  const external = path.join(temporary, "external"); fs.mkdirSync(external); fs.writeFileSync(path.join(external, "secret.md"), "private");
  const scripts = path.join(privateDirectory, "skills", "summarize", "scripts");
  try { fs.symlinkSync(path.join(external, "secret.md"), path.join(scripts, "link.md")); }
  catch (error) { if (error.code !== "EPERM") throw error; }
  if (fs.existsSync(path.join(scripts, "link.md"))) {
    assert.throws(() => exportAgentBundle({ agent: source, agentDirectory: privateDirectory }), /symbolic-link/);
    fs.unlinkSync(path.join(scripts, "link.md"));
  }
  fs.renameSync(path.join(privateDirectory, "skills"), path.join(privateDirectory, "old-skills"));
  fs.symlinkSync(path.join(privateDirectory, "old-skills"), path.join(privateDirectory, "skills"), "junction");
  assert.throws(() => exportAgentBundle({ agent: source, agentDirectory: privateDirectory }), /symbolic-link/);
});

test("CAS push/pull keeps cloud revisions immutable and preserves conflicting local work", async () => {
  const { state, sync } = fakeCloud();
  const first = await sync.pushAsset({ bundle, id: null });
  assert.equal(first.status, "synced"); assert.equal(first.revision, 1);
  const nextSpec = structuredClone(bundle.spec); nextSpec.skills[0].steps = ["Cloud revision two"];
  const next = exportSpecBundle({ spec: nextSpec, files: bundle.files });
  const updated = await sync.pushAsset({ id: "asset-one", expectedRevision: 1, bundle: next });
  assert.equal(updated.revision, 2);
  const stale = await sync.pushAsset({ id: "asset-one", expectedRevision: 1, bundle });
  assert.equal(stale.status, "conflict");
  assert.equal(bundleHash(JSON.parse(fs.readFileSync(stale.conflictPath, "utf8")).bundle), bundleHash(bundle));
  assert.equal(state.assets.get("asset-one").revision, 2);
  assert.equal((await sync.pullAsset("asset-one")).revision, 2);
  assert.equal((await sync.pullAsset("asset-one", { revision: 1 })).revision, 1);
  assert.equal(fs.statSync(stale.conflictPath).mode & 0o777, process.platform === "win32" ? fs.statSync(stale.conflictPath).mode & 0o777 : 0o600);
  assert.equal(globalThis.cloudCodeExecuted, undefined);
});

test("near-5MiB bundles use compact cache JSON and honor the SQL JSONB size boundary", async () => {
  const candidate = structuredClone(bundle);
  for (let index = 0; index < 5; index++) candidate.files.push({ path: `assets/boundary-${index}.json`, content: "" });
  // Fill only file contents, staying below the individual file limit. Account
  // for jsonb::text spaces before hitting exactly the server's byte limit.
  let remaining = BUNDLE_LIMITS.jsonBytes - cloudBundleStorageBytes(validateCloudBundle(candidate));
  for (const file of candidate.files.filter((item) => item.path.startsWith("assets/boundary-"))) {
    const size = Math.min(remaining, BUNDLE_LIMITS.fileBytes); file.content = "x".repeat(size); remaining -= size;
  }
  assert.equal(remaining, 0);
  const nearLimit = validateCloudBundle(candidate);
  assert.equal(cloudBundleStorageBytes(nearLimit), BUNDLE_LIMITS.jsonBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(nearLimit, null, 2)) > BUNDLE_LIMITS.jsonBytes, "old pretty cache exceeded limit");
  const { state, sync } = fakeCloud();
  const published = await sync.pushAsset({ bundle: nearLimit });
  assert.equal(published.status, "synced");
  const cachedFile = path.join(published.cacheDirectory, "bundle.json");
  assert.equal(fs.statSync(cachedFile).size, Buffer.byteLength(JSON.stringify(nearLimit)));
  const pulled = await sync.pullAsset("asset-one");
  assert.equal(bundleHash(pulled.bundle), bundleHash(nearLimit));
  const overflow = structuredClone(nearLimit);
  overflow.files.find((file) => file.path === "assets/boundary-4.json").content += "x";
  assert.ok(Buffer.byteLength(JSON.stringify(overflow)) < BUNDLE_LIMITS.jsonBytes, "compact alone would incorrectly pass");
  assert.throws(() => validateCloudBundle(overflow), /cloud storage JSON exceeds size limit/);
  await assert.rejects(sync.pushAsset({ bundle: overflow }), /cloud storage JSON exceeds size limit/);
  assert.equal(state.saved.length, 1, "oversize bundle was rejected before cloud save");
  assert.equal(state.assets.get("asset-one").revision, 1);
});

test("each account has isolated caches and logged-out callers cannot read them", async () => {
  const { state, sync } = fakeCloud(); await sync.pushAsset({ bundle });
  const a = await sync.pullAsset("asset-one");
  state.user = { id: "account-b" }; assert.deepEqual(await sync.listCachedAssets(), []);
  const b = await sync.pullAsset("asset-one");
  assert.notEqual(a.cacheDirectory, b.cacheDirectory);
  assert.ok(a.cacheDirectory.includes("account-a")); assert.ok(b.cacheDirectory.includes("account-b"));
  assert.equal(a.userId, "account-a"); assert.equal(b.accountId, "account-b");
  state.user = null;
  await assert.rejects(sync.listCachedAssets(), /sign-in/);
  await assert.rejects(sync.prepareAssetRun({ assetId: "asset-one", allowOfflineCache: true, task: "整理" }), /sign-in/);
});

test("offline use is explicit and revoked permissions never fall back to a cache", async () => {
  const { state, sync } = fakeCloud(); await sync.pushAsset({ bundle });
  state.error = Object.assign(new Error("Network offline"), { code: "network_error" });
  await assert.rejects(sync.pullAsset("asset-one"), /offline/);
  const offline = await sync.prepareAssetRun({ assetId: "asset-one", task: "整理", allowOfflineCache: true });
  assert.equal(offline.cloud.offline, true); assert.match(offline.prompt, /離線快取/);
  for (const status of [401, 403, 404, 500]) {
    state.error = Object.assign(new Error("Server denied"), { status });
    await assert.rejects(sync.pullAsset("asset-one", { allowOfflineCache: true }), /Server denied/);
  }
  state.error = Object.assign(new Error("Network offline"), { code: "network_error" });
  await assert.rejects(sync.pullAsset("asset-one", { allowOfflineCache: true }), /access was revoked/);
  assert.deepEqual(await sync.listCachedAssets(), []);
  state.error = null;
  assert.equal((await sync.pullAsset("asset-one")).revision, 1);
});

test("account switching during a cloud request prevents cross-account cache writes", async () => {
  const { state, client, sync } = fakeCloud(); await sync.pushAsset({ bundle });
  const fresh = structuredClone(state.assets.get("asset-one")); fresh.revision = 2;
  client.getAsset = async () => { state.user = { id: "account-b" }; return fresh; };
  await assert.rejects(sync.pullAsset("asset-one"), /account changed/);
  assert.ok(!fs.existsSync(path.join(temporary, "cloud", "cache", "account-b")));
  assert.ok(!fs.existsSync(path.join(temporary, "cloud", "cache", "account-a", "asset-one", "2")));
});

test("cloud Agent/Skill/Workflow prepares current-host execution from portable cache without changing private SOPs", async () => {
  const before = tree(privateDirectory), { state, sync } = fakeCloud();
  const standaloneSkill = exportSkillBundle({ agent: source, agentDirectory: privateDirectory, skillId: "summarize" });
  const standaloneWorkflow = exportWorkflowBundle({ agent: source, agentDirectory: privateDirectory, workflowId: "review-flow" });
  for (const [index, assetBundle] of [bundle, standaloneSkill, standaloneWorkflow].entries()) {
    const assetId = `asset-${index}`;
    state.assets.set(assetId, { id: assetId, kind: assetBundle.kind, revision: 1, title: "雲端來源", bundle: assetBundle });
    const prepared = await sync.prepareAssetRun({ assetId, task: "整理本次影片", approvalMode: "manual" });
    assert.equal(prepared.execution.mode, "current-host");
    assert.match(prepared.prompt, /VIXO 公用影片處理規則/);
    assert.match(prepared.prompt, /不修改私人 SOP/);
    assert.ok(prepared.resources.some((item) => item.localPath.endsWith("helper.js") && fs.existsSync(item.localPath)));
    assert.equal(prepared.cloud.revision, 1);
    assert.equal(prepared.cloud.userId, "account-a");
    if (assetBundle.kind === "workflow") { assert.equal(prepared.workflow.nodes.at(-1).requiresApproval, true); assert.match(prepared.prompt, /必須停下來取得使用者明確確認/); }
  }
  assert.deepEqual(tree(privateDirectory), before); assert.equal(globalThis.cloudCodeExecuted, undefined);
});

test("known permission denial survives a fresh sync client and blocks offline cache until reauthorized", async () => {
  const { state, sync } = fakeCloud(); await sync.pushAsset({ bundle });
  state.error = Object.assign(new Error("Access revoked"), { status: 403, code: "forbidden" });
  await assert.rejects(sync.pullAsset("asset-one"), /Access revoked/);
  const independent = createCloudSync({ cloudRoot: path.join(temporary, "cloud"), client: {
    getUser: async () => ({ id: "account-a" }),
    getAsset: async () => { throw Object.assign(new Error("Disconnected"), { code: "offline" }); }
  } });
  await assert.rejects(independent.prepareAssetRun({ assetId: "asset-one", task: "整理", allowOfflineCache: true }), /access was revoked/);
  assert.deepEqual(await independent.listCachedAssets(), []);
  state.error = null; await sync.pullAsset("asset-one");
  assert.equal((await independent.prepareAssetRun({ assetId: "asset-one", task: "整理", allowOfflineCache: true })).cloud.offline, true);
});

test("real shared client requires current approval even for cached assets and blocks revoked or unavailable approval", async () => {
  const userId = "22222222-2222-4222-8222-222222222222", assetId = "11111111-1111-4111-8111-111111111111";
  let offline = false, assetOffline = false, denied = false, approval = 'approved';
  let stored = { access_token: "test-access", refresh_token: "test-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600 };
  const options = { url: "https://cloud.example.invalid", key: "sb_publishable_test", getSession: () => stored, saveSession: (value) => stored = value,
    fetchImpl: async (url) => {
      if (offline) throw new TypeError("fetch failed");
      const route = new URL(url).pathname;
      if (route === "/auth/v1/user") return Response.json({ id: userId, email: "test@example.invalid" });
      if (route === '/rest/v1/rpc/vixo_my_access') return Response.json({ userId, status: approval, isAdmin: false });
      if (assetOffline) throw new TypeError('fetch failed');
      if (route === "/rest/v1/vixo_assets") return denied ? Response.json({ message: "Access revoked" }, { status: 403 })
        : Response.json([{ id: assetId, kind: "agent", title: "Shared definition", revision: 1, bundle }]);
      return Response.json({ ok: true });
    } };
  const client = createCloudClient(options), sync = createCloudSync({ client, cloudRoot: path.join(temporary, "real-client-cloud") });
  const initial = await sync.pullAsset(assetId); assert.equal(initial.userId, userId);
  offline = true;
  await assert.rejects(sync.prepareAssetRun({ assetId, task: "整理" }), /無法連線/);
  await assert.rejects(sync.prepareAssetRun({ assetId, task: '整理', allowOfflineCache: true }), { code: 'network_error' });
  offline = false; assetOffline = true;
  const cached = await sync.prepareAssetRun({ assetId, task: "整理", allowOfflineCache: true });
  assert.equal(cached.cloud.userId, userId); assert.equal(cached.cloud.offline, true);
  const restarted = createCloudSync({ client: createCloudClient(options), cloudRoot: path.join(temporary, "real-client-cloud") });
  assert.equal((await restarted.prepareAssetRun({ assetId, task: "整理", allowOfflineCache: true })).cloud.offline, true);
  approval = 'disabled';
  await assert.rejects(restarted.prepareAssetRun({ assetId, task: '整理', allowOfflineCache: true }), { code: 'account_disabled' });
  approval = 'pending';
  await assert.rejects(restarted.prepareAssetRun({ assetId, task: '整理', allowOfflineCache: true }), { code: 'account_pending' });
  approval = 'approved'; assetOffline = false; denied = true;
  await assert.rejects(sync.pullAsset(assetId), /Access revoked/);
  assetOffline = true;
  await assert.rejects(restarted.prepareAssetRun({ assetId, task: "整理", allowOfflineCache: true }), /access was revoked/);
  stored = { ...stored, expires_at: Math.floor(Date.now() / 1000) - 1 };
  offline = true;
  const expired = createCloudSync({ client: createCloudClient(options), cloudRoot: path.join(temporary, "real-client-cloud") });
  await assert.rejects(expired.prepareAssetRun({ assetId, task: "整理", allowOfflineCache: true }), /無法連線/);
});

test("a standalone manual Workflow is portable without invented Skill dependencies", async () => {
  const manual = exportSpecBundle({ kind: "workflow", spec: { id: "manual-flow", name: "手動流程", description: "先確認", triggers: [], skills: [], nodes: [{ id: "confirm", name: "確認", type: "approval", instructions: "取得確認" }] } });
  assert.deepEqual(manual.spec.skills, []); assert.deepEqual(manual.dependencies, []);
  const { state, sync } = fakeCloud(); state.assets.set("manual", { id: "manual", kind: "workflow", title: "手動流程", revision: 1, bundle: manual });
  const prepared = await sync.prepareAssetRun({ assetId: "manual", task: "執行流程" });
  assert.equal(prepared.workflow.nodes[0].requiresApproval, true);
  assert.match(prepared.prompt, /取得使用者明確確認/);
});

test("tampered cache resources, symlinks and same-revision remote changes are refused", async () => {
  const { state, sync } = fakeCloud(); const first = await sync.pushAsset({ bundle });
  const helper = path.join(first.cacheDirectory, "skills", "summarize", "scripts", "helper.js");
  fs.writeFileSync(helper, "changed");
  await assert.rejects(sync.prepareAssetRun({ assetId: "asset-one", task: "整理" }), /cached resource changed/);
  fs.writeFileSync(helper, bundle.files.find((item) => item.path.endsWith("helper.js")).content);
  const skills = path.join(first.cacheDirectory, "skills"), backup = path.join(first.cacheDirectory, "old-skills");
  fs.renameSync(skills, backup);
  fs.symlinkSync(backup, skills, "junction");
  await assert.rejects(sync.pullAsset("asset-one"), /symlink/);
  fs.unlinkSync(skills); fs.renameSync(backup, skills);
  const edited = structuredClone(bundle.spec); edited.skills[0].steps = ["Remote rewrote immutable revision"];
  state.assets.get("asset-one").bundle = exportSpecBundle({ spec: edited, files: bundle.files });
  await assert.rejects(sync.pullAsset("asset-one"), (error) => error.code === "cache_conflict" && fs.existsSync(error.conflictPath));
  assert.equal(bundleHash(JSON.parse(fs.readFileSync(path.join(first.cacheDirectory, "bundle.json"), "utf8"))), bundleHash(bundle));
});

test("explicit platform/tool requirements are enforced and metadata cannot leak local credentials", async () => {
  const { state, sync } = fakeCloud();
  const constrained = validateCloudBundle({ ...bundle, requirements: { platforms: ["windows"], tools: ["ERP"] } });
  state.assets.set("asset-win", { id: "asset-win", kind: "agent", title: "Windows ERP", revision: 1, bundle: constrained });
  await assert.rejects(sync.prepareAssetRun({ assetId: "asset-win", task: "整理", platform: "darwin" }), /incompatible/);
  await assert.rejects(sync.prepareAssetRun({ assetId: "asset-win", task: "整理", platform: "win32", tools: [] }), /tools are unavailable/);
  assert.equal((await sync.prepareAssetRun({ assetId: "asset-win", task: "整理", platform: "win32", tools: ["ERP"] })).execution.mode, "current-host");
  await assert.rejects(sync.pushAsset({ bundle, description: "/Users/private/Documents/data.json" }), /absolute path/);
  assert.equal(state.saved.length, 0);
});
