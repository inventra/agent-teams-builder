// The endpoint uses a 256-bit, expiring capability instead of a user login.
// Only its server-side service key can claim a code or create a device identity.
export function createPairHandler({ url, serviceKey, anonKey, fetchImpl = fetch, now = Date.now }) {
  const allowed = new Set(['https://inventra.github.io']);
  const attempts = new Map();
  async function call(route, { method = 'GET', body, publicAuth = false } = {}) {
    const key = publicAuth ? anonKey : serviceKey;
    const response = await fetchImpl(`${url}${route}`, { method, headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error('pairing_unavailable');
    return data;
  }
  return async (request) => {
    const origin = request.headers.get('origin');
    const allowedOrigin = !origin || allowed.has(origin) || /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin);
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-headers': 'apikey, authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS', ...(allowedOrigin && origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) };
    const respond = (status, data) => new Response(JSON.stringify(data), { status, headers });
    if (!allowedOrigin) return respond(403, { error: 'Origin is not allowed' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return respond(405, { error: 'POST required' });
    // Invalid attempts are cheap lookups; never create identities before checking a capability.
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'local';
    const time = now();
    for (const [key, entry] of attempts) if (time - entry.at > 60000) attempts.delete(key);
    const entry = attempts.get(ip) || { at: time, count: 0 }; entry.count++; attempts.set(ip, entry);
    if (entry.count > 20 || attempts.size > 10000) return respond(429, { error: '請稍後再試。' });
    let createdId = null, joined = false;
    try {
      const raw = await request.text();
      if (raw.length > 1024) return respond(400, { error: 'Invalid pairing request' });
      const code = String(JSON.parse(raw).code || '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(code)) return respond(400, { error: '連線碼格式不正確。' });
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
      const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const devices = await call(`/rest/v1/vixo_device_codes?select=user_id,expires_at,claimed_at&code_hash=eq.${hash}`);
      const device = devices[0];
      let userId, invite = null;
      if (device) {
        if (device.claimed_at || Date.parse(device.expires_at) <= time) return respond(400, { error: '連線碼已使用或已過期。' });
        const claim = await call('/rest/v1/rpc/vixo_claim_device_code', { method: 'POST', body: { p_code: code } });
        userId = claim.user_id;
      } else {
        const invites = await call(`/rest/v1/vixo_invites?select=expires_at,max_uses,uses&hash=eq.${hash}`);
        invite = invites[0];
        if (!invite || Date.parse(invite.expires_at) <= time || invite.uses >= invite.max_uses) return respond(400, { error: '找不到有效的裝置連線碼或團隊邀請碼。' });
      }
      let user;
      if (userId) user = await call(`/auth/v1/admin/users/${userId}`);
      else {
        user = await call('/auth/v1/admin/users', { method: 'POST', body: { email: `${crypto.randomUUID()}@devices.vixo.invalid`, email_confirm: true, app_metadata: { vixo_device_identity: true } } });
        createdId = user.id; userId = user.id;
      }
      if (invite) { await call('/rest/v1/rpc/vixo_claim_invite', { method: 'POST', body: { p_code: code, p_user_id: userId } }); joined = true; }
      // generate_link does not send email. The link is consumed only server-side.
      const link = await call('/auth/v1/admin/generate_link', { method: 'POST', body: { type: 'magiclink', email: user.email } });
      const tokenHash = link.hashed_token || link.properties?.hashed_token;
      if (!tokenHash) throw new Error('pairing_unavailable');
      const session = await call('/auth/v1/verify', { method: 'POST', publicAuth: true, body: { type: 'magiclink', token_hash: tokenHash } });
      if (!session.access_token || !session.refresh_token) throw new Error('pairing_unavailable');
      return respond(200, { access_token: session.access_token, refresh_token: session.refresh_token, expires_in: session.expires_in, expires_at: session.expires_at, token_type: session.token_type, user: { id: session.user.id, email: session.user.email } });
    } catch {
      // Only roll back a newly created, unattached identity after a failed claim.
      if (createdId && !joined) { try { await call(`/auth/v1/admin/users/${createdId}`, { method: 'DELETE' }); } catch {} }
      return respond(400, { error: '配對未完成，連線碼可能已失效。請取得新碼後重試。' });
    }
  };
}
