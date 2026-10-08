import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCloudClient } from '../web/cloud-client.mjs';
import { agentTeamsRoot, ensureAgentTeamsRoot, getAgent, listAgents, createPreview, commitPreview, normalizeSpec, prepareRun, prepareWorkflowRun } from './store.mjs';
import { exportAgentBundle, exportSkillBundle, exportWorkflowBundle, exportSpecBundle, validateCloudBundle } from './cloud-bundle.mjs';
import { createCloudSync } from './cloud-sync.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../web/cloud-config.json', import.meta.url), 'utf8'));
const affirmative = /^(確認|同意|是|好|可以|請建立|請修改|yes\b|confirm\b|approved\b|ok\b)/i;
const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } };
export function cloudRoot() {
  const root = path.join(ensureAgentTeamsRoot(), '.system', 'cloud');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Cloud directory cannot be a symbolic link');
  return root;
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file);
}
export function cloudConnected() { return Boolean(read(path.join(cloudRoot(), 'session.json'))?.access_token); }
export function cloudPortalUrl() { return config.portalUrl; }
export function cloudClient(options = {}) {
  const file = path.join(cloudRoot(), 'session.json');
  return createCloudClient({ ...config, redirectTo: config.portalUrl, getSession: () => read(file), saveSession: (session) => { if (session) write(file, session); else fs.rmSync(file, { force: true }); }, ...options });
}
export function cloudSync(client = cloudClient()) { return createCloudSync({ client, cloudRoot: cloudRoot() }); }
export async function cloudStatus() {
  const connected = cloudConnected();
  return { connected, source: connected ? 'cloud' : 'local', portalUrl: config.portalUrl, user: connected ? await cloudClient().getUser() : null };
}
function parseReference(reference) {
  const match = /^cloud:([a-f0-9-]{36})(?:@(\d+))?$/.exec(reference || '');
  return match ? { assetId: match[1], ...(match[2] ? { revision: Number(match[2]) } : {}) } : null;
}
async function resolveReference(reference, client = cloudClient()) {
  const parsed = parseReference(reference);
  if (parsed) return parsed;
  const needle = String(reference).trim().toLowerCase();
  const candidates = (await client.listAssets()).filter((asset) => asset.kind === 'agent' && [asset.slug, asset.title].some((name) => name.toLowerCase() === needle));
  if (candidates.length !== 1) throw new Error(candidates.length ? '雲端名稱重複，請使用 cloud:ID 指定項目。' : `找不到雲端 Agent：${reference}`);
  return { assetId: candidates[0].id };
}
export async function getSourceAgent(reference) {
  if (!cloudConnected() && !parseReference(reference)) return getAgent(reference);
  const client = cloudClient(); const { assetId, revision } = await resolveReference(reference, client);
  const pulled = revision ? await cloudSync(client).pullAsset(assetId, { revision }) : null;
  const asset = pulled ? { ...pulled.asset, bundle: pulled.bundle, workspace_id: pulled.asset.workspaceId ?? null } : await client.getAsset(assetId);
  if (asset.kind !== 'agent') throw new Error('這個雲端項目不是 Agent');
  validateCloudBundle(asset.bundle);
  return { ...asset.bundle.spec, id: `cloud:${asset.id}`, version: asset.revision, cloud: { assetId: asset.id, revision: asset.revision, workspaceId: asset.workspace_id, slug: asset.slug } };
}
export async function listSourceAgents() {
  if (!cloudConnected()) return listAgents().map((agent) => getAgent(agent.id));
  const client = cloudClient();
  const assets = (await client.listAssets()).filter((asset) => asset.kind === 'agent');
  const results = [];
  // Keep requests bounded; each read is authorized by current RLS membership.
  for (let index = 0; index < assets.length; index += 8) {
    const batch = assets.slice(index, index + 8);
    const settled = await Promise.allSettled(batch.map((asset) => getSourceAgent(`cloud:${asset.id}`)));
    for (const [offset, result] of settled.entries()) {
      if (result.status === 'fulfilled') results.push(result.value);
      else {
        // Authentication/network failures are not silently downgraded to cached/local data.
        if (!String(result.reason?.message).startsWith('Cloud bundle:')) throw result.reason;
        const asset = batch[offset];
        results.push({ id: `cloud:${asset.id}`, displayName: asset.title, description: `套件需要修正：${result.reason.message}`, version: asset.revision, skills: [], workflows: [], cloud: { assetId: asset.id, invalid: true } });
      }
    }
  }
  return results;
}
export async function prepareSourceRun(input, workflow = false) {
  if (!cloudConnected() && !parseReference(input.agent)) return workflow ? prepareWorkflowRun(input) : prepareRun(input);
  const client = cloudClient(); const reference = await resolveReference(input.agent, client);
  const prepared = await cloudSync(client).prepareAssetRun({ ...reference, task: input.task || '執行這個 Workflow', skill: input.skill, workflow: input.workflow, approvalMode: input.approvalMode || 'manual' });
  return { ...prepared, agent: { ...prepared.agent, id: `cloud:${reference.assetId}` } };
}
async function saveDraft(payload) {
  const user = await cloudClient().getUser();
  const token = `cloud_${crypto.randomBytes(32).toString('hex')}`;
  const draft = { ...payload, userId: user.id, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
  validateCloudBundle(draft.bundle);
  write(path.join(cloudRoot(), 'previews', `${token}.json`), draft);
  return { token, expiresAt: draft.expiresAt, source: 'cloud', ...payload, spec: payload.bundle.spec };
}
export async function previewSourceAgent({ action, spec, cloudAssetId, expectedRevision, workspaceId = null }) {
  if (!cloudConnected()) return createPreview({ action, spec });
  const client = cloudClient();
  let previous = null;
  if (action === 'update') {
    const reference = await resolveReference(cloudAssetId ? `cloud:${cloudAssetId}` : spec.id, client);
    previous = await client.getAsset(reference.assetId);
    if (previous.kind !== 'agent') throw new Error('只能以 Agent 定義更新 Agent');
  }
  const clean = normalizeSpec({ ...spec, id: parseReference(spec.id) ? previous?.slug : spec.id }, previous?.bundle?.spec || null);
  const bundle = exportSpecBundle({ kind: 'agent', spec: { ...clean, memory: '' }, files: previous?.bundle?.files || [], dependencies: previous?.bundle?.dependencies || [], requirements: previous?.bundle?.requirements || { platforms: [], tools: [] } });
  return saveDraft({ action, id: previous?.id || null, kind: 'agent', slug: clean.id, title: clean.displayName, description: clean.description, bundle, workspaceId: previous ? previous.workspace_id : workspaceId, expectedRevision: expectedRevision ?? previous?.revision ?? 0, message: 'Agent SOP confirmed update' });
}
export async function previewLocalPublish({ agent: reference, kind = 'agent', skillId, workflowId, workspaceId = null, id = null, expectedRevision = 0 }) {
  const agent = getAgent(reference);
  const agentDirectory = path.join(agentTeamsRoot(), agent.id);
  const input = { agent, agentDirectory };
  const bundle = kind === 'agent' ? exportAgentBundle(input) : kind === 'skill' ? exportSkillBundle({ ...input, skillId }) : kind === 'workflow' ? exportWorkflowBundle({ ...input, workflowId }) : null;
  if (!bundle) throw new Error('Unknown bundle kind');
  const selected = kind === 'agent' ? agent : kind === 'skill' ? agent.skills.find((item) => item.id === skillId) : agent.workflows.find((item) => item.id === workflowId);
  return saveDraft({ action: id ? 'update' : 'create', id, kind, slug: selected.id, title: selected.displayName || selected.name, description: selected.description, bundle, workspaceId, expectedRevision, message: 'Published from local VIXO' });
}
export async function commitSourcePreview({ token, userConfirmation }) {
  if (!String(token).startsWith('cloud_')) return commitPreview({ token, userConfirmation });
  if (!/^cloud_[a-f0-9]{64}$/.test(token) || !affirmative.test(String(userConfirmation).trim())) throw new Error('請先檢視完整內容並明確確認發布。');
  const file = path.join(cloudRoot(), 'previews', `${token}.json`);
  const draft = read(file);
  const client = cloudClient(); const user = await client.getUser();
  if (!draft || draft.userId !== user.id || Date.parse(draft.expiresAt) < Date.now()) throw new Error('預覽已過期或屬於其他帳號，請重新預覽。');
  const result = await cloudSync(client).pushAsset(draft);
  if (result?.status === 'conflict' || result?.conflict) return result;
  fs.rmSync(file);
  return result;
}
export const cloudConfiguration = Object.freeze({ ...config });
