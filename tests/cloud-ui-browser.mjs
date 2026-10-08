// Isolated browser check: all cloud calls use fixture data; never reaches Supabase.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { blankBundle } from '../cloud/app.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.VIXO_BROWSER_PACKAGE_ROOT || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json'));
const { chromium } = require('playwright');
const fixture = `
export function createCloudClient({getSession,saveSession}) {
 const user = {id:'user1',email:'fixture@devices.vixo.invalid'};
 let assets = []; let revisions = {}; let workspaces = [{id:'team1',name:'營運團隊',owner_id:'user1'}];
 window.fixtureCalls = [];
 let sessionFingerprint = getSession()?.access_token || null;
 return {
  pairDevice: async code => { if(code !== 'fixture-code') throw new Error('連線碼無效'); window.fixtureCalls.push('pair'); if(sessionFingerprint !== (getSession()?.access_token || null)) throw new Error('已兌換但無法儲存：舊client仍綁定另一份session'); saveSession({access_token:'fixture-access',refresh_token:'fixture-refresh',user}); sessionFingerprint = 'fixture-access'; },
  getUser: async () => getSession()?.access_token ? user : null,
  signOut: async () => { saveSession(null); sessionFingerprint = null; },
  listWorkspaces: async () => workspaces,
  listAssets: async ({workspaceId}) => { window.fixtureCalls.push('list'); return assets.filter(a => a.workspace_id === (workspaceId || null)); },
  getAsset: async id => assets.find(a => a.id === id),
  listRevisions: async id => revisions[id] || [],
  saveAsset: async input => {
   const old = assets.find(a => a.id === input.id); if(old && old.revision !== input.expectedRevision) throw Object.assign(new Error('Conflict'),{code:'revision_conflict'});
   const asset = {...input,id:input.id || 'asset' + (assets.length + 1),owner_id:'user1',workspace_id:input.workspaceId,revision:(old?.revision || 0)+1,updated_at:new Date().toISOString()};
   assets = [...assets.filter(a=>a.id !== asset.id),asset]; revisions[asset.id] = [{...asset,created_at:asset.updated_at},...(revisions[asset.id] || [])]; window.fixtureCalls.push('save'); return asset;
  },
  createWorkspace: async name => {const workspace = {id:'team'+(workspaces.length+1),name,owner_id:'user1'}; workspaces.push(workspace); return workspace;},
  listMembers: async () => [{user_id:'user1',role:'owner'},{user_id:'user2',role:'viewer'}],
  createInvite: async () => ({code:'INVITE-FIXTURE',expires_at:'2026-10-09T00:00:00Z'}),
  joinWorkspace: async () => ({workspace_id:'team1'}),
  removeMember: async () => {},
  createDeviceCode: async () => ({code:'DEVICE-FIXTURE',expires_at:'2026-10-09T00:00:00Z'})
 };
}`;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/config.json') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({url:'https://fixture.invalid',key:'public-fixture-key'})); return; }
  if (pathname === '/cloud-client.mjs') { response.setHeader('content-type', 'text/javascript'); response.end(fixture); return; }
  if (pathname === '/local-cloud' || pathname === '/cloud-panel.mjs') {
    response.setHeader('content-type',pathname.endsWith('.mjs') ? 'text/javascript' : 'text/html');
    response.end(await readFile(path.join(root,'plugins/agent-teams-builder/web',pathname.endsWith('.mjs') ? 'cloud-panel.mjs' : 'cloud.html'))); return;
  }
  const files = {'/':'index.html','/index.html':'index.html','/app.mjs':'app.mjs','/styles.css':'styles.css'};
  if (!files[pathname]) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html');
  response.end(await readFile(path.join(root, 'cloud', files[pathname])));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser = await chromium.launch({headless:true});
 const browserContext = await browser.newContext({viewport:{width:1440,height:1040}});
 const page = await browserContext.newPage();
 const errors = []; page.on('pageerror', error => errors.push(error.message));
 page.on('dialog', dialog => { errors.push('Unexpected dialog: '+dialog.message()); dialog.dismiss(); });
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByRole('heading',{name:'連接你的 VIXO'}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixtureCalls.length),0,'private data loaded before pairing');
 assert.equal(await page.locator('input[type=password]').count(),0);
 await page.getByLabel('一次性裝置連線碼／團隊邀請碼').fill('fixture-code');
 await page.getByRole('button',{name:'連接雲端工作室',exact:true}).click();
 await page.getByRole('heading',{name:'我的 Agent',exact:true}).waitFor();
 await page.getByRole('button',{name:'＋ 建立／匯入'}).click();
 await page.getByLabel('顯示名稱').fill('ERP <img src=x onerror=alert(1)>');
 await page.getByLabel('識別名稱').fill('erp-helper');
 const bundle = blankBundle('agent'); bundle.spec.displayName = 'ERP 助手'; bundle.spec.systemPrompt = '完整 SOP：先確認輸入，再處理。'; bundle.files[0].content = '<script>alert(1)</script>\n完整技能內容'; bundle.dependencies = [{kind:'skill',id:'erp-video-automation',version:'1.8.0'}]; bundle.requirements = {platforms:['windows'],tools:['Codex']};
 await page.getByLabel('完整資產 JSON').fill(JSON.stringify(bundle,null,2));
 await page.getByRole('button',{name:'預覽完整內容 →'}).click();
 await page.getByRole('heading',{name:'發布前，確認完整內容'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'確認發布',exact:true}).isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x==='save').length),0);
 assert.equal(await page.locator('dialog img').count(),0,'asset title interpreted as markup');
 await page.getByText('skills/new-skill/SKILL.md',{exact:true}).click();
 assert.match(await page.locator('dialog').innerText(),/完整技能內容/);
 await page.getByLabel('我已檢查完整 SOP、附加檔案及分享範圍，確認發布這個版本。').check();
 await page.getByRole('button',{name:'確認發布',exact:true}).click();
 await page.getByRole('heading',{name:'ERP <img src=x onerror=alert(1)>',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x==='save').length),1);
 await page.getByRole('button',{name:'編輯新版本'}).click();
 await page.getByLabel('簡短說明').fill('更新後的說明');
 await page.getByRole('button',{name:'預覽完整內容 →'}).click();
 await page.getByRole('button',{name:'← 返回編輯'}).click();
 assert.equal(await page.getByLabel('識別名稱').inputValue(),'erp-helper','back changed slug');
 assert.equal(await page.getByLabel('簡短說明').inputValue(),'更新後的說明');
 await page.getByRole('button',{name:'預覽完整內容 →'}).click();
 await page.getByLabel('我已檢查完整 SOP、附加檔案及分享範圍，確認發布這個版本。').check();
 await page.getByRole('button',{name:'確認發布新版本'}).click();
 await page.getByText('目前版本 v2',{exact:true}).waitFor();
 await page.getByRole('tab',{name:'歷史版本'}).click();
 await page.getByRole('button',{name:'預覽回復'}).click();
 assert.match(await page.locator('dialog').innerText(),/回復 v1/);
 await page.getByLabel('我已檢查完整 SOP、附加檔案及分享範圍，確認發布這個版本。').check();
 await page.getByRole('button',{name:'確認發布新版本'}).click();
 await page.getByText('目前版本 v3',{exact:true}).waitFor();
 await page.getByRole('button',{name:'複製到空間'}).click();
 await page.getByLabel('發布位置').selectOption('team1');
 await page.getByRole('button',{name:'預覽完整內容 →'}).click();
 assert.match(await page.locator('dialog').innerText(),/團隊的成員將能讀取完整內容/);
 await page.getByLabel('我已檢查完整 SOP、附加檔案及分享範圍，確認發布這個版本。').check();
 await page.getByRole('button',{name:'確認發布',exact:true}).click();
 await page.getByText('目前版本 v1',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('選擇工作空間').inputValue(),'team1');
 await page.getByRole('button',{name:'成員與邀請'}).click();
 await page.getByRole('button',{name:'產生邀請碼'}).click();
 await page.getByLabel('授予權限').selectOption('editor');
 await page.getByRole('button',{name:'產生邀請碼'}).click();
 await page.getByText('INVITE-FIXTURE',{exact:true}).waitFor();
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.getByRole('button',{name:'連接另一台裝置',exact:true}).click();
 await page.getByText('DEVICE-FIXTURE',{exact:true}).waitFor();
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.getByRole('button',{name:'← 回到資產清單'}).click();
 const screenshotDir = process.env.VIXO_UI_SCREENSHOT_DIR;
 if(screenshotDir) { await mkdir(screenshotDir,{recursive:true}); await page.screenshot({path:path.join(screenshotDir,'vixo-cloud-desktop.png'),fullPage:true}); }
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),'mobile page overflows horizontally');
 if(screenshotDir) await page.screenshot({path:path.join(screenshotDir,'vixo-cloud-mobile.png'),fullPage:true});
 await page.setViewportSize({width:320,height:720});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),'small mobile page overflows horizontally');
 await page.getByRole('button',{name:'中斷此裝置連線',exact:true}).click();
 await page.getByRole('heading',{name:'連接你的 VIXO'}).waitFor();
 assert.equal(await page.getByText('ERP <img src=x onerror=alert(1)>',{exact:true}).count(),0,'private content survives disconnect');
 // Another tab changes credentials. This page must recreate its client before
 // redeeming a fresh, single-use code; fixture's fingerprint catches the old bug.
 await page.getByLabel('一次性裝置連線碼／團隊邀請碼').fill('fixture-code');
 await page.getByRole('button',{name:'連接雲端工作室',exact:true}).click();
 await page.getByRole('heading',{name:'我的 Agent',exact:true}).waitFor();
 const otherTab = await page.context().newPage();
 await otherTab.goto('http://127.0.0.1:'+server.address().port);
 await otherTab.getByRole('heading',{name:'我的 Agent',exact:true}).waitFor();
 let navigations = 0;
 page.on('framenavigated', frame => { if(frame === page.mainFrame()) navigations++; });
 await otherTab.evaluate(() => { const key = 'vixo.cloud.session.v1'; const value = JSON.parse(localStorage.getItem(key)); localStorage.setItem(key,JSON.stringify({...value,user_verified_at:Date.now()})); });
 await page.waitForTimeout(100);
 assert.equal(navigations,0,'verification metadata causes reload loops');
 await otherTab.evaluate(() => localStorage.removeItem('vixo.cloud.session.v1'));
 await page.getByRole('heading',{name:'連接你的 VIXO'}).waitFor();
 assert.ok(navigations >= 1,'cross-tab disconnect did not recreate the page/client');
 await page.getByLabel('一次性裝置連線碼／團隊邀請碼').fill('fixture-code');
 await page.getByRole('button',{name:'連接雲端工作室',exact:true}).click();
 await page.getByRole('heading',{name:'我的 Agent',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(x=>x==='pair').length),1,'fresh code was consumed more than once');
 assert.equal(await page.evaluate(()=>Boolean(JSON.parse(localStorage.getItem('vixo.cloud.session.v1'))?.access_token)),true,'fresh session was not saved');
 await otherTab.close();
 const panel = await browserContext.newPage();
 panel.on('pageerror', error => errors.push(error.message));
 let actor = 'identity-a', delayedRoute = null, releaseDelayed = null, delayKind = null;
 await panel.route('**/api/cloud/**', async route => {
   const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
   const body = route.request().postDataJSON();
   const currentActor = actor;
   let data;
   if(endpoint === 'status') data = {connected:Boolean(actor),user:actor ? {id:actor} : null,portalUrl:'https://fixture.invalid/'};
   else if(endpoint === 'local-agents') data = [{id:'local-fixture',displayName:'本地測試',skills:[{id:'fixture-skill',name:'測試技能'}],workflows:[]}];
   else if(endpoint === 'workspaces') data = [{id:'team-one',name:'測試團隊'}];
   else if(endpoint === 'assets') data = [{id:'fixture-asset',title:'測試雲端資產',kind:'agent',revision:1}];
   else if(endpoint === 'pair') {actor = body.code; data = {ok:true};}
   else if(endpoint === 'disconnect') {actor = null; data = {ok:true};}
   else if(endpoint === 'preview-upload') data = {token:'draft-'+actor,title:'測試預覽',kind:'agent',workspaceId:body.workspaceId,bundle:{privateFixture:actor}};
   else if(endpoint === 'open-portal') { assert.deepEqual(body,{},'client supplied an external opener URL'); data={opened:true}; }
   else if(endpoint === 'device-code') data = {code:'DEVICE-'+currentActor,expires_at:'2026-10-09T00:00:00Z'};
   else if(endpoint === 'pull') data = {privateFixture:'DETAIL-'+currentActor};
   else throw new Error('Unexpected local panel API: '+endpoint);
   if(endpoint === delayKind) { delayedRoute = endpoint; await new Promise(resolve=>{releaseDelayed=resolve}); delayKind=null; }
   await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await panel.goto('http://127.0.0.1:'+server.address().port+'/local-cloud?token=local-fixture-token');
 await panel.getByRole('button',{name:'測試雲端資產 · agent · v1'}).waitFor();
 assert.equal(await panel.locator('#back').getAttribute('href'),'/?token=local-fixture-token','sandbox return link loses its local bearer');
 await panel.getByRole('button',{name:'開啟雲端管理中心',exact:true}).click();
 await panel.getByText('已在預設瀏覽器開啟雲端管理中心；瀏覽器首次連線時，請使用自己的裝置換機碼。',{exact:true}).waitFor();
 await panel.getByRole('button',{name:'連接另一台自己的裝置'}).click();
 await panel.waitForFunction(()=>document.getElementById('device-result').textContent.includes('DEVICE-identity-a'));
 await panel.getByRole('button',{name:'測試雲端資產 · agent · v1'}).click();
 await panel.waitForFunction(()=>document.getElementById('asset-detail').textContent.includes('DETAIL-identity-a'));
 await panel.getByRole('button',{name:'預覽完整內容',exact:true}).click();
 await panel.locator('#draft:not([hidden])').waitFor();
 await panel.getByRole('button',{name:'中斷此裝置連線',exact:true}).click();
 await panel.locator('#connect:not([hidden])').waitFor();
 for(const id of ['device-result','draft-content','asset-detail']) assert.equal(await panel.locator('#'+id).textContent(),'','old identity data retained: '+id);
 async function pairPanel(id) { await panel.getByLabel('一次性裝置連線碼或團隊邀請碼').fill(id); await panel.getByRole('button',{name:'連接雲端',exact:true}).click(); await panel.getByRole('button',{name:'測試雲端資產 · agent · v1'}).waitFor(); }
 await pairPanel('identity-b');
 assert.equal(await panel.locator('#device-result').textContent(),'','old device capability revealed to next identity');
 for(const endpoint of ['device-code','pull']) {
   delayKind=endpoint; delayedRoute=null;
   await panel.getByRole('button',{name:endpoint === 'device-code' ? '連接另一台自己的裝置' : '測試雲端資產 · agent · v1'}).click();
   for(let attempt=0; !delayedRoute && attempt<500; attempt++) await new Promise(resolve=>setTimeout(resolve,10));
   assert.ok(delayedRoute,'delayed fixture request was not started');
   await panel.getByRole('button',{name:'中斷此裝置連線',exact:true}).click();
   await panel.locator('#connect:not([hidden])').waitFor();
   await pairPanel('identity-next-'+endpoint);
   releaseDelayed();
   await panel.waitForTimeout(60);
   for(const id of ['device-result','asset-detail']) assert.equal(await panel.locator('#'+id).textContent(),'','late private response crossed identities: '+id);
 }
 await panel.getByRole('button',{name:'預覽完整內容',exact:true}).click();
 await panel.locator('#draft:not([hidden])').waitFor();
 await panel.locator('#workspace').selectOption('team-one');
 assert.equal(await panel.locator('#draft').isVisible(),false,'changed publish scope retained old preview');
 await panel.close();
 assert.deepEqual(errors,[]);
 console.log('Cloud browser checks passed: device pairing, safe rendering, preview, edit, restore, team copy, invitation, device code, mobile, disconnect, cross-tab disconnect/re-pair, local-panel identity cleanup and delayed responses.');
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
