import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairHandler } from '../supabase/functions/vixo-device-pair/handler.mjs';
const code = 'a'.repeat(64);
const json = (data) => new Response(JSON.stringify(data));
const request = (value = code) => new Request('https://example.supabase.co/functions/v1/vixo-device-pair', { method: 'POST', body: JSON.stringify({ code: value }) });
const opts = { url: 'https://example.supabase.co', serviceKey: 'server-only', anonKey: 'public' };
test('malformed or unknown pairing codes cannot create an identity', async () => {
  const paths = [];
  const handler = createPairHandler({ ...opts, fetchImpl: async (url) => { paths.push(url); return json([]); } });
  assert.equal((await handler(request('bad'))).status, 400); assert.equal(paths.length, 0);
  assert.equal((await handler(request())).status, 400); assert.equal(paths.length, 2);
  assert.equal(paths.some((url) => url.includes('/admin/')), false);
});
test('existing device code consumes once and returns user session, never service key', async () => {
  const paths = [];
  const handler = createPairHandler({ ...opts, fetchImpl: async (url, options) => {
    paths.push(url);
    if (url.includes('vixo_device_codes?')) return json([{ user_id: 'user-1', expires_at: new Date(Date.now() + 60000).toISOString(), claimed_at: null }]);
    if (url.includes('vixo_claim_device_code')) return json({ user_id: 'user-1' });
    if (url.includes('/admin/users/user-1')) return json({ id: 'user-1', email: 'internal@devices.vixo.invalid' });
    if (url.includes('/generate_link')) return json({ hashed_token: 'hashed-link' });
    if (url.endsWith('/verify')) { assert.equal(options.headers.apikey, 'public'); return json({ access_token: 'user-access', refresh_token: 'user-refresh', user: { id: 'user-1' } }); }
    throw new Error('unexpected');
  } });
  const response = await handler(request()); const body = await response.text();
  assert.equal(response.status, 200); assert.match(body, /user-access/); assert.doesNotMatch(body, /server-only|hashed-link/);
  assert.equal(paths.filter((url) => url.includes('vixo_claim_device_code')).length, 1);
});
test('untrusted web origins are rejected before database access', async () => {
  const handler = createPairHandler({ ...opts, fetchImpl: async () => { throw new Error('must not call'); } });
  const req = new Request('https://example.supabase.co', { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ code }) });
  assert.equal((await handler(req)).status, 403);
});
