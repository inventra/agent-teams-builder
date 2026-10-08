import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createLocalLibrary } from "../src/local-library.mjs";
import { createCloudSync } from "../src/cloud-sync.mjs";
import { BUNDLE_LIMITS, cloudBundleStorageBytes, exportSpecBundle, validateCloudBundle } from "../src/cloud-bundle.mjs";

const makeBundle = (label = "來源整理") => exportSpecBundle({ kind: "agent", spec: {
  id: "reader", displayName: "資料員", aliases: [], description: label, purpose: "整理本次來源", systemPrompt: "只依本次使用者授權處理。", memory: "",
  skills: [{ id: "read", name: "整理", description: label, triggers: ["整理"], steps: ["核對來源"], allowedTools: [], successCriteria: ["保留來源"] }], workflows: []
} });
let root;
test.beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "vixo-library-")); });
test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function fake() {
  const state = { userId: "account-a", approved: true, assets: new Map(), histories: new Map(), calls: { user: 0, approved: 0, list: 0, full: 0, metadata: 0, save: 0, history: 0 }, saveMode: null, barrier: null };
  const client = {
    async getUser() { state.calls.user++; return { id: state.userId }; },
    async requireApproved() { state.calls.approved++; if (!state.approved) throw Object.assign(new Error("disabled"), { code: "account_disabled", status: 403 }); return { userId: state.userId, status: "approved" }; },
    async listAssets() { state.calls.list++; if (state.listFailureOnce) { state.listFailureOnce = false; throw Object.assign(new Error("offline"), { code: "network_error" }); } return [...state.assets.values()].map(({ bundle, ...asset }) => structuredClone(asset)); },
    async getAssetMetadata(id) { state.calls.metadata++; if (!state.assets.has(id)) throw Object.assign(new Error("revoked"), { status: 404, code: "not_found" }); const { bundle, ...asset } = state.assets.get(id); return structuredClone(asset); },
    async getAsset(id) { state.calls.full++; if (!state.assets.has(id)) throw Object.assign(new Error("revoked"), { status: 404, code: "not_found" }); return structuredClone(state.assets.get(id)); },
    async listRevisions(id) { state.calls.history++; return structuredClone(state.histories.get(id) || []); },
    async saveAsset(input) {
      state.calls.save++; if (state.barrier) await state.barrier;
      if (state.saveMode === "offline-before") throw Object.assign(new Error("lost response"), { code: "network_error" });
      if (state.unique && !input.id && [...state.assets.values()].some(asset => asset.slug === input.slug && asset.kind === input.kind && asset.workspaceId === input.workspaceId && asset.ownerId === state.userId)) {
        state.listFailureOnce = true;
        throw Object.assign(new Error("duplicate slug"), { status: 409, code: "23505" });
      }
      const id = input.id || crypto.randomUUID(), old = state.assets.get(id);
      if ((old?.revision || 0) !== input.expectedRevision) throw Object.assign(new Error("CAS"), { code: "revision_conflict", status: 409 });
      const asset = { id, ownerId: old?.ownerId || state.userId, kind: input.kind, slug: input.slug, title: input.title, description: input.description, workspaceId: input.workspaceId, bundle: structuredClone(input.bundle), revision: (old?.revision || 0) + 1 };
      state.assets.set(id, asset); state.histories.set(id, [...(state.histories.get(id) || []), { ...asset, created_by: state.userId, message: input.message }]);
      if (state.saveMode === "lost-after") throw Object.assign(new Error("lost response"), { code: "network_error" });
      return structuredClone(asset);
    }
  };
  let time = Date.now();
  const library = () => createLocalLibrary({ client, cloudRoot: root, userId: state.userId, now: () => time });
  return { state, client, library, tick: () => { time += 180001; } };
}
const stage = (library, extra = {}) => library.stageConfirmed({ bundle: makeBundle(), ...extra });

test("stage is durable before network, stable draft IDs use local CAS, clean cooldown makes zero requests", async () => {
  const { state, library, tick } = fake(), a = library();
  const first = stage(a); assert.match(first.id, /^local:/); assert.equal(first.syncState, "pending"); assert.equal(state.calls.user, 0);
  assert.equal(library().snapshot().entries[0].localHash, first.localHash);
  assert.throws(() => stage(a, { localId: first.id, expectedLocalHash: "stale" }), { code: "local_draft_conflict" });
  const edited = stage(a, { localId: first.id, expectedLocalHash: first.localHash, bundle: makeBundle("第二版來源") });
  assert.equal(edited.id, first.id); assert.notEqual(edited.localHash, first.localHash);
  assert.equal(fs.readdirSync(path.join(root, "library", "account-a", "drafts", first.id.slice(6))).length, 2);
  const saved = await a.sync(); assert.equal(saved.entries.length, 1); assert.equal(saved.entries[0].syncState, "synced"); assert.equal(saved.entries[0].id, first.id);
  const baseline = structuredClone(state.calls);
  for (let i = 0; i < 10; i++) await library().sync();
  assert.deepEqual(state.calls, baseline);
  tick(); await a.sync(); assert.equal(state.calls.list, baseline.list + 1); assert.equal(state.calls.full, baseline.full);
});

test("metadata polls download only changed revisions and advance stable local IDs", async () => {
  const { state, library } = fake(), a = library(); stage(a); let view = await a.sync();
  const local = view.entries[0], asset = state.assets.get(local.assetId);
  const before = state.calls.full; await a.sync({ force: true }); assert.equal(state.calls.full, before);
  state.assets.set(asset.id, { ...asset, revision: 2, title: "雲端修改", bundle: makeBundle("已改內容") });
  view = await a.sync({ force: true }); assert.equal(state.calls.full, before + 1);
  assert.equal(view.entries[0].id, local.id); assert.equal(view.entries[0].revision, 2); assert.equal(view.entries[0].title, "雲端修改");
});

test("cross-instance sync is single-flight and an edit during sending is preserved and anchored", async () => {
  const { state, library } = fake(), a = library(), b = library(); let finish;
  state.barrier = new Promise((resolve) => { finish = resolve; });
  const original = stage(a), p = a.sync(), same = b.sync({ force: true }); assert.equal(p, same);
  while (!state.calls.save) await new Promise(resolve => setTimeout(resolve, 5));
  const edited = stage(b, { localId: original.id, expectedLocalHash: original.localHash, bundle: makeBundle("同步時修改") });
  finish(); await p; state.barrier = null;
  const mid = a.snapshot().entries[0]; assert.equal(mid.id, edited.id); assert.equal(mid.syncState, "pending"); assert.equal(mid.revision, 1); assert.equal(mid.bundle.spec.description, "同步時修改");
  assert.notEqual(mid.localHash, edited.localHash);
  assert.throws(() => stage(a, { localId: edited.id, expectedLocalHash: edited.localHash, bundle: makeBundle("過期核准") }), { code: "local_draft_conflict" });
  await a.sync(); assert.equal(state.calls.save, 2); assert.equal(a.snapshot().entries[0].revision, 2); assert.equal(state.assets.size, 1);
});

test("conflict comparison refreshes the remote side even during the metadata cooldown", async () => {
  const { state, library } = fake(), a = library(); stage(a); const saved = (await a.sync()).entries[0];
  stage(a, { id: saved.assetId, localId: saved.id, expectedRevision: saved.revision, expectedLocalHash: saved.localHash, title: "local" });
  const remote = state.assets.get(saved.assetId); state.assets.set(saved.assetId, { ...remote, revision: 2, title: "current remote" });
  const view = await a.sync();
  assert.equal(view.entries.find(item => item.id.startsWith("cloud:")).revision, 2);
  assert.equal(view.entries.find(item => item.id.startsWith("cloud:")).title, "current remote");
  assert.equal(view.entries.find(item => item.id === saved.id).remoteRevision, 2); assert.equal(state.calls.save, 1);
});

test("near-limit immutable drafts fit compact durable state and keep hashes across reload", () => {
  const { library } = fake(), a = library(), bundle = makeBundle();
  for (let i = 0; i < 5; i++) bundle.files.push({ path: `references/large-${i}.md`, content: "x".repeat(BUNDLE_LIMITS.fileBytes - 4096) });
  const extra = BUNDLE_LIMITS.jsonBytes - cloudBundleStorageBytes(bundle) - 128;
  if (extra > 0) bundle.files.push({ path: "references/fill.md", content: "x".repeat(extra - 200) });
  const clean = validateCloudBundle(bundle), entry = stage(a, { bundle: clean });
  assert.ok(JSON.stringify(clean).length > BUNDLE_LIMITS.jsonBytes - 32000);
  assert.equal(library().snapshot().entries[0].bundleHash, entry.bundleHash);
});

test("new duplicate-slug conflict without base ID requires the actual matching remote before resolution", async () => {
  const { state, library } = fake(), a = library(), bundle = makeBundle(), id = crypto.randomUUID();
  state.assets.set(id, { id, ownerId: "account-a", workspaceId: null, kind: "agent", slug: "reader", title: "Existing Reader", description: "remote", revision: 1, bundle });
  state.unique = true; const local = stage(a);
  const view = await a.sync(); assert.equal(view.entries.find(e => e.id === local.id).syncState, "conflict");
  assert.equal(view.entries.find(e => e.id === local.id).assetId, null); // post409 lookup lost its response
  const remote = await a.conflictRemote(local.id); assert.equal(remote.assetId, id); assert.equal(remote.title, "Existing Reader");
  assert.equal(a.snapshot().entries.find(e => e.id === local.id).localHash, local.localHash);
  await assert.rejects(a.resolveConflict(local.id, "remote", { expectedLocalHash: local.localHash, expectedRemoteRevision: null }), { code: "revision_conflict" });
  const resolved = await a.resolveConflict(local.id, "remote", { expectedLocalHash: local.localHash, expectedRemoteRevision: 1 });
  assert.equal(resolved.snapshot.entries.length, 1); assert.equal(resolved.snapshot.entries[0].assetId, id); assert.equal(state.calls.save, 1);
});

test("lost successful write is reconciled by exact scope/hash/revision/actor without replay", async () => {
  const { state, library } = fake(), a = library(); state.saveMode = "lost-after"; stage(a);
  let view = await a.sync(); assert.equal(view.entries[0].syncState, "uncertain"); assert.equal(state.calls.save, 1);
  state.saveMode = null; view = await library().sync(); assert.equal(state.calls.save, 1); assert.equal(state.calls.history, 1);
  assert.equal(view.entries.length, 1); assert.equal(view.entries[0].syncState, "synced"); assert.equal(view.entries[0].revision, 1);
});

test("unconfirmed writes never blindly retry or merge a different actor's matching contents", async () => {
  const { state, library } = fake(), a = library(); state.saveMode = "lost-after"; const local = stage(a); await a.sync();
  const asset = [...state.assets.values()][0]; state.histories.get(asset.id)[0].created_by = "other-user";
  for (let i = 0; i < 3; i++) await a.sync({ force: true });
  assert.equal(state.calls.save, 1); assert.equal(a.snapshot().entries.find(e => e.id === local.id).syncState, "uncertain");
  const calls = structuredClone(state.calls); for (let i = 0; i < 5; i++) await library().sync(); assert.deepEqual(state.calls, calls);
  assert.throws(() => stage(a, { localId: local.id, expectedLocalHash: local.localHash, bundle: makeBundle("不得覆寫") }), { code: "local_draft_conflict" });
});

test("CAS conflict keeps both sides; stale resolution fails and confirmed copy creates another asset", async () => {
  const { state, library } = fake(), a = library(); stage(a); const saved = (await a.sync()).entries[0], asset = state.assets.get(saved.assetId);
  const draft = stage(a, { id: saved.assetId, localId: saved.id, expectedRevision: 1, expectedLocalHash: saved.localHash, title: "本機修改" });
  state.assets.set(asset.id, { ...asset, revision: 2, title: "遠端修改", bundle: makeBundle("遠端內容") });
  const view = await a.sync({ force: true }); assert.equal(view.entries.length, 2); assert.equal(view.entries.find(e => e.id === draft.id).syncState, "conflict");
  await assert.rejects(a.resolveConflict(draft.id, "copy", { expectedLocalHash: draft.localHash, expectedRemoteRevision: 1 }), { code: "revision_conflict" });
  const resolved = await a.resolveConflict(draft.id, "copy", { expectedLocalHash: draft.localHash, expectedRemoteRevision: 2 });
  assert.notEqual(resolved.entry.id, draft.id); assert.equal(resolved.entry.assetId, null); assert.match(resolved.entry.slug, /-copy-/); assert.equal(state.calls.save, 1);
  await a.sync(); assert.equal(state.assets.size, 2); assert.equal(state.assets.get(asset.id).revision, 2);
});

test("remote resolution archives immutable draft, does not overwrite remote, and revocation hides synchronized rows", async () => {
  const { state, library } = fake(), a = library(); stage(a); const saved = (await a.sync()).entries[0], asset = state.assets.get(saved.assetId);
  const local = stage(a, { id: saved.assetId, localId: saved.id, expectedRevision: 1, expectedLocalHash: saved.localHash, title: "local" });
  state.assets.set(asset.id, { ...asset, revision: 2 }); await a.sync({ force: true });
  const resolved = await a.resolveConflict(local.id, "remote", { expectedLocalHash: local.localHash, expectedRemoteRevision: 2 });
  assert.equal(resolved.snapshot.entries.length, 1); assert.equal(resolved.snapshot.entries[0].id, `cloud:${asset.id}`); assert.equal(state.calls.save, 1);
  assert.ok(fs.existsSync(path.join(root, "library", "account-a", "drafts", local.id.slice(6))));
  state.assets.clear(); const hidden = await a.sync({ force: true }); assert.equal(hidden.entries.length, 0);
});

test("account isolation, symlink and draft/cache tampering fail closed; preparation always verifies live approval and membership", async () => {
  const { state, client, library } = fake(), a = library(), item = stage(a);
  state.userId = "account-b"; assert.equal(library().snapshot().entries.length, 0); const denied = await a.sync(); assert.equal(denied.sync.state, "error"); assert.equal(state.calls.save, 0);
  state.userId = "account-a"; await a.sync(); const synced = a.snapshot().entries[0];
  const sync = createCloudSync({ client, cloudRoot: root, userId: "account-a" });
  const prepared = await sync.prepareLocalBundleRun({ bundle: item.bundle, localId: item.id, baseAssetId: synced.assetId, task: "整理來源" });
  assert.equal(prepared.cloud, undefined); assert.equal(prepared.local.id, item.id); assert.equal(prepared.local.baseAssetId, synced.assetId); assert.equal(prepared.execution.mode, "current-host");
  state.approved = false; await assert.rejects(sync.prepareLocalBundleRun({ bundle: item.bundle, localId: item.id, task: "整理" }), { code: "account_disabled" });
  state.approved = true; state.assets.clear(); await assert.rejects(sync.prepareLocalBundleRun({ bundle: item.bundle, localId: item.id, baseAssetId: synced.assetId, task: "整理" }), { code: "not_found" });
  const dir = path.join(root, "library", "account-a", "drafts", item.id.slice(6)), file = path.join(dir, fs.readdirSync(dir)[0]);
  const tampered = JSON.parse(fs.readFileSync(file)); tampered.payload.title = "tampered"; fs.writeFileSync(file, JSON.stringify(tampered));
  assert.throws(() => a.snapshot(), { code: "cache_tampered" });
  fs.unlinkSync(file); fs.symlinkSync(path.join(root, "outside"), file); assert.throws(() => a.snapshot());
});

test("a live external process lock prevents duplicate send and dead sending checkpoints recover uncertain", async () => {
  const { state, library } = fake(), a = library(); stage(a);
  const child = spawn(process.execPath, ["--input-type=module", "-e", "process.stdin.resume(); setTimeout(()=>{},10000)"], { stdio: ["pipe", "ignore", "ignore"] });
  const lock = path.join(root, "library", "account-a", "sync.lock"); fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, token: "external" }));
  const pending = a.sync(); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(state.calls.save, 0);
  child.kill(); await new Promise(resolve => child.once("exit", resolve)); await pending; assert.equal(state.calls.save, 1);
  // Persisted sending state resembles a process dying after handing off a write.
  const item = a.snapshot().entries[0]; stage(a, { id: item.assetId, localId: item.id, expectedRevision: item.revision, expectedLocalHash: item.localHash, title: "new" });
  state.saveMode = "offline-before"; await a.sync();
  const headPath = path.join(root, "library", "account-a", "heads", `${item.id.slice(6)}.json`), head = JSON.parse(fs.readFileSync(headPath)); head.status = "sending"; fs.writeFileSync(headPath, JSON.stringify(head));
  state.saveMode = null; await library().sync(); assert.equal(state.calls.save, 2); assert.equal(a.snapshot().entries.find(e => e.id === item.id).syncState, "uncertain");
});
