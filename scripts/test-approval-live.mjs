// Explicit live acceptance with two newly registered QA users. No end-user
// credentials are changed. The sole real admin session may approve/disable only
// the exact QA UUIDs created by this run. All secrets stay in ignored output.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCloudClient } from '../plugins/agent-teams-builder/web/cloud-client.mjs';
import { createCloudSync } from '../plugins/agent-teams-builder/src/cloud-sync.mjs';
import { exportSpecBundle } from '../plugins/agent-teams-builder/src/cloud-bundle.mjs';
const out = path.resolve('output/approval-verification');
const passed = []; let step = 'verify operator configuration';
const save = (file, data) => { fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.chmodSync(file, 0o600); };
const mark = (label) => { passed.push(label); save(path.join(out, 'live-report.json'), { passed }); console.log(`PASS ${label}`); };
try {
  const file = process.env.VIXO_ADMIN_SESSION_FILE, expected = process.env.VIXO_EXPECTED_ADMIN_ID;
  assert.ok(file && expected); assert.match(expected, /^[a-f0-9-]{36}$/);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 }); fs.chmodSync(out, 0o700);
  const config = JSON.parse(fs.readFileSync('plugins/agent-teams-builder/web/cloud-config.json'));
  assert.equal(new URL(config.url).hostname, 'rbyjxnklfepeevoehtjn.supabase.co');
  function harness(initial = null, file = null) {
    let session = initial;
    const client = createCloudClient({ ...config, getSession: () => session, saveSession: data => { session = data; if (file) save(file, data); } });
    return { client, token: () => session?.access_token };
  }
  const admin = harness(JSON.parse(fs.readFileSync(file)), file);
  assert.equal((await admin.client.getUser()).id, expected);
  assert.equal((await admin.client.getAccess()).isAdmin, true);
  const baseline = await admin.client.listAssets({ workspaceId: null });
  const checksum = rows => crypto.createHash('sha256').update(JSON.stringify(rows.slice().sort((a,b)=>a.id.localeCompare(b.id)))).digest('hex');
  const before = checksum(baseline);
  mark('operator identity verified as the existing administrator');
  const run = crypto.randomBytes(7).toString('hex');
  const records = [];
  for (const label of ['member', 'peer']) {
    step = 'register an isolated pending account';
    const credentials = { username: `qa_${run}_${label}`, password: `Qa!${crypto.randomBytes(24).toString('base64url')}`, displayName: `自動測試 ${label} ${run}` };
    const user = harness(null, path.join(out, `${run}-${label}.session.json`));
    save(path.join(out, `${run}-${label}.credentials.json`), credentials);
    const registered = await user.client.registerAccount(credentials);
    assert.ok(registered.user.id); assert.notEqual(registered.user.id, expected);
    const access = await user.client.getAccess();
    assert.equal(access.userId, registered.user.id); assert.equal(access.status, 'pending'); assert.equal(access.isAdmin, false);
    records.push({ ...user, id: access.userId, credentials });
  }
  const [member, peer] = records; assert.notEqual(member.id, peer.id);
  save(path.join(out, `${run}-identities.json`), { ids: records.map(r=>r.id) });
  mark('self-registered accounts start pending without administrator privileges');
  async function raw(user, route, body, method = body === undefined ? 'GET' : 'POST') {
    if (user) await user.client.getUser();
    const response = await fetch(config.url + route, { method, headers: { apikey: config.key, 'content-type': 'application/json', ...(user ? { authorization: `Bearer ${user.token()}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, data: await response.json().catch(()=>null) };
  }
  async function change(user, status) {
    assert.ok(records.includes(user)); assert.notEqual(user.id, expected);
    const result = await admin.client.setAccountStatus(user.id, status); assert.equal(result.status, status);
  }
  step = 'verify pending raw API and self-escalation denial';
  for (const user of records) {
    await assert.rejects(user.client.listAssets(), { code: 'account_pending' });
    const table = await raw(user, '/rest/v1/vixo_assets?select=id'); assert.equal(table.status, 200); assert.deepEqual(table.data, []);
    const create = await raw(user, '/rest/v1/rpc/vixo_create_workspace', { p_name: 'Blocked QA' }); assert.equal(create.status, 403);
    const adminList = await raw(user, '/rest/v1/rpc/vixo_admin_list_accounts', {}); assert.equal(adminList.status, 403);
    const self = await raw(user, '/rest/v1/rpc/vixo_admin_set_account_status', { p_user_id: user.id, p_status: 'approved' }); assert.equal(self.status, 403);
  }
  const patch = await raw(member, `/rest/v1/vixo_account_access?user_id=eq.${member.id}`, { status: 'approved', is_admin: true }, 'PATCH'); assert.ok([401,403].includes(patch.status));
  const metadata = await raw(member, '/auth/v1/user', { data: { is_admin: true, status: 'approved', role: 'admin' } }, 'PUT'); assert.equal(metadata.status, 200);
  assert.equal((await member.client.getAccess()).status, 'pending'); assert.equal((await member.client.getAccess()).isAdmin, false);
  mark('pending users cannot read assets, create workspaces or grant themselves access');
  step = 'verify registration role injection and duplicate username denial';
  const injected = await raw(null, '/functions/v1/vixo-register', { ...peer.credentials, isAdmin: true }); assert.equal(injected.status, 400);
  const duplicate = await raw(null, '/functions/v1/vixo-register', member.credentials); assert.equal(duplicate.status, 409);
  mark('registration rejects role injection and duplicate usernames');
  step = 'approve only the new QA accounts';
  const accounts = await admin.client.listAccounts();
  assert.ok(records.every(r=>accounts.some(a=>a.userId===r.id && a.status==='pending')));
  await change(member, 'approved'); await change(peer, 'approved');
  for (const user of records) { assert.equal((await user.client.getAccess()).status, 'approved'); assert.deepEqual(await user.client.listWorkspaces(), []); }
  mark('administrator approval enables accounts without adding team memberships');
  step = 'verify approved member permissions and private isolation';
  const spec = { id: `approval-${run}`, name: '授權驗證技能', description: '獨立測試資料', triggers: ['驗證'], allowedTools: [], steps: ['讀取測試文字'], successCriteria: ['僅輸出測試文字'] };
  const bundle = exportSpecBundle({ kind: 'skill', spec });
  const asset = await member.client.saveAsset({ kind: 'skill', slug: spec.id, title: spec.name, description: spec.description, bundle, expectedRevision: 0 });
  await assert.rejects(peer.client.getAsset(asset.id), { status: 404 });
  await assert.rejects(admin.client.getAsset(asset.id), { status: 404 });
  const peerAdmin = await raw(peer, '/rest/v1/rpc/vixo_admin_set_account_status', { p_user_id: member.id, p_status: 'disabled' }); assert.equal(peerAdmin.status, 403);
  mark('approved members remain non-admin and private assets remain owner-only');
  const sync = createCloudSync({ client: member.client, cloudRoot: path.join(out, `${run}-cache`) });
  await sync.pullAsset(asset.id);
  step = 'disable approved user and verify existing-token revocation';
  await change(member, 'disabled');
  assert.equal((await member.client.getUser()).id, member.id); assert.equal((await member.client.getAccess()).status, 'disabled');
  await assert.rejects(member.client.listAssets(), { code: 'account_disabled' });
  const rows = await raw(member, '/rest/v1/vixo_assets?select=id'); assert.equal(rows.status, 200); assert.deepEqual(rows.data, []);
  const blocked = await raw(member, '/rest/v1/rpc/vixo_create_workspace', { p_name: 'Blocked again' }); assert.equal(blocked.status, 403);
  await assert.rejects(sync.prepareAssetRun({ assetId: asset.id, task: '僅準備測試，不執行', allowOfflineCache: true }), { code: 'account_disabled' });
  mark('disabling blocks existing sessions, raw data APIs and cached execution preparation');
  step = 'restore access and leave only the synthetic accounts disabled';
  await change(member, 'approved'); assert.equal((await member.client.getAsset(asset.id)).revision, 1);
  const fresh = harness(); await fresh.client.signInWithPassword(member.credentials); assert.equal((await fresh.client.getAccess()).status, 'approved');
  await change(member, 'disabled'); await change(peer, 'disabled');
  assert.equal(checksum(await admin.client.listAssets({ workspaceId: null })), before);
  assert.equal((await admin.client.getAccess()).isAdmin, true);
  mark('restore and password login work; QA accounts finish disabled and administrator assets stay unchanged');
} catch {
  console.error(`Approval verification stopped during: ${step}. Sensitive details suppressed.`);
  process.exitCode = 1;
}
