import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCloudClient } from '../web/cloud-client.mjs';
import { agentTeamsRoot, ensureAgentTeamsRoot, getAgent, listAgents, normalizeSpec, prepareRun, prepareWorkflowRun } from './store.mjs';
import { exportAgentBundle, exportSkillBundle, exportWorkflowBundle, exportSpecBundle, validateCloudBundle, bundleHash } from './cloud-bundle.mjs';
import { createCloudSync } from './cloud-sync.mjs';
import { createLocalLibrary } from './local-library.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../web/cloud-config.json', import.meta.url), 'utf8'));
const affirmative = /^(確認|同意|是|好|可以|請建立|請修改|yes\b|confirm\b|approved\b|ok\b)/i;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const authViews = new Map(), syncJobs = new Map();
const fault = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), { code, status });
function read(file, fallback = null) {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw fault('拒絕讀取符號連結'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function directory(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw fault('路徑超出工作區');
  let current = root;
  for (const item of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (item) current = path.join(current, item);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw fault('拒絕使用符號連結工作區');
  }
}
export function cloudRoot() {
  const base = ensureAgentTeamsRoot(), root = path.join(base, '.system', 'cloud');
  directory(base, root); return root;
}
function write(file, value) {
  directory(cloudRoot(), path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw fault('拒絕覆寫符號連結');
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file);
}
function sessionFile() { return path.join(cloudRoot(), 'session.json'); }
function storedSession() { return read(sessionFile()); }
function sessionKey() { const s = storedSession(); return s?.access_token ? crypto.createHash('sha256').update(s.access_token).digest('hex') : ''; }
export function cloudConnected() { return Boolean(storedSession()?.access_token); }
export function cloudPortalUrl() { return config.portalUrl; }
export function invalidateAccountView() { authViews.delete(cloudRoot()); }
export function cloudClient(options = {}) {
  const file = sessionFile();
  return createCloudClient({ ...config, redirectTo: config.portalUrl, getSession: () => read(file), saveSession: (session) => {
    const previous = read(file);
    if (!session || previous?.user?.id !== session.user?.id) invalidateAccountView();
    if (session) write(file, session); else fs.rmSync(file, { force: true });
  }, ...options });
}
export function cloudSync(client = cloudClient()) { return createCloudSync({ client, cloudRoot: cloudRoot() }); }
function ownership() { return read(path.join(cloudRoot(), 'legacy-owner.json'), { formatVersion: 1, userId: null, agentIds: listAgents().map(a => a.id) }); }
export function ownsLegacy(userId, agentId) { const owner = ownership(); return owner.userId === userId && owner.agentIds?.includes(String(agentId).replace(/^legacy:/, '')); }
function legacyInfo(userId) { const owner = ownership(); return { legacyImportAvailable: !owner.userId && owner.agentIds?.length > 0, legacyCount: owner.userId && owner.userId !== userId ? 0 : (owner.agentIds?.length || 0) }; }
export async function cloudStatus({ force = false, allowOffline = true } = {}) {
  const root = cloudRoot(), key = sessionKey();
  if (!key) { authViews.delete(root); return { connected: false, source: 'hybrid', user: null, access: null, offline: false, portalUrl: config.portalUrl }; }
  const old = authViews.get(root);
  if (!force && old?.key === key && old.until > Date.now()) return old.value;
  if (old?.key === key && old.promise) return old.promise;
  const promise = (async () => {
    try {
      const client = cloudClient(), user = await client.getUser(), access = await client.getAccess();
      if (!uuid.test(user.id) || access.userId !== user.id || storedSession()?.user?.id !== user.id) throw fault('帳號已變更，請重新載入。', 'account_changed', 401);
      const value = { connected: true, source: 'hybrid', user, access, offline: false, portalUrl: config.portalUrl, ...legacyInfo(user.id) };
      write(path.join(root, 'verified-account.json'), { user, access, verifiedAt: Date.now() });
      authViews.set(root, { key: sessionKey(), value, until: Date.now() + 30_000 }); return value;
    } catch (error) {
      authViews.delete(root);
      const current = storedSession(), verified = read(path.join(root, 'verified-account.json'));
      // Offline editing is scoped to a still-valid, previously verified identity.
      // This never authorizes execution or a cloud write.
      if (allowOffline && error.code === 'network_error' && sessionKey() === key && current?.user?.id && current.expires_at > Date.now() / 1000 && verified?.user?.id === current.user.id && verified.access?.status === 'approved') {
        return { connected: true, source: 'hybrid', user: verified.user, access: verified.access, offline: true, portalUrl: config.portalUrl, ...legacyInfo(current.user.id) };
      }
      throw error;
    }
  })();
  authViews.set(root, { key, promise, until: 0 }); return promise;
}
export async function requireAccount({ force = false, allowOffline = false } = {}) {
  const state = await cloudStatus({ force, allowOffline });
  if (!state.connected) throw fault('請先登入 VIXO。', 'unauthorized', 401);
  if (state.access?.status !== 'approved') throw fault(state.access?.status === 'disabled' ? '帳號已停用，請聯絡 Kevin。' : '帳號待 Kevin 審核。', `account_${state.access?.status || 'unconfirmed'}`, 403);
  if (state.offline && !allowOffline) throw fault('目前離線，請連線後再執行或同步。', 'network_error', 503);
  return state;
}
export function assertAccount(userId) { if (!cloudConnected() || storedSession()?.user?.id !== userId) throw fault('帳號已變更，請重新操作。', 'account_changed', 401); }
function localLibrary(state) { return createLocalLibrary({ client: cloudClient(), cloudRoot: cloudRoot(), userId: state.user.id }); }
function backgroundSync(state, force = false) {
  const key = `${cloudRoot()}:${state.user.id}`;
  if (syncJobs.has(key)) return syncJobs.get(key);
  const promise = localLibrary(state).sync({ force }).finally(() => { if (syncJobs.get(key) === promise) syncJobs.delete(key); });
  syncJobs.set(key, promise); promise.catch(() => {}); return promise;
}
export async function syncLibrary({ force = false } = {}) {
  const state = await requireAccount({ force: true });
  await backgroundSync(state, force); assertAccount(state.user.id);
  const snapshot = await libraryState({ background: false });
  assertAccount(state.user.id);
  if (snapshot.userId !== state.user.id) throw fault('帳號已變更。', 'account_changed', 401);
  return snapshot;
}
function legacyEntries(state) {
  const owner = ownership(); if (owner.userId !== state.user.id) return [];
  return (owner.agentIds || []).flatMap(id => {
    try {
      const agent = getAgent(id); let bundle = null, error = null;
      try { bundle = exportAgentBundle({ agent, agentDirectory: path.join(agentTeamsRoot(), id) }); } catch { error = '這份本機內容尚未符合雲端套件格式，可在本機使用；請整理後再同步。'; }
      return [{ id: `legacy:${id}`, assetId: null, hasCloudCopy: false, syncMode: 'local-only', kind: 'agent', slug: id, title: agent.displayName, description: agent.description, revision: agent.version, workspaceId: null, ownerId: state.user.id, bundle, bundleHash: bundle ? bundleHash(bundle) : null, syncState: 'local', legacy: true, ...(error ? { error, agent } : {}) }];
    } catch (error) { if (String(error.message).startsWith('Agent not found:')) return []; throw error; }
  });
}
export async function libraryState({ background = true } = {}) {
  const state = await requireAccount({ allowOffline: true });
  const library = localLibrary(state); let snapshot = library.snapshot();
  if (!state.offline && background) {
    const job = backgroundSync(state);
    if (!snapshot.sync?.lastSyncedAt && !snapshot.entries.length) { await job; snapshot = library.snapshot(); }
  }
  if (storedSession()?.user?.id !== state.user.id) throw fault('帳號已變更。', 'account_changed', 401);
  let entries = snapshot.entries;
  if (state.offline) entries = entries.filter(entry => entry.id.startsWith('local:') && !entry.assetId && !entry.workspaceId);
  const local = legacyEntries(state);
  const hashes = new Set(entries.filter(e => e.bundle && e.kind === 'agent' && !e.workspaceId && (!e.ownerId || e.ownerId === state.user.id)).map(e => bundleHash(e.bundle)));
  entries = [...entries, ...local.filter(e => !hashes.has(e.bundleHash))];
  return { entries: entries.map(e => ({ ...e, bundleHash: e.bundleHash || (e.bundle ? bundleHash(e.bundle) : null) })), sync: { ...snapshot.sync, offline: state.offline }, userId: state.user.id, offline: state.offline };
}
export async function importLegacy({ userConfirmation } = {}) {
  if (!affirmative.test(String(userConfirmation || '').trim())) throw fault('請先確認匯入這台電腦的舊 Agent。');
  const state = await requireAccount({ force: true }), file = path.join(cloudRoot(), 'legacy-owner.json'), lock = `${file}.lock`;
  let fd; try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw fault('匯入正在進行，請稍後再試。', 'conflict', 409); }
  try {
    const owner = ownership();
    if (owner.userId && owner.userId !== state.user.id) throw fault('本機舊資料已屬於其他帳號。', 'forbidden', 403);
    write(file, { ...owner, userId: state.user.id, confirmedAt: new Date().toISOString() });
    return { imported: owner.agentIds.length };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
async function entryFor(reference, options) {
  const snapshot = await libraryState(options);
  if (options?.expectedUserId && snapshot.userId !== options.expectedUserId) throw fault('帳號已變更。', 'account_changed', 401);
  const needle = String(reference || '').toLowerCase();
  const direct = snapshot.entries.find(e => e.id === reference) || snapshot.entries.find(e => e.syncState === 'synced' && e.assetId && `cloud:${e.assetId}` === reference);
  if (direct) return direct;
  const candidates = snapshot.entries.filter(e => [e.slug, e.title, ...(e.bundle?.spec.aliases || e.agent?.aliases || [])].some(name => String(name).toLowerCase() === needle));
  if (candidates.length !== 1) throw fault(candidates.length ? '名稱重複，請使用完整項目 ID。' : '找不到此帳號的項目。', 'not_found', 404);
  return candidates[0];
}
function agentFrom(entry) {
  if (entry.kind !== 'agent') throw fault('這個項目不是 Agent');
  return { ...(entry.bundle?.spec || entry.agent), id: entry.id, version: entry.revision || entry.bundle?.spec.version, syncState: entry.syncState, syncMode: entry.syncMode, assetId: entry.assetId || null, hasCloudCopy: Boolean(entry.assetId), source: entry.legacy ? 'local' : entry.id.startsWith('cloud:') ? 'cloud' : 'local',
    ...(entry.assetId || entry.id.startsWith('cloud:') ? { cloud: { assetId: entry.assetId || entry.id.slice(6), revision: entry.revision, workspaceId: entry.workspaceId, slug: entry.slug } } : {}) };
}
export async function getSourceAgent(reference) { return agentFrom(await entryFor(reference)); }
export async function listSourceAgents() { return (await libraryState()).entries.filter(e => e.kind === 'agent').map(agentFrom); }
export async function listLocalAgents() {
  const state = await requireAccount(); return legacyEntries(state).map(e => ({ ...getAgent(e.slug), id: e.slug }));
}
export async function prepareSourceRun(input, workflow = false) {
  const state = await requireAccount({ force: true });
  const entry = await entryFor(input.agent, { expectedUserId: state.user.id });
  assertAccount(state.user.id);
  if (entry.legacy) {
    if (!ownsLegacy(state.user.id, entry.slug)) throw fault('無法存取本機項目。', 'forbidden', 403);
    const prepared = workflow ? prepareWorkflowRun({ ...input, agent: entry.slug }) : prepareRun({ ...input, agent: entry.slug });
    return { ...prepared, agent: { ...prepared.agent, id: entry.id }, local: { userId: state.user.id, id: entry.id, cacheDirectory: path.join(agentTeamsRoot(), entry.slug) } };
  }
  if (entry.id.startsWith('cloud:') || entry.syncState === 'synced') {
    const assetId = entry.assetId || entry.id.slice(6);
    const prepared = await cloudSync().prepareAssetRun({ assetId, task: input.task || '執行這個 Workflow', skill: input.skill, workflow: input.workflow, approvalMode: input.approvalMode || 'manual' });
    assertAccount(state.user.id);
    if (prepared.cloud.userId !== state.user.id) throw fault('帳號已變更。', 'account_changed', 401);
    return { ...prepared, agent: { ...prepared.agent, id: `cloud:${assetId}` } };
  }
  if (entry.assetId) await cloudClient().getAssetMetadata(entry.assetId);
  if (entry.workspaceId) throw fault('團隊修改請先同步後再執行。', 'sync_required', 409);
  const prepared = await cloudSync().prepareLocalBundleRun({ bundle: entry.bundle, localId: entry.id, baseAssetId: entry.assetId || undefined, task: input.task || '執行這個 Workflow', skill: input.skill, workflow: input.workflow, approvalMode: input.approvalMode || 'manual' });
  assertAccount(state.user.id);
  if (prepared.local.userId !== state.user.id) throw fault('帳號已變更。', 'account_changed', 401);
  return { ...prepared, local: { ...prepared.local, syncMode: entry.syncMode, hasCloudCopy: Boolean(entry.assetId) } };
}
async function saveDraft(payload, state) {
  assertAccount(state.user.id);
  const token = `local_${crypto.randomBytes(32).toString('hex')}`;
  const draft = { ...payload, userId: state.user.id, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
  validateCloudBundle(draft.bundle);
  write(path.join(cloudRoot(), 'previews', `${token}.json`), draft);
  return { token, expiresAt: draft.expiresAt, source: 'local', ...payload, spec: payload.bundle.spec, entry: { ...payload, assetId: payload.id || null, hasCloudCopy: Boolean(payload.id), syncState: payload.syncMode === 'local-only' ? 'local-only' : 'pending' } };
}
export async function previewLibraryEntry(input) {
  const state = await requireAccount({ force: true, allowOffline: true });
  if (input.expectedUserId && input.expectedUserId !== state.user.id) throw fault('帳號已變更。', 'account_changed', 401);
  const previous = input.id ? await entryFor(input.id, { background: false, expectedUserId: state.user.id }) : null;
  const bundle = validateCloudBundle(input.bundle);
  if (previous?.legacy && !previous.bundle) throw fault('請先整理本機內容的可攜格式，再建立同步草稿。');
  if (previous && previous.kind !== bundle.kind) throw fault('不能更改項目種類。');
  if (state.offline && (previous?.assetId || previous?.workspaceId || previous?.legacy || input.workspaceId)) throw fault('離線時只可編輯私人本機草稿。', 'network_error', 503);
  const remoteId = previous?.assetId || (previous?.id.startsWith('cloud:') ? previous.id.slice(6) : null);
  const workspaceId = previous ? previous.workspaceId : input.workspaceId || null;
  if (workspaceId && state.offline) throw fault('團隊分享需要連線。', 'network_error', 503);
  const syncMode = input.syncMode ?? previous?.syncMode ?? (remoteId || workspaceId ? 'cloud' : 'local-only');
  if (!['local-only', 'cloud'].includes(syncMode)) throw fault('未知同步模式。');
  if (syncMode === 'local-only' && (remoteId || workspaceId)) throw fault('已有雲端版本或團隊範圍，請另存本機副本。', 'sync_mode_locked', 409);
  return saveDraft({ action: previous ? 'update' : 'create', id: remoteId, localId: previous?.id.startsWith('local:') ? previous.id : undefined, kind: bundle.kind,
    slug: previous?.slug || input.slug || bundle.spec.id, title: input.title || bundle.spec.displayName || bundle.spec.name, description: input.description ?? previous?.description ?? '', bundle, workspaceId,
    expectedRevision: input.expectedRevision ?? (remoteId ? previous.revision : 0), expectedHash: previous?.bundleHash, expectedLocalHash: previous?.localHash, originalId: previous?.id, syncMode, message: 'Confirmed local update' }, state);
}
export async function previewSourceAgent({ action, spec, cloudAssetId, expectedRevision, workspaceId = null, syncMode }) {
  const state = await requireAccount({ force: true, allowOffline: true });
  if (action === 'create' && (await libraryState()).entries.some(e => e.kind === 'agent' && e.slug === spec.id)) throw fault('Agent 已存在，請使用更新。', 'already_exists', 409);
  const previous = action === 'update' ? await entryFor(cloudAssetId ? `cloud:${cloudAssetId}` : spec.id, { expectedUserId: state.user.id }) : null;
  if (previous?.legacy && !previous.bundle) throw fault('請先整理本機內容的可攜格式，再建立同步草稿。');
  const clean = normalizeSpec({ ...spec, id: previous?.slug || spec.id }, previous?.bundle?.spec || null);
  const bundle = exportSpecBundle({ kind: 'agent', spec: { ...clean, memory: '' }, files: previous?.bundle?.files || [], dependencies: previous?.bundle?.dependencies || [], requirements: previous?.bundle?.requirements || { platforms: [], tools: [] } });
  return previewLibraryEntry({ expectedUserId: state.user.id, id: previous?.id, bundle, title: clean.displayName, description: clean.description, expectedRevision, workspaceId, syncMode });
}
export async function previewLocalPublish({ agent: reference, kind = 'agent', skillId, workflowId, workspaceId = null, id = null, expectedRevision = 0 }) {
  const state = await requireAccount({ force: true });
  const localId = String(reference).replace(/^legacy:/, '');
  if (!ownsLegacy(state.user.id, localId)) throw fault('這個本機 Agent 不屬於目前帳號。', 'forbidden', 403);
  const agent = getAgent(localId), input = { agent, agentDirectory: path.join(agentTeamsRoot(), agent.id) };
  const bundle = kind === 'agent' ? exportAgentBundle(input) : kind === 'skill' ? exportSkillBundle({ ...input, skillId }) : kind === 'workflow' ? exportWorkflowBundle({ ...input, workflowId }) : null;
  if (!bundle) throw fault('未知套件種類');
  return saveDraft({ id, kind, slug: bundle.spec.id, title: bundle.spec.displayName || bundle.spec.name, description: bundle.spec.description || '', bundle, workspaceId, expectedRevision, syncMode: 'cloud', message: 'Confirmed local publication' }, state);
}
export async function commitSourcePreview({ token, userConfirmation }) {
  if (!/^local_[a-f0-9]{64}$/.test(token || '') || !affirmative.test(String(userConfirmation || '').trim())) throw fault('請先檢視完整內容並明確確認儲存。');
  const state = await requireAccount({ force: true, allowOffline: true }), file = path.join(cloudRoot(), 'previews', `${token}.json`), draft = read(file);
  if (!draft || draft.userId !== state.user.id || Date.parse(draft.expiresAt) < Date.now()) throw fault('預覽已過期或屬於其他帳號，請重新預覽。');
  if (draft.originalId) {
    const current = await entryFor(draft.originalId, { background: false, expectedUserId: state.user.id });
    if (current.bundleHash !== draft.expectedHash) throw fault('本機版本已變更，請重新預覽。', 'revision_conflict', 409);
  }
  if (state.offline && (draft.id || draft.workspaceId)) throw fault('離線時只可保存私人本機草稿。', 'network_error', 503);
  let lock; try { lock = fs.openSync(`${file}.lock`, 'wx', 0o600); } catch { throw fault('此預覽已在儲存，請重新整理。', 'conflict', 409); }
  let saved;
  try {
    if (!fs.existsSync(file)) throw fault('此預覽已經儲存。', 'conflict', 409);
    assertAccount(state.user.id);
    // Older previews explicitly described queued synchronization. Preserve them
    // while every newly created preview records the requested mode above.
    saved = await localLibrary(state).stageConfirmed({ ...draft, syncMode: draft.syncMode ?? 'cloud' });
    fs.unlinkSync(file);
  } finally { fs.closeSync(lock); fs.unlinkSync(`${file}.lock`); }
  if (saved.syncMode === 'cloud' && !state.offline) backgroundSync(state).catch(() => {});
  return { ...saved, status: saved.syncMode === 'local-only' ? 'saved-local' : 'queued', message: saved.syncMode === 'local-only' ? '已保存至本機，可在登入核准且連線時執行；尚未加入雲端同步。' : '已保存至本機，等待背景同步。' };
}
export async function enableLibrarySync({ id, expectedHash, expectedLocalHash, userConfirmation }) {
  if (!affirmative.test(String(userConfirmation || '').trim())) throw fault('請先檢視完整內容並明確確認加入雲端同步。');
  if (!/^local:/.test(id || '') || !uuid.test(id.slice(6))) throw fault('只有本機草稿可以加入同步。', 'sync_mode_locked', 409);
  const state = await requireAccount({ force: true });
  const entry = await entryFor(id, { background: false, expectedUserId: state.user.id });
  if (!expectedHash || entry.bundleHash !== expectedHash || !expectedLocalHash || entry.localHash !== expectedLocalHash) throw fault('本機版本已變更，請重新檢視。', 'revision_conflict', 409);
  assertAccount(state.user.id);
  const saved = localLibrary(state).enableSync(id, { expectedLocalHash });
  backgroundSync(state).catch(() => {});
  return { ...saved, status: 'queued', message: '已明確加入雲端同步，等待背景上傳。' };
}
export async function libraryItem(id) {
  const state = await requireAccount({ allowOffline: true }), entry = await entryFor(id, { background: false, expectedUserId: state.user.id });
  let remote = null;
  if (!state.offline && entry.id.startsWith('local:') && ['conflict', 'uncertain', 'error'].includes(entry.syncState)) {
    remote = await localLibrary(state).conflictRemote(entry.id);
  }
  assertAccount(state.user.id);
  return { entry, remote };
}
export async function resolveLibraryConflict({ id, resolution, userConfirmation, expectedHash, remoteRevision }) {
  if (!affirmative.test(String(userConfirmation || '').trim()) || !['remote', 'copy'].includes(resolution)) throw fault('請先比較並確認要保留的版本。');
  const state = await requireAccount({ force: true }), { entry, remote } = await libraryItem(id);
  if (!expectedHash || entry.bundleHash !== expectedHash || (remote?.revision ?? null) !== (remoteRevision ?? null)) throw fault('版本已變更，請重新比較。', 'revision_conflict', 409);
  assertAccount(state.user.id);
  const result = await localLibrary(state).resolveConflict(id, resolution, { expectedLocalHash: entry.localHash, expectedRemoteRevision: remote?.revision ?? entry.remoteRevision ?? null });
  assertAccount(state.user.id);
  backgroundSync(state).catch(() => {}); return result;
}
export const cloudConfiguration = Object.freeze({ ...config });
