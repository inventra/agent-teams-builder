import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BUNDLE_LIMITS, assertCloudShareableText, bundleHash, validateCloudBundle } from "./cloud-bundle.mjs";
import { createCloudSync } from "./cloud-sync.mjs";

const flights = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => structuredClone(value);
function fault(message, code = "library_error", status = 0) { return Object.assign(new Error(message), { code, ...(status ? { status } : {}) }); }
function assert(value, message, code) { if (!value) throw fault(message, code); }
function safeId(value) {
  assert(typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9]|constructor|prototype)$/i.test(value), "Invalid library identity"); return value;
}
function localId(value) { assert(/^local:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value || ""), "Invalid local draft ID"); return value; }
function scope(asset) { return asset.workspaceId || asset.workspace_id || null; }
function metadata(asset) {
  safeId(asset.id);
  assert(["agent", "skill", "workflow"].includes(asset.kind) && Number.isSafeInteger(asset.revision) && asset.revision > 0, "Invalid cloud asset metadata");
  const ownerId = asset.ownerId || asset.owner_id || null, workspaceId = scope(asset);
  if (ownerId) safeId(ownerId); if (workspaceId) safeId(workspaceId);
  for (const field of ["slug", "title", "description"]) assertCloudShareableText(asset[field] || "", field);
  return { id: asset.id, ownerId, workspaceId, kind: asset.kind, slug: asset.slug, title: asset.title, description: asset.description || "", revision: asset.revision };
}

/** Content cache only. The caller must verify the bound account before displaying
 * snapshots. No cached access record is authorization to execute cloud content. */
export function createLocalLibrary({ client, cloudRoot, userId, now = Date.now }) {
  safeId(userId);
  assert(client && typeof client.getUser === "function" && typeof client.listAssets === "function", "Cloud library client is required");
  assert(typeof cloudRoot === "string" && path.isAbsolute(cloudRoot), "Absolute cloud root is required");
  if (fs.existsSync(cloudRoot)) assert(fs.lstatSync(cloudRoot).isDirectory() && !fs.lstatSync(cloudRoot).isSymbolicLink(), "Cloud root is unsafe");
  fs.mkdirSync(cloudRoot, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(cloudRoot), key = `${root}\0${userId}`;
  const cloud = createCloudSync({ client, cloudRoot: root, userId });
  const timestamp = () => new Date(now()).toISOString();
  function target(...parts) { const result = path.resolve(root, "library", userId, ...parts); assert(result.startsWith(`${root}${path.sep}`), "Library path escaped root"); return result; }
  function directory(value) {
    assert(value === root || value.startsWith(`${root}${path.sep}`), "Library directory escaped root");
    let current = root;
    for (const part of path.relative(root, value).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) { try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
      const stat = fs.lstatSync(current); assert(stat.isDirectory() && !stat.isSymbolicLink(), "Library directory is a symlink or non-directory");
    }
  }
  directory(target());
  function read(file, optional = false) {
    directory(path.dirname(file));
    if (!fs.existsSync(file) && optional) return null;
    const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= BUNDLE_LIMITS.jsonBytes + 65536, "Library state file is unsafe");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  function durable(file, value, immutable = false) {
    directory(path.dirname(file));
    if (fs.existsSync(file)) { const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink(), "Library state file is unsafe"); assert(!immutable, "Immutable draft already exists"); }
    const temporary = `${file}.tmp-${crypto.randomUUID()}`, data = JSON.stringify(value);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, data, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(temporary, file);
      // Windows does not support opening directories for fsync. The immutable
      // file itself is flushed on every platform before its atomic rename.
      if (process.platform !== "win32") { const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
    }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }
  function acquire(name) {
    const file = target(`${name}.lock`), token = crypto.randomUUID();
    try { const fd = fs.openSync(file, "wx", 0o600); try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } return () => { const held = read(file, true); assert(held?.token === token, "Library lock ownership changed"); fs.unlinkSync(file); }; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink(), "Library lock is unsafe");
      // Never expire a lock owned by a live process, even during a slow request.
      let held; try { held = read(file); } catch { throw fault("Unrecoverable library lock; inspect it before retrying", "library_lock_corrupt"); }
      assert(Number.isSafeInteger(held.pid) && held.pid > 0 && typeof held.token === "string", "Invalid library lock", "library_lock_corrupt");
      if (!alive(held.pid)) {
        // Recovery is serialized independently from the lock being recovered.
        const recover = `${file}.recover`;
        let fd;
        try { fd = fs.openSync(recover, "wx", 0o600); }
        catch (recoveryError) { if (recoveryError.code === "EEXIST") return null; throw recoveryError; }
        try { if (fs.existsSync(file) && read(file).token === held.token) fs.unlinkSync(file); }
        finally { fs.closeSync(fd); fs.unlinkSync(recover); }
        return acquire(name);
      }
      return null;
    }
  }
  function locked(fn) {
    const until = Date.now() + 5000;
    let release;
    while (!(release = acquire("state"))) { if (Date.now() > until) throw fault("Library is busy", "library_busy"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
    try { return fn(); } finally { release(); }
  }
  function manifest() {
    const value = read(target("catalog.json"), true) || { userId, assets: [], lastSyncedAt: null, state: "idle" };
    assert(value.userId === userId && Array.isArray(value.assets), "Library catalog account mismatch"); return value;
  }
  function writeManifest(value) {
    // Keep catalog metadata compact even for thousands of long descriptions.
    // Display fields live with each separately validated immutable cache bundle.
    const assets = value.assets.map(({ id, ownerId, workspaceId, kind, slug, revision }) => ({ id, ownerId, workspaceId, kind, slug, revision }));
    durable(target("catalog.json"), { ...value, assets });
  }
  function headFile(id) { return target("heads", `${localId(id).slice(6)}.json`); }
  function heads() {
    const base = target("heads"); directory(base);
    return fs.readdirSync(base).filter((file) => file.endsWith(".json")).map((file) => {
      const value = read(path.join(base, file)); localId(value.id); assert(value.userId === userId && file === `${value.id.slice(6)}.json`, "Library draft account mismatch");
      if (value.attempt) {
        safeId(value.attempt.id);
        const record = read(target("attempts", `${value.attempt.id}.json`));
        assert(record.userId === userId && record.localId === value.id, "Library attempt identity mismatch");
        const { userId: actor, localId: identity, ...stored } = record;
        assert(JSON.stringify(stored) === JSON.stringify(value.attempt) && bundleHash(value.attempt.payload.bundle) === value.attempt.bundleHash, "Library attempt changed", "cache_tampered");
      }
      return value;
    });
  }
  function draft(head, version = head.versionId) {
    safeId(version);
    const value = read(target("drafts", head.id.slice(6), `${version}.json`));
    assert(value.userId === userId && value.localId === head.id && value.versionId === version, "Library immutable draft identity mismatch");
    const bundle = validateCloudBundle(value.payload.bundle);
    assert(bundleHash(bundle) === value.bundleHash && hash(value.payload) === value.localHash, "Library draft hash mismatch", "cache_tampered");
    return value;
  }
  function entry(head) {
    const value = draft(head), payload = value.payload;
    // Content can stay identical while an acknowledged write advances its base
    // identity/revision. Include both the immutable version and that anchor in
    // the edit token, so an old approval cannot target the new base accidentally.
    const localHash = hash({ payloadHash: value.localHash, versionId: value.versionId, assetId: head.assetId || payload.id, revision: head.revision ?? payload.expectedRevision });
    return { id: head.id, assetId: head.assetId || payload.id || null, ownerId: head.ownerId || userId, kind: payload.kind, slug: payload.slug, title: payload.title, description: payload.description,
      revision: head.revision ?? payload.expectedRevision, workspaceId: payload.workspaceId, bundle: value.payload.bundle, bundleHash: value.bundleHash, localHash,
      syncState: head.status === "sending" ? "pending" : head.status, ...(head.remoteRevision !== undefined ? { remoteRevision: head.remoteRevision } : {}), ...(head.error ? { error: head.error } : {}) };
  }
  function snapshotUnlocked() {
    const catalog = manifest(), local = heads().filter((head) => !head.archived).map(entry), entries = [...local];
    const shadowed = new Set(local.filter((value) => !["conflict", "uncertain", "error"].includes(value.syncState)).map((value) => value.assetId).filter(Boolean));
    for (const asset of catalog.assets) {
      const clean = metadata(asset); if (shadowed.has(clean.id)) continue;
      let cached; try { cached = cloud.readLibraryCache(userId, clean.id, clean.revision); } catch (error) { if (["cache_unavailable", "forbidden"].includes(error.code)) continue; throw error; }
      const digest = bundleHash(cached.bundle);
      entries.push({ ...clean, ...metadata(cached.asset), id: `cloud:${clean.id}`, assetId: clean.id, bundle: cached.bundle, bundleHash: digest, localHash: digest, syncState: "synced" });
    }
    const pendingCount = local.filter((value) => ["local", "pending"].includes(value.syncState)).length;
    const conflictCount = local.filter((value) => ["conflict", "uncertain", "error"].includes(value.syncState)).length;
    return clone({ entries, sync: { lastSyncedAt: catalog.lastSyncedAt, state: flights.has(key) ? "syncing" : conflictCount ? "conflict" : catalog.state,
      pendingCount, conflictCount, ...(catalog.error ? { error: catalog.error } : {}) } });
  }
  function snapshot() { return locked(snapshotUnlocked); }
  function normalize(input) {
    const bundle = validateCloudBundle(input.bundle), id = input.id || null, workspaceId = input.workspaceId || null;
    if (id) safeId(id); if (workspaceId) safeId(workspaceId);
    const expectedRevision = input.expectedRevision ?? (id ? null : 0);
    assert(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0 && (id ? expectedRevision > 0 : expectedRevision === 0), "Invalid expected revision");
    assert(!input.kind || input.kind === bundle.kind, "Draft kind does not match bundle");
    const result = { id, kind: bundle.kind, slug: input.slug || bundle.spec.id, title: input.title || bundle.spec.displayName || bundle.spec.name, description: input.description || "", bundle, workspaceId, expectedRevision, message: input.message || "" };
    for (const field of ["slug", "title", "description", "message"]) assertCloudShareableText(result[field], field);
    assert(/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(result.slug) && result.title.trim() && result.title.length <= 200, "Invalid draft slug/title");
    return result;
  }
  function stageUnlocked(input) {
    const payload = normalize(input), id = input.localId ? localId(input.localId) : `local:${crypto.randomUUID()}`;
    const previous = read(headFile(id), true);
    if (previous) {
      assert(previous.userId === userId && !previous.archived, "Draft is not available");
      const old = draft(previous);
      if (!input.expectedLocalHash || input.expectedLocalHash !== entry(previous).localHash) throw fault("Local draft changed; compare it again", "local_draft_conflict", 409);
      if (payload.kind !== old.payload.kind || payload.workspaceId !== old.payload.workspaceId || payload.id !== (previous.assetId || old.payload.id)) throw fault("Cannot change draft identity/scope", "local_draft_conflict", 409);
      if (["uncertain", "conflict", "error"].includes(previous.status)) throw fault("Resolve the existing draft before editing it", "local_draft_conflict", 409);
      if (previous.status !== "sending" && payload.expectedRevision !== (previous.revision ?? old.payload.expectedRevision)) throw fault("Draft base revision changed", "local_draft_conflict", 409);
    }
    const versionId = crypto.randomUUID(), value = { userId, localId: id, versionId, payload, bundleHash: bundleHash(payload.bundle), localHash: hash(payload), createdAt: timestamp() };
    durable(target("drafts", id.slice(6), `${versionId}.json`), value, true);
    const next = { userId, id, versionId, status: "pending", assetId: payload.id, revision: payload.expectedRevision, ownerId: previous?.ownerId || userId,
      ...(previous?.attempt ? { attempt: previous.attempt } : {}), createdAt: previous?.createdAt || timestamp(), updatedAt: timestamp() };
    durable(headFile(id), next); return entry(next);
  }
  function stageConfirmed(input) { return locked(() => stageUnlocked(input)); }
  async function currentUser() {
    const current = await client.getUser(); assert(current?.id === userId, "Library account changed", "account_changed");
    if (typeof client.requireApproved === "function") { const access = await client.requireApproved(); assert(access.userId === userId, "Library account changed", "account_changed"); }
  }
  function updateHead(id, change) { return locked(() => { const head = read(headFile(id)); assert(head.userId === userId, "Library account changed"); change(head); head.updatedAt = timestamp(); durable(headFile(id), head); return head; }); }
  async function refreshMetadata() {
    await currentUser();
    const rows = await client.listAssets(); assert(Array.isArray(rows), "Invalid cloud metadata list");
    const assets = rows.map(metadata), seen = new Set();
    for (const asset of assets) { assert(!seen.has(asset.id), "Duplicate cloud metadata entry", "list_changed"); seen.add(asset.id); }
    // Do not remove previously readable content until the entire list succeeds.
    for (const asset of assets) {
      cloud.markLibraryAccess(userId, asset.id, true);
      try { cloud.readLibraryCache(userId, asset.id, asset.revision); }
      catch (error) {
        if (error.code !== "cache_unavailable") throw error;
        const full = await client.getAsset(asset.id);
        assert(full?.id === asset.id && full.revision === asset.revision, "Cloud changed during download; refresh again", "list_changed");
        assert(full.kind === asset.kind && scope(full) === asset.workspaceId, "Cloud metadata identity mismatch");
        await currentUser(); cloud.storeLibraryCache(userId, full, full.bundle);
      }
    }
    await currentUser();
    locked(() => {
      const old = manifest();
      for (const asset of old.assets) if (!seen.has(asset.id)) cloud.markLibraryAccess(userId, asset.id, false);
      for (const head of heads()) {
        if (head.archived || head.status !== "synced" || !head.assetId) continue;
        const remote = assets.find((asset) => asset.id === head.assetId);
        if (!remote) { head.archived = true; head.archivedAt = timestamp(); head.resolution = "access_revoked"; durable(headFile(head.id), head); continue; }
        if (remote.revision !== head.revision) {
          const cached = cloud.readLibraryCache(userId, remote.id, remote.revision), versionId = crypto.randomUUID();
          const payload = normalize({ ...remote, id: remote.id, bundle: cached.bundle, expectedRevision: remote.revision });
          const value = { userId, localId: head.id, versionId, payload, bundleHash: bundleHash(payload.bundle), localHash: hash(payload), createdAt: timestamp() };
          durable(target("drafts", head.id.slice(6), `${versionId}.json`), value, true);
          head.versionId = versionId; head.revision = remote.revision; head.ownerId = remote.ownerId; head.updatedAt = timestamp(); durable(headFile(head.id), head);
        }
      }
      writeManifest({ ...old, assets, lastSyncedAt: timestamp(), state: "idle", error: undefined });
    });
    return assets;
  }
  function effective(head, value) { return { ...value.payload, id: head.assetId || value.payload.id, expectedRevision: head.revision ?? value.payload.expectedRevision }; }
  async function rememberRemote(raw) {
    const clean = metadata(raw); cloud.markLibraryAccess(userId, clean.id, true);
    try { cloud.readLibraryCache(userId, clean.id, clean.revision); }
    catch (error) {
      if (error.code !== "cache_unavailable") throw error;
      const full = await client.getAsset(clean.id);
      assert(full?.id === clean.id && full.revision === clean.revision && full.kind === clean.kind && scope(full) === clean.workspaceId, "Remote changed during conflict comparison", "list_changed");
      await currentUser(); cloud.storeLibraryCache(userId, full, full.bundle);
    }
    locked(() => { const catalog = manifest(); catalog.assets = [...catalog.assets.filter((asset) => asset.id !== clean.id), clean]; writeManifest(catalog); });
    return clean;
  }
  function acknowledge(head, attempt, asset) {
    const input = attempt.payload, clean = metadata(asset);
    assert((!input.id || clean.id === input.id) && clean.kind === input.kind && clean.workspaceId === input.workspaceId && clean.slug === input.slug && clean.revision === input.expectedRevision + 1,
      "Unexpected cloud write acknowledgement", "uncertain_write");
    assert(clean.title === input.title && clean.description === input.description && (!asset.bundle || bundleHash(asset.bundle) === attempt.bundleHash), "Cloud acknowledgement content mismatch", "uncertain_write");
    if (!input.id) assert(clean.ownerId === userId, "Cloud write owner mismatch", "uncertain_write");
    cloud.storeLibraryCache(userId, asset, input.bundle);
    updateHead(head.id, (latest) => {
      assert(latest.attempt?.id === attempt.id, "Draft attempt changed", "uncertain_write");
      latest.assetId = clean.id; latest.ownerId = clean.ownerId; latest.revision = clean.revision;
      latest.status = latest.versionId === attempt.versionId ? "synced" : "pending";
      delete latest.attempt; delete latest.error; delete latest.remoteRevision;
    });
    locked(() => { const catalog = manifest(); catalog.assets = [...catalog.assets.filter((item) => item.id !== clean.id), clean]; writeManifest(catalog); });
  }
  async function reconcile(head, assets) {
    const attempt = head.attempt; if (!attempt) return;
    const input = attempt.payload;
    const candidates = assets.filter((asset) => (!input.id || asset.id === input.id) && asset.kind === input.kind && asset.workspaceId === input.workspaceId && asset.slug === input.slug
      && (input.id || asset.ownerId === userId) && asset.revision >= input.expectedRevision + 1 && (!attempt.baselineIds.includes(asset.id) || !!input.id));
    if (candidates.length !== 1) return;
    const asset = candidates[0];
    // Immutable history proves the actor as well as the exact intended contents.
    const rows = await client.listRevisions(asset.id);
    const history = (Array.isArray(rows) ? rows : rows.revisions || []).find((item) => item.revision === input.expectedRevision + 1);
    if (!history || (history.created_by || history.createdBy) !== userId || !history.bundle || bundleHash(history.bundle) !== attempt.bundleHash || history.title !== input.title || (history.description || "") !== input.description || (history.message || "") !== input.message) return;
    // A later unrelated revision cannot silently anchor a queued edit to that head.
    if (asset.revision !== input.expectedRevision + 1) { updateHead(head.id, (latest) => { latest.status = "conflict"; latest.remoteRevision = asset.revision; latest.error = "Remote changed after the uncertain write"; }); return; }
    await currentUser(); acknowledge(head, attempt, { ...asset, bundle: history.bundle });
  }
  async function flush(head, assets) {
    if (head.archived || !["local", "pending"].includes(head.status) || head.attempt) return;
    await currentUser();
    // Check membership before the sending checkpoint; a read failure is safe to retry.
    if (head.assetId) {
      const live = await client.getAssetMetadata(head.assetId);
      const clean = metadata(live), input = effective(head, draft(head));
      assert(clean.kind === input.kind && clean.workspaceId === input.workspaceId && clean.slug === input.slug, "Cloud asset identity changed");
      if (clean.revision !== input.expectedRevision) { await rememberRemote(live); updateHead(head.id, (latest) => { latest.status = "conflict"; latest.remoteRevision = clean.revision; }); return; }
    }
    const attempt = locked(() => {
      const latest = read(headFile(head.id)); if (latest.attempt || !["local", "pending"].includes(latest.status)) return null;
      const value = draft(latest), payload = effective(latest, value);
      const record = { id: crypto.randomUUID(), versionId: latest.versionId, payload, bundleHash: value.bundleHash, baselineIds: assets.map((item) => item.id), startedAt: timestamp() };
      durable(target("attempts", `${record.id}.json`), { userId, localId: latest.id, ...record }, true);
      latest.attempt = record; latest.status = "sending"; durable(headFile(latest.id), latest); return record;
    });
    if (!attempt) return;
    try {
      const response = await client.saveAsset(attempt.payload);
      await currentUser(); acknowledge(head, attempt, response.asset || response);
    } catch (error) {
      const status = error.status || error.statusCode || 0;
      const conflict = status === 409 || error.code === "revision_conflict";
      const definite = [400, 401, 403, 404, 422].includes(status) && error.code !== "account_changed";
      updateHead(head.id, (latest) => {
        latest.status = conflict ? "conflict" : definite ? "error" : "uncertain";
        latest.error = conflict ? "revision_conflict" : definite ? error.code || "write_rejected" : "Write response was not confirmed; reconcile or resolve before retrying";
        if (conflict || definite) delete latest.attempt;
      });
      if (conflict && attempt.payload.id) {
        // A CAS race can occur after the preflight read. Preserve and expose the
        // new remote side immediately rather than waiting out the poll cooldown.
        try {
          const remote = await rememberRemote(await client.getAssetMetadata(attempt.payload.id));
          updateHead(head.id, (latest) => { latest.remoteRevision = remote.revision; });
        } catch (comparisonError) {
          if ([401, 403, 404].includes(comparisonError.status)) cloud.markLibraryAccess(userId, attempt.payload.id, false);
        }
      } else if (conflict) {
        const input = attempt.payload;
        try {
          const candidates = (await client.listAssets()).map(metadata).filter((asset) => asset.kind === input.kind && asset.workspaceId === input.workspaceId && asset.slug === input.slug && (input.workspaceId || asset.ownerId === userId));
          if (candidates.length === 1) {
            const remote = await rememberRemote(candidates[0]);
            // This only connects the comparison view. The draft remains a
            // conflict and can never turn into an update without resolution.
            updateHead(head.id, (latest) => { latest.assetId = remote.id; latest.remoteRevision = remote.revision; });
          }
        } catch { /* Keep the draft conflict if the remote side cannot be read. */ }
      }
    }
  }
  async function runSync({ force = false } = {}) {
    let release; const until = Date.now() + 30000;
    while (!(release = acquire("sync"))) { if (Date.now() > until) throw fault("Another process is synchronizing the library", "library_busy"); await delay(25); }
    try {
      await currentUser();
      // An abandoned sending checkpoint is an unknown outcome, not a retry ticket.
      locked(() => { for (const head of heads()) if (head.attempt && ["sending", "pending"].includes(head.status)) { head.status = "uncertain"; durable(headFile(head.id), head); } });
      let catalog = locked(manifest), local = locked(heads);
      const due = !catalog.lastSyncedAt || now() - Date.parse(catalog.lastSyncedAt) >= 180000;
      const reconcileDue = local.some((head) => !head.archived && head.status === "uncertain" && (!head.lastReconciledAt || force || due));
      const dirty = reconcileDue || local.some((head) => !head.archived && ["local", "pending"].includes(head.status));
      let assets = catalog.assets;
      if (force || due || reconcileDue) assets = await refreshMetadata();
      // Attempts always start against a known metadata baseline; a dirty first run
      // therefore polls even if a previous catalog has no timestamp.
      if (dirty) {
        if (reconcileDue) for (const head of locked(heads)) if (!head.archived && head.status === "uncertain") {
          await reconcile(head, assets);
          updateHead(head.id, (latest) => { if (latest.status === "uncertain") latest.lastReconciledAt = timestamp(); });
        }
        for (const head of locked(heads)) await flush(head, assets);
      }
      locked(() => { const value = manifest(); value.state = "idle"; delete value.error; writeManifest(value); });
    } catch (error) {
      locked(() => { const value = manifest(); value.state = ["network_error", "offline", "fetch_failed", "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT"].includes(error.code) ? "offline" : "error"; value.error = error.code || "sync_failed"; writeManifest(value); });
    } finally { release(); }
    return snapshot();
  }
  function sync(options = {}) {
    if (flights.has(key)) return flights.get(key);
    // UI polling already passed the service account guard. During the metadata
    // cooldown, a clean content snapshot needs no Auth or REST request at all.
    const quiet = locked(() => {
      const catalog = manifest();
      return !options.force && catalog.lastSyncedAt && now() - Date.parse(catalog.lastSyncedAt) < 180000
        && !heads().some((head) => !head.archived && (["local", "pending", "sending"].includes(head.status) || (head.status === "uncertain" && !head.lastReconciledAt)));
    });
    if (quiet) return Promise.resolve(snapshot());
    const promise = runSync(options).finally(() => flights.delete(key)).then(() => snapshot()); flights.set(key, promise); return promise;
  }
  async function remoteFor(head) {
    const input = draft(head).payload, baseId = head.assetId || input.id;
    let remote;
    if (baseId) remote = metadata(await client.getAssetMetadata(baseId));
    else {
      const candidates = (await client.listAssets()).map(metadata).filter((asset) => asset.kind === input.kind && asset.workspaceId === input.workspaceId && asset.slug === input.slug && (input.workspaceId || asset.ownerId === userId));
      assert(candidates.length <= 1, "More than one remote asset matches this conflict; inspect manually", "ambiguous_conflict");
      remote = candidates[0] || null;
    }
    if (!remote) return null;
    assert(remote.kind === input.kind && remote.workspaceId === input.workspaceId && remote.slug === input.slug, "Remote conflict identity changed", "revision_conflict");
    await rememberRemote(remote); await currentUser();
    const cached = cloud.readLibraryCache(userId, remote.id, remote.revision), digest = bundleHash(cached.bundle);
    return { ...remote, ...metadata(cached.asset), id: `cloud:${remote.id}`, assetId: remote.id, bundle: cached.bundle, bundleHash: digest, localHash: digest, syncState: "synced" };
  }
  async function conflictRemote(id) {
    localId(id); await currentUser();
    const head = locked(() => heads().find((value) => value.id === id && !value.archived));
    assert(head && ["conflict", "uncertain", "error"].includes(head.status), "Draft has no conflict");
    return remoteFor(head);
  }
  async function resolveConflict(id, resolution, { expectedLocalHash, expectedRemoteRevision } = {}) {
    localId(id); assert(["remote", "copy"].includes(resolution), "Invalid conflict resolution");
    await currentUser();
    const initial = locked(() => { const head = read(headFile(id)); assert(head.userId === userId && !head.archived && ["conflict", "uncertain", "error"].includes(head.status), "Draft has no conflict"); return { head, value: draft(head) }; });
    if (!expectedLocalHash || entry(initial.head).localHash !== expectedLocalHash) throw fault("Local conflict changed; compare again", "local_draft_conflict", 409);
    const remoteEntry = await remoteFor(initial.head);
    const remote = remoteEntry ? { ...remoteEntry, id: remoteEntry.assetId } : null;
    if (expectedRemoteRevision === undefined || (remote?.revision ?? null) !== expectedRemoteRevision) throw fault("Remote conflict changed; compare again", "revision_conflict", 409);
    if (!remote && resolution === "remote" && initial.head.status === "conflict") throw fault("The conflicting remote side is unavailable; refresh before choosing it", "conflict_remote_unavailable", 409);
    const result = locked(() => {
      const head = read(headFile(id)), value = draft(head);
      if (entry(head).localHash !== expectedLocalHash || head.versionId !== initial.head.versionId || head.attempt?.id !== initial.head.attempt?.id) throw fault("Local conflict changed", "local_draft_conflict", 409);
      let copied;
      if (resolution === "copy") {
        const slug = `${value.payload.slug.slice(0, 110)}-copy-${crypto.randomUUID().slice(0, 8)}`;
        copied = stageUnlocked({ ...value.payload, id: null, expectedRevision: 0, slug });
      }
      head.archived = true; head.archivedAt = timestamp(); head.resolution = resolution; durable(headFile(id), head);
      if (remote) { const catalog = manifest(); catalog.assets = [...catalog.assets.filter((asset) => asset.id !== remote.id), remote]; writeManifest(catalog); }
      return { ...(copied ? { entry: copied } : {}), archivedId: id };
    });
    return { ...result, snapshot: snapshot() };
  }
  return { snapshot, stageConfirmed, sync, conflictRemote, resolveConflict };
}
