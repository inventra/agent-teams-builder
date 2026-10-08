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
  if (!response.ok) throw new Error(data.error || '雲端操作失敗');
  return data;
}
const action = (handler) => async (event) => {
  event?.preventDefault();
  const button = event?.submitter || event?.currentTarget;
  if (button) button.disabled = true;
  try { await handler(event); }
  catch (error) { if (error.code !== 'stale_operation') notice(error.message); }
  finally { if (button) button.disabled = false; }
};
function option(select, value, text) { const item = document.createElement('option'); item.value = value; item.textContent = text; select.append(item); }
function invalidateDraft() { draft = null; $('draft').hidden = true; $('draft-content').textContent = ''; }
function clearIdentityView() {
  localAgents = []; state = null; invalidateDraft();
  for (const name of ['device-result', 'asset-detail', 'identity', 'notice']) $(name).textContent = '';
  for (const name of ['assets', 'local-agent', 'resource', 'workspace']) $(name).replaceChildren();
  for (const name of ['account', 'publish-section', 'assets-section']) $(name).hidden = true;
  $('connect').hidden = false;
}
function resources() {
  const agent = localAgents.find((entry) => entry.id === $('local-agent').value);
  const kind = $('kind').value;
  $('resource-label').hidden = kind === 'agent'; $('resource').replaceChildren();
  for (const entry of (kind === 'skill' ? agent?.skills : agent?.workflows) || []) option($('resource'), entry.id, entry.name);
  invalidateDraft();
}
async function refresh() {
  const next = await api('status');
  if (state?.user?.id && state.user.id !== next.user?.id) { generation++; clearIdentityView(); }
  state = next;
  $('connect').hidden = state.connected;
  for (const name of ['account', 'publish-section', 'assets-section']) $(name).hidden = !state.connected;
  $('identity').textContent = state.user ? `此裝置已連接個人雲端空間 · ${state.user.id.slice(0, 8)}` : '';
  if (!state.connected) { clearIdentityView(); state = next; return; }
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
$('pair').onsubmit = action(async () => {
  const code = $('pair-code').value;
  generation++; clearIdentityView();
  await api('pair', { code });
  broadcastConnectionChange();
  $('pair-code').value = '';
  await refresh(); notice('裝置已連線。');
});
$('disconnect').onclick = action(async () => {
  generation++; clearIdentityView();
  try { await api('disconnect', {}); } finally { broadcastConnectionChange(); await refresh(); }
  notice('此裝置已中斷連線。');
});
$('device-code').onclick = action(async () => {
  $('device-result').textContent = '';
  const result = await api('device-code', {});
  $('device-result').textContent = `只用於你自己的另一台裝置，請勿當作同仁邀請碼：${result.code}\n有效至 ${result.expires_at}`;
});
$('portal').onclick = action(async () => {
  await api('open-portal', {});
  notice('已在預設瀏覽器開啟雲端管理中心；瀏覽器首次連線時，請使用自己的裝置換機碼。');
});
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
window.addEventListener('focus', () => {
  // BroadcastChannel is unavailable in some opaque/sandboxed host frames.
  // Never leave an old capability exposed while checking the active identity.
  $('device-result').textContent = '';
  if (!state) return;
  action(async () => {
    const next = await api('status');
    if (next.user?.id !== state?.user?.id || next.connected !== state?.connected) {
      generation++; clearIdentityView(); await refresh();
    }
  })();
});
refresh().catch((error) => { if (error.code !== 'stale_operation') notice(error.message); });
