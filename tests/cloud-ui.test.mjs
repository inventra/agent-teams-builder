import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudController, parseImport, preparePreview, exportAsset, validateBundle, friendlyError, blankBundle, sessionCredentialsChanged } from '../cloud/app.mjs';

const bundle = () => { const value = blankBundle('agent'); value.spec.displayName = '測試助手'; value.spec.systemPrompt = '先確認任務，再執行。'; value.files[0].content = '# 完整 SOP\n1. 驗證資料'; value.dependencies = [{ kind: 'skill', id: 'erp-video-automation', version: '1.8.0' }]; value.requirements = { platforms: ['windows'], tools: ['Codex'] }; return value; };
const input = overrides => ({ kind: 'agent', title: '測試助手', slug: 'test-agent', description: '測試', bundle: bundle(), workspaceId: null, ...overrides });
function fixture(overrides = {}) {
  const calls = [];
  const asset = { id: 'a1', owner_id: 'u1', workspace_id: null, revision: 1, ...input() };
  const client = { getUser: async () => ({ id: 'u1', email: 'test@devices.vixo.invalid' }), listWorkspaces: async () => [{ id: 'team1', name: '測試團隊', owner_id: 'u1' }], listAssets: async args => { calls.push(['list', args]); return [asset]; }, getAsset: async () => asset, listRevisions: async () => [{ ...asset, created_at: '2026-10-08T00:00:00Z' }], saveAsset: async value => { calls.push(['save', value]); return { ...asset, ...value, workspace_id: value.workspaceId, revision: value.expectedRevision + 1 }; }, ...overrides };
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
