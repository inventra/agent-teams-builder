import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudController, parseImport, preparePreview, exportAsset, validateBundle, friendlyError, blankBundle, sessionCredentialsChanged, validateAccountSetup } from '../cloud/app.mjs';

const bundle = () => { const value = blankBundle('agent'); value.spec.displayName = '測試助手'; value.spec.systemPrompt = '先確認任務，再執行。'; value.files[0].content = '# 完整 SOP\n1. 驗證資料'; value.dependencies = [{ kind: 'skill', id: 'erp-video-automation', version: '1.8.0' }]; value.requirements = { platforms: ['windows'], tools: ['Codex'] }; return value; };
const input = overrides => ({ kind: 'agent', title: '測試助手', slug: 'test-agent', description: '測試', bundle: bundle(), workspaceId: null, ...overrides });
function fixture(overrides = {}) {
  const calls = [];
  const asset = { id: 'a1', owner_id: 'u1', workspace_id: null, revision: 1, ...input() };
  const client = { getAccess: async () => ({ userId: 'u1', status: 'approved', isAdmin: false }), getUser: async () => ({ id: 'u1', email: 'test@devices.vixo.invalid' }), listWorkspaces: async () => [{ id: 'team1', name: '測試團隊', owner_id: 'u1' }], listAssets: async args => { calls.push(['list', args]); return [asset]; }, getAsset: async () => asset, listRevisions: async () => [{ ...asset, created_at: '2026-10-08T00:00:00Z' }], saveAsset: async value => { calls.push(['save', value]); return { ...asset, ...value, workspace_id: value.workspaceId, revision: value.expectedRevision + 1 }; }, ...overrides };
  return { client, calls, asset };
}

test('bundle import/export preserves full SOP, files and dependencies while excluding owner and workspace identity', () => {
  const original = { id: 'private-id', owner_id: 'private-user', workspace_id: 'private-workspace', ...input() };
  const exported = exportAsset(original);
  for (const privateValue of ['private-id', 'private-user', 'private-workspace']) assert.ok(!exported.includes(privateValue));
  assert.deepEqual(parseImport(exported), { kind: 'agent', title: '測試助手', slug: 'test-agent', description: '測試', bundle: bundle() });
  assert.deepEqual(parseImport(JSON.stringify(bundle())).bundle, bundle());
});

test('import rejects malformed/oversized data, unsupported format and unsafe file paths before preview', () => {
  assert.throws(() => parseImport('{invalid'), /JSON/);
  assert.throws(() => parseImport('x'.repeat(5 * 1024 * 1024 + 1)), /5 MB/);
  assert.throws(() => parseImport('[]'), /物件/);
  assert.throws(() => validateBundle({ ...bundle(), formatVersion: 2 }), /格式/);
  for (const path of ['../secret', 'a/../../secret', '/etc/password', 'C:\\secret', 'a\\..\\secret']) assert.throws(() => validateBundle({ ...bundle(), files: [{ path, content: 'x' }] }), /路徑/);
  assert.throws(() => validateBundle({ ...bundle(), files: [{ path: 'skills/new-skill/SKILL.md', content: '1' }, { path: 'skills/new-skill/SKILL.md', content: '2' }] }), /重複/);
  assert.throws(() => validateBundle({ ...bundle(), dependencies: [{ kind: 'skill', id: 'x' }] }), /依賴/);
});

test('preview checks title/slug/kind and requires a specific current revision for edits', () => {
  assert.throws(() => preparePreview(input({ title: '  ' })), /名稱/);
  assert.throws(() => preparePreview(input({ slug: '../unsafe' })), /識別名稱/);
  assert.throws(() => preparePreview(input({ kind: 'skill' })), /不一致/);
  assert.throws(() => preparePreview(input({ id: 'a1' })), /版本號/);
  assert.equal(preparePreview(input()).expectedRevision, 0);
  assert.equal(preparePreview(input({ id: 'a1', expectedRevision: 5 })).expectedRevision, 5);
});

test('unauthenticated controller never fetches private lists or publishes', async () => {
  const { client, calls } = fixture({ getUser: async () => null });
  const controller = createCloudController(client);
  assert.equal(await controller.initialize(), false);
  await assert.rejects(controller.refresh(), /先連接/);
  await assert.rejects(controller.chooseScope('team1'), /先連接/);
  await assert.rejects(controller.selectAsset('a1'), /先連接/);
  assert.throws(() => controller.stage(input()), /先連接/);
  await assert.rejects(controller.publish(), /先連接/);
  assert.deepEqual(calls, []);
});

test('staging is isolated from edits and requires explicit publication; clears preview after save', async () => {
  const { client, calls } = fixture();
  const controller = createCloudController(client);
  await controller.initialize();
  await assert.rejects(controller.publish(), /先檢視/);
  const source = input();
  const preview = controller.stage(source);
  source.bundle.spec.systemPrompt = 'tampered original'; preview.bundle.spec.systemPrompt = 'tampered preview';
  assert.equal(calls.filter(c => c[0] === 'save').length, 0);
  await controller.publish();
  const saved = calls.find(c => c[0] === 'save')[1];
  assert.equal(saved.bundle.spec.systemPrompt, '先確認任務，再執行。');
  assert.equal(controller.state.preview, null);
  controller.stage(input()); controller.cancelPreview();
  await assert.rejects(controller.publish(), /先檢視/);
});

test('revision conflicts retain the exact preview and never retry by overwriting the newer revision', async () => {
  let attempts = 0;
  const { client } = fixture({ saveAsset: async value => { attempts++; assert.equal(value.expectedRevision, 3); throw Object.assign(new Error('revision conflict'), { code: 'revision_conflict', status: 409 }); } });
  const controller = createCloudController(client);
  await controller.initialize(); controller.stage(input({ id: 'a1', expectedRevision: 3 }));
  await assert.rejects(controller.publish(), /revision conflict/);
  assert.equal(attempts, 1); assert.equal(controller.state.preview.expectedRevision, 3);
  assert.match(friendlyError({ code: 'revision_conflict' }), /較新的版本/);
});

test('workspace switch drops a late response from the previously selected scope', async () => {
  let resolveSlow;
  const { client } = fixture();
  const controller = createCloudController(client);
  await controller.initialize();
  client.listAssets = ({ workspaceId }) => workspaceId === 'team1' ? new Promise(resolve => { resolveSlow = resolve; }) : Promise.resolve([{ id: 'personal-asset' }]);
  const slow = controller.chooseScope('team1');
  await new Promise(resolve => setImmediate(resolve));
  await controller.chooseScope(null);
  resolveSlow([{ id: 'team-asset' }]); await slow;
  assert.equal(controller.state.scope, null);
  assert.deepEqual(controller.state.assets, [{ id: 'personal-asset' }]);
});

test('disconnect removes data immediately and ignores late detail responses', async () => {
  let resolveAsset;
  const { client } = fixture();
  const controller = createCloudController(client);
  await controller.initialize();
  client.getAsset = () => new Promise(resolve => { resolveAsset = resolve; });
  const pending = controller.selectAsset('a1');
  await new Promise(resolve => setImmediate(resolve));
  await controller.clear();
  resolveAsset({ id: 'private-late-data' }); await pending;
  assert.equal(controller.state.user, null); assert.equal(controller.state.selected, null);
  assert.deepEqual(controller.state.assets, []); assert.deepEqual(controller.state.workspaces, []); assert.deepEqual(controller.state.revisions, []);
});

test('duplicate publication is blocked while the first request is pending', async () => {
  let resolveSave;
  const { client } = fixture({ saveAsset: () => new Promise(resolve => { resolveSave = resolve; }) });
  const controller = createCloudController(client);
  await controller.initialize(); controller.stage(input());
  const first = controller.publish();
  await assert.rejects(controller.publish(), /正在發布/);
  resolveSave({ id: 'a1', ...input(), revision: 1 }); await first;
});

test('all UI starter templates satisfy the local executable bundle validator', async () => {
  const { validateCloudBundle } = await import('../plugins/agent-teams-builder/src/cloud-bundle.mjs');
  for (const kind of ['agent', 'skill', 'workflow']) { const value = blankBundle(kind); validateBundle(value); assert.equal(validateCloudBundle(value).kind, kind); }
});

test('cross-tab handling reloads for token changes but not verification metadata updates', () => {
  const session = { access_token: 'access', refresh_token: 'refresh', user_verified_at: 1 };
  assert.equal(sessionCredentialsChanged(session, { ...session, user_verified_at: 2 }), false);
  assert.equal(sessionCredentialsChanged(session, null), true);
  assert.equal(sessionCredentialsChanged(session, { ...session, access_token: 'rotated' }), true);
  assert.equal(sessionCredentialsChanged(session, { ...session, refresh_token: 'rotated' }), true);
  assert.equal(sessionCredentialsChanged(null, null), false);
});


test('account setup normalizes allowed usernames and validates password confirmation without creating an identity', () => {
  const password = 'fixture-only-password';
  assert.deepEqual(validateAccountSetup(' Test_User-2 ', password, password), { username: 'test_user-2', password });
  for (const username of ['ab', '9tester', 'test.user', 'test user', '測試帳號', 'a'.repeat(33)]) assert.throws(() => validateAccountSetup(username, password, password), /帳號/);
  for (const value of ['x'.repeat(11), 'x'.repeat(73), '密'.repeat(25), '😀'.repeat(11)]) assert.throws(() => validateAccountSetup('tester', value, value), /密碼需至少/);
  assert.equal(validateAccountSetup('tester', '密'.repeat(24), '密'.repeat(24)).password, '密'.repeat(24));
  assert.equal(validateAccountSetup('tester', ' x'.repeat(12), ' x'.repeat(12)).password, ' x'.repeat(12));
  assert.throws(() => validateAccountSetup('tester', password, 'different-fixture-password'), /不一致/);
});

test('account errors distinguish successful binding with unavailable session from retryable setup input errors', () => {
  for (const code of ['account_bind_in_progress', 'account_bind_unconfirmed']) {
    assert.match(friendlyError({ code, status: 409 }), /先用剛設定的帳號密碼登入/);
    assert.doesNotMatch(friendlyError({ code, status: 409 }), /版本/);
  }
  assert.equal(friendlyError({ code: 'account_bound_session_unavailable', status: 503 }), '帳號已設定，請用剛設定的帳號密碼登入');
  assert.match(friendlyError({ code: 'account_already_bound', status: 409 }), /目前身分已設定帳號密碼/);
  assert.match(friendlyError({ code: 'username_unavailable', status: 409 }), /帳號已被使用/);
  assert.match(friendlyError({ code: 'invalid_credentials', status: 401 }), /帳號或密碼不正確/);
});


test('pending and disabled identities never load workspaces or assets and cannot stage or publish', async () => {
  for (const status of ['pending', 'disabled']) {
    let privateCalls = 0;
    const { client } = fixture({ getAccess: async () => ({ userId: 'u1', status, isAdmin: false }), listWorkspaces: async () => { privateCalls++; return []; }, listAssets: async () => { privateCalls++; return []; } });
    const controller = createCloudController(client);
    assert.equal(await controller.initialize(), true);
    assert.equal(controller.state.user.id, 'u1'); assert.equal(controller.state.access.status, status);
    assert.equal(privateCalls, 0);
    assert.throws(() => controller.stage(input()), /核准/);
    await assert.rejects(controller.selectAsset('a1'), /核准/);
    await assert.rejects(controller.publish(), /核准/);
  }
});

test('access revocation clears private state and discards a detail response already in flight', async () => {
  let status = 'approved', resolveAsset;
  const { client } = fixture({ getAccess: async () => ({ userId: 'u1', status, isAdmin: false }) });
  const controller = createCloudController(client); await controller.initialize(); controller.stage(input());
  client.getAsset = () => new Promise(resolve => { resolveAsset = resolve; });
  const pending = controller.selectAsset('a1'); await new Promise(resolve => setImmediate(resolve));
  status = 'disabled'; await controller.refresh();
  resolveAsset({ id: 'private-late-response' }); await pending;
  assert.equal(controller.state.access.status, 'disabled');
  for (const field of ['assets', 'workspaces', 'revisions']) assert.deepEqual(controller.state[field], []);
  assert.equal(controller.state.selected, null); assert.equal(controller.state.preview, null);
});

test('permission checks fail closed during network errors and suspension invalidates late publication', async () => {
  let resolveSave;
  const { client } = fixture({ saveAsset: () => new Promise(resolve => { resolveSave = resolve; }) });
  const controller = createCloudController(client); await controller.initialize(); controller.stage(input());
  const pending = controller.publish(); await new Promise(resolve => setImmediate(resolve));
  controller.suspend(); resolveSave({ id: 'late-save', kind: 'agent' });
  assert.equal(await pending, null); assert.deepEqual(controller.state.assets, []);
  client.getAccess = async () => { throw Object.assign(new Error('offline'), { code: 'network_error' }); };
  await assert.rejects(controller.refresh(), /offline/);
  assert.equal(controller.state.access, null); assert.deepEqual(controller.state.workspaces, []);
});

test('approval can be rechecked without losing the connected identity and mismatched access cannot reveal assets', async () => {
  let access = { userId: 'u1', status: 'pending', isAdmin: false };
  const { client } = fixture({ getAccess: async () => access });
  const controller = createCloudController(client); await controller.initialize();
  access = { ...access, status: 'approved' }; await controller.refresh();
  assert.equal(controller.state.user.id, 'u1'); assert.equal(controller.state.assets.length, 1);
  access = { ...access, userId: 'different-identity' };
  await assert.rejects(controller.refresh(), /目前帳號/);
  assert.equal(controller.state.access, null); assert.deepEqual(controller.state.assets, []);
  assert.match(friendlyError({ code: 'account_registration_unconfirmed' }), /勿重複註冊/);
  assert.match(friendlyError({ code: 'account_pending', status: 403 }), /Kevin/);
});
