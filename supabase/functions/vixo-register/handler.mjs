// Anonymous registration deliberately creates a pending account. The Auth-user
// trigger owns access status; no client field can select an approver or role.
const usernamePattern = /^[a-z][a-z0-9_-]{2,31}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const secretPattern = /(?:\b(?:Bearer\s+\S+|(?:api[_ -]?key|password|passwd|secret|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+)|(?:密碼|金鑰|憑證)\s*[:：=]\s*\S+|\b(?:sb_secret_|sk-(?:proj-)?)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

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

function ipHint(request) {
  // XFF is only an additional bucket, never an authentication fact. Hosted
  // gateway sanitization is not assumed; the durable global ceiling always runs.
  const forwarded = request.headers.get('x-forwarded-for');
  if (!forwarded || forwarded.length > 512) return null;
  const candidate = forwarded.split(',').at(-1).trim().toLowerCase();
  const parts = candidate.split('.');
  if (parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)) return candidate;
  if (candidate.length > 45 || !/^[a-f0-9:.]+$/.test(candidate) || !candidate.includes(':')) return null;
  try { return new URL(`http://[${candidate}]/`).hostname.slice(1, -1); } catch { return null; }
}

export function createRegisterHandler({ url, serviceKey, anonKey, publicKey, fetchImpl = fetch }) {
  const allowed = new Set(['https://inventra.github.io']);
  // Project API-key authentication deliberately admits anonymous users. This
  // published key does not authorize cloud data or approve a pending account.
  // Rotate the bundled public config together with the browser/plugin config;
  // the runtime's known anon key is also accepted during that transition.
  const configuredPublicKey = typeof publicKey === 'string' && publicKey.length > 0 && publicKey !== serviceKey && !publicKey.startsWith('sb_secret_');
  const projectKeys = new Set(configuredPublicKey ? [publicKey, ...(typeof anonKey === 'string' && anonKey && anonKey !== serviceKey && !anonKey.startsWith('sb_secret_') ? [anonKey] : [])] : []);
  let hashingKey;
  async function ipHash(request) {
    const hint = ipHint(request);
    if (!hint) return null;
    hashingKey ||= crypto.subtle.importKey('raw', new TextEncoder().encode(serviceKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', await hashingKey, new TextEncoder().encode(`vixo-register-ip-v1:${hint}`)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  async function call(route, { body, publicAuth = false } = {}) {
    const key = publicAuth ? anonKey : serviceKey;
    const response = await fetchImpl(`${url}${route}`, {
      method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
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
    const respond = (status, code, message, extraHeaders = {}) => new Response(JSON.stringify({ code, error: message }), { status, headers: { ...headers, ...extraHeaders } });
    const uncertain = () => respond(503, 'account_registration_unconfirmed', '帳號建立結果尚未確認。請先嘗試用剛填的帳密登入；若無法登入，請聯絡管理員，勿重複註冊。');
    const sessionUnavailable = () => respond(503, 'account_registered_session_unavailable', '帳號已建立並等待審核。請用剛設定的帳密登入，不需重複註冊。');
    if (!allowedOrigin) return respond(403, 'origin_not_allowed', 'Origin is not allowed');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return respond(405, 'method_not_allowed', 'POST required');
    const projectKey = request.headers.get('apikey');
    if (!projectKey || !projectKeys.has(projectKey)) return respond(401, 'invalid_project_key', '請使用目前的 VIXO 註冊頁面或更新外掛後再試。');
    let input;
    try { input = await readBody(request); } catch { return respond(400, 'invalid_request', '註冊格式不正確。'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== 3 || Object.keys(input).some((key) => !['username', 'password', 'displayName'].includes(key))) return respond(400, 'invalid_request', '註冊格式不正確。');
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    if (!usernamePattern.test(username)) return respond(400, 'invalid_username', '帳號需為 3–32 個英文字母、數字、底線或連字號，並以英文字母開頭。');
    const password = input.password;
    if (typeof password !== 'string' || [...password].length < 12 || new TextEncoder().encode(password).byteLength > 72) return respond(400, 'invalid_password', '密碼至少 12 個字元，UTF-8 編碼最多 72 bytes。');
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!displayName || [...displayName].length > 80 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(displayName) || displayName === password.trim() || secretPattern.test(displayName)) return respond(400, 'invalid_display_name', '顯示名稱需為 1–80 個字元，不包含憑證或控制字元。');
    try {
      const quota = await call('/rest/v1/rpc/vixo_claim_registration_quota', { body: { p_ip_hash: await ipHash(request) } });
      if (!quota.ok || typeof quota.data?.allowed !== 'boolean') return respond(503, 'registration_service_unavailable', '註冊服務暫時無法使用，請稍後再試。');
      if (!quota.data.allowed) {
        const retry = Number.isInteger(quota.data.retry_after_seconds) && quota.data.retry_after_seconds > 0 ? Math.min(quota.data.retry_after_seconds, 3600) : 3600;
        return respond(429, 'registration_rate_limited', '目前註冊次數已達上限，請稍後再試。', { 'retry-after': String(retry) });
      }
    } catch { return respond(503, 'registration_service_unavailable', '註冊服務暫時無法使用，請稍後再試。'); }
    const email = `${username}@accounts.vixo.invalid`;
    let created;
    try {
      created = await call('/auth/v1/admin/users', { body: {
        email, password, email_confirm: true,
        app_metadata: { vixo_username: username, vixo_account_registration: true },
        user_metadata: { display_name: displayName },
      } });
    } catch { return uncertain(); }
    if (!created.ok) {
      const code = typeof created.data?.code === 'string' ? created.data.code : created.data?.error_code;
      if ([400, 422].includes(created.status) && ['email_exists', 'user_already_exists'].includes(code)) return respond(409, 'username_unavailable', '這個帳號已被使用，請選擇另一個帳號。');
      if ([400, 422].includes(created.status) && code === 'weak_password') return respond(400, 'invalid_password', '密碼未符合雲端安全設定，請使用更強的密碼。');
      return uncertain();
    }
    const user = created.data;
    if (!uuidPattern.test(user?.id || '') || user.email !== email || user.app_metadata?.vixo_username !== username || user.app_metadata?.vixo_account_registration !== true) return uncertain();
    try {
      const granted = await call('/auth/v1/token?grant_type=password', { publicAuth: true, body: { email, password } });
      const session = granted.data;
      if (!granted.ok || !session?.access_token || !session?.refresh_token || session.user?.id !== user.id || session.user?.email !== email) return sessionUnavailable();
      return new Response(JSON.stringify({
        access_token: session.access_token, refresh_token: session.refresh_token,
        expires_in: session.expires_in, expires_at: session.expires_at, token_type: session.token_type,
        user: { id: user.id, email, username, displayName },
      }), { status: 200, headers });
    } catch { return sessionUnavailable(); }
  };
}
