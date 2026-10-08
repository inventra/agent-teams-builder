import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportSpecBundle } from '../src/cloud-bundle.mjs';
import { invalidateAccountView, libraryState, prepareSourceRun } from '../src/cloud-service.mjs';
import { processSchedules } from '../src/dashboard-server.mjs';

const a = '10000000-0000-4000-8000-000000000001';
const b = '20000000-0000-4000-8000-000000000001';
const assetId = '30000000-0000-4000-8000-000000000001';
const workspaceId = '40000000-0000-4000-8000-000000000001';
const spec = { id: 'race-agent', displayName: '競態測試', description: '測試', purpose: '測試', systemPrompt: '僅整理測試資料', memory: '',
  skills: [{ id: 'summary', name: '摘要', description: '摘要', triggers: ['摘要'], steps: ['整理資料'], successCriteria: ['完成摘要'] }],
  workflows: [{ id: 'daily', name: '每日摘要', description: '摘要', nodes: [{ id: 'start', name: '摘要', type: 'skill', skillId: 'summary', instructions: '摘要' }] }] };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vixo-cloud-race-'));
  const previousRoot = process.env.AGENT_TEAMS_HOME, previousFetch = globalThis.fetch;
  process.env.AGENT_TEAMS_HOME = root;
  const cloud = path.join(root, '.system', 'cloud'); fs.mkdirSync(cloud, { recursive: true });
  const login = id => {
    fs.writeFileSync(path.join(cloud, 'session.json'), JSON.stringify({ access_token: id === a ? 'fixture-race-a' : 'fixture-race-b',
      refresh_token: 'fixture-race-refresh', expires_at: Date.now() / 1000 + 3600, user: { id }, user_verified_at: Date.now() }));
    invalidateAccountView();
  };
  const asset = { id: assetId, owner_id: a, workspace_id: workspaceId, kind: 'agent', slug: spec.id,
    title: spec.displayName, description: spec.description, revision: 1, bundle: exportSpecBundle({ kind: 'agent', spec }) };
  let switchDuringAsset = false, switches = 0;
  // Both test identities may read this team asset. Isolation must therefore
  // come from the operation identity, not an incidental RLS/not-found failure.
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input), actor = options.headers?.authorization?.endsWith('-b') ? b : a;
    if (url.pathname === '/auth/v1/user') return Response.json({ id: actor });
    if (url.pathname === '/rest/v1/rpc/vixo_my_access') return Response.json({ userId: actor, status: 'approved', isAdmin: false });
    if (url.pathname === '/rest/v1/vixo_assets') {
      if (switchDuringAsset && url.searchParams.has('id')) { switchDuringAsset = false; switches++; login(b); }
      return Response.json([asset]);
    }
    throw new Error('Offline race fixture rejects unexpected network route: ' + url.pathname);
  };
  fs.writeFileSync(path.join(cloud, 'legacy-owner.json'), JSON.stringify({ formatVersion: 1, userId: a, agentIds: [] }));
  login(a);
  return { root, login, switchOnAsset: () => { switchDuringAsset = true; }, switches: () => switches,
    cleanup() { globalThis.fetch = previousFetch; if (previousRoot === undefined) delete process.env.AGENT_TEAMS_HOME; else process.env.AGENT_TEAMS_HOME = previousRoot; fs.rmSync(root, { recursive: true, force: true }); } };
}

test('cloud preparation rejects an identity switch during a shared-asset response', async () => {
  const f = fixture();
  try {
    await libraryState(); f.switchOnAsset();
    await assert.rejects(prepareSourceRun({ agent: `cloud:${assetId}`, workflow: 'daily', task: '摘要' }, true), { code: 'account_changed' });
    assert.equal(f.switches(), 1);
    assert.equal(fs.existsSync(path.join(f.root, '.system', 'runs')), false, 'preparation must not start host execution');
  } finally { f.cleanup(); }
});

test('scheduled execution pins its original account through preparation and rejects mismatched prepared identities', async () => {
  for (const switchIdentity of [true, false]) {
    const f = fixture();
    try {
      await libraryState();
      fs.writeFileSync(path.join(f.root, '.system', 'schedules.json'), JSON.stringify([{ id: 'schedule-a', agentId: `cloud:${assetId}`,
        workflowId: 'daily', host: 'codex', task: '摘要', cloud: { userId: a, assetId }, enabled: true, time: '09:30' }]));
      const launches = [];
      await processSchedules(new Date(2026, 9, 8, 9, 30), {
        prepareCloud: async input => {
          if (switchIdentity) { f.login(b); return prepareSourceRun(input, true); }
          const prepared = await prepareSourceRun(input, true);
          return { ...prepared, cloud: { ...prepared.cloud, userId: b } };
        },
        // Record calls instead of invoking an installed CLI or opening an app.
        launch: (input, prepared) => launches.push({ input, prepared })
      });
      assert.deepEqual(launches, [], switchIdentity ? 'a real account switch must cancel launch' : 'a mismatched prepared account must cancel launch');
      const runs = fs.readdirSync(path.join(f.root, '.system', 'runs')).filter(name => name.endsWith('.json'));
      assert.equal(runs.length, 1);
      const failure = JSON.parse(fs.readFileSync(path.join(f.root, '.system', 'runs', runs[0]), 'utf8'));
      assert.equal(failure.status, 'failed'); assert.equal(failure.cloud.userId, a); assert.match(failure.error, /帳號已變更/);
    } finally { f.cleanup(); }
  }
});
