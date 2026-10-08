import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPreview, commitPreview } from '../src/store.mjs';
import { cloudRoot, cloudClient, cloudStatus, previewLocalPublish, commitSourcePreview, previewSourceAgent, listSourceAgents, prepareSourceRun } from '../src/cloud-service.mjs';
import { processSchedules, cloudRecordVisible, openCloudPortal } from '../src/dashboard-server.mjs';
const uid = '10000000-0000-4000-8000-000000000001', aid = '20000000-0000-4000-8000-000000000001';
const spec = { id: 'demo-agent', displayName: '測試助理', description: '測試', purpose: '整理資訊', systemPrompt: '依照需求整理資訊', memory: 'private note', skills: [{ id: 'summarize', name: '摘要', description: '整理資料', triggers: ['摘要'], steps: ['閱讀內容', '整理重點'], successCriteria: ['完整摘要'] }], workflows: [{ id: 'daily', name: '每日摘要', description: '整理流程', nodes: [{ id: 'start', name: '摘要', type: 'skill', skillId: 'summarize', instructions: '完成摘要' }] }] };
test('sandboxed panel opener uses only the fixed public portal and no shell', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    let invocation;
    const result = await openCloudPortal({ platform, url: 'file:///private', spawnImpl: (command, args, options) => {
      invocation = { command, args, options }; const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('spawn')); return child;
    } });
    assert.equal(result.opened, true);
    assert.equal(invocation.args.at(-1), 'https://inventra.github.io/agent-teams-builder/');
    assert.equal(invocation.options.shell, undefined);
    assert.equal(invocation.command, { darwin: 'open', win32: 'rundll32.exe', linux: 'xdg-open' }[platform]);
  }
});
test('local preview publication, cloud training and execution use cloud versions without editing private SOPs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vixo-source-')); const oldRoot = process.env.AGENT_TEAMS_HOME, oldFetch = globalThis.fetch;
  process.env.AGENT_TEAMS_HOME = root; let asset = null; let userId = uid;
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return reply({ id: userId, email: 'test@devices.vixo.invalid' });
    if (url.pathname === '/rest/v1/vixo_assets') return reply(asset ? [asset] : []);
    if (url.pathname === '/rest/v1/rpc/vixo_save_asset') {
      const body = JSON.parse(options.body);
      if (asset && body.p_expected_revision !== asset.revision) return reply({ code: '40001', message: 'revision_conflict' }, 400);
      asset = { id: aid, owner_id: uid, workspace_id: null, kind: body.p_kind, slug: body.p_slug, title: body.p_title, description: body.p_description, bundle: body.p_bundle, revision: (asset?.revision || 0) + 1 };
      return reply(asset);
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  try {
    const local = createPreview({ action: 'create', spec }); commitPreview({ token: local.token, userConfirmation: '確認' });
    const privatePath = path.join(root, spec.id, 'agent.json'); const before = fs.readFileSync(privatePath, 'utf8');
    fs.writeFileSync(path.join(cloudRoot(), 'session.json'), JSON.stringify({ access_token: 'test-access' }));
    const preview = await previewLocalPublish({ agent: spec.id });
    assert.equal(preview.bundle.spec.memory, ''); assert.equal(asset, null);
    await assert.rejects(commitSourcePreview({ token: preview.token, userConfirmation: 'maybe' }));
    const result = await commitSourcePreview({ token: preview.token, userConfirmation: '確認' });
    assert.equal(result.status, 'synced'); assert.equal(asset.revision, 1);
    assert.equal((await listSourceAgents())[0].id, `cloud:${aid}`);
    const update = await previewSourceAgent({ action: 'update', spec: { ...spec, id: `cloud:${aid}`, systemPrompt: '使用雲端第二版 SOP' } });
    await commitSourcePreview({ token: update.token, userConfirmation: '確認' });
    const prepared = await prepareSourceRun({ agent: `cloud:${aid}`, task: '摘要影片內容' });
    assert.match(prepared.prompt, /雲端第二版 SOP/); assert.equal(prepared.cloud.revision, 2);
    assert.equal(fs.readFileSync(privatePath, 'utf8'), before);
    const stale = await previewSourceAgent({ action: 'update', spec, expectedRevision: 1 });
    const conflict = await commitSourcePreview({ token: stale.token, userConfirmation: '確認' });
    assert.equal(conflict.status, 'conflict'); assert.equal(asset.revision, 2); assert.ok(fs.existsSync(conflict.conflictPath));
    const crossUser = await previewSourceAgent({ action: 'update', spec }); userId = '30000000-0000-4000-8000-000000000001';
    await assert.rejects(commitSourcePreview({ token: crossUser.token, userConfirmation: '確認' }), /其他帳號/);
  } finally { globalThis.fetch = oldFetch; if (oldRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = oldRoot; fs.rmSync(root, { recursive: true, force: true }); }
});
test('slow cloud preparation cannot launch one schedule twice and local schedules retain their source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vixo-schedule-')); const old = process.env.AGENT_TEAMS_HOME, oldFetch = globalThis.fetch; process.env.AGENT_TEAMS_HOME = root;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: uid }));
  let release; const gate = new Promise((resolve) => { release = resolve; }); let entered; const started = new Promise((resolve) => { entered = resolve; });
  const launches = [], sources = []; const now = new Date(2026, 9, 8, 9, 30);
  try {
    const directory = path.join(root, '.system'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(cloudRoot(), 'session.json'), JSON.stringify({ access_token: 'test' }));
    fs.writeFileSync(path.join(directory, 'schedules.json'), JSON.stringify([
      { id: 'cloud', enabled: true, time: '09:30', agentId: `cloud:${aid}`, cloud: { userId: uid }, workflowId: 'daily' },
      { id: 'local', enabled: true, time: '09:30', agentId: 'demo-agent', workflowId: 'daily' }
    ]));
    const options = { prepareCloud: async () => { sources.push('cloud'); entered(); await gate; return {}; }, prepareLocal: () => { sources.push('local'); return {}; }, launch: (input) => launches.push(input.agent) };
    const first = processSchedules(now, options); await started; await processSchedules(now, options);
    assert.equal(launches.length, 0); release(); await first; await processSchedules(now, options);
    assert.deepEqual(sources, ['cloud', 'local']); assert.equal(launches.length, 2);
  } finally { globalThis.fetch = oldFetch; if (old === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = old; fs.rmSync(root, { recursive: true, force: true }); }
});

test('cloud run history is scoped to the connected identity including legacy and disconnected states', () => {
  const own = { agentId: `cloud:${aid}`, cloud: { userId: uid } };
  assert.equal(cloudRecordVisible(own, uid), true);
  assert.equal(cloudRecordVisible(own, 'other-user'), false);
  assert.equal(cloudRecordVisible(own, null), false);
  assert.equal(cloudRecordVisible({ agentId: `cloud:${aid}` }, uid), false);
  assert.equal(cloudRecordVisible({ agentId: 'local-agent' }, null), true);
  assert.equal(cloudRecordVisible({ agentId: 'local-agent' }, uid), false);
});
