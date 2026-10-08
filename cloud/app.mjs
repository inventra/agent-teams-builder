const TYPES = Object.freeze({ agent: { label: 'Agent', plural: '我的 Agent', icon: '✧', description: '把訓練好的角色與工作方法，帶到每一個裝置。' }, skill: { label: 'Skill', plural: '技能資料庫', icon: '◇', description: '保存可重複使用的專業能力，讓團隊一起進步。' }, workflow: { label: 'Workflow', plural: '工作流程', icon: '⇢', description: '把協作步驟整理成流程，讓每一次執行都有依據。' } });
const SESSION_KEY = 'vixo.cloud.session.v1';
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export function sessionCredentialsChanged(previous, next) {
  return (previous?.access_token || null) !== (next?.access_token || null) || (previous?.refresh_token || null) !== (next?.refresh_token || null);
}

export function validateAccountSetup(username, password, confirmation) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(normalized)) throw new Error('帳號需為 3–32 個小寫英文字母、數字、底線或連字號，且以英文字母開頭。');
  if (typeof password !== 'string' || [...password].length < 12 || new TextEncoder().encode(password).length > 72) throw new Error('密碼需至少 12 個字元；過長時請縮短密碼，中文字元佔較多長度。');
  if (password !== confirmation) throw new Error('兩次輸入的密碼不一致，請重新確認。');
  return { username: normalized, password };
}

export function friendlyError(error) {
  const code = String(error?.code || '');
  if (['account_bind_in_progress', 'account_bind_unconfirmed'].includes(code)) return '帳號設定正在處理或結果待確認。請先用剛設定的帳號密碼登入；若仍無法登入，請聯絡管理員，勿重複設定。';
  if (code === 'account_bound_session_unavailable') return '帳號已設定，請用剛設定的帳號密碼登入';
  if (code === 'account_already_bound') return '目前身分已設定帳號密碼，請使用原有帳號登入。';
  if (code === 'username_unavailable') return '這個帳號已被使用，請設定其他帳號。';
  if (/invalid.*credentials|invalid login|帳號或密碼/i.test(code + ' ' + error?.message)) return '帳號或密碼不正確，請再確認一次。';
  if (/username.*taken|account.*exists/i.test(code + ' ' + error?.message)) return '這個帳號已被使用，請設定其他帳號。';
  if (code === 'revision_conflict' || error?.status === 409) return '雲端已有較新的版本。請關閉預覽、重新整理內容後再更新，避免覆蓋同仁的修改。';
  if (/invalid.*code|expired.*code|code.*expired|code.*invalid/i.test(code + ' ' + error?.message)) return '連線碼無效、已使用或已過期，請向已連線的 VIXO 取得新碼。';
  if (/already.*exist|duplicate|23505/i.test(code + ' ' + error?.message)) return '這個空間已有相同識別名稱，請使用其他名稱。';
  if (/rate.limit|too.many/i.test(code + ' ' + error?.message)) return '操作次數較多，請稍候再試。';
  if (/expired|jwt|session|refresh_token/i.test(code) || error?.status === 401) return '登入已過期，請重新使用帳號密碼登入。';
  if (error?.status === 403 || /permission|row.level|42501/i.test(code + ' ' + error?.message)) return '目前裝置身分沒有這項操作的權限，請向團隊管理者確認。';
  if (/failed to fetch|network|load failed/i.test(error?.message || '')) return '無法連上雲端，請確認網路後再試。';
  if (/^[\x20-\x7e\s]+$/.test(error?.message || '')) return '操作未完成，請稍後再試或確認輸入內容。' + (code ? `（${code}）` : '');
  return error?.message || '操作未完成，請稍後再試。';
}

export function parseImport(text) {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('匯入檔案超過 5 MB，請拆分資產後再試。');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('JSON 格式不正確，請檢查括號、引號與逗號。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('請匯入一個 Agent、Skill 或 Workflow 的 JSON 物件。');
  const asset = data.asset || data;
  const bundle = asset.bundle || asset;
  validateBundle(bundle);
  return { kind: bundle.kind, title: String(asset.title || bundle.spec?.displayName || bundle.spec?.name || bundle.spec?.title || ''), slug: String(asset.slug || bundle.spec?.id || ''), description: String(asset.description || bundle.spec?.description || ''), bundle };
}

export function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.formatVersion !== 1 || !TYPES[bundle.kind]) throw new Error('不支援的資產格式。需要 formatVersion: 1，kind 為 agent、skill 或 workflow。');
  if (!bundle.spec || typeof bundle.spec !== 'object' || Array.isArray(bundle.spec)) throw new Error('資產缺少 spec 設定內容。');
  if (!Array.isArray(bundle.files) || !Array.isArray(bundle.dependencies) || !bundle.requirements || !Array.isArray(bundle.requirements.platforms) || !Array.isArray(bundle.requirements.tools)) throw new Error('資產需要 files、dependencies 與 requirements（platforms、tools）清單。');
  const nonempty = (value, label, max = 12000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 必須是完整文字，且不可超過 ${max} 字元。`); };
  const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
  const stringList = (list, label, min = 0, max = 100, length = 1200) => { if (!Array.isArray(list) || list.length < min || list.length > max || list.some(item => typeof item !== 'string' || !item.trim() || item.length > length)) throw new Error(`${label} 需要有效的文字清單。`); };
  const validateSkill = skill => {
    if (!skill || !validId(skill.id)) throw new Error('Skill 需要有效的 id（小寫英文開頭，可含數字與連字號）。');
    nonempty(skill.name, 'Skill.name', 100); nonempty(skill.description, 'Skill.description', 1000);
    stringList(skill.triggers, 'Skill.triggers', 1, 30, 160); stringList(skill.allowedTools || [], 'Skill.allowedTools', 0, 40, 120);
    stringList(skill.steps, 'Skill.steps', 1, 100, 1200); stringList(skill.successCriteria, 'Skill.successCriteria', 1, 50, 700);
  };
  const spec = bundle.spec;
  if (!validId(spec.id)) throw new Error('spec.id 需要小寫英文開頭，可含數字與連字號，長度 1–64。');
  if (bundle.kind === 'agent') {
    for (const [name, max] of [['displayName', 100], ['description', 1000], ['purpose', 2000], ['systemPrompt', 12000]]) nonempty(spec[name], `Agent.${name}`, max);
    if (spec.memory) throw new Error('個人記憶不能放入共用套件，請將 spec.memory 清空。');
    stringList(spec.aliases || [], 'Agent.aliases', 0, 30, 100);
    if (!Array.isArray(spec.skills) || !spec.skills.length) throw new Error('Agent 至少需要一項完整 Skill。');
  }
  const skills = bundle.kind === 'skill' ? [spec] : spec.skills;
  if (!Array.isArray(skills)) throw new Error('Workflow 必須包含所需的 skills 定義。');
  skills.forEach(validateSkill);
  const ids = new Set(skills.map(skill => skill.id));
  if (ids.size !== skills.length) throw new Error('Skill id 不得重複。');
  const workflows = bundle.kind === 'agent' ? spec.workflows || [] : bundle.kind === 'workflow' ? [spec] : [];
  if (!Array.isArray(workflows)) throw new Error('workflows 必須是清單。');
  if (new Set(workflows.map(workflow => workflow?.id)).size !== workflows.length) throw new Error('Workflow id 不得重複。');
  for (const workflow of workflows) {
    if (!validId(workflow.id)) throw new Error('Workflow 需要有效的 id。');
    nonempty(workflow.name, 'Workflow.name', 120); nonempty(workflow.description, 'Workflow.description', 1200); stringList(workflow.triggers || [], 'Workflow.triggers', 0, 30, 160);
    if (!Array.isArray(workflow.nodes) || !workflow.nodes.length) throw new Error('Workflow 至少需要一個流程節點。');
    if (new Set(workflow.nodes.map(node => node?.id)).size !== workflow.nodes.length) throw new Error('流程節點 id 不得重複。');
    for (const node of workflow.nodes) {
      if (!node || !validId(node.id) || !['skill', 'tool', 'approval', 'manual'].includes(node.type || 'skill')) throw new Error('流程節點需要有效的 id 與 type。');
      nonempty(node.name, 'Node.name', 120); nonempty(node.instructions, 'Node.instructions', 2000);
      if ((!node.type || node.type === 'skill') && !ids.has(node.skillId)) throw new Error('流程引用的 Skill 不在這個套件內。');
    }
  }
  if (!bundle.files.length || bundle.files.length > 512) throw new Error('請附上完整 Skill／Workflow 檔案，最多 512 個。');
  if (bundle.requirements.platforms.some(value => !['windows', 'macos', 'linux'].includes(value))) throw new Error('平台只支援 windows、macos、linux。');
  stringList(bundle.requirements.tools, 'requirements.tools', 0, 64, 120);
  const paths = new Set();
  let fileBytes = 0;
  for (const file of bundle.files) {
    if (!file || typeof file.path !== 'string' || !file.path || typeof file.content !== 'string') throw new Error('每個檔案都需要 path 與文字 content。');
    if (/^[\\/]|^[a-z]:|\x00/i.test(file.path) || file.path.split(/[\\/]/).some(part => part === '..' || part === '.')) throw new Error('檔案路徑必須是資產內的相對路徑，不能包含上層目錄。');
    const parts = file.path.split('/');
    if (file.path.includes('\\') || parts.some(part => !part || part.startsWith('.') || /[<>:\"|?*\x00-\x1f\x7f]/.test(part) || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || !['skills', 'workflows', 'references', 'scripts', 'assets'].includes(parts[0]) || parts.length < 2 || !/\.(md|js|mjs|py|ps1|json|html)$/i.test(file.path)) throw new Error('檔案路徑需要放在 skills、workflows、references、scripts 或 assets，且使用可攜的文字檔案格式。');
    if (parts.some(part => /^(?:history|runs|erp-runs|media|screenshots|memory|node_modules|cache|credentials|output|outputs|dist)$/i.test(part)) || /^(?:memory(?:\..*)?|credentials(?:\..*)?|session\.json|input\.json|request\.json)$/i.test(parts.at(-1))) throw new Error('執行紀錄、個人記憶及憑證檔案不可加入共用套件。');
    const folded = file.path.normalize('NFC').toLowerCase();
    if (paths.has(folded)) throw new Error('資產中有重複的檔案路徑。');
    paths.add(folded);
    const size = new TextEncoder().encode(file.content).length;
    if (size > 1024 * 1024) throw new Error('單一檔案不可超過 1 MB。');
    fileBytes += size;
  
  }
  if (fileBytes > MAX_IMPORT_BYTES) throw new Error('附加檔案總大小不可超過 5 MB。');
  for (const skill of skills) if (!bundle.files.some(file => file.path === `skills/${skill.id}/SKILL.md`)) throw new Error(`缺少完整 Skill 檔案：skills/${skill.id}/SKILL.md`);
  const dependencyIds = new Set();
  for (const dependency of bundle.dependencies) {
    if (!dependency || ![...Object.keys(TYPES), 'plugin'].includes(dependency.kind) || !validId(dependency.id) || typeof dependency.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(dependency.version) || /^(latest|main|master|head)$/i.test(dependency.version)) throw new Error('每個依賴都需要 kind、id 與固定 version（不可使用 latest）。');
    const key = `${dependency.kind}/${dependency.id}`;
    if (dependencyIds.has(key)) throw new Error('依賴項目不能重複。');
    dependencyIds.add(key);
  }
  return bundle;
}

export function preparePreview(input) {
  const title = String(input.title || '').trim();
  const slug = String(input.slug || '').trim();
  if (!title) throw new Error('請填寫顯示名稱。');
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(slug)) throw new Error('識別名稱請使用 1–80 個小寫英文字母、數字、底線或連字號。');
  validateBundle(input.bundle);
  if (input.kind !== input.bundle.kind) throw new Error('資產類型與 bundle.kind 不一致。');
  if (input.id && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)) throw new Error('更新需要目前版本號，請重新開啟這個資產。');
  return structuredClone({ ...(input.id ? { id: input.id } : {}), kind: input.kind, slug, title, description: String(input.description || '').trim(), bundle: input.bundle, workspaceId: input.workspaceId || null, expectedRevision: input.id ? input.expectedRevision : 0, message: String(input.message || '').trim() });
}

export function exportAsset(asset) {
  return JSON.stringify({ exportVersion: 1, asset: { kind: asset.kind, slug: asset.slug, title: asset.title, description: asset.description || '', bundle: asset.bundle } }, null, 2) + '\n';
}

// The controller keeps preview and publication separate and discards stale responses
// after account/workspace switches, so another user's content cannot remain visible.
export function createCloudController(client, onChange = () => {}) {
  const state = { user: null, workspaces: [], scope: null, assets: [], selected: null, revisions: [], preview: null };
  let epoch = 0;
  let selection = 0;
  let publishing = false;
  const changed = () => onChange(state);
  const requireUser = () => { if (!state.user) throw new Error('請先連接此裝置，再管理雲端資產。'); };
  async function loadAssets() {
    requireUser();
    const ticket = ++epoch;
    const scope = state.scope;
    const assets = await client.listAssets({ workspaceId: scope });
    if (ticket === epoch && state.user) { state.assets = assets; changed(); }
  }
  return {
    state,
    async initialize() {
      const ticket = ++epoch;
      const user = await client.getUser();
      if (ticket !== epoch) return false;
      if (!user?.id) return false;
      state.user = user;
      const workspaces = await client.listWorkspaces();
      if (ticket !== epoch) return false;
      state.workspaces = workspaces;
      changed();
      await loadAssets();
      return true;
    },
    async clear() {
      ++epoch; ++selection;
      Object.assign(state, { user: null, workspaces: [], scope: null, assets: [], selected: null, revisions: [], preview: null });
      changed();
    },
    async refresh() { requireUser(); const ticket = epoch; const workspaces = await client.listWorkspaces(); if (ticket !== epoch || !state.user) return; state.workspaces = workspaces; if (state.scope && !workspaces.some(w => w.id === state.scope)) state.scope = null; state.selected = null; state.revisions = []; ++selection; changed(); await loadAssets(); },
    async chooseScope(scope) {
      requireUser();
      if (scope && !state.workspaces.some(w => w.id === scope)) throw new Error('這個團隊空間不存在或尚未加入。');
      state.scope = scope || null; state.assets = []; state.selected = null; state.revisions = []; state.preview = null; ++selection; changed();
      await loadAssets();
    },
    async selectAsset(id) {
      requireUser();
      const ticket = ++selection;
      const account = epoch;
      state.selected = null; state.revisions = [];
      const [asset, revisions] = await Promise.all([client.getAsset(id), client.listRevisions(id)]);
      if (ticket !== selection || account !== epoch || !state.user) return;
      state.selected = asset; state.revisions = revisions; changed();
    },
    back() { ++selection; state.selected = null; state.revisions = []; changed(); },
    stage(input) { requireUser(); state.preview = preparePreview(input); return structuredClone(state.preview); },
    cancelPreview() { state.preview = null; },
    async publish() {
      requireUser();
      if (!state.preview) throw new Error('請先檢視完整內容，再確認發布。');
      if (publishing) throw new Error('正在發布，請稍候。');
      const preview = structuredClone(state.preview);
      const userId = state.user.id;
      publishing = true;
      try {
        const asset = await client.saveAsset(preview);
        if (state.user?.id !== userId) return null;
        state.preview = null;
        await this.chooseScope(preview.workspaceId);
        await this.selectAsset(asset.id);
        return asset;
      } finally { publishing = false; }
    },
  };
}

function element(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && !key.startsWith('aria-')) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child !== null && child !== undefined) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}
const button = (text, action, style = '') => element('button', { type: 'button', text, class: style, onclick: action });
const code = value => element('pre', { class: 'code-view', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
const dateText = value => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '尚無日期' : new Intl.DateTimeFormat('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); };
function field(label, control, help) { return element('div', { class: 'field' }, [element('label', { htmlFor: control.id, text: label }), control, help ? element('div', { class: 'help-text', text: help }) : null]); }
export function blankBundle(kind) {
  const skill = { id: 'new-skill', name: '新技能', description: '請填寫這項技能的用途。', triggers: ['使用者指定這項技能'], allowedTools: [], steps: ['請在這裡填寫完整、可執行的工作步驟。'], successCriteria: ['確認完成使用者要求。'] };
  const workflow = { id: 'new-workflow', name: '新流程', description: '請填寫這項流程的用途。', triggers: [], nodes: [{ id: 'first-step', name: '執行技能', type: 'skill', skillId: skill.id, instructions: '依技能的完整 SOP 執行。', requiresApproval: false }] };
  const agent = { id: 'new-agent', displayName: '新 Agent', aliases: [], description: '請填寫這個角色的用途。', purpose: '依使用者指定的任務提供協助。', systemPrompt: '請依完整 SOP 與本次使用者授權執行工作；缺少資料時先確認。', memory: '', skills: [skill], workflows: [] };
  return { formatVersion: 1, kind, spec: kind === 'agent' ? agent : kind === 'workflow' ? { ...workflow, skills: [skill] } : skill, files: [{ path: 'skills/new-skill/SKILL.md', content: '# 新技能\n\n請在此補上與 spec.steps 一致的完整工作步驟。\n' }], dependencies: [], requirements: { platforms: [], tools: [] } };
}

export async function boot() {
  const main = document.querySelector('#main');
  const account = document.querySelector('#account');
  const notice = document.querySelector('#notice');
  const modal = document.querySelector('#modal');
  let kind = 'agent';
  let search = '';
  let detailTab = 'content';
  let client;
  let stored = null;
  let controller;
  let busy = false;
  let modalGeneration = 0;
  function announce(text, error = false) { notice.textContent = text; notice.hidden = !text; notice.classList.toggle('error', error); }
  function showError(error) { announce(friendlyError(error), true); }
  function closeModal() { ++modalGeneration; if (modal.open) modal.close(); controller?.cancelPreview(); }
  modal.addEventListener('cancel', () => { ++modalGeneration; controller?.cancelPreview(); });
  async function attempt(action) { try { await action(); } catch (error) { showError(error); } }
  function showModal(title, body, actions = []) {
    ++modalGeneration;
    modal.replaceChildren(element('div', { class: 'modal-header' }, [element('h2', { id: 'modal-title', text: title }), button('✕', closeModal, 'quiet small')]), element('div', { class: 'modal-body' }, body), element('div', { class: 'modal-footer' }, actions));
    modal.querySelector('.modal-header button').setAttribute('aria-label', '關閉視窗');
    if (!modal.open) modal.showModal();
    return modalGeneration;
  }
  function scopeName(scope) { return scope ? controller.state.workspaces.find(w => w.id === scope)?.name || '團隊空間' : '我的私人空間'; }
  function scopeSelect(id, selected = controller.state.scope) {
    const select = element('select', { id });
    select.append(element('option', { value: '', text: '我的私人空間' }));
    for (const workspace of controller.state.workspaces) select.append(element('option', { value: workspace.id, text: workspace.name }));
    select.value = selected || '';
    return select;
  }

  function renderAuth() {
    account.replaceChildren();
    const username = element('input', { id: 'login-account', name: 'username', type: 'text', placeholder: '你的 VIXO 帳號', required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 32 });
    const password = element('input', { id: 'login-password', name: 'password', type: 'password', placeholder: '請輸入密碼', required: true, autocomplete: 'current-password', maxLength: 72 });
    const status = element('p', { class: 'inline-error', role: 'alert' });
    const submit = element('button', { type: 'submit', class: 'primary', text: '登入工作室' });
    const form = element('form', { onsubmit: async event => {
      event.preventDefault();
      if (busy) return;
      const credentials = { username: username.value.trim().toLowerCase(), password: password.value };
      password.value = '';
      busy = true; submit.disabled = true; status.textContent = ''; announce('');
      try {
        await client.signInWithPassword(credentials);
        if (await controller.initialize()) { renderApp(); announce('已登入，原有雲端內容已載入。'); }
        else throw new Error('尚未完成登入，請重新確認帳號密碼。');
      } catch (error) { status.textContent = friendlyError(error); }
      finally { busy = false; submit.disabled = false; }
    } }, [field('帳號', username), field('密碼', password), status, submit]);
    const pairing = element('input', { id: 'device-code', name: 'device-code', type: 'text', placeholder: '貼上既有裝置碼或團隊邀請碼', required: true, autocomplete: 'off', spellcheck: false, maxLength: 200 });
    const pairStatus = element('p', { class: 'inline-error', role: 'alert' });
    const pairSubmit = element('button', { type: 'submit', text: '使用連線碼' });
    const pairForm = element('form', { onsubmit: async event => {
      event.preventDefault();
      if (busy) return;
      const value = pairing.value.trim(); pairing.value = '';
      busy = true; pairSubmit.disabled = true; pairStatus.textContent = '';
      try {
        await client.pairDevice(value);
        if (await controller.initialize()) { renderApp(); announce('已連接原有雲端身分。可設定帳號密碼，之後直接登入。'); }
        else throw new Error('尚未完成裝置連線，請重新確認連線碼。');
      } catch (error) { pairStatus.textContent = friendlyError(error); }
      finally { busy = false; pairSubmit.disabled = false; }
    } }, [field('一次性裝置連線碼／團隊邀請碼', pairing), pairStatus, pairSubmit]);
    main.replaceChildren(element('div', { class: 'auth-layout' }, [element('section', { class: 'auth-intro' }, [element('span', { class: 'eyebrow', text: 'Your team. Everywhere.' }), element('h1', {}, ['你的 Agent，', element('br'), '走到哪都在。']), element('p', { text: '使用同一組帳號密碼，接續你的角色、技能與工作流程，也把累積的經驗分享給團隊。' }), element('div', { class: 'hero-labels' }, [element('span', { text: '↗ 跨裝置同步' }), element('span', { text: '◇ 團隊共享' }), element('span', { text: '↺ 版本保留' })])]), element('section', { class: 'auth-card', 'aria-label': '帳號登入' }, [element('h2', { text: '登入 VIXO' }), element('p', { class: 'muted small-text', text: '輸入你在 VIXO 設定的帳號密碼。' }), form, element('div', { class: 'first-account-note' }, [element('strong', { text: '第一次使用帳號登入？' }), element('p', { text: '請先回到已連線、保有原本 Agent 的 VIXO 外掛，在「雲端連線」設定帳號密碼，再回到這裡登入。原有資產與團隊權限會保留。' })]), element('p', { class: 'help-text', text: '忘記密碼時，請向管理員確認恢復方式，並保留仍可使用的已連線裝置。' }), element('details', { class: 'advanced-auth' }, [element('summary', { text: '進階：使用裝置碼或團隊邀請碼' }), element('p', { class: 'help-text', text: '既有裝置換機碼沿用同一身分；受邀同仁可用團隊邀請碼加入，再為自己的身分設定帳號密碼。' }), pairForm]), element('p', { class: 'help-text', text: '雲端保存與分享資產；ERP 與裝置操作，仍由具備環境的本地 VIXO 執行。' })]) ]));
  }

  function renderApp() {
    if (!controller.state.user) { renderAuth(); return; }
    const state = controller.state;
    account.replaceChildren(element('span', { class: 'email', text: state.user.username || '已連線的 VIXO 裝置' }), ...(!state.user.accountConfigured ? [button('設定帳號密碼', openSetupAccount, 'small')] : []), button('登出此裝置', () => attempt(async () => { await controller.clear(); closeModal(); try { await client.signOut(); } finally { stored = null; try { localStorage.removeItem(SESSION_KEY); } catch {} renderAuth(); announce('已登出此裝置。'); } }), 'quiet small'));
    const scope = scopeSelect('workspace-select');
    scope.className = 'workspace-select'; scope.setAttribute('aria-label', '選擇工作空間');
    scope.addEventListener('change', () => attempt(async () => { closeModal(); await controller.chooseScope(scope.value); renderApp(); }));
    const nav = element('nav', { class: 'side-nav', 'aria-label': '資產類型' });
    for (const [key, type] of Object.entries(TYPES)) {
      const item = button('', () => { kind = key; search = ''; controller.back(); renderApp(); }, `nav-item ${kind === key ? 'active' : ''}`);
      item.setAttribute('aria-current', kind === key ? 'page' : 'false');
      item.append(element('span', { class: 'nav-icon', text: type.icon, 'aria-hidden': 'true' }), element('span', { text: type.label }), element('span', { class: 'nav-count', text: String(state.assets.filter(a => a.kind === key).length) })); nav.append(item);
    }
    const sidebar = element('aside', { class: 'sidebar' }, [element('div', {}, [element('p', { class: 'side-heading', text: 'Workspace' }), element('div', { class: 'scope-top' }, [scope, element('div', { class: 'scope-actions' }, [button('＋ 建立團隊', openCreateWorkspace), button('加入團隊', openJoinWorkspace)])])]), element('div', {}, [element('p', { class: 'side-heading', text: 'My collection' }), nav]), state.scope ? button('成員與邀請', () => attempt(openMembers), 'small') : null, element('div', { class: 'sidebar-note' }, [element('strong', { text: '雲端管理，本地執行' }), '在這裡整理與分享資產，再由各裝置的 VIXO 同步下載後執行。', element('br'), element('a', { href: 'https://github.com/inventra/agent-teams-builder/releases/latest', target: '_blank', rel: 'noopener noreferrer', text: '取得本地 VIXO ↗' }), element('details', { class: 'advanced-auth' }, [element('summary', { text: '進階裝置連線' }), button('產生一次性換機碼', () => attempt(openDeviceCode), 'small')])])]);
    const content = element('section', { class: 'workspace-main', 'aria-label': '工作室內容' });
    if (!state.user.accountConfigured) content.append(element('div', { class: 'account-setup-banner' }, [element('div', {}, [element('strong', { text: '讓這份資料可以用帳號密碼登入' }), element('p', { text: '目前內容已連線。設定登入方式後，可在網站或新裝置使用同一份 Agent 與團隊權限。' })]), button('設定帳號密碼', openSetupAccount, 'primary')]));
    if (state.selected) renderDetail(content, state.selected); else renderCollection(content);
    main.replaceChildren(element('div', { class: 'workspace-layout' }, [sidebar, content]));
  }

  function renderCollection(container) {
    const state = controller.state;
    const searchInput = element('input', { type: 'search', class: 'search', placeholder: '搜尋名稱、說明…', value: search, 'aria-label': '搜尋資產' });
    const grid = element('div', { class: 'asset-grid' });
    const count = element('span', { class: 'result-count' });
    function updateGrid() {
      const assets = state.assets.filter(asset => asset.kind === kind && `${asset.title} ${asset.description || ''} ${asset.slug}`.toLowerCase().includes(search.toLowerCase()));
      count.textContent = `${assets.length} 個${TYPES[kind].label}`;
      grid.replaceChildren();
      if (!assets.length) {
        grid.className = '';
        grid.append(element('div', { class: 'empty-state' }, [element('div', { class: 'empty-symbol', text: TYPES[kind].icon }), element('h2', { text: search ? '沒有符合的資產' : `第一個 ${TYPES[kind].label}，從這裡開始` }), element('p', { text: search ? '試試其他關鍵字，或切換工作空間。' : '匯入本地 VIXO 匯出的 JSON，或建立新資產。完整內容確認後，才會發布到這個空間。' }), search ? null : button('建立或匯入', () => openEditor(), 'primary')])); return;
      }
      grid.className = 'asset-grid';
      for (const asset of assets) {
        const card = button('', () => attempt(async () => { await controller.selectAsset(asset.id); detailTab = 'content'; renderApp(); }), 'asset-card');
        card.append(element('div', { class: 'asset-card-top' }, [element('span', { class: `asset-icon ${kind}`, text: TYPES[kind].icon }), element('span', { class: 'version', text: `v${asset.revision}` })]), element('h2', { text: asset.title }), element('p', { text: asset.description || '尚未加入說明；開啟查看完整內容。' }), element('div', { class: 'asset-card-bottom' }, [element('span', { text: `${asset.bundle?.files?.length ?? '—'} 個檔案` }), element('span', { text: `${dateText(asset.updated_at)} ↗` })])); grid.append(card);
      }
    }
    searchInput.addEventListener('input', () => { search = searchInput.value; updateGrid(); });
    container.append(element('div', { class: 'page-heading' }, [element('div', {}, [element('h1', { text: TYPES[kind].plural }), element('p', { text: TYPES[kind].description })]), element('div', { class: 'heading-actions' }, [button('重新整理', () => attempt(async () => { await controller.refresh(); renderApp(); announce('已載入雲端最新內容。'); })), button('＋ 建立／匯入', () => openEditor(), 'primary')])]), element('div', { class: 'context-strip' }, [element('span', { text: state.scope ? `目前位於「${scopeName(state.scope)}」，這裡的資產由團隊共同使用。` : '你的私人收藏。選擇「複製到空間」，即可分享給團隊。' }), element('span', { class: 'tag', text: state.scope ? '團隊空間' : '僅自己可見' })]), element('div', { class: 'toolbar' }, [searchInput, count]), grid);
    updateGrid();
  }

  function appendBundle(container, bundle, activeTab = 'content') {
    if (activeTab === 'requirements') {
      container.append(element('h3', { class: 'section-title', text: '執行環境' }), code(bundle.requirements), element('h3', { class: 'section-title', text: '依賴項目與版本' }), code(bundle.dependencies), element('p', { class: 'help-text', text: '依賴清單是資產的一部分。同步到本地後，仍需準備對應的系統、工具與每位使用者自己的帳號。' })); return;
    }
    if (activeTab === 'files') {
      if (!bundle.files.length) container.append(element('p', { class: 'muted small-text', text: '這個資產沒有附加檔案。' }));
      for (const file of bundle.files) container.append(element('details', { class: 'file-row' }, [element('summary', { text: file.path }), code(file.content)])); return;
    }
    container.append(element('h3', { class: 'section-title', text: '完整設定與 SOP' }), code(bundle.spec), element('div', { class: 'bundle-summary' }, [element('span', { class: 'tag', text: `${bundle.files.length} 個檔案` }), element('span', { class: 'tag', text: `${bundle.dependencies.length} 個依賴` }), element('span', { class: 'tag', text: `格式 v${bundle.formatVersion}` })]));
  }

  function renderDetail(container, asset) {
    container.append(button('← 回到資產清單', () => { controller.back(); renderApp(); }, 'quiet small'));
    container.append(element('div', { class: 'detail-header' }, [element('span', { class: `asset-icon ${asset.kind}`, text: TYPES[asset.kind]?.icon || '◇' }), element('div', {}, [element('h1', { text: asset.title }), element('div', { class: 'detail-meta' }, [element('span', { class: 'tag', text: TYPES[asset.kind]?.label || asset.kind }), element('span', { class: 'version', text: `目前版本 v${asset.revision}` }), element('span', { class: 'version', text: scopeName(asset.workspace_id) })])])]), element('p', { class: 'detail-description', text: asset.description || '尚未填寫說明。' }), element('div', { class: 'detail-actions' }, [button('編輯新版本', () => openEditor(asset), 'primary'), button('複製到空間', () => openEditor(asset, true)), button('下載 JSON', () => download(asset)), button('重新整理', () => attempt(async () => { await controller.selectAsset(asset.id); renderApp(); }))]));
    const content = element('div');
    const tabs = element('div', { class: 'detail-tabs', role: 'tablist', 'aria-label': '資產詳情' });
    for (const [key, label] of [['content', '內容與 SOP'], ['files', '檔案'], ['requirements', '環境與依賴'], ['history', '歷史版本']]) {
      const tab = button(label, () => { detailTab = key; renderApp(); }, detailTab === key ? 'active' : ''); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(detailTab === key)); tabs.append(tab);
    }
    container.append(tabs, content);
    if (detailTab === 'history') {
      content.append(element('p', { class: 'help-text', text: '回復會以舊內容建立一個新版本，保留目前與過去的紀錄。請先預覽，再確認發布。' }));
      const list = element('div', { class: 'revision-list' });
      for (const revision of controller.state.revisions) list.append(element('div', { class: 'revision-row' }, [element('div', {}, [element('strong', { text: `v${revision.revision}${revision.revision === asset.revision ? ' · 目前版本' : ''}` }), element('p', { text: `${dateText(revision.created_at)}${revision.message ? ` · ${revision.message}` : ''}` })]), button(revision.revision === asset.revision ? '查看內容' : '預覽回復', () => previewRevision(asset, revision), 'small')]));
      if (!controller.state.revisions.length) list.append(element('p', { class: 'muted small-text', text: '尚無版本紀錄。' })); content.append(list);
    } else appendBundle(content, asset.bundle, detailTab);
  }

  function download(asset) {
    const blob = new Blob([exportAsset(asset)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = element('a', { href: url, download: `${asset.slug || 'vixo-asset'}-v${asset.revision || 1}.json` });
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('JSON 已交給瀏覽器下載，可匯入其他裝置的 VIXO。');
  }

  function openEditor(asset = null, copy = false, draft = null) {
    const editing = asset && !copy;
    const initial = draft || asset;
    const type = element('select', { id: 'asset-kind', disabled: Boolean(editing) }, Object.entries(TYPES).map(([value, item]) => element('option', { value, text: item.label })));
    type.value = initial?.kind || kind;
    const title = element('input', { id: 'asset-title', value: initial?.title || '', required: true, maxLength: 200, placeholder: '例如：ERP 費用單助手' });
    const slug = element('input', { id: 'asset-slug', value: draft ? draft.slug : copy ? `${asset.slug.slice(0, 65)}-copy` : asset?.slug || '', required: true, maxLength: 80, placeholder: 'erp-expense-helper', readOnly: Boolean(editing) });
    const description = element('textarea', { id: 'asset-description', value: initial?.description || '', rows: 2, maxLength: 4000, placeholder: '這個資產可以幫同仁完成什麼？' });
    const scope = scopeSelect('asset-scope', draft ? draft.workspace_id : copy ? null : editing ? asset.workspace_id : controller.state.scope);
    scope.disabled = Boolean(editing);
    const message = element('input', { id: 'asset-message', value: draft ? draft.message : copy ? `複製自 ${asset.title} v${asset.revision}` : '', maxLength: 500, placeholder: '這次新增或調整了什麼？' });
    const json = element('textarea', { id: 'asset-json', class: 'json-editor', rows: 12, spellcheck: false, value: JSON.stringify(initial?.bundle || blankBundle(type.value), null, 2), required: true });
    const error = element('p', { class: 'inline-error modal-error', role: 'alert' });
    const file = element('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': '選擇 JSON 檔案' });
    let templateKind = type.value;
    type.addEventListener('change', () => { if (json.value !== JSON.stringify(blankBundle(templateKind), null, 2)) { type.value = templateKind; error.textContent = '已有匯入或編輯的內容；請先另存 JSON，再建立其他類型。'; return; } templateKind = type.value; json.value = JSON.stringify(blankBundle(type.value), null, 2); error.textContent = '已切換為該類型的範本，請填寫完整內容。'; });
    file.addEventListener('change', async () => {
      try {
        const selected = file.files?.[0]; if (!selected) return;
        if (selected.size > MAX_IMPORT_BYTES) throw new Error('匯入檔案超過 5 MB，請拆分資產後再試。');
        const imported = parseImport(await selected.text());
        if (editing && imported.kind !== asset.kind) throw new Error('更新版本必須與目前資產類型相同。');
        type.value = imported.kind; if (imported.title) title.value = imported.title; if (!editing && imported.slug) slug.value = imported.slug;
        description.value = imported.description; json.value = JSON.stringify(imported.bundle, null, 2); error.textContent = '';
      } catch (failure) { error.textContent = friendlyError(failure); }
      finally { file.value = ''; }
    });
    const next = button('預覽完整內容 →', () => {
      try {
        if (!title.reportValidity() || !slug.reportValidity()) return;
        const imported = parseImport(json.value);
        const preview = controller.stage({ ...(editing ? { id: asset.id, expectedRevision: asset.revision } : {}), kind: type.value, title: title.value, slug: slug.value, description: description.value, bundle: imported.bundle, workspaceId: scope.value || null, message: message.value });
        showPublishPreview(preview, () => openEditor(asset, copy, { ...preview, workspace_id: preview.workspaceId }));
      } catch (failure) { error.textContent = friendlyError(failure); error.scrollIntoView({ block: 'nearest' }); }
    }, 'primary');
    showModal(editing ? `編輯 ${asset.title} 的新版本` : copy ? '複製資產到另一個空間' : `建立／匯入 ${TYPES[kind].label}`, [element('div', { class: 'upload-zone' }, [element('span', { text: '已有本地資產？匯入 VIXO 匯出的 JSON。' }), button('選擇檔案', () => file.click(), 'small'), file]), element('div', { class: 'field-grid' }, [field('資產類型', type), field('發布位置', scope), field('顯示名稱', title), field('識別名稱', slug, '小寫英文、數字、- 或 _；同一空間內不得重複。')]), field('簡短說明', description), field('版本說明', message), field('完整資產 JSON', json, '建立前請完成範本內的內容。變更資產類型會換成該類型的新範本。'), element('p', { class: 'editor-note', text: 'spec 保存設定與完整 SOP；files 保存 Skill 或流程需要的文字檔案。請檢查個人記憶、對話、業務資料與密鑰，確認內容適合目前的分享範圍。' }), error], [button('取消', closeModal), next]);
  }

  function showPublishPreview(preview, back = null) {
    const content = element('div');
    const check = element('input', { type: 'checkbox', id: 'confirm-preview' });
    const error = element('p', { class: 'inline-error modal-error', role: 'alert' });
    const publish = button(preview.id ? '確認發布新版本' : '確認發布', async () => {
      if (!check.checked || publish.disabled) return;
      publish.disabled = true; error.textContent = '';
      const generation = modalGeneration;
      try { const saved = await controller.publish(); if (generation !== modalGeneration) return; closeModal(); if (saved) { kind = saved.kind; detailTab = 'content'; renderApp(); announce(`「${saved.title}」v${saved.revision} 已發布到${scopeName(saved.workspace_id)}。`); } }
      catch (failure) { error.textContent = friendlyError(failure); publish.disabled = false; }
    }, 'primary');
    publish.disabled = true;
    check.addEventListener('change', () => { publish.disabled = !check.checked; });
    content.append(element('div', { class: 'modal-warning', text: `即將${preview.id ? `以 v${preview.expectedRevision} 為基礎建立新版本` : '建立新資產'}，發布到「${scopeName(preview.workspaceId)}」。${preview.workspaceId ? '這個團隊的成員將能讀取完整內容。' : '目前只有你能存取。'}` }), element('table', { class: 'info-table' }, [element('tbody', {}, [['名稱', preview.title], ['識別名稱', preview.slug], ['類型', TYPES[preview.kind].label], ['說明', preview.description || '未填寫'], ['版本說明', preview.message || '未填寫']].map(([label, value]) => element('tr', {}, [element('td', { text: label }), element('td', { text: value })])))]));
    appendBundle(content, preview.bundle);
    content.append(element('h3', { class: 'section-title', text: '完整附加檔案（展開檢視）' })); appendBundle(content, preview.bundle, 'files');
    appendBundle(content, preview.bundle, 'requirements');
    content.append(element('label', { class: 'checkbox-label', htmlFor: 'confirm-preview' }, [check, element('span', { text: '我已檢查完整 SOP、附加檔案及分享範圍，確認發布這個版本。' })]), error);
    showModal('發布前，確認完整內容', content, [back ? button('← 返回編輯', back) : button('取消', closeModal), publish]);
  }

  function previewRevision(asset, revision) {
    if (revision.revision === asset.revision) { detailTab = 'content'; renderApp(); return; }
    try {
      const preview = controller.stage({ id: asset.id, expectedRevision: asset.revision, kind: asset.kind, slug: asset.slug, title: revision.title || asset.title, description: revision.description ?? asset.description, bundle: revision.bundle, workspaceId: asset.workspace_id, message: `回復 v${revision.revision} 的內容（原目前版本 v${asset.revision}）` });
      showPublishPreview(preview);
    } catch (error) { showError(error); }
  }

  function simpleForm(title, fields, submitLabel, action) {
    const error = element('p', { class: 'inline-error modal-error', role: 'alert' });
    const submit = button(submitLabel, async () => {
      for (const item of fields) if (item.control.reportValidity && !item.control.reportValidity()) return;
      submit.disabled = true; error.textContent = '';
      const generation = modalGeneration;
      try { const result = await action(); if (generation !== modalGeneration) return; if (result !== false) closeModal(); }
      catch (failure) { error.textContent = friendlyError(failure); }
      finally { submit.disabled = false; }
    }, 'primary');
    showModal(title, [...fields.map(item => field(item.label, item.control, item.help)), error], [button('取消', closeModal), submit]);
  }
  function openSetupAccount() {
    const originalUserId = controller.state.user?.id;
    if (!originalUserId) return;
    const username = element('input', { id: 'setup-account', type: 'text', required: true, autocomplete: 'username', autocapitalize: 'none', spellcheck: false, minLength: 3, maxLength: 32, placeholder: '例如：kaikai_wu' });
    const password = element('input', { id: 'setup-password', type: 'password', required: true, autocomplete: 'new-password', minLength: 12, maxLength: 72 });
    const confirmation = element('input', { id: 'setup-password-confirm', type: 'password', required: true, autocomplete: 'new-password', minLength: 12, maxLength: 72 });
    simpleForm('設定目前身分的帳號密碼', [
      { label: '設定帳號', control: username, help: '3–32 個小寫英文、數字、_ 或 -，以英文字母開頭。' },
      { label: '設定密碼', control: password, help: '至少 12 個字元，建議使用英文字母、數字與符號。這項設定保留目前的 Agent、資產與團隊權限。' },
      { label: '再次輸入密碼', control: confirmation },
    ], '儲存帳號密碼', async () => {
      const started = modalGeneration;
      const credentials = validateAccountSetup(username.value, password.value, confirmation.value);
      password.value = ''; confirmation.value = '';
      try { await client.setupAccount(credentials); }
      catch (error) {
        if (error.code !== 'account_bound_session_unavailable') throw error;
        if (started !== modalGeneration || controller.state.user?.id !== originalUserId) return false;
        // Credentials were saved. Preserve the existing session and offer login,
        // rather than repeating a successful one-time account binding.
        closeModal(); renderAuth(); announce(friendlyError(error));
        return false;
      }
      const user = await client.getUser();
      if (started !== modalGeneration) return false;
      if (user?.id !== originalUserId || controller.state.user?.id !== originalUserId) throw new Error('雲端身分已變更，請重新整理後確認。');
      controller.state.user = user;
      renderApp(); announce('帳號密碼已設定，原有資產與權限已保留。之後可直接使用帳號密碼登入。');
    });
  }
  async function openDeviceCode() {
    const userId = controller.state.user?.id;
    const result = await client.createDeviceCode();
    if (!userId || controller.state.user?.id !== userId) return;
    const value = result?.code;
    if (!value) throw new Error('沒有取得連線碼，請重新操作。');
    const status = element('p', { class: 'help-text', role: 'status' });
    showModal('連接另一台裝置', [element('div', { class: 'modal-warning', text: '這個連線碼會讓另一台裝置使用同一個身分，取得你的私人資產與團隊權限。請只在自己的裝置輸入；分享給同仁請使用團隊邀請碼。' }), element('div', { class: 'invite-code', text: value }), element('p', { class: 'help-text', text: result.expires_at ? `使用一次後失效。有效期限：${dateText(result.expires_at)}` : '這是一次性連線碼，使用後即失效。' }), status], [button('複製連線碼', async () => { try { await navigator.clipboard.writeText(value); status.textContent = '已複製，請到另一台裝置的工作室輸入。'; } catch { status.textContent = '瀏覽器未允許剪貼簿存取，請手動複製上方連線碼。'; } }, 'primary'), button('完成', closeModal)]);
  }
  function openCreateWorkspace() {
    const name = element('input', { id: 'workspace-name', required: true, maxLength: 100, placeholder: '例如：營運團隊' });
    simpleForm('建立團隊空間', [{ label: '團隊名稱', control: name, help: '你會成為這個空間的擁有者，之後可產生邀請碼讓同仁加入。' }], '建立空間', async () => { const workspace = await client.createWorkspace(name.value.trim()); await controller.refresh(); await controller.chooseScope(workspace.id); renderApp(); announce(`已建立「${workspace.name}」。`); });
  }
  function openJoinWorkspace() {
    const invite = element('input', { id: 'invite-code', required: true, placeholder: '貼上管理者提供的邀請碼', autocomplete: 'off', maxLength: 200 });
    simpleForm('加入團隊空間', [{ label: '邀請碼', control: invite, help: '加入後，即可使用這個空間中開放給團隊的資產。' }], '加入團隊', async () => { const joined = await client.joinWorkspace(invite.value.trim()); await controller.refresh(); const id = joined?.workspace_id || joined?.workspaceId || joined?.id; if (id && controller.state.workspaces.some(w => w.id === id)) await controller.chooseScope(id); renderApp(); announce('已加入團隊，工作空間清單已更新。'); });
  }
  async function openMembers() {
    const workspaceId = controller.state.scope;
    if (!workspaceId) return;
    const workspace = controller.state.workspaces.find(w => w.id === workspaceId);
    const members = await client.listMembers(workspaceId);
    if (controller.state.scope !== workspaceId || !controller.state.user) return;
    const current = members.find(m => m.user_id === controller.state.user.id);
    const canManage = workspace?.owner_id === controller.state.user.id || ['owner', 'admin'].includes(current?.role);
    const body = element('div', {}, [element('p', { class: 'help-text', text: '同仁可在 VIXO 的連線頁面貼上邀請碼加入。已連線的同仁選擇「加入團隊」。邀請碼由你自行分享。' })]);
    for (const member of members) body.append(element('div', { class: 'member-row' }, [element('div', {}, [element('strong', { text: member.email || (member.user_id === controller.state.user.id ? '你' : member.user_id) }), element('div', { class: 'help-text', text: ({ owner: '擁有者', admin: '管理者', editor: '可編輯', viewer: '可檢視', member: '成員' })[member.role] || member.role })]), canManage && member.role !== 'owner' && member.user_id !== workspace?.owner_id && member.user_id !== controller.state.user.id ? button('移除', () => {
      const removal = element('p', { class: 'small-text', text: '移除後，這位成員將無法存取此團隊空間。確認移除這個成員？' });
      const error = element('p', { class: 'inline-error', role: 'alert' });
      const confirm = button('確認移除', async () => { confirm.disabled = true; try { await client.removeMember(workspaceId, member.user_id); closeModal(); await openMembers(); announce('已移除成員。'); } catch (failure) { error.textContent = friendlyError(failure); confirm.disabled = false; } }, 'danger');
      showModal('移除團隊成員', [removal, element('p', { class: 'help-text', text: member.email || member.user_id }), error], [button('取消', () => attempt(openMembers)), confirm]);
    }, 'danger small') : null]));
    const actions = [button('完成', closeModal)];
    if (canManage) actions.unshift(button('產生邀請碼', () => {
      const role = element('select', { id: 'invite-role' }, [element('option', { value: 'viewer', text: '可檢視與下載' }), element('option', { value: 'editor', text: '可檢視與編輯' })]);
      simpleForm('邀請同仁加入', [{ label: '授予權限', control: role }], '產生邀請碼', async () => {
        const result = await client.createInvite(workspaceId, role.value);
        const codeValue = result?.code || result?.invite_code || (typeof result === 'string' ? result : '');
        if (!codeValue) throw new Error('沒有取得邀請碼，請重新操作。');
        const copyStatus = element('p', { class: 'help-text', role: 'status' });
        showModal('邀請碼已建立', [element('p', { class: 'small-text', text: '請將這段邀請碼提供給同仁。未連線的同仁可直接輸入邀請碼；已連線者選擇「加入團隊」。' }), element('div', { class: 'invite-code', text: codeValue }), element('p', { class: 'help-text', text: result.expires_at ? `有效期限：${dateText(result.expires_at)}` : '邀請碼的有效期限依伺服器設定。' }), copyStatus], [button('複製邀請碼', async () => { try { await navigator.clipboard.writeText(codeValue); copyStatus.textContent = '已複製。'; } catch { copyStatus.textContent = '瀏覽器未允許剪貼簿存取，請選取上方邀請碼手動複製。'; } }, 'primary'), button('完成', closeModal)]);
        return false;
      });
    }, 'primary'));
    showModal(`${workspace?.name || '團隊'} · 成員與邀請`, body, actions);
  }

  try {
    const response = await fetch('./config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('目前尚未完成雲端連線設定，請稍後再試。');
    const config = await response.json();
    const url = config.supabaseUrl || config.url || config.SUPABASE_URL;
    const key = config.supabasePublishableKey || config.supabaseAnonKey || config.key || config.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error('目前尚未完成雲端連線設定，請稍後再試。');
    const { createCloudClient } = await import('./cloud-client.mjs');
    try { stored = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch {}
    client = createCloudClient({ url, key, getSession: () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return stored; } }, saveSession: session => { stored = session; try { if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session)); else localStorage.removeItem(SESSION_KEY); } catch {} } });
    controller = createCloudController(client);
    window.addEventListener('storage', event => {
      if (event.key !== SESSION_KEY && event.key !== null) return;
      let next = null;
      try { next = JSON.parse(event.key === null ? localStorage.getItem(SESSION_KEY) || 'null' : event.newValue || 'null'); } catch {}
      // Verification timestamps may change in another tab without changing credentials.
      // Reload only for real session changes; this also rebuilds the client's storage
      // fingerprint before a new one-time device code can be redeemed.
      if (!sessionCredentialsChanged(stored, next)) { stored = next; return; }
      closeModal(); stored = next; controller.clear(); account.replaceChildren();
      main.replaceChildren(element('div', { class: 'loading-state', text: '裝置連線已變更，正在重新載入工作室…' }));
      location.reload();
    });
    if (stored?.access_token) {
      try { if (await controller.initialize()) renderApp(); else renderAuth(); }
      catch (error) { await controller.clear(); renderAuth(); showError(error); }
    } else renderAuth();
  } catch (error) {
    main.replaceChildren(element('section', { class: 'standalone-message' }, [element('h1', { text: '工作室暫時無法開啟' }), element('p', { text: friendlyError(error) }), button('重新載入', () => location.reload(), 'primary')]));
  }
}

if (typeof document !== 'undefined') boot();
