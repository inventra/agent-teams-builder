// Shared browser / Node client. Only publishable keys belong in this module's configuration.
export class CloudError extends Error {
  constructor(message, { status = 0, code = "cloud_error" } = {}) {
    super(message); this.name = "CloudError"; this.status = status; this.code = code;
  }
}

export function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) throw new CloudError('帳號需以英文字母開頭，使用 3–32 個英文字母、數字、底線或連字號。', { code: 'invalid_username' });
  return username;
}
function publicUser(user) {
  const name = user?.app_metadata?.vixo_username || user?.username;
  const configured = typeof name === 'string' && /^[a-z][a-z0-9_-]{2,31}$/.test(name) && user?.email === `${name}@accounts.vixo.invalid`;
  return { id: user?.id, email: user?.email, username: configured ? name : null, accountConfigured: configured };
}

export function createCloudClient({ url, key, fetchImpl = globalThis.fetch, getSession = () => null, saveSession = () => {}, redirectTo } = {}) {
  const base = new URL(url);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Cloud URL must use HTTPS");
  if (!key || String(key).startsWith("sb_secret_")) throw new Error("A Supabase publishable key is required");
  if (String(key).split('.').length === 3) {
    let role; try { role = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role; } catch {}
    if (role !== 'anon') throw new Error('Only legacy anon or publishable keys are allowed');
  }
  const origin = base.origin;
  let session = getSession() || null;
  const fingerprint = (value) => JSON.stringify([value?.access_token || null, value?.refresh_token || null]);
  let storedFingerprint = fingerprint(getSession());
  let refreshing = null;
  let generation = 0;
  const checkGeneration = (started) => { if (started !== generation) throw new CloudError('雲端身分已變更，請重試。', { status: 401, code: 'account_changed' }); };
  function assertStorage() {
    if (fingerprint(getSession()) !== storedFingerprint) {
      generation++; session = null;
      throw new CloudError('此裝置的雲端身分已變更，請重新整理後再試。', { status: 401, code: 'account_changed' });
    }
  }
  const persist = (value) => { assertStorage(); saveSession(value); storedFingerprint = fingerprint(getSession()); session = value; return value; };
  const normalize = (value) => ({ access_token: value.access_token, refresh_token: value.refresh_token, token_type: value.token_type || 'bearer', expires_in: value.expires_in || 3600, expires_at: value.expires_at || Math.floor(Date.now() / 1000) + (value.expires_in || 3600), ...(value.user ? { user: publicUser(value.user) } : {}) });
  function adopt(data, started) {
    if (!data?.access_token || !data?.refresh_token) throw new CloudError('尚未取得有效的登入狀態。');
    checkGeneration(started); assertStorage();
    generation++; persist(normalize(data));
    return { user: publicUser(data.user), session: true };
  }
  async function raw(route, { method = "GET", body, token } = {}) {
    let response;
    try {
      response = await fetchImpl(`${origin}${route}`, {
        method, headers: { apikey: key, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000)
      });
    } catch { throw new CloudError("無法連線雲端，請檢查網路後重試。", { code: "network_error" }); }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      let code = (typeof data?.code === 'string' && data.code) || data?.error_code || "cloud_error";
      const message = data?.message || data?.msg || data?.error_description || data?.error || `Cloud request failed (${response.status})`;
      if (['account_pending', 'account_disabled', 'admin_required'].includes(message)) code = message;
      const conflict = code === "40001" || String(message).includes("revision_conflict");
      throw new CloudError(conflict ? "雲端已有新版本。你的修改已保留，請比較後再發布。" : message, { status: conflict ? 409 : response.status, code: conflict ? "revision_conflict" : code });
    }
    return data;
  }
  async function refresh() {
    if (!session?.refresh_token) throw new CloudError("請先登入 VIXO 雲端。", { status: 401, code: "login_required" });
    if (!refreshing) {
      const started = generation;
      refreshing = raw("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: session.refresh_token } })
        .then((data) => { if (started !== generation) throw new CloudError("登入狀態已變更，請重試。", { status: 401 }); return persist(normalize(data)); })
        .catch((error) => { if (started === generation && [400, 401, 403].includes(error.status)) persist(null); throw error; })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }
  async function request(route, options = {}) {
    assertStorage();
    const started = generation;
    if (!session?.access_token) throw new CloudError("請先登入 VIXO 雲端。", { status: 401, code: "login_required" });
    if (session.expires_at && session.expires_at < Date.now() / 1000 + 60) await refresh();
    checkGeneration(started);
    try { const data = await raw(route, { ...options, token: session.access_token }); assertStorage(); checkGeneration(started); return data; }
    catch (error) {
      checkGeneration(started);
      if (error.code === 'account_changed') throw error;
      if (options.retryAuth === false || error.status !== 401 || !session?.refresh_token) throw error;
      await refresh();
      checkGeneration(started);
      const data = await raw(route, { ...options, token: session.access_token }); assertStorage(); checkGeneration(started); return data;
    }
  }
  async function getAccess() {
    const access = await request('/rest/v1/rpc/vixo_my_access', { method: 'POST', body: {} });
    if (!access?.userId || !['pending', 'approved', 'disabled'].includes(access.status) ||
        (session?.user?.id && access.userId !== session.user.id)) throw new CloudError('無法確認帳號授權，請重新登入後再試。', { status: 403, code: 'access_unconfirmed' });
    return { ...access, isAdmin: access.status === 'approved' && access.isAdmin === true };
  }
  async function requireApproved() {
    const access = await getAccess();
    if (access.status !== 'approved') throw new CloudError(access.status === 'disabled' ? '帳號已停用，請聯絡 Kevin。' : '帳號待 Kevin 審核，核准後即可使用。', { status: 403, code: `account_${access.status}` });
    return access;
  }
  async function requireAdmin() {
    const access = await requireApproved();
    if (!access.isAdmin) throw new CloudError('只有管理員可以審核帳號。', { status: 403, code: 'admin_required' });
  }
  const rpc = async (name, body, options = {}) => { await requireApproved(); return request(`/rest/v1/rpc/${name}`, { method: "POST", body, ...options }); };
  const table = async (name, params) => { await requireApproved(); return request(`/rest/v1/${name}?${new URLSearchParams(params)}`); };
  const uuid = (value) => { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value || "")) throw new Error("Invalid cloud ID"); return value; };
  return {
    getAccess,
    requireApproved,
    async registerAccount({ username, password, displayName } = {}) {
      assertStorage(); const started = generation;
      if (session?.access_token) throw new CloudError('目前已連線，請先登出再註冊；新帳號不會包含原身分的資料。', { status: 409, code: 'account_already_connected' });
      const name = normalizeUsername(username);
      if (typeof password !== 'string' || [...password].length < 12 || new TextEncoder().encode(password).length > 72) throw new CloudError('密碼至少 12 個字元；過長時請縮短後重試。', { code: 'invalid_password' });
      const display = typeof displayName === 'string' ? displayName.trim() : '';
      if (!display || [...display].length > 80) throw new CloudError('請填寫 1–80 個字元的姓名，讓管理員辨識。', { code: 'invalid_display_name' });
      const data = await raw('/functions/v1/vixo-register', { method: 'POST', body: { username: name, password, displayName: display } });
      if (!publicUser(data?.user).accountConfigured || publicUser(data.user).username !== name) throw new CloudError('註冊結果尚未確認，請先嘗試以剛設定的帳密登入。', { code: 'account_registration_unconfirmed' });
      return adopt(data, started);
    },
    async listAccounts() {
      await requireAdmin();
      return request('/rest/v1/rpc/vixo_admin_list_accounts', { method: 'POST', body: {} });
    },
    async setAccountStatus(userId, status) {
      if (!['approved', 'disabled'].includes(status)) throw new CloudError('無效的帳號狀態。', { code: 'invalid_account_status' });
      await requireAdmin();
      return request('/rest/v1/rpc/vixo_admin_set_account_status', { method: 'POST', body: { p_user_id: uuid(userId), p_status: status }, retryAuth: false });
    },
    async signInWithPassword({ username, password } = {}) {
      assertStorage(); const started = generation;
      const name = normalizeUsername(username);
      if (typeof password !== 'string' || !password || new TextEncoder().encode(password).length > 72) throw new CloudError('請輸入有效的帳號與密碼。', { code: 'invalid_credentials' });
      let data;
      try { data = await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: `${name}@accounts.vixo.invalid`, password } }); }
      catch (error) {
        if (['invalid_credentials', 'email_not_confirmed', 'user_banned'].includes(error.code)) throw new CloudError('帳號或密碼不正確，請重新輸入。', { status: 401, code: 'invalid_credentials' });
        throw error;
      }
      if (!publicUser(data?.user).accountConfigured) throw new CloudError('帳號或密碼不正確，請重新輸入。', { status: 401, code: 'invalid_credentials' });
      return adopt(data, started);
    },
    async setupAccount({ username, password } = {}) {
      assertStorage(); const started = generation;
      const name = normalizeUsername(username);
      if (typeof password !== 'string' || [...password].length < 12 || new TextEncoder().encode(password).length > 72) throw new CloudError('密碼至少 12 個字元；若含中文或特殊字元而過長，請縮短後重試。', { code: 'invalid_password' });
      const current = await request('/auth/v1/user');
      if (publicUser(current).accountConfigured) throw new CloudError('這個身分已設定帳號，請使用原帳號登入。', { status: 409, code: 'account_already_bound' });
      // A credential write must never be retried after an uncertain outcome.
      const data = await request('/functions/v1/vixo-account', { method: 'POST', body: { username: name, password }, retryAuth: false });
      if (data?.user?.id !== current.id) throw new CloudError('設定帳號的身分不一致，請重新確認連線。', { code: 'account_changed' });
      return adopt(data, started);
    },
    async pairDevice(code) {
      assertStorage();
      const started = generation;
      const data = await raw('/functions/v1/vixo-device-pair', { method: 'POST', body: { code: String(code).trim() } });
      if (!data?.access_token || !data?.refresh_token) throw new CloudError('裝置配對未完成。');
      return adopt(data, started);
    },
    createDeviceCode() { return rpc('vixo_create_device_code', {}); },
    async setSession(value) {
      assertStorage();
      const started = generation;
      if (!value?.access_token || !value?.refresh_token) throw new Error("Invalid session");
      const user = await raw("/auth/v1/user", { token: value.access_token });
      checkGeneration(started);
      generation++; persist(normalize({ ...value, user })); return publicUser(user);
    },
    async signOut() {
      const token = session?.access_token; generation++; persist(null);
      if (token) await raw("/auth/v1/logout?scope=local", { method: "POST", token });
      return { ok: true };
    },
    async getUser({ allowOfflineCache = false } = {}) {
      const started = generation;
      try {
        const user = await request('/auth/v1/user');
        checkGeneration(started);
        const safe = publicUser(user);
        persist({ ...session, user: safe, user_verified_at: Date.now() });
        return safe;
      } catch (error) {
        assertStorage();
        checkGeneration(started);
        if (allowOfflineCache && error.code === 'network_error' && session?.user_verified_at && session.user?.id && session.expires_at > Date.now() / 1000) return { ...publicUser(session.user), offline: true };
        throw error;
      }
    },
    async listAssets({ workspaceId } = {}) {
      const params = { select: "id,owner_id,workspace_id,kind,slug,title,description,revision,created_at,updated_at", order: "updated_at.desc,id.asc", limit: "1000" };
      if (workspaceId === null) params.workspace_id = "is.null";
      else if (workspaceId) params.workspace_id = `eq.${uuid(workspaceId)}`;
      const result = [], seen = new Set();
      for (let offset = 0; ; offset += 1000) {
        const page = await table("vixo_assets", { ...params, offset: String(offset) });
        if (!Array.isArray(page)) throw new CloudError("雲端清單格式錯誤。", { code: "invalid_response" });
        for (const item of page) {
          if (seen.has(item.id)) throw new CloudError("雲端清單同步期間已變更，請重試。", { code: "list_changed" });
          seen.add(item.id); result.push(item);
        }
        if (page.length < 1000) return result;
      }
    },
    async getAssetMetadata(id) {
      const rows = await table("vixo_assets", { select: "id,owner_id,workspace_id,kind,slug,title,description,revision,created_at,updated_at", id: `eq.${uuid(id)}` });
      if (!rows[0]) throw new CloudError("找不到項目，或你已沒有存取權限。", { status: 404, code: "not_found" });
      return rows[0];
    },
    async getAsset(id) {
      const rows = await table("vixo_assets", { select: "*", id: `eq.${uuid(id)}` });
      if (!rows[0]) throw new CloudError("找不到項目，或你已沒有存取權限。", { status: 404, code: "not_found" });
      return rows[0];
    },
    listRevisions(id) { return table("vixo_asset_revisions", { select: "*", asset_id: `eq.${uuid(id)}`, order: "revision.desc", limit: "1000" }); },
    saveAsset({ id = null, kind, slug, title, description = "", bundle, workspaceId = null, expectedRevision = 0, message = "" }) {
      // A response can be lost after a write commits. The durable outbox decides
      // whether to reconcile it; the transport must never replay this write.
      return rpc("vixo_save_asset", { p_id: id ? uuid(id) : null, p_kind: kind, p_slug: slug, p_title: title, p_description: description, p_bundle: bundle, p_workspace_id: workspaceId ? uuid(workspaceId) : null, p_expected_revision: expectedRevision, p_message: message }, { retryAuth: false });
    },
    listWorkspaces() { return table("vixo_workspaces", { select: "*", order: "created_at.asc" }); },
    createWorkspace(name) { return rpc("vixo_create_workspace", { p_name: name }); },
    createInvite(workspaceId, role = "viewer") { return rpc("vixo_create_invite", { p_workspace_id: uuid(workspaceId), p_role: role }); },
    joinWorkspace(code) { return rpc("vixo_join_workspace", { p_code: code }); },
    listMembers(workspaceId) { return table("vixo_members", { select: "user_id,role", workspace_id: `eq.${uuid(workspaceId)}` }); },
    removeMember(workspaceId, userId) { return rpc("vixo_remove_member", { p_workspace_id: uuid(workspaceId), p_user_id: uuid(userId) }); }
  };
}
