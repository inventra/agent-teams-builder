import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountHandler } from '../supabase/functions/vixo-account/handler.mjs';

const id = '10000000-0000-4000-8000-000000000001';
const claimId = '20000000-0000-4000-8000-000000000001';
const password = 'fixture-password-123';
const opts = { url: 'https://example.supabase.co', serviceKey: 'server-only', anonKey: 'public-key' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const request = (body = { username: 'fixture_user', password }, headers = {}) => new Request(`${opts.url}/functions/v1/vixo-account`, {
  method: 'POST', headers: { authorization: 'Bearer verified-access', ...headers }, body: JSON.stringify(body),
});
const device = () => ({ id, email: 'fixture@devices.vixo.invalid', app_metadata: { vixo_device_identity: true, existing: 'preserved' } });
function backend({ user = device(), putError, putThrow, grantError, grantUser, beforePut, confirmUser, beginError, releaseError } = {}) {
  const state = { user: structuredClone(user), claim: null, calls: [], putCount: 0, releaseCount: 0 };
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ url, options, body });
    if (url.endsWith('/auth/v1/user')) {
      assert.equal(options.headers.apikey, opts.anonKey);
      assert.equal(options.headers.authorization, 'Bearer verified-access');
      return json(state.user);
    }
    if (url.includes('/rest/v1/rpc/')) {
      assert.equal(options.headers.apikey, opts.serviceKey);
      assert.equal(options.headers.authorization, `Bearer ${opts.serviceKey}`);
      assert.equal(body.p_user_id, id);
      assert.equal(JSON.stringify(body).includes(password), false);
      if (url.endsWith('/vixo_begin_account_bind')) {
        if (beginError) return json({ message: beginError, code: 'PT409' }, 409);
        if (state.claim) return json({ message: 'account_bind_in_progress', code: 'PT409' }, 409);
        state.claim = { username: body.p_username, claim_id: claimId }; return json({ claim_id: claimId });
      }
      if (url.endsWith('/vixo_release_account_bind')) {
        state.releaseCount++;
        assert.equal(body.p_claim_id, claimId);
        if (releaseError) return json({ message: 'account_already_bound' }, 409);
        state.claim = null; return json({ released: true });
      }
    }
    if (url.endsWith(`/admin/users/${id}`)) {
      assert.equal(options.headers.apikey, opts.serviceKey);
      if (options.method === 'GET') return json(confirmUser || state.user);
      assert.equal(options.method, 'PUT'); state.putCount++;
      if (beforePut) await beforePut();
      if (putThrow) throw new Error('simulated uncertain update');
      if (putError) return json({ code: putError.code, error_code: putError.error_code, message: `private diagnostic ${password} ${opts.serviceKey}` }, putError.status);
      assert.deepEqual(Object.keys(body).sort(), ['app_metadata', 'email', 'email_confirm', 'password']);
      assert.equal(body.email_confirm, true); assert.equal(body.password, password);
      state.user = { ...state.user, email: body.email, app_metadata: body.app_metadata };
      return json(state.user);
    }
    if (url.endsWith('/auth/v1/token?grant_type=password')) {
      assert.equal(options.headers.apikey, opts.anonKey);
      assert.equal(options.headers.authorization, `Bearer ${opts.anonKey}`);
      assert.deepEqual(body, { email: 'fixture_user@accounts.vixo.invalid', password });
      if (grantError) throw new Error('simulated unavailable session');
      return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600,
        token_type: 'bearer', user: grantUser || state.user, extra: opts.serviceKey });
    }
    throw new Error(`unexpected route: ${url}`);
  };
  return { state, fetchImpl, handler: createAccountHandler({ ...opts, fetchImpl }) };
}

test('bind validates user bearer at Auth and returns a fresh session with the same UUID', async () => {
  const { state, handler } = backend();
  const response = await handler(request({ username: ' Fixture_User ', password }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.deepEqual(result.user, { id, email: 'fixture_user@accounts.vixo.invalid', username: 'fixture_user' });
  assert.equal(result.access_token, 'new-access'); assert.equal(result.refresh_token, 'new-refresh');
  assert.equal(state.putCount, 1); assert.ok(state.claim); assert.equal(state.user.id, id);
  assert.equal(state.user.app_metadata.existing, 'preserved');
  assert.equal(JSON.stringify(result).includes(password), false); assert.equal(JSON.stringify(result).includes(opts.serviceKey), false);
  assert.deepEqual(state.calls.map((call) => call.options.method), ['GET', 'POST', 'PUT', 'POST']);
});

test('missing or rejected bearer cannot invoke admin or claim APIs', async () => {
  let calls = 0;
  const handler = createAccountHandler({ ...opts, fetchImpl: async () => { calls++; return json({ code: 'bad_jwt' }, 401); } });
  assert.equal((await handler(request(undefined, { authorization: '' }))).status, 401); assert.equal(calls, 0);
  const response = await handler(request()); assert.equal(response.status, 401); assert.equal(calls, 1);
  assert.equal((await response.json()).code, 'login_required');
});

test('client cannot supply a target UUID, metadata, registration action, or invalid credentials', async () => {
  let calls = 0;
  const handler = createAccountHandler({ ...opts, fetchImpl: async () => { calls++; throw new Error('no network'); } });
  for (const body of [null, [], { username: 'fixture_user', password, userId: id }, { username: 'fixture_user', password, app_metadata: {} },
    { username: 'fixture_user', password, action: 'register' }, { username: 'with.dot', password }, { username: 'ab', password },
    { username: '1name', password }, { username: '名name', password }, { username: 'fixture_user', password: 'short' },
    { username: 'fixture_user', password: 'a'.repeat(73) }, { username: 'fixture_user', password: '密'.repeat(25) },
    { username: 'fixture_user', password: '😀'.repeat(11) }]) {
    assert.equal((await handler(request(body))).status, 400);
  }
  assert.equal(calls, 0);
});

test('password length counts Unicode characters and UTF-8 bytes without trimming or truncating', async () => {
  const passwords = ['a'.repeat(72), '密'.repeat(24), ` ${'a'.repeat(12)} `];
  for (const value of passwords) {
    let sent;
    const user = device();
    const handler = createAccountHandler({ ...opts, fetchImpl: async (url, options) => {
      if (url.endsWith('/auth/v1/user')) return json(user);
      if (url.endsWith('/vixo_begin_account_bind')) return json({ claim_id: claimId });
      if (url.endsWith(`/admin/users/${id}`)) {
        sent = JSON.parse(options.body).password;
        return json({ ...user, email: 'fixture_user@accounts.vixo.invalid', app_metadata: { ...user.app_metadata, vixo_username: 'fixture_user' } });
      }
      if (url.includes('grant_type=password')) return json({ access_token: 'a', refresh_token: 'r', user });
      throw new Error('unexpected');
    } });
    assert.equal((await handler(request({ username: 'fixture_user', password: value }))).status, 200);
    assert.equal(sent, value);
  }
});

test('oversized or malformed request bodies are rejected before Auth access', async () => {
  let calls = 0;
  const handler = createAccountHandler({ ...opts, fetchImpl: async () => { calls++; throw new Error('no network'); } });
  for (const body of ['{', 'a'.repeat(4097)]) {
    const response = await handler(new Request(opts.url, { method: 'POST', headers: { authorization: 'Bearer verified-access' }, body }));
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('bound, non-device, mismatched email, and user-metadata-only identities cannot bind', async () => {
  for (const user of [
    { ...device(), email: 'prior@accounts.vixo.invalid', app_metadata: { vixo_device_identity: true, vixo_username: 'prior' } },
    { ...device(), app_metadata: { vixo_device_identity: false } },
    { ...device(), email: 'attacker@example.com' },
    { ...device(), app_metadata: {}, user_metadata: { vixo_device_identity: true } },
    { ...device(), app_metadata: { vixo_device_identity: true, vixo_username: null } },
  ]) {
    const { state, handler } = backend({ user });
    assert.equal((await handler(request())).status, 409); assert.equal(state.calls.length, 1); assert.equal(state.putCount, 0);
  }
});

test('a username preflight collision creates no claim and performs no Auth update', async () => {
  const { state, handler } = backend({ beginError: 'username_unavailable' });
  const response = await handler(request()); assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'username_unavailable'); assert.equal(state.claim, null); assert.equal(state.putCount, 0);
});

test('two independent Edge handlers share durable claim and only one can update a UUID', async () => {
  let startPut, finishPut;
  const started = new Promise((resolve) => { startPut = resolve; });
  const pending = new Promise((resolve) => { finishPut = resolve; });
  const { state, fetchImpl, handler } = backend({ beforePut: async () => { startPut(); await pending; } });
  const secondHandler = createAccountHandler({ ...opts, fetchImpl });
  const first = handler(request()); await started;
  const second = await secondHandler(request({ username: 'different_user', password: 'different-password-123' }));
  assert.equal(second.status, 409); assert.equal((await second.json()).code, 'account_bind_in_progress');
  assert.equal(state.putCount, 1); assert.equal(state.claim.username, 'fixture_user');
  finishPut(); assert.equal((await first).status, 200); assert.equal(state.user.id, id);
});

test('two UUIDs competing for a username cannot both reach Auth PUT', async () => {
  const otherId = '10000000-0000-4000-8000-000000000002';
  const users = new Map([[id, device()], [otherId, { ...device(), id: otherId, email: 'second@devices.vixo.invalid' }]]);
  const names = new Map(); let puts = 0; let startPut, finishPut;
  const started = new Promise((resolve) => { startPut = resolve; });
  const pending = new Promise((resolve) => { finishPut = resolve; });
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.endsWith('/auth/v1/user')) return json(users.get(options.headers.authorization === 'Bearer second-access' ? otherId : id));
    if (url.endsWith('/vixo_begin_account_bind')) {
      if (names.has(body.p_username)) return json({ code: 'PT409', message: 'username_unavailable' }, 409);
      names.set(body.p_username, body.p_user_id); return json({ claim_id: claimId });
    }
    if (url.includes('/admin/users/')) {
      assert.equal(url.endsWith(id), true); assert.equal(options.method, 'PUT'); puts++;
      startPut(); await pending;
      const user = { ...users.get(id), email: body.email, app_metadata: body.app_metadata }; users.set(id, user);
      return json(user);
    }
    if (url.includes('grant_type=password')) return json({ access_token: 'a', refresh_token: 'r', user: users.get(id) });
    throw new Error('unexpected');
  };
  const first = createAccountHandler({ ...opts, fetchImpl })(request()); await started;
  const second = await createAccountHandler({ ...opts, fetchImpl })(request(undefined, { authorization: 'Bearer second-access' }));
  assert.equal(second.status, 409); assert.equal((await second.json()).code, 'username_unavailable'); assert.equal(puts, 1);
  assert.equal(users.get(otherId).email, 'second@devices.vixo.invalid');
  finishPut(); assert.equal((await first).status, 200); assert.equal(names.get('fixture_user'), id);
});

test('Auth name rejections with string or numeric code release only after fresh unchanged-user confirmation', async () => {
  for (const putError of [{ status: 422, code: 'email_exists' }, { status: 422, code: 422, error_code: 'email_exists' }]) {
    const { state, handler } = backend({ putError });
    const response = await handler(request()); assert.equal(response.status, 409);
    const body = await response.text(); assert.match(body, /username_unavailable/);
    assert.doesNotMatch(body, /fixture-password|server-only|private diagnostic/);
    assert.equal(state.releaseCount, 1); assert.equal(state.claim, null); assert.equal(state.user.email, device().email);
  }
});

test('definite weak-password rejections with string or numeric code release the claim for another attempt', async () => {
  for (const putError of [{ status: 400, code: 'weak_password' }, { status: 400, code: 400, error_code: 'weak_password' }]) {
    const { state, handler } = backend({ putError });
    const response = await handler(request()); assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_password'); assert.equal(state.claim, null); assert.equal(state.releaseCount, 1);
  }
});

test('a rejected response cannot release a claim if fresh user shows binding happened', async () => {
  const { state, handler } = backend({ putError: { status: 422, code: 'email_exists' },
    confirmUser: { ...device(), email: 'fixture_user@accounts.vixo.invalid', app_metadata: { vixo_device_identity: true, vixo_username: 'fixture_user' } } });
  const response = await handler(request()); assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'account_bind_unconfirmed'); assert.ok(state.claim); assert.equal(state.releaseCount, 0);
});

test('failed release verification retains claim instead of authorizing another bind', async () => {
  const { state, handler } = backend({ putError: { status: 422, code: 'email_exists' }, releaseError: true });
  const response = await handler(request()); assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'account_bind_unconfirmed'); assert.ok(state.claim); assert.equal(state.releaseCount, 1);
  assert.equal((await handler(request())).status, 409); assert.equal(state.putCount, 1);
});

test('ambiguous Auth update failures retain claim and cannot be retried with another password', async () => {
  for (const options of [{ putThrow: true }, { putError: { status: 500, code: 'unexpected_failure' } }]) {
    const { state, handler } = backend(options);
    const response = await handler(request()); assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'account_bind_unconfirmed'); assert.ok(state.claim); assert.equal(state.releaseCount, 0);
    assert.equal((await handler(request({ username: 'another_user', password: 'another-password-123' }))).status, 409);
    assert.equal(state.putCount, 1);
  }
});

test('session creation failure keeps bound account and instructs password login without rollback', async () => {
  const { state, handler } = backend({ grantError: true });
  const response = await handler(request()); assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'account_bound_session_unavailable');
  assert.equal(state.user.email, 'fixture_user@accounts.vixo.invalid'); assert.ok(state.claim); assert.equal(state.releaseCount, 0);
  assert.equal(state.calls.filter((call) => call.options.method === 'PUT').length, 1);
  assert.equal(state.calls.some((call) => call.options.method === 'DELETE'), false);
});

test('an unexpected session UUID is never disclosed or allowed to replace the caller identity', async () => {
  const { handler } = backend({ grantUser: { id: '30000000-0000-4000-8000-000000000001' } });
  const response = await handler(request()); assert.equal(response.status, 503);
  const body = await response.text(); assert.match(body, /account_bound_session_unavailable/); assert.doesNotMatch(body, /new-access|new-refresh/);
});

test('web origin, preflight, method, and local throttle gates run before Auth mutations', async () => {
  let calls = 0;
  const handler = createAccountHandler({ ...opts, now: () => 1000, fetchImpl: async () => { calls++; return json({}, 401); } });
  assert.equal((await handler(request(undefined, { origin: 'https://evil.example' }))).status, 403);
  const preflight = await handler(new Request(opts.url, { method: 'OPTIONS', headers: { origin: 'https://inventra.github.io' } }));
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://inventra.github.io');
  assert.equal((await handler(new Request(opts.url))).status, 405); assert.equal(calls, 0);
  for (let i = 0; i < 20; i++) assert.equal((await handler(request())).status, 401);
  assert.equal((await handler(request())).status, 429); assert.equal(calls, 20);
});
