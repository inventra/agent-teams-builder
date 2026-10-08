import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudClient } from '../web/cloud-client.mjs';
const id = '10000000-0000-4000-8000-000000000001';
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const options = { url: 'https://example.supabase.co', key: 'sb_publishable_test' };
test('unauthenticated reads never call data APIs', async () => {
  let calls = 0; const client = createCloudClient({ ...options, fetchImpl: async () => { calls++; } });
  await assert.rejects(client.listAssets(), { code: 'login_required' }); assert.equal(calls, 0);
});
test('device pairing stores a session and exposes only non-secret status', async () => {
  let saved; const requests = [];
  const client = createCloudClient({ ...options, saveSession: (value) => { saved = value; }, fetchImpl: async (url, request) => {
    requests.push({ url, request }); return reply({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, user: { id } });
  } });
  const result = await client.pairDevice('a'.repeat(64));
  assert.equal(result.session, true); assert.equal(result.access_token, undefined); assert.equal(saved.refresh_token, 'test-refresh');
  assert.equal(requests[0].request.headers.authorization, undefined);
  assert.ok(requests[0].url.endsWith('/functions/v1/vixo-device-pair'));
});
test('concurrent requests refresh once and reuse only new access token', async () => {
  let refreshes = 0; let saved;
  const client = createCloudClient({ ...options, getSession: () => ({ access_token: 'old', refresh_token: 'r', expires_at: 1 }), saveSession: (value) => { saved = value; }, fetchImpl: async (url, request) => {
    if (url.includes('grant_type=refresh_token')) { refreshes++; return reply({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }); }
    assert.equal(request.headers.authorization, 'Bearer new'); return reply({ id });
  } });
  await Promise.all([client.getUser(), client.getUser()]); assert.equal(refreshes, 1); assert.equal(saved.refresh_token, 'r2');
});
test('revision conflicts retain server conflict meaning', async () => {
  const client = createCloudClient({ ...options, getSession: () => ({ access_token: 'a' }), fetchImpl: async () => reply({ code: '40001', message: 'revision_conflict' }, 400) });
  await assert.rejects(client.saveAsset({ id, kind: 'agent', expectedRevision: 3 }), { status: 409, code: 'revision_conflict' });
});
test('unreadable asset is never returned as an empty valid asset', async () => {
  const client = createCloudClient({ ...options, getSession: () => ({ access_token: 'a' }), fetchImpl: async () => reply([]) });
  await assert.rejects(client.getAsset(id), { status: 404 });
});
test('signout clears local credentials even when server is unreachable', async () => {
  let saved = 'unchanged';
  const client = createCloudClient({ ...options, getSession: () => ({ access_token: 'a' }), saveSession: (value) => { saved = value; }, fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(client.signOut(), { code: 'network_error' }); assert.equal(saved, null);
  await assert.rejects(client.getUser(), { code: 'login_required' });
});
test('a slow old client cannot overwrite a newly paired identity in shared storage', async () => {
  let storage = { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 1 };
  let finish; const pending = new Promise((resolve) => { finish = resolve; });
  const old = createCloudClient({ ...options, getSession: () => storage, saveSession: (value) => { storage = value; }, fetchImpl: async () => { await pending; return reply({ access_token: 'refreshed-old', refresh_token: 'old-new' }); } });
  const request = old.getUser();
  storage = { access_token: 'new-user-access', refresh_token: 'new-user-refresh' }; finish();
  await assert.rejects(request, { code: 'account_changed' }); assert.equal(storage.access_token, 'new-user-access');
});
test('a stale tab cannot consume a one-time pairing code after shared session changes', async () => {
  let storage = { access_token: 'old-access', refresh_token: 'old-refresh' }; let calls = 0;
  const config = { ...options, getSession: () => storage, saveSession: (value) => { storage = value; }, fetchImpl: async () => {
    calls++; return reply({ access_token: 'paired-access', refresh_token: 'paired-refresh', user: { id } });
  } };
  const stale = createCloudClient(config); storage = null;
  await assert.rejects(stale.pairDevice('a'.repeat(64)), { code: 'account_changed' }); assert.equal(calls, 0);
  const fresh = createCloudClient(config); await fresh.pairDevice('a'.repeat(64));
  assert.equal(calls, 1); assert.equal(storage.access_token, 'paired-access');
});
