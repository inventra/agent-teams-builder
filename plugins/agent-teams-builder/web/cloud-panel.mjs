const $ = (id) => document.getElementById(id);
let storedToken = '';
try { storedToken = sessionStorage.getItem('vixo-token') || ''; } catch {}
const token = new URLSearchParams(location.search).get('token') || storedToken;
try { if (token) sessionStorage.setItem('vixo-token', token); } catch {}
try { history.replaceState(null, '', location.pathname); } catch {}
// Sandboxed Codex frames cannot rely on sessionStorage for the return trip.
$('back').href = `/?token=${encodeURIComponent(token)}`;
let localAgents = [], draft = null, state = null, generation = 0;
const notice = (text) => { $('notice').textContent = text; };
let connectionChannel = null;
try { connectionChannel = new BroadcastChannel('vixo-cloud-connection'); } catch {}
const broadcastConnectionChange = () => connectionChannel?.postMessage({ type: 'identity-changed' });
function staleOperation() { return Object.assign(new Error('裝置身分已變更，已略過舊操作結果。'), { code: 'stale_operation' }); }
async function api(route, body) {
  const started = generation;
  const response = await fetch(`/api/cloud/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (started !== generation) throw staleOperation();
  if (!response.ok) throw Object.assign(new Error(data.error || '雲端操作失敗'), { code: data.code, status: response.status });
  return data;
}
function accountError(error) {
  if (error.code === 'account_pending') return '帳號正在等待 Kevin 管理員核准。';
  if (error.code === 'account_disabled') return '此帳號已停用，請聯絡 Kevin 管理員。';
  if (error.code === 'admin_required') return '這項操作需要管理員權限。';
  if (error.code === 'account_registration_unconfirmed') return '註冊結果待確認。請先用剛填寫的帳號密碼登入；若仍無法登入，請聯絡管理員，勿重複註冊。';
  if (error.code === 'account_registered_session_unavailable') return '帳號已建立，請用剛註冊的帳號密碼登入。';
  if (error.code === 'account_already_connected') return '此裝置已連線，請保留原身分設定帳號。新註冊不會帶入原資料。';
  if (error.name === 'TypeError') return '無法連上雲端，請確認網路後重新檢查權限。';
  if (['account_bind_in_progress', 'account_bind_unconfirmed'].includes(error.code)) return '帳號設定正在處理或結果待確認。請先用剛設定的帳號密碼登入；若仍無法登入，請聯絡管理員，勿重複設定。';
  if (error.code === 'account_bound_session_unavailable') return '帳號已設定，請用剛設定的帳號密碼登入';
  if (error.code === 'account_already_bound') return '目前身分已設定帳號密碼，請使用原有帳號登入。';
  if (error.code === 'username_unavailable') return '這個帳號已被使用，請設定其他帳號。';
  if (error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message)) return '帳號或密碼不正確，請再確認一次。';
  return error.message;
}
const action = (handler) => async (event) => {
  event?.preventDefault();
  const button = event?.submitter || event?.currentTarget;
  if (button) button.disabled = true;
  try { await handler(event); }
  catch (error) {
    if (error.code === 'stale_operation') return;
    if (state?.connected && (['account_pending', 'account_disabled', 'network_error', 'access_unconfirmed'].includes(error.code) || error.name === 'TypeError')) {
      suspendConnection();
      if (['account_pending', 'account_disabled'].includes(error.code)) state.access = { userId: state.user?.id, status: error.code === 'account_disabled' ? 'disabled' : 'pending', isAdmin: false };
      renderAccess();
    }
    if (error.code === 'admin_required') { $('account-list').replaceChildren(); $('account-admin').hidden = true; $('manage-accounts').hidden = true; }
    notice(accountError(error));
  }
  finally { if (button) button.disabled = false; }
};
function option(select, value, text) { const item = document.createElement('option'); item.value = value; item.textContent = text; select.append(item); }
function invalidateDraft() { draft = null; $('draft').hidden = true; $('draft-content').textContent = ''; }
function clearIdentityView() {
  localAgents = []; state = null; invalidateDraft();
  for (const name of ['device-result', 'asset-detail', 'identity', 'notice', 'access-message']) $(name).textContent = '';
  for (const name of ['assets', 'local-agent', 'resource', 'workspace', 'account-list']) $(name).replaceChildren();
  for (const name of ['account', 'publish-section', 'assets-section', 'account-admin', 'access-state']) $(name).hidden = true;
  for (const name of ['login-password', 'setup-password', 'setup-password-confirm', 'pair-code', 'register-password', 'register-confirm', 'register-name', 'register-account']) $(name).value = '';
  $('setup-account').value = ''; $('account-setup').hidden = true;
  $('portal-help').textContent = '';
  for (const name of ['advanced-pair', 'advanced-device', 'registration']) $(name).open = false;
  $('manage-accounts').hidden = true;
  $('connect').hidden = false;
}
function resources() {
  const agent = localAgents.find((entry) => entry.id === $('local-agent').value);
  const kind = $('kind').value;
  $('resource-label').hidden = kind === 'agent'; $('resource').replaceChildren();
  for (const entry of (kind === 'skill' ? agent?.skills : agent?.workflows) || []) option($('resource'), entry.id, entry.name);
  invalidateDraft();
}
function renderAccess() {
  if (!state?.connected) return;
  $('connect').hidden = true;
  for (const id of ['account', 'publish-section', 'assets-section', 'account-admin']) $(id).hidden = true;
  $('access-state').hidden = false;
  const status = state.access?.status;
  $('access-title').textContent = status === 'pending' ? '等待 Kevin 核准' : status === 'disabled' ? '帳號已停用' : '請重新確認使用權限';
  $('access-message').textContent = status === 'pending' ? (state.user?.accountConfigured ? '註冊已完成。Kevin 管理員核准後，才能使用雲端 Agent、Skill 與 Workflow。' : '已連接雲端身分。請先設定帳號密碼，方便 Kevin 管理員辨識；核准後才能使用雲端內容。') : status === 'disabled' ? '此帳號目前無法使用雲端內容，請聯絡 Kevin 管理員。' : '目前尚未確認帳號權限，請連線後重新檢查。';
  if (status === 'pending' && !state.user?.accountConfigured) {
    $('access-state').insertBefore($('account-setup'), $('access-recheck'));
    $('account-setup').hidden = false;
  }
}
function suspendConnection() {
  const previous = state;
  generation++; clearIdentityView();
  if (previous?.connected) { state = { ...previous, access: null }; renderAccess(); }
}
async function refresh() {
  suspendConnection();
  const next = await api('status');
  state = next;
  if (!state.connected) { clearIdentityView(); state = next; return; }
  if (state.access?.status !== 'approved' || state.access?.userId !== state.user?.id) { renderAccess(); return; }
  $('connect').hidden = true; $('access-state').hidden = true;
  for (const id of ['account', 'publish-section', 'assets-section']) $(id).hidden = false;
  $('identity').textContent = `${state.user.username ? `帳號：${state.user.username}` : state.access.isAdmin ? 'Kevin 管理員' : '已連線的 VIXO 裝置'} · ${state.user.id.slice(0, 8)}`;
  $('account').insertBefore($('account-setup'), $('account').querySelector('.actions'));
  $('account-setup').hidden = Boolean(state.user.accountConfigured);
  $('manage-accounts').hidden = !state.access.isAdmin;
  $('portal-help').textContent = state.user.accountConfigured ? '網站和其他裝置可直接使用這組帳號密碼登入。' : '請先在上方設定原身分的帳號密碼，再到網站登入。原有雲端內容會保留。';
  const [agents, workspaces, assets] = await Promise.all([api('local-agents'), api('workspaces'), api('assets')]);
  localAgents = agents; $('local-agent').replaceChildren();
  for (const agent of agents) option($('local-agent'), agent.id, agent.displayName);
  $('workspace').replaceChildren(); option($('workspace'), '', '我的個人空間');
  for (const workspace of workspaces) option($('workspace'), workspace.id, workspace.name);
  resources(); $('assets').replaceChildren();
  for (const asset of assets) {
    const item = document.createElement('li'); const button = document.createElement('button');
    button.textContent = `${asset.title} · ${asset.kind} · v${asset.revision}`;
    button.onclick = action(async () => {
      const result = await api('pull', { assetId: asset.id });
      $('asset-detail').textContent = JSON.stringify(result, null, 2);
      notice('已驗證權限並下載到此帳號的獨立快取。');
    });
    item.append(button); const ref = document.createElement('code'); ref.textContent = `cloud:${asset.id}`; item.append(ref); $('assets').append(item);
  }
}
$('login').onsubmit = action(async () => {
  const credentials = { username: $('login-account').value.trim().toLowerCase(), password: $('login-password').value };
  generation++; clearIdentityView();
  await api('login', credentials);
  broadcastConnectionChange();
  await refresh(); if (state?.access?.status === 'approved') notice('已登入，原有雲端內容已載入。');
});
$('register').onsubmit = action(async () => {
  if (state?.connected) throw new Error('此裝置已連線，請保留原身分設定帳號。');
  const username = $('register-account').value.trim().toLowerCase(), password = $('register-password').value, displayName = $('register-name').value.trim();
  if (!displayName || [...displayName].length > 80) throw new Error('請填寫 1–80 個字元的姓名，方便管理員確認身分。');
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) throw new Error('帳號需為 3–32 個小寫英文、數字、底線或連字號，且以英文字母開頭。');
  if ([...password].length < 12 || new TextEncoder().encode(password).length > 72) throw new Error('密碼需至少 12 個字元；過長時請縮短密碼，中文字元佔較多長度。');
  if (password !== $('register-confirm').value) throw new Error('兩次輸入的密碼不一致，請重新確認。');
  generation++; clearIdentityView();
  try { await api('register', { username, password, displayName }); }
  catch (error) { if (['account_registration_unconfirmed', 'account_registered_session_unavailable'].includes(error.code)) $('login-account').value = username; throw error; }
  broadcastConnectionChange(); await refresh();
});
$('credentials').onsubmit = action(async () => {
  const originalUserId = state?.user?.id;
  if (!originalUserId) throw new Error('請先登入或連接原有雲端身分。');
  const username = $('setup-account').value.trim().toLowerCase();
  const password = $('setup-password').value;
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) throw new Error('帳號需為 3–32 個小寫英文、數字、底線或連字號，且以英文字母開頭。');
  if ([...password].length < 12 || new TextEncoder().encode(password).length > 72) throw new Error('密碼需至少 12 個字元；過長時請縮短密碼，中文字元佔較多長度。');
  if (password !== $('setup-password-confirm').value) throw new Error('兩次輸入的密碼不一致，請重新確認。');
  $('setup-password').value = ''; $('setup-password-confirm').value = '';
  try { await api('setup-account', { username, password }); }
  catch (error) {
    if (error.code !== 'account_bound_session_unavailable') throw error;
    // The account binding succeeded. Keep its server-side session and do not retry.
    generation++; clearIdentityView();
    $('login-account').value = username; notice(accountError(error));
    return;
  }
  if (state?.user?.id !== originalUserId) throw staleOperation();
  generation++; clearIdentityView(); broadcastConnectionChange();
  await refresh();
  if (state?.user?.id !== originalUserId) throw new Error('雲端身分已變更，請重新整理後確認。');
  notice(state?.access?.status === 'pending' ? '帳號密碼已設定，仍須等待 Kevin 管理員核准。原有雲端身分已保留。' : '帳號密碼已設定，原有資產與團隊權限已保留。網站和其他裝置可直接登入。');
});
$('pair').onsubmit = action(async () => {
  const code = $('pair-code').value;
  generation++; clearIdentityView();
  await api('pair', { code });
  broadcastConnectionChange();
  $('pair-code').value = '';
  await refresh(); notice('裝置已連線。');
});
const disconnect = action(async () => {
  generation++; clearIdentityView();
  try { await api('disconnect', {}); } finally { broadcastConnectionChange(); await refresh(); }
  notice('已登出此裝置。');
});
$('disconnect').onclick = disconnect; $('access-disconnect').onclick = disconnect;
$('access-recheck').onclick = action(refresh);
$('device-code').onclick = action(async () => {
  $('device-result').textContent = '';
  const result = await api('device-code', {});
  $('device-result').textContent = `只用於你自己的另一台裝置，請勿當作同仁邀請碼：${result.code}\n有效至 ${result.expires_at}`;
});
$('portal').onclick = action(async () => {
  await api('open-portal', {});
  notice(state?.user?.accountConfigured ? '已在預設瀏覽器開啟雲端管理中心，請用這組帳號密碼登入。' : '已在預設瀏覽器開啟雲端管理中心。請先在這台已連線的 VIXO 設定帳號密碼，再到網站登入。');
});
async function ensureAdmin() {
  const access = await api('access');
  if (access.userId !== state?.user?.id) throw staleOperation();
  state.access = access;
  if (access.status !== 'approved') { const next = state; suspendConnection(); state = next; renderAccess(); return false; }
  if (!access.isAdmin) { generation++; $('account-list').replaceChildren(); $('account-admin').hidden = true; $('manage-accounts').hidden = true; throw Object.assign(new Error('這項操作需要管理員權限。'), { code: 'admin_required' }); }
  return true;
}
async function showAccounts() {
  $('account-list').replaceChildren();
  if (!await ensureAdmin()) return;
  const accounts = await api('accounts');
  for (const [status, title] of [['pending', '待審核'], ['approved', '已核准'], ['disabled', '已停用']]) {
    const group = document.createElement('section'); group.setAttribute('aria-label', title);
    const heading = document.createElement('h3'); heading.textContent = title; group.append(heading);
    const rows = accounts.filter(row => row.status === status);
    if (!rows.length) { const empty = document.createElement('p'); empty.textContent = '目前沒有帳號。'; group.append(empty); }
    for (const row of rows) {
      const item = document.createElement('div'); item.className = 'actions';
      const label = document.createElement('p'); label.textContent = `${row.displayName || row.username || (row.isAdmin ? 'Kevin 管理員' : '尚未設定帳號')} · ${row.username || '既有裝置身分'}`; item.append(label);
      if (row.isAdmin) { const tag = document.createElement('p'); tag.textContent = '管理員'; item.append(tag); }
      else {
        for (const desired of status === 'pending' ? ['approved', 'disabled'] : [status === 'approved' ? 'disabled' : 'approved']) {
          const button = document.createElement('button');
          button.textContent = desired === 'disabled' ? '停用' : status === 'pending' ? '核准' : '恢復';
          button.onclick = action(async () => { if (!await ensureAdmin()) return; await api('account-status', { userId: row.userId, status: desired }); broadcastConnectionChange(); await showAccounts(); notice(desired === 'approved' ? '帳號已核准，團隊權限需另外邀請。' : '帳號已停用。'); });
          item.append(button);
        }
      }
      group.append(item);
    }
    $('account-list').append(group);
  }
  $('account-admin').hidden = false;
}
$('manage-accounts').onclick = action(showAccounts);
$('close-accounts').onclick = () => { $('account-admin').hidden = true; $('account-list').replaceChildren(); };
$('reload').onclick = action(refresh);
$('kind').onchange = resources; $('local-agent').onchange = resources;
$('resource').onchange = invalidateDraft; $('workspace').onchange = invalidateDraft;
$('preview').onsubmit = action(async () => {
  invalidateDraft();
  const selected = { agent: $('local-agent').value, kind: $('kind').value, skillId: $('resource').value, workflowId: $('resource').value, workspaceId: $('workspace').value || null };
  const result = await api('preview-upload', selected);
  if (selected.agent !== $('local-agent').value || selected.kind !== $('kind').value || selected.skillId !== $('resource').value || selected.workspaceId !== ($('workspace').value || null)) return;
  draft = result;
  $('draft-content').textContent = JSON.stringify({ title: draft.title, kind: draft.kind, workspaceId: draft.workspaceId, expectedRevision: draft.expectedRevision, bundle: draft.bundle }, null, 2);
  $('draft').hidden = false; notice('請檢視完整 SOP、檔案、依賴與發布空間，再確認發布。');
});
$('confirm').onclick = action(async () => {
  if (!draft) return;
  const result = await api('publish', { token: draft.token, userConfirmation: '確認發布' });
  if (result?.status === 'conflict') { notice('雲端已有新版本，修改已保留。'); return; }
  invalidateDraft();
  await refresh(); notice('已發布到雲端。');
});
if (connectionChannel) connectionChannel.onmessage = event => {
  if (event.data?.type !== 'identity-changed') return;
  generation++; clearIdentityView();
  action(refresh)();
};
window.addEventListener('focus', () => { if (state?.connected) action(refresh)(); });
window.addEventListener('online', () => { if (state?.connected) action(refresh)(); });
window.addEventListener('offline', () => { if (state?.connected) { suspendConnection(); notice('目前無法連線，已隱藏雲端內容。請連線後重新檢查帳號權限。'); } });
action(refresh)();
