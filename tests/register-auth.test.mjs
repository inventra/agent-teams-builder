import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegisterHandler } from '../supabase/functions/vixo-register/handler.mjs';

const id = '10000000-0000-4000-8000-000000000001';
const options = { url: 'https://example.supabase.co', serviceKey: 'server-only-secret', anonKey: 'public-key', publicKey: 'sb_publishable_fixture' };
const input = { username: 'fixture_user', password: 'fixture-password-123', displayName: '測試同仁' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const request = (body = input, headers = {}) => new Request(`${options.url}/functions/v1/vixo-register`, {
  method: 'POST', headers: { apikey: options.publicKey, ...headers }, body: JSON.stringify(body),
});

function backend({ quota, quotaThrow, quotaError, createError, createThrow, wrongCreated, grantError, grantThrow, grantUser, noTokens } = {}) {
  const state = { calls: [], created: null, access: null, quotaCalls: 0, creates: 0 };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    state.calls.push({ url, init, body });
    if (url.endsWith('/vixo_claim_registration_quota')) {
      state.quotaCalls++;
      assert.equal(init.headers.apikey, options.serviceKey);
      assert.deepEqual(Object.keys(body), ['p_ip_hash']);
      assert.doesNotMatch(JSON.stringify(body), /fixture-password|server-only-secret|fixture_user|測試同仁/);
      if (quotaThrow) throw new Error(`private ${options.serviceKey}`);
      if (quotaError) return json({ private: options.serviceKey }, 500);
      return json(quota ?? { allowed: true, retry_after_seconds: 0 });
    }
    if (url.endsWith('/auth/v1/admin/users')) {
      state.creates++;
      assert.equal(init.headers.apikey, options.serviceKey);
      assert.equal(init.headers.authorization, `Bearer ${options.serviceKey}`);
      assert.deepEqual(Object.keys(body).sort(), ['app_metadata', 'email', 'email_confirm', 'password', 'user_metadata']);
      assert.deepEqual(body.app_metadata, { vixo_username: input.username, vixo_account_registration: true });
      assert.equal(body.email_confirm, true);
      if (createThrow) throw new Error(`private ${input.password} ${options.serviceKey}`);
      if (createError) return json({ ...createError, message: `private ${input.password} ${options.serviceKey}` }, createError.status);
      state.created = wrongCreated || { id, email: body.email, app_metadata: body.app_metadata, user_metadata: body.user_metadata };
      // The real 006 Auth INSERT trigger, tested separately in SQL, fixes status.
      state.access = { status: 'pending', is_admin: false };
      return json(state.created);
    }
    if (url.endsWith('/auth/v1/token?grant_type=password')) {
      assert.equal(init.headers.apikey, options.anonKey);
      assert.equal(init.headers.authorization, `Bearer ${options.anonKey}`);
      assert.deepEqual(body, { email: state.created.email, password: state.calls.find(call => call.url.endsWith('/auth/v1/admin/users')).body.password });
      if (grantThrow) throw new Error(`private ${options.serviceKey}`);
      if (grantError) return json({ code: 400, error_code: 'invalid_credentials', private: options.serviceKey }, 400);
      return json({ ...(noTokens ? {} : { access_token: 'new-access', refresh_token: 'new-refresh' }),
        expires_in: 3600, token_type: 'bearer', user: grantUser || state.created, extra: options.serviceKey, password: input.password });
    }
    throw new Error(`Unexpected route ${url}`);
  };
  return { state, fetchImpl, handler: createRegisterHandler({ ...options, fetchImpl }) };
}

test('anonymous registration creates one pending non-admin identity and returns only its same-UUID session', async () => {
  const { state, handler } = backend();
  const response = await handler(request({ ...input, username: ' Fixture_User ', displayName: ' 測試同仁 ' }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.user, { id, email: 'fixture_user@accounts.vixo.invalid', username: input.username, displayName: '測試同仁' });
  assert.equal(body.access_token, 'new-access'); assert.equal(body.refresh_token, 'new-refresh');
  assert.deepEqual(state.access, { status: 'pending', is_admin: false });
  assert.deepEqual(state.created.user_metadata, { display_name: '測試同仁' });
  assert.equal(state.creates, 1); assert.equal(state.quotaCalls, 1);
  assert.deepEqual(state.calls.map(call => call.init.method), ['POST', 'POST', 'POST']);
  assert.doesNotMatch(JSON.stringify(body), /fixture-password|server-only-secret/);
});

test('project API-key authentication rejects missing or bad keys before quota or account creation', async () => {
  const { state, handler } = backend();
  for (const headers of [{ apikey: '' }, { apikey: 'wrong-project' }, { apikey: options.serviceKey }, { apikey: 'sb_secret_untrusted' }]) {
    const response = await handler(request(input, headers));
    assert.equal(response.status, 401); assert.equal((await response.json()).code, 'invalid_project_key');
  }
  const missing = await handler(new Request(options.url, { method: 'POST', body: JSON.stringify(input) }));
  assert.equal(missing.status, 401); assert.equal(state.calls.length, 0);
  for (const key of [options.publicKey, options.anonKey]) {
    assert.equal((await backend().handler(request(input, { apikey: key }))).status, 200);
  }
  for (const publicKey of [undefined, '', options.serviceKey, 'sb_secret_bad-config']) {
    const { state, fetchImpl } = backend();
    const invalidConfig = createRegisterHandler({ ...options, publicKey, fetchImpl });
    assert.equal((await invalidConfig(request(input, { apikey: options.anonKey }))).status, 401);
    assert.equal(state.calls.length, 0);
  }
});

test('role, approval, target identity, metadata, and extra fields are rejected before quota or Auth', async () => {
  const { state, handler } = backend();
  for (const extra of [{ role: 'admin' }, { is_admin: true }, { status: 'approved' }, { userId: id }, { user_id: id },
    { app_metadata: { is_admin: true } }, { user_metadata: {} }, { action: 'signup' }, { __proto__: null, constructor: 'admin' }]) {
    const response = await handler(request({ ...input, ...extra }));
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'invalid_request');
  }
  for (const value of [null, [], { username: input.username, password: input.password }, { ...input, displayName: undefined }]) assert.equal((await handler(request(value))).status, 400);
  assert.equal(state.calls.length, 0);
});

test('username and display-name validation rejects malformed, oversized, control, and obvious secret input', async () => {
  const { state, handler } = backend();
  for (const username of ['ab', '1name', 'name.with.dot', '中文姓名', 'a'.repeat(33), { toString: 'fake' }]) assert.equal((await handler(request({ ...input, username }))).status, 400);
  for (const displayName of ['', ' ', 'a'.repeat(81), '😀'.repeat(81), 'bad\u0000name', '\ud800', input.password, 'API_KEY=private-key-123', '密碼：private-password', 'Bearer private-access', 'sk-proj-private-key-123', '-----BEGIN PRIVATE KEY-----', 123]) {
    const response = await handler(request({ ...input, displayName }));
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'invalid_display_name');
  }
  assert.equal(state.calls.length, 0);
});

test('registration honors password Unicode count and exact UTF-8 byte boundary without trimming', async () => {
  for (const password of ['a'.repeat(72), '密'.repeat(24), '😀'.repeat(18), ` ${'a'.repeat(12)} `]) {
    const { state, handler } = backend();
    assert.equal((await handler(request({ ...input, password, displayName: '😀'.repeat(80) }))).status, 200);
    assert.equal(state.calls[1].body.password, password);
  }
  const { state, handler } = backend();
  for (const password of ['a'.repeat(11), '😀'.repeat(11), 'a'.repeat(73), '密'.repeat(25), '😀'.repeat(19), null]) assert.equal((await handler(request({ ...input, password }))).status, 400);
  assert.equal(state.calls.length, 0);
});

test('malformed, non-UTF-8, and oversized bodies are rejected without spending quota or creating users', async () => {
  const { state, handler } = backend();
  for (const body of ['{', 'a'.repeat(4097), new Uint8Array([0xc3, 0x28])]) {
    assert.equal((await handler(new Request(options.url, { method: 'POST', headers: { apikey: options.publicKey }, body }))).status, 400);
  }
  assert.equal(state.calls.length, 0);
});

test('only fixed allowed web origins, loopback, and no-origin clients reach registration', async () => {
  const { state, handler } = backend();
  assert.equal((await handler(request(input, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await handler(new Request(options.url))).status, 405);
  const preflight = await handler(new Request(options.url, { method: 'OPTIONS', headers: { origin: 'https://inventra.github.io' } }));
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://inventra.github.io');
  assert.equal(state.calls.length, 0);
  for (const origin of ['https://inventra.github.io', 'http://127.0.0.1:3876', 'http://localhost:4321']) {
    const result = await backend().handler(request(input, { origin })); assert.equal(result.status, 200);
  }
});

test('duplicate usernames with string or numeric Auth codes return conflict and never reset or delete', async () => {
  for (const createError of [{ status: 422, code: 'email_exists' }, { status: 422, code: 422, error_code: 'email_exists' },
    { status: 400, code: 400, error_code: 'user_already_exists' }]) {
    const { state, handler } = backend({ createError });
    const response = await handler(request()); assert.equal(response.status, 409);
    const text = await response.text(); assert.match(text, /username_unavailable/); assert.doesNotMatch(text, /fixture-password|server-only-secret|private/);
    assert.equal(state.calls.length, 2); assert.equal(state.quotaCalls, 1);
    assert.equal(state.calls.some(call => call.init.method !== 'POST'), false);
  }
});

test('known weak-password rejection is safe input failure, while unknown create outcomes remain unconfirmed', async () => {
  for (const createError of [{ status: 422, code: 'weak_password' }, { status: 400, code: 400, error_code: 'weak_password' }]) {
    const { handler } = backend({ createError });
    const response = await handler(request()); assert.equal(response.status, 400); assert.equal((await response.json()).code, 'invalid_password');
  }
  for (const setting of [{ createThrow: true }, { createError: { status: 500, code: 'unexpected_failure' } },
    { createError: { status: 422, code: 'unrecognized_error' } }, { wrongCreated: { id, email: 'wrong@example.com' } }]) {
    const { state, handler } = backend(setting);
    const response = await handler(request()); assert.equal(response.status, 503);
    const text = await response.text(); assert.match(text, /account_registration_unconfirmed/); assert.doesNotMatch(text, /new-access|new-refresh|fixture-password|server-only-secret/);
    assert.equal(state.calls.length, 2); assert.equal(state.calls.every(call => call.init.method === 'POST'), true);
  }
});

test('session mint failure keeps the registered pending identity and gives login instructions without rollback', async () => {
  for (const setting of [{ grantThrow: true }, { grantError: true }, { noTokens: true },
    { grantUser: { id: '20000000-0000-4000-8000-000000000001', email: 'fixture_user@accounts.vixo.invalid' } }]) {
    const { state, handler } = backend(setting);
    const response = await handler(request()); assert.equal(response.status, 503);
    const text = await response.text(); assert.match(text, /account_registered_session_unavailable/); assert.doesNotMatch(text, /new-access|new-refresh|fixture-password|server-only-secret/);
    assert.equal(state.created.id, id); assert.equal(state.access.status, 'pending'); assert.equal(state.creates, 1);
    assert.equal(state.calls.length, 3); assert.equal(state.calls.every(call => call.init.method === 'POST'), true);
  }
});

test('durable quota denial and quota failure never reach Auth, even across independent Edge instances', async () => {
  const { state, fetchImpl } = backend({ quota: { allowed: false, retry_after_seconds: 900 } });
  for (let count = 0; count < 2; count++) {
    const handler = createRegisterHandler({ ...options, fetchImpl });
    const response = await handler(request()); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '900');
  }
  assert.equal(state.creates, 0); assert.equal(state.quotaCalls, 2);
  for (const setting of [{ quotaThrow: true }, { quotaError: true }, { quota: {} }]) {
    const { state, handler } = backend(setting);
    assert.equal((await handler(request())).status, 503); assert.equal(state.creates, 0);
  }
});

test('IP hints are bounded, canonicalized, HMAC hashed, and omitted when absent or invalid', async () => {
  const hashes = [];
  for (const forwarded of ['203.0.113.7', 'spoofed, 203.0.113.7', '2001:0db8:0:0:0:0:0:1', '2001:db8::1']) {
    const { state, handler } = backend();
    assert.equal((await handler(request(input, { 'x-forwarded-for': forwarded }))).status, 200);
    const hash = state.calls[0].body.p_ip_hash; assert.match(hash, /^[a-f0-9]{64}$/); assert.equal(hash.includes(forwarded), false); hashes.push(hash);
  }
  assert.equal(hashes[0], hashes[1]); assert.equal(hashes[2], hashes[3]); assert.notEqual(hashes[0], hashes[2]);
  for (const forwarded of [null, 'spoofed', '999.1.1.1', '203.0.113.7,'.padEnd(513, 'x')]) {
    const { state, handler } = backend();
    assert.equal((await handler(request(input, forwarded ? { 'x-forwarded-for': forwarded } : {}))).status, 200);
    assert.deepEqual(state.calls[0].body, { p_ip_hash: null }); assert.equal(state.quotaCalls, 1);
  }
});

test('rotating spoofed IP hints and missing headers cannot bypass the mandatory global quota', async () => {
  let quotaCount = 0, creates = 0;
  const { fetchImpl } = backend();
  const sharedFetch = async (url, init) => {
    if (url.endsWith('/vixo_claim_registration_quota')) return json({ allowed: ++quotaCount <= 50, retry_after_seconds: 3600 });
    if (url.endsWith('/auth/v1/admin/users')) creates++;
    return fetchImpl(url, init);
  };
  for (let count = 1; count <= 52; count++) {
    const handler = createRegisterHandler({ ...options, fetchImpl: sharedFetch });
    const response = await handler(request(input, count % 2 ? { 'x-forwarded-for': `203.0.113.${count}` } : {}));
    assert.equal(response.status, count <= 50 ? 200 : 429);
  }
  assert.equal(creates, 50); assert.equal(quotaCount, 52);
});
