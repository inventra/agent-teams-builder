// Bind an existing, verified device identity once. Password hashing is handled
// by Supabase Auth; credentials and service keys are never persisted or logged.
const usernamePattern = /^[a-z][a-z0-9_-]{2,31}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const deviceEmailPattern = /^[^@\s]+@devices\.vixo\.invalid$/;
const eligible = (user) => user?.app_metadata?.vixo_device_identity === true &&
  !Object.hasOwn(user.app_metadata, 'vixo_username') && deviceEmailPattern.test(user.email || '');

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_request');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new Error('invalid_request'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function createAccountHandler({ url, serviceKey, anonKey, fetchImpl = fetch, now = Date.now }) {
  const allowed = new Set(['https://inventra.github.io']);
  const attempts = new Map();
  async function call(route, { method = 'GET', body, userToken, publicAuth = false } = {}) {
    const key = userToken || publicAuth ? anonKey : serviceKey;
    const response = await fetchImpl(`${url}${route}`, {
      method, headers: { apikey: key, authorization: `Bearer ${userToken || key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) };
  }
  return async (request) => {
    const origin = request.headers.get('origin');
    const allowedOrigin = !origin || allowed.has(origin) || /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin);
    const headers = {
      'content-type': 'application/json', 'cache-control': 'no-store',
      'access-control-allow-headers': 'apikey, authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS',
      ...(allowedOrigin && origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    };
    const respond = (status, code, message) => new Response(JSON.stringify({ code, error: message }), { status, headers });
    const uncertain = () => respond(503, 'account_bind_unconfirmed', '帳號設定結果尚未確認。請先用剛設定的帳密登入；若無法登入，請聯絡管理員，勿重複設定。');
    const sessionUnavailable = () => respond(503, 'account_bound_session_unavailable', '帳號已設定，請以剛設定的帳密登入。');
    if (!allowedOrigin) return respond(403, 'origin_not_allowed', 'Origin is not allowed');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return respond(405, 'method_not_allowed', 'POST required');
    const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') || '')?.[1];
    if (!bearer) return respond(401, 'login_required', '請先連接目前的 VIXO 雲端身分。');
    // This local throttle reduces abuse; Supabase Auth also enforces its own limits.
    const time = now();
    for (const [key, entry] of attempts) if (time - entry.at >= 60000) attempts.delete(key);
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
    const attempt = attempts.get(ip) || { at: time, count: 0 }; attempt.count++; attempts.set(ip, attempt);
    if (attempt.count > 20 || attempts.size > 10000) return respond(429, 'rate_limited', '請稍後再試。');
    let input;
    try { input = await readBody(request); } catch { return respond(400, 'invalid_request', '帳號設定格式不正確。'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['username', 'password'].includes(key))) return respond(400, 'invalid_request', '帳號設定格式不正確。');
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!usernamePattern.test(username)) return respond(400, 'invalid_username', '帳號需為 3–32 個英文字母、數字、底線或連字號，並以英文字母開頭。');
    const password = input.password;
    if (typeof password !== 'string' || [...password].length < 12 || new TextEncoder().encode(password).byteLength > 72) return respond(400, 'invalid_password', '密碼至少 12 個字元；若含中文或特殊字元而過長，請縮短後重試。');
    let user;
    try {
      const result = await call('/auth/v1/user', { userToken: bearer });
      if (!result.ok) return [401, 403].includes(result.status)
        ? respond(401, 'login_required', '登入已失效，請重新連接目前的身分。')
        : respond(503, 'account_service_unavailable', '暫時無法驗證雲端身分，請稍後再試。');
      user = result.data;
    } catch { return respond(503, 'account_service_unavailable', '暫時無法驗證雲端身分，請稍後再試。'); }
    if (!uuidPattern.test(user?.id || '') || !eligible(user)) return respond(409, 'account_already_bound', '此身分已設定帳號，或不支援首次設定；請使用帳密登入。');
    const email = `${username}@accounts.vixo.invalid`;
    let claim;
    try {
      const result = await call('/rest/v1/rpc/vixo_begin_account_bind', { method: 'POST', body: { p_user_id: user.id, p_username: username } });
      if (!result.ok) {
        if (result.data?.message === 'account_already_bound') return respond(409, 'account_already_bound', '此身分已設定帳號，請使用帳密登入。');
        if (result.data?.message === 'account_bind_in_progress') return respond(409, 'account_bind_in_progress', '帳號設定正在處理或結果待確認。請先嘗試帳密登入，或聯絡管理員。');
        if (result.data?.message === 'username_unavailable') return respond(409, 'username_unavailable', '這個帳號無法使用，請選擇另一個帳號。');
        return uncertain();
      }
      claim = result.data?.claim_id;
      if (!uuidPattern.test(claim || '')) return uncertain();
    } catch { return uncertain(); }
    let updated;
    try {
      updated = await call(`/auth/v1/admin/users/${user.id}`, { method: 'PUT', body: {
        email, password, email_confirm: true, app_metadata: { ...user.app_metadata, vixo_username: username },
      } });
    } catch { return uncertain(); }
    if (!updated.ok) {
      // A transport failure or 5xx can occur after a commit. Keep the durable
      // claim in those cases; never blindly restore email or overwrite a password.
      if (![400, 422].includes(updated.status)) return uncertain();
      try {
        const fresh = await call(`/auth/v1/admin/users/${user.id}`);
        if (!fresh.ok || fresh.data?.id !== user.id || !eligible(fresh.data) || fresh.data.email !== user.email) return uncertain();
        const released = await call('/rest/v1/rpc/vixo_release_account_bind', { method: 'POST', body: { p_user_id: user.id, p_claim_id: claim } });
        if (!released.ok || released.data?.released !== true) return uncertain();
      } catch { return uncertain(); }
      const errorCode = typeof updated.data?.code === 'string' ? updated.data.code : updated.data?.error_code;
      if (['email_exists', 'user_already_exists'].includes(errorCode)) return respond(409, 'username_unavailable', '這個帳號無法使用，請選擇另一個帳號。');
      if (errorCode === 'weak_password') return respond(400, 'invalid_password', '密碼未符合雲端安全設定，請使用更強的密碼。');
      return respond(400, 'account_setup_rejected', '帳號設定未完成，請檢查帳號與密碼後重試。');
    }
    if (updated.data?.id !== user.id || updated.data?.email !== email || updated.data?.app_metadata?.vixo_username !== username) return uncertain();
    try {
      const result = await call('/auth/v1/token?grant_type=password', { method: 'POST', publicAuth: true, body: { email, password } });
      const session = result.data;
      if (!result.ok || !session?.access_token || !session?.refresh_token || session?.user?.id !== user.id) return sessionUnavailable();
      return new Response(JSON.stringify({
        access_token: session.access_token, refresh_token: session.refresh_token, expires_in: session.expires_in,
        expires_at: session.expires_at, token_type: session.token_type, user: { id: user.id, email, username },
      }), { status: 200, headers });
    } catch { return sessionUnavailable(); }
  };
}
