import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPreview, commitPreview } from '../src/store.mjs';
import { cloudRoot, cloudClient, cloudStatus, previewLocalPublish, commitSourcePreview, previewSourceAgent, listSourceAgents, prepareSourceRun, syncLibrary, libraryState, cloudStatus as sourceStatus } from '../src/cloud-service.mjs';
import { processSchedules, cloudRecordVisible, openCloudPortal, createDashboardServer } from '../src/dashboard-server.mjs';
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
    if (url.pathname === '/rest/v1/rpc/vixo_my_access') return reply({ userId, status: 'approved', isAdmin: false });
    if (url.pathname === '/rest/v1/vixo_assets') return reply(asset ? [asset] : []);
    if (url.pathname === '/rest/v1/vixo_asset_revisions') return reply([]);
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
    fs.writeFileSync(path.join(cloudRoot(), 'legacy-owner.json'), JSON.stringify({formatVersion:1,userId:uid,agentIds:[spec.id]}));
    const drain = async () => { for(let i=0;i<3;i++){ const view=await syncLibrary({force:true}); if(!view.sync.pendingCount)return view; } throw Error('Queue did not drain'); };
    const preview = await previewLocalPublish({ agent: spec.id });
    assert.equal(preview.bundle.spec.memory, ''); assert.equal(asset, null);
    await assert.rejects(commitSourcePreview({ token: preview.token, userConfirmation: 'maybe' }));
    const result = await commitSourcePreview({ token: preview.token, userConfirmation: '確認' });
    assert.equal(result.status, 'queued'); await drain(); assert.equal(asset.revision, 1);
    assert.ok((await listSourceAgents()).some(agent=>agent.cloud?.assetId===aid));
    const update = await previewSourceAgent({ action: 'update', spec: { ...spec, id: `cloud:${aid}`, systemPrompt: '使用雲端第二版 SOP' } });
    await commitSourcePreview({ token: update.token, userConfirmation: '確認' });
    await drain();
    const prepared = await prepareSourceRun({ agent: `cloud:${aid}`, task: '摘要影片內容' });
    assert.match(prepared.prompt, /雲端第二版 SOP/); assert.equal(prepared.cloud.revision, 2);
    assert.equal(fs.readFileSync(privatePath, 'utf8'), before);
    const stale = await previewSourceAgent({ action: 'update', spec, cloudAssetId: aid });
    asset = {...asset, revision:3, bundle:{...asset.bundle,spec:{...asset.bundle.spec,systemPrompt:'另一台裝置第三版'}}};
    const conflict = await commitSourcePreview({ token: stale.token, userConfirmation: '確認' });
    assert.equal(conflict.status, 'queued'); await drain(); assert.equal(asset.revision, 3); assert.ok((await libraryState({background:false})).entries.some(entry=>entry.syncState==='conflict'));
    const crossUser = await previewSourceAgent({ action: 'update', spec, cloudAssetId: aid }); userId = '30000000-0000-4000-8000-000000000001';
    await assert.rejects(commitSourcePreview({ token: crossUser.token, userConfirmation: '確認' }), /其他帳號/);
  } finally { globalThis.fetch = oldFetch; if (oldRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = oldRoot; fs.rmSync(root, { recursive: true, force: true }); }
});
test('slow cloud preparation cannot launch one schedule twice and local schedules retain their source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vixo-schedule-')); const old = process.env.AGENT_TEAMS_HOME, oldFetch = globalThis.fetch; process.env.AGENT_TEAMS_HOME = root;
  globalThis.fetch = async input => new Response(JSON.stringify(new URL(input).pathname.includes('vixo_my_access') ? {userId:uid,status:'approved',isAdmin:false} : {id:uid}));
  let release; const gate = new Promise((resolve) => { release = resolve; }); let entered; const started = new Promise((resolve) => { entered = resolve; });
  const launches = [], sources = []; const now = new Date(2026, 9, 8, 9, 30);
  try {
    const directory = path.join(root, '.system'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(cloudRoot(), 'session.json'), JSON.stringify({ access_token: 'test' }));
    fs.writeFileSync(path.join(cloudRoot(), 'legacy-owner.json'), JSON.stringify({formatVersion:1,userId:uid,agentIds:['demo-agent']}));
    fs.writeFileSync(path.join(directory, 'schedules.json'), JSON.stringify([
      { id: 'cloud', enabled: true, time: '09:30', agentId: `cloud:${aid}`, cloud: { userId: uid }, workflowId: 'daily' },
      { id: 'local', enabled: true, time: '09:30', agentId: 'demo-agent', workflowId: 'daily' }
    ]));
    const options = { prepareCloud: async () => { sources.push('cloud'); entered(); await gate; return { cloud: { userId: uid } }; }, prepareLocal: () => { sources.push('local'); return { local: { userId: uid } }; }, launch: (input) => launches.push(input.agent) };
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

test('local cloud panel exposes pending status but blocks data and account administration behind local authentication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vixo-approval-api-'));
  const oldRoot = process.env.AGENT_TEAMS_HOME, originalFetch = globalThis.fetch;
  process.env.AGENT_TEAMS_HOME = root;
  const { server, token } = createDashboardServer({ token: 'local-test-bearer' });
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === '127.0.0.1') return originalFetch(input, options);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: uid, email: 'qa@accounts.vixo.invalid', app_metadata: { vixo_username: 'qa' } });
    if (url.pathname === '/rest/v1/rpc/vixo_my_access') return Response.json({ userId: uid, status: 'pending', isAdmin: false });
    throw new Error('Unexpected private data request');
  };
  try {
    fs.writeFileSync(path.join(cloudRoot(), 'session.json'), JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/cloud/`;
    const request = (route, body, authenticated = true) => originalFetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const status = await request('status'); assert.equal(status.status, 200);
    const data = await status.json(); assert.equal(data.connected, true); assert.equal(data.access.status, 'pending');
    assert.doesNotMatch(JSON.stringify(data), /fixture-access|fixture-refresh/);
    for (const route of ['assets', 'local-agents', 'accounts']) {
      const response = await request(route); assert.equal(response.status, 403); assert.equal((await response.json()).code, 'account_pending');
    }
    const denied = await request('account-status', { userId: uid, status: 'approved' }); assert.equal(denied.status, 403);
    const unauthenticated = await request('register', { username: 'qa_member', password: 'test-only-password', displayName: 'QA' }, false); assert.equal(unauthenticated.status, 401);
    const existing = await request('register', { username: 'qa_member', password: 'test-only-password', displayName: 'QA' }); assert.equal(existing.status, 409); assert.equal((await existing.json()).code, 'account_already_connected');
  } finally {
    await new Promise(resolve => server.close(resolve)); globalThis.fetch = originalFetch;
    if (oldRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = oldRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
