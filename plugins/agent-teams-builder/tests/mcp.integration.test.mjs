import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { exportSpecBundle } from '../src/cloud-bundle.mjs';

test("MCP login gate and confirmed local queue, merged reads, preparation, and synchronization stay account-scoped", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mcp-test-"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.join(here, "..", "src", "server.mjs");
  const userId = '10000000-0000-4000-8000-000000000001';
  const otherUserId = '20000000-0000-4000-8000-000000000001';
  const cloud = path.join(temporary, '.system', 'cloud'); fs.mkdirSync(cloud, { recursive: true });
  const database = path.join(temporary, 'mock-database.json'); fs.writeFileSync(database, JSON.stringify({ assets: [], saves: 0 }));
  const preload = path.join(temporary, 'test-only-fetch.mjs');
  fs.writeFileSync(preload, `
import fs from 'node:fs';
const database = ${JSON.stringify(database)};
const users = { a: ${JSON.stringify(userId)}, b: ${JSON.stringify(otherUserId)} };
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value); const route = url.pathname;
  const actor = users[options.headers?.authorization?.endsWith('-b') ? 'b' : 'a'];
  const user = { id: actor, email: 'fixture_user@accounts.vixo.invalid', app_metadata: { vixo_username: 'fixture_user' } };
  const body = options.body ? JSON.parse(options.body) : {};
  const data = JSON.parse(fs.readFileSync(database, 'utf8'));
  if (route === '/auth/v1/user') return Response.json(user);
  if (route === '/rest/v1/rpc/vixo_my_access') return Response.json({ userId: actor, status: 'approved', isAdmin: false });
  if (route === '/rest/v1/vixo_workspaces') return Response.json([]);
  if (route === '/rest/v1/vixo_assets') {
    const selected = url.searchParams.get('id')?.replace(/^eq\./, '');
    return Response.json(data.assets.filter(asset => asset.owner_id === actor && (!selected || asset.id === selected)));
  }
  if (route === '/rest/v1/vixo_asset_revisions') {
    const selected = url.searchParams.get('asset_id')?.replace(/^eq\./, '');
    return Response.json(data.assets.filter(asset => asset.owner_id === actor && asset.id === selected).map(asset => ({ asset_id: asset.id, revision: asset.revision, bundle: asset.bundle })));
  }
  if (route === '/rest/v1/rpc/vixo_save_asset') {
    const existing = data.assets.find(asset => asset.id === body.p_id);
    if (existing && data.forceConflict) {
      existing.revision++; data.forceConflict = false; fs.writeFileSync(database, JSON.stringify(data));
      return Response.json({ code: 'PT409', message: 'revision_conflict' }, { status: 409 });
    }
    if (existing && (existing.owner_id !== actor || existing.revision !== body.p_expected_revision)) return Response.json({ code: 'PT409', message: 'revision_conflict' }, { status: 409 });
    if (!existing && body.p_expected_revision !== 0) return Response.json({ code: 'PT409', message: 'revision_conflict' }, { status: 409 });
    const asset = { id: existing?.id || '30000000-0000-4000-8000-' + String(data.saves + 1).padStart(12, '0'), owner_id: actor, workspace_id: body.p_workspace_id,
      kind: body.p_kind, slug: body.p_slug, title: body.p_title, description: body.p_description, bundle: body.p_bundle, revision: (existing?.revision || 0) + 1, updated_at: new Date().toISOString() };
    data.saves++; data.assets = [...data.assets.filter(row => row.id !== asset.id), asset]; fs.writeFileSync(database, JSON.stringify(data)); return Response.json(asset);
  }
  throw new Error('Test-only fake backend rejects unhandled network route: ' + route);
};
`);
  const saveSession = (id, suffix = 'a') => fs.writeFileSync(path.join(cloud, 'session.json'), JSON.stringify({ access_token: `fixture-access-${suffix}`, refresh_token: `fixture-refresh-${suffix}`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id }, user_verified_at: Date.now() }));
  fs.writeFileSync(path.join(cloud, 'legacy-owner.json'), JSON.stringify({ formatVersion: 1, userId, agentIds: [], createdAt: new Date().toISOString() }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(preload).href, serverPath],
    env: { ...process.env, AGENT_TEAMS_HOME: temporary }
  });
  const client = new Client({ name: "agent-teams-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["agent_commit", "agent_get", "agent_list", "agent_prepare_run", "agent_preview", "cloud_create_device_code", "cloud_create_invite", "cloud_create_workspace", "cloud_list", "cloud_prepare_run", "cloud_preview_publish", "cloud_status", "dashboard_open", 'library_commit', 'library_preview', 'library_resolve', 'library_sync', "workflow_prepare_run"]);
    const unauthenticated = await client.callTool({ name: 'agent_list', arguments: {} });
    assert.equal(unauthenticated.isError, true); assert.match(unauthenticated.content[0].text, /登入/);
    saveSession(userId);
    const preview = await client.callTool({
      name: "agent_preview",
      arguments: {
        action: "create",
        spec: {
          id: "social-editor",
          displayName: "社群小編",
          aliases: ["小編"],
          description: "管理社群工作",
          purpose: "依照確認過的流程處理社群任務",
          systemPrompt: "先確認平台與內容，不可未經同意直接發布。",
          memory: "使用繁體中文。",
          skills: [
            {
              id: "find-keywords",
              name: "尋找關鍵字",
              description: "整理社群關鍵字",
              triggers: ["關鍵字"],
              allowedTools: ["WebSearch"],
              steps: ["確認主題", "搜尋資料", "整理關鍵字"],
              successCriteria: ["提供來源", "未發布貼文"]
            },
            {
              id: "draft-facebook-post",
              name: "撰寫 FB 貼文",
              description: "依素材草擬貼文",
              triggers: ["FB 貼文"],
              allowedTools: [],
              steps: ["讀取素材", "草擬貼文", "等待確認"],
              successCriteria: ["貼文可供審核", "未直接發布"]
            }
          ],
          workflows: [{
            id: "content-planning",
            name: "內容規劃流程",
            description: "先找關鍵字，再撰寫貼文",
            triggers: ["規劃貼文"],
            nodes: [
              { id: "keywords", name: "找關鍵字", type: "skill", skillId: "find-keywords", instructions: "搜尋並整理關鍵字" },
              { id: "draft", name: "撰寫貼文", type: "skill", skillId: "draft-facebook-post", instructions: "撰寫可供審核的貼文" },
              { id: "approval", name: "人工審核", type: "approval", instructions: "等待使用者確認", requiresApproval: true }
            ]
          }]
        }
      }
    });
    assert.equal(preview.isError, undefined);
    assert.equal(preview.structuredContent.spec.skills.length, 2);
    const committed = await client.callTool({ name: "agent_commit", arguments: { token: preview.structuredContent.token, userConfirmation: "確認建立社群小編" } });
    assert.equal(committed.structuredContent.status, 'queued');
    assert.match(committed.structuredContent.id, /^local:[a-f0-9-]{36}$/);
    const localId = committed.structuredContent.id;
    assert.equal(fs.existsSync(path.join(temporary, 'social-editor')), false, 'confirmed local queue must not create a legacy employee directory');
    const listed = await client.callTool({ name: "agent_list", arguments: {} });
    assert.equal(listed.structuredContent.agents[0].skills.length, 2);
    const prepared = await client.callTool({ name: "agent_prepare_run", arguments: { agent: "小編", task: "幫我找關鍵字" } });
    assert.equal(prepared.structuredContent.skill.id, "find-keywords");
    assert.equal(prepared.structuredContent.execution.mode, "current-host");
    const workflow = await client.callTool({ name: "workflow_prepare_run", arguments: { agent: "小編", workflow: "content-planning", task: "規劃新品貼文" } });
    assert.equal(workflow.structuredContent.workflow.nodes.length, 3);
    assert.equal(workflow.structuredContent.approvalMode, 'manual');
    assert.match(workflow.structuredContent.prompt, /遇到 approval 或 requiresApproval 節點必須停下來取得使用者明確確認/);
    const skillBundle = exportSpecBundle({ kind: 'skill', spec: preview.structuredContent.spec.skills[0] });
    const skillPreview = await client.callTool({ name: 'library_preview', arguments: { bundle: skillBundle, title: '獨立關鍵字技能' } });
    assert.equal(skillPreview.isError, undefined);
    const invalidCommit = await client.callTool({ name: 'library_commit', arguments: { token: skillPreview.structuredContent.token, userConfirmation: '先不要' } });
    assert.equal(invalidCommit.isError, true);
    const skillCommit = await client.callTool({ name: 'library_commit', arguments: { token: skillPreview.structuredContent.token, userConfirmation: '確認儲存這個私人技能' } });
    assert.equal(skillCommit.structuredContent.status, 'queued');
    const synchronized = await client.callTool({ name: 'library_sync', arguments: {} });
    assert.equal(synchronized.isError, undefined);
    assert.equal(synchronized.structuredContent.entries.filter(entry => entry.syncState === 'synced').length, 2);
    const saved = JSON.parse(fs.readFileSync(database, 'utf8'));
    assert.equal(saved.assets.length, 2); assert.equal(saved.assets.every(asset => asset.owner_id === userId && asset.workspace_id === null), true);
    const readBack = await client.callTool({ name: 'agent_get', arguments: { agent: localId } });
    assert.equal(readBack.isError, undefined); assert.equal(readBack.structuredContent.skills.length, 2);
    const changedSkill = exportSpecBundle({ kind: 'skill', spec: { ...skillBundle.spec, steps: [...skillBundle.spec.steps, '提供可查核的整理結果'] } });
    const edited = await client.callTool({ name: 'library_preview', arguments: { id: skillCommit.structuredContent.id, bundle: changedSkill } });
    assert.equal(edited.isError, undefined);
    fs.writeFileSync(database, JSON.stringify({ ...JSON.parse(fs.readFileSync(database, 'utf8')), forceConflict: true }));
    const editedCommit = await client.callTool({ name: 'library_commit', arguments: { token: edited.structuredContent.token, userConfirmation: '確認儲存修改後的技能' } });
    assert.equal(editedCommit.structuredContent.status, 'queued');
    await client.callTool({ name: 'library_sync', arguments: {} });
    const conflicted = await client.callTool({ name: 'cloud_list', arguments: {} });
    const conflict = conflicted.structuredContent.entries.find(entry => entry.id === skillCommit.structuredContent.id);
    assert.equal(conflict.syncState, 'conflict');
    assert.equal(conflicted.structuredContent.entries.find(entry => entry.id === `cloud:${conflict.assetId}`).revision, 2);
    const staleResolution = await client.callTool({ name: 'library_resolve', arguments: { id: conflict.id, resolution: 'copy', userConfirmation: '確認另存副本', expectedHash: 'stale', remoteRevision: 2 } });
    assert.equal(staleResolution.isError, true);
    const copied = await client.callTool({ name: 'library_resolve', arguments: { id: conflict.id, resolution: 'copy', userConfirmation: '確認另存副本', expectedHash: conflict.bundleHash, remoteRevision: 2 } });
    assert.equal(copied.isError, undefined); assert.notEqual(copied.structuredContent.entry.id, conflict.id);
    assert.equal(copied.structuredContent.archivedId, conflict.id);
    await client.callTool({ name: 'library_sync', arguments: {} });
    const resolvedDatabase = JSON.parse(fs.readFileSync(database, 'utf8'));
    assert.equal(resolvedDatabase.assets.length, 3);
    assert.equal(resolvedDatabase.assets.find(asset => asset.id === conflict.assetId).revision, 2, 'resolving as a copy must not overwrite the changed remote asset');
    saveSession(otherUserId, 'b');
    const otherList = await client.callTool({ name: 'agent_list', arguments: {} });
    assert.equal(otherList.isError, undefined); assert.deepEqual(otherList.structuredContent.agents, []);
    const forbidden = await client.callTool({ name: 'agent_get', arguments: { agent: localId } });
    assert.equal(forbidden.isError, true, 'another account cannot read the first account local ID');
    fs.unlinkSync(path.join(cloud, 'session.json'));
    const signedOut = await client.callTool({ name: 'agent_prepare_run', arguments: { agent: localId, task: '不應執行' } });
    assert.equal(signedOut.isError, true); assert.match(signedOut.content[0].text, /登入/);
  } finally {
    await client.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
