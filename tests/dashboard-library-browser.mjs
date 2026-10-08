// Isolated Dashboard fixture. Never connects to Supabase or real user data.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {draftBundleTemplate} from '../plugins/agent-teams-builder/web/workbench-model.js';
import {listPublicSkills,getPublicSkill,readPublicSkillReference,preparePublicSkill} from '../plugins/agent-teams-builder/src/public-skills.mjs';
import {bundleHash} from '../plugins/agent-teams-builder/src/cloud-bundle.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const web=path.join(root,'plugins/agent-teams-builder/web');
const require=createRequire(process.env.VIXO_BROWSER_PACKAGE_ROOT||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json'));
const {chromium}=require('playwright');
let session={connected:false}, calls=[], delayedState=null, holdState=false, delayedPublicPrepare=null, holdPublicPrepare=false, previewCounter=0;
const previews=new Map(), publicSkills=listPublicSkills();
const bundle=draftBundleTemplate('agent');bundle.spec.displayName='Fixture Agent';
let entries=[{id:'local:agent-one',assetId:'agent-one',hasCloudCopy:true,syncMode:'cloud',kind:'agent',title:'Fixture Agent',slug:'fixture-agent',description:'Private fixture SOP',syncState:'pending',bundle,bundleHash:'hash-local',localHash:'local-version-one',revision:1,workspaceId:null},
 {id:'cloud:skill-one',assetId:'skill-one',hasCloudCopy:true,syncMode:'cloud',kind:'skill',title:'Independent cloud skill',slug:'cloud-skill',description:'Standalone skill',syncState:'synced',bundle:draftBundleTemplate('skill'),revision:2,workspaceId:null}];
const legacyAgent={id:'legacy:old-agent',displayName:'Legacy fixture agent',description:'Original local definition',purpose:'Local-only SOP <script>window.fixtureInjected=true</script>',skills:[],workflows:[],version:1};
entries.push({id:legacyAgent.id,assetId:null,hasCloudCopy:false,syncMode:'local-only',kind:'agent',slug:'old-agent',title:legacyAgent.displayName,description:legacyAgent.description,legacy:true,bundle:null,agent:legacyAgent,error:'這份本機內容尚未符合雲端套件格式，可在本機使用；請整理後再同步。',syncState:'local'});
const approved=(id='fixture-user')=>({connected:true,user:{id,username:'fixture_user',accountConfigured:true},access:{userId:id,status:'approved',isAdmin:true},offline:false,source:'hybrid'});
const data=()=>({agents:[{...bundle.spec,id:'local:agent-one',skills:bundle.spec.skills,workflows:[],version:1},legacyAgent],publicSkills,library:entries.map(({bundle,...metadata})=>metadata),sync:{pendingCount:entries.filter(e=>e.syncState==='pending').length,conflictCount:entries.some(e=>['conflict','uncertain','error'].includes(e.syncState))?1:0},hosts:{codex:true,claude:false},runs:[],schedules:[],codexProjects:[],update:null});
const send=(res,status,obj)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(obj));};
const server=createServer(async(req,res)=>{
 try{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
 let input={};if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;input=JSON.parse(raw||'{}');}
 calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:req.method,input});
 if(url.pathname==='/api/session')return send(res,200,session);
 if(url.pathname==='/api/cloud/login'){session=approved();return send(res,200,{user:session.user});}
 if(url.pathname==='/api/cloud/register'){session={...approved('new-user'),access:{status:'pending',isAdmin:false}};return send(res,200,{user:session.user});}
 if(url.pathname==='/api/cloud/setup-account'){session.user.accountConfigured=true;session.user.username=input.username;return send(res,200,{user:session.user});}
 if(url.pathname==='/api/cloud/disconnect'){session={connected:false};return send(res,200,{});}
 if(url.pathname==='/api/state'){const snapshot=data();if(holdState){delayedState=()=>send(res,200,snapshot);return;}return send(res,200,snapshot);}
 if(url.pathname==='/api/sync')return send(res,200,{state:'syncing'});
 if(url.pathname==='/api/public-skills')return send(res,200,publicSkills);
 if(url.pathname==='/api/public-skills/item')return send(res,200,url.searchParams.has('reference')?readPublicSkillReference(url.searchParams.get('slug'),url.searchParams.get('reference')):getPublicSkill(url.searchParams.get('slug')));
 if(url.pathname==='/api/public-skills/prepare'){const prepared=preparePublicSkill(input);if(holdPublicPrepare){delayedPublicPrepare=()=>send(res,200,prepared);return;}return send(res,200,prepared);}
 if(url.pathname==='/api/library/item'){const entry=entries.find(e=>e.id===url.searchParams.get('id'));return send(res,200,{entry,remote:entry?.syncState==='conflict'?{...entry,revision:5,bundle:{...bundle,spec:{...bundle.spec,purpose:'Remote revision five'}}}:null});}
 if(url.pathname==='/api/library/prepare')return send(res,200,{prompt:'Fixture local execution prompt: use the current approved local host.'});
 if(url.pathname==='/api/library/preview'){const token='fixture-preview-'+(++previewCounter);previews.set(token,input);return send(res,200,{token,entry:{...input,syncState:input.syncMode==='local-only'?'local-only':'pending'}});}
 if(url.pathname==='/api/library/commit'){const draft=previews.get(input.token);assert.ok(draft);assert.equal(input.userConfirmation,'確認');const entry={...draft,id:'local:draft-new',assetId:null,hasCloudCopy:false,bundleHash:bundleHash(draft.bundle),localHash:'local-new-version-one',revision:0,workspaceId:null,syncState:draft.syncMode==='local-only'?'local-only':'pending'};entries.push(entry);return send(res,200,{...entry,status:draft.syncMode==='local-only'?'saved-local':'queued'});}
 if(url.pathname==='/api/library/enable-sync'){const entry=entries.find(e=>e.id===input.id);if(!entry||input.expectedHash!==entry.bundleHash||input.expectedLocalHash!==entry.localHash)return send(res,409,{error:'版本已改變，請重新檢視。',code:'revision_conflict'});assert.equal(input.userConfirmation,'確認');assert.equal(entry.syncMode,'local-only');entry.syncMode='cloud';entry.syncState='pending';return send(res,200,{...entry,status:'queued'});}
 if(url.pathname==='/api/library/resolve'){entries[0].syncState='pending';return send(res,200,{queued:true});}
 if(url.pathname==='/api/preferences/workbench')return send(res,200,{});
 if(url.pathname==='/api/workbench')return send(res,200,{summary:{completedRuns:0,pendingApprovals:0,totalAgents:1,activeRuns:0,failedRuns:0},runs:[],approvals:[],alerts:[],integrations:[],refreshedAt:new Date().toISOString()});
 return send(res,404,{error:'Unknown fixture endpoint'});
 }
 const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
 if(file.includes('..'))return res.writeHead(404).end();
 const content=await readFile(path.join(web,file));res.writeHead(200,{'content-type':(file.endsWith('.js')||file.endsWith('.mjs'))?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});res.end(content);
 }catch(error){send(res,error.status||500,{error:error.message,code:error.code});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1360,height:1000}});const page=await context.newPage();
 const errors=[], external=[];page.on('pageerror',error=>errors.push(error.message));
 const base='http://127.0.0.1:'+server.address().port;
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==base){external.push(url.origin);return route.abort();}return route.continue();});
 await page.goto(base+'/?token=fixture-local-bearer');
 await page.getByRole('heading',{name:'登入 VIXO',exact:true}).waitFor();
 await mkdir(path.join(root,'output/local-first-verification'),{recursive:true});await page.screenshot({path:path.join(root,'output/local-first-verification/login-preview.png'),fullPage:true});
 assert.equal(calls.filter(c=>c.path==='/api/state').length,0,'private state never fetched before login');
 await page.locator('[name=username]').fill('unfinished_name');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await new Promise(resolve=>setTimeout(resolve,80));assert.equal(await page.locator('[name=username]').inputValue(),'unfinished_name','session heartbeat preserves active auth form');
 await page.locator('#auth-toggle').click();await page.locator('[name=displayName]').fill('Fixture colleague');await page.locator('[name=username]').fill('fixture_user');await page.locator('[name=password]').fill('fixture-password-only');await page.locator('[name=confirmation]').fill('fixture-password-only');
 await page.getByRole('button',{name:'註冊並送交審核'}).click();await page.getByRole('heading',{name:'等待管理員核准'}).waitFor();assert.equal(calls.filter(c=>c.path==='/api/state').length,0);
 session={...session,user:{...session.user,accountConfigured:false}};await page.getByRole('button',{name:'重新檢查',exact:true}).click();await page.locator('#session-gate summary').click();
 await page.locator('#gate-setup [name=username]').fill('fixture_bound');await page.locator('#gate-setup [name=password]').fill('fixture-password-only');await page.locator('#gate-setup [name=confirmation]').fill('fixture-password-only');await page.locator('#gate-setup button').click();
 await page.waitForFunction(()=>!document.querySelector('#gate-setup'));assert.equal(session.user.id,'new-user','setup preserves UUID');
 session=approved();await page.getByRole('button',{name:'重新檢查',exact:true}).click();await page.getByRole('heading',{name:'我的資料庫'}).waitFor();await page.getByRole('heading',{name:'Fixture Agent',exact:true}).waitFor();
 await page.locator('.open-library-item[data-id="legacy:old-agent"]').click();await page.getByRole('heading',{name:'原有本機內容（唯讀）'}).waitFor();
 assert.match(await page.locator('#library-dialog-body').textContent(),/尚未符合雲端套件格式/);assert.equal(await page.locator('#edit-draft').count(),0);assert.equal(await page.locator('#draft-form').count(),0);assert.equal(await page.evaluate(()=>window.fixtureInjected),undefined);
 await page.getByRole('button',{name:'查看所屬本機 Agent'}).click();await page.getByRole('heading',{name:'Legacy fixture agent',exact:true,level:1}).waitFor();await page.locator('[data-id=library]').click();
 entries[0].syncState='synced';await page.locator('#refresh').click();await page.locator('.open-library-item[data-id="local:agent-one"]').click();await page.getByRole('button',{name:'取得執行提示'}).click();
 await page.getByRole('heading',{name:'在目前的 Codex Session 執行'}).waitFor();assert.match(await page.locator('#library-dialog-body').textContent(),/Fixture local execution prompt/);
 assert.deepEqual(calls.find(c=>c.path==='/api/library/prepare').input,{id:'local:agent-one'});await page.locator('#close-library-dialog').click();
 await page.getByRole('tab',{name:'Skill',exact:true}).click();await page.getByRole('heading',{name:'Independent cloud skill'}).waitFor();assert.equal(await page.getByRole('button',{name:'查看所屬 Agent'}).count(),1);
 // Public installed skills sit beside the personal cloud Skill list but use
 // their own registry/detail/prepare contract, never a fake cloud asset ID.
 assert.equal(await page.locator('.public-skill-card').count(),3);
 await page.getByRole('heading',{name:'ERP 影片自動化工坊',exact:true}).waitFor();
 assert.match(await page.locator('.public-section').textContent(),/GitHub 共用套件.*本機使用/);
 await page.locator('#library-source').selectOption('local');assert.equal(await page.getByRole('heading',{name:'Independent cloud skill'}).count(),0);assert.equal(await page.locator('.public-skill-card').count(),3);
 await page.locator('#library-source').selectOption('cloud');await page.getByRole('heading',{name:'Independent cloud skill'}).waitFor();
 await page.locator('#library-source').selectOption('all');
 const publicMutationCount=calls.filter(c=>['/api/library/preview','/api/library/commit','/api/library/prepare','/api/runs'].includes(c.path)).length;
 const entriesBeforePublic=JSON.stringify(entries);
 await page.locator('.open-public-skill[data-slug="erp-video-automation"]').click();await page.locator('#library-dialog-title').getByText('ERP 影片自動化工坊',{exact:true}).waitFor();
 assert.match(await page.locator('#library-dialog-body').textContent(),/GitHub 公用套件.*本機已安裝/);assert.equal(await page.locator('#edit-draft').count(),0);assert.equal(await page.locator('#enable-library-sync').count(),0);
 await page.getByText('閱讀完整 Skill',{exact:true}).click();assert.match(await page.locator('#library-dialog-body .skill-content pre').first().textContent(),/# ERP 影片自動化工坊/);
 await page.getByText('配套參考文件（2）',{exact:true}).click();await page.locator('.read-public-reference[data-path="references/contracts.md"]').click();await page.locator('#public-reference:not([hidden])').waitFor();
 assert.equal(await page.locator('#public-reference').textContent(),readPublicSkillReference('erp-video-automation','references/contracts.md').markdown);
 assert.deepEqual(calls.filter(c=>c.path==='/api/public-skills/item').at(-1).query,{slug:'erp-video-automation',reference:'references/contracts.md'});
 await mkdir(path.join(root,'output/public-skills-verification'),{recursive:true});await page.screenshot({path:path.join(root,'output/public-skills-verification/erp-public-detail.png'),fullPage:true});
 await page.getByRole('button',{name:'取得使用提示',exact:true}).click();await page.getByRole('heading',{name:'在目前 Session 使用公用 Skill',exact:true}).waitFor();
 const publicPrompt=await page.locator('#public-usage-prompt').inputValue();assert.match(publicPrompt,/erp-video-automation/);assert.match(publicPrompt,/本次已安裝的 SKILL\.md/);assert.match(publicPrompt,/不會建立員工、修改私人 SOP，也不會執行 ERP/);
 assert.deepEqual(calls.find(c=>c.path==='/api/public-skills/prepare').input,{slug:'erp-video-automation'});
 await page.getByRole('button',{name:'選取完整提示',exact:true}).click();assert.equal(await page.locator('#public-usage-prompt').evaluate(el=>el.selectionEnd-el.selectionStart),publicPrompt.length);
 assert.equal(JSON.stringify(entries),entriesBeforePublic);assert.equal(calls.filter(c=>['/api/library/preview','/api/library/commit','/api/library/prepare','/api/runs'].includes(c.path)).length,publicMutationCount);
 await page.locator('#close-library-dialog').click();await page.locator('.open-public-skill[data-slug="erp-video-automation"]').click();await page.locator('#prepare-public-skill').waitFor();holdPublicPrepare=true;await page.locator('#prepare-public-skill').click();
 await page.waitForFunction(()=>document.querySelector('#prepare-public-skill')?.disabled===true);await page.waitForTimeout(50);assert.ok(delayedPublicPrepare);await page.locator('#close-library-dialog').click();holdPublicPrepare=false;delayedPublicPrepare();await page.waitForTimeout(80);assert.equal(await page.locator('#library-dialog').evaluate(el=>el.open),false,'a late prompt response cannot reopen a dialog the user closed');
 await page.locator('[data-id="public-skills"]').click();await page.getByRole('heading',{name:'公用 Skills',exact:true,level:1}).waitFor();assert.equal(await page.locator('.public-skill-card').count(),3);
 publicSkills.find(skill=>skill.slug==='vixo-video-intake').availability='missing';await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('.open-public-skill[data-slug="vixo-video-intake"]')?.disabled===true);assert.equal(await page.locator('.open-public-skill[data-slug="vixo-video-intake"]').isDisabled(),true);assert.match(await page.locator('.public-skill-card').last().textContent(),/待安裝/);
 publicSkills.find(skill=>skill.slug==='vixo-video-intake').availability='installed';await page.locator('[data-id="library"]').click();
 await page.getByRole('tab',{name:'Agent',exact:true}).click();await page.getByRole('button',{name:'新增本機草稿'}).click();await page.locator('#draft-form [name=title]').fill('New local draft');
 assert.equal(await page.locator('#draft-form [name=syncMode]').inputValue(),'local-only');assert.equal(await page.locator('#draft-form [name=syncMode]').isDisabled(),false);
 await page.getByRole('button',{name:'預覽完整內容'}).click();await page.getByRole('heading',{name:'確認完整草稿'}).waitFor();assert.equal(calls.filter(c=>c.path==='/api/library/commit').length,0);assert.equal(await page.locator('#commit-draft').isDisabled(),true);
 assert.equal(calls.filter(c=>c.path==='/api/library/preview').at(-1).input.syncMode,'local-only');assert.match(await page.locator('#library-dialog-body .save-scope').textContent(),/僅存本機，不上傳雲端/);
 const syncCountBeforeLocalCommit=calls.filter(c=>c.path==='/api/sync').length;
 await page.locator('#confirm-draft').check();await page.locator('#commit-draft').click();await page.getByRole('heading',{name:'New local draft',exact:true}).waitFor();assert.equal(calls.find(c=>c.path==='/api/library/commit').input.userConfirmation,'確認');
 await page.waitForTimeout(80);assert.equal(calls.filter(c=>c.path==='/api/sync').length,syncCountBeforeLocalCommit,'local-only commit does not trigger upload');
 const newDraft=entries.find(entry=>entry.id==='local:draft-new');assert.equal(newDraft.syncMode,'local-only');assert.equal(newDraft.syncState,'local-only');assert.equal(newDraft.assetId,null);
 await page.locator('#library-source').selectOption('local');assert.equal(await page.getByRole('heading',{name:'Fixture Agent',exact:true}).count(),0);await page.getByRole('heading',{name:'New local draft',exact:true}).waitFor();
 await page.locator('#library-source').selectOption('cloud');await page.getByRole('heading',{name:'Fixture Agent',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'New local draft',exact:true}).count(),0);assert.equal(await page.getByRole('heading',{name:'Legacy fixture agent',exact:true}).count(),0);
 await page.locator('#library-source').selectOption('all');await page.locator('#sync-now').click();await page.waitForTimeout(80);assert.equal(newDraft.syncMode,'local-only');assert.equal(newDraft.assetId,null,'immediate sync does not turn a local-only entry into a cloud copy');
 await page.locator('.open-library-item[data-id="local:draft-new"]').click();await page.getByRole('button',{name:'開啟雲端同步',exact:true}).click();await page.getByRole('heading',{name:'確認開啟雲端同步',exact:true}).waitFor();assert.equal(await page.locator('#commit-enable-sync').isDisabled(),true);
 const oldLocalHash=newDraft.localHash;newDraft.localHash='metadata-changed-after-confirmation-preview';await page.locator('#confirm-enable-sync').check();await page.locator('#commit-enable-sync').click();await page.locator('#dialog-error').waitFor();assert.equal(newDraft.syncMode,'local-only');
 assert.deepEqual(calls.filter(c=>c.path==='/api/library/enable-sync').at(-1).input,{id:newDraft.id,expectedHash:newDraft.bundleHash,expectedLocalHash:oldLocalHash,userConfirmation:'確認'});
 await page.locator('#close-library-dialog').click();await page.locator('.open-library-item[data-id="local:draft-new"]').click();await page.getByRole('button',{name:'開啟雲端同步',exact:true}).click();await page.locator('#confirm-enable-sync').check();await page.locator('#commit-enable-sync').click();await page.waitForFunction(()=>!document.querySelector('#library-dialog').open);
 const enabled=calls.filter(c=>c.path==='/api/library/enable-sync').at(-1).input;assert.equal(enabled.expectedHash,newDraft.bundleHash);assert.equal(enabled.expectedLocalHash,newDraft.localHash);assert.equal(newDraft.syncMode,'cloud');assert.equal(newDraft.syncState,'pending');
 await page.locator('#library-source').selectOption('cloud');assert.equal(await page.getByRole('heading',{name:'New local draft',exact:true}).count(),0,'queued entry is not falsely labelled as an existing cloud copy');
 newDraft.assetId='confirmed-new-cloud-copy';newDraft.hasCloudCopy=true;newDraft.syncState='synced';newDraft.revision=1;await page.locator('#refresh').click();await page.getByRole('heading',{name:'New local draft',exact:true}).waitFor();
 await page.locator('.open-library-item[data-id="local:draft-new"]').click();assert.equal(await page.locator('#enable-library-sync').count(),0);await page.getByRole('button',{name:'編輯本機草稿',exact:true}).click();assert.equal(await page.locator('#draft-form [name=syncMode]').inputValue(),'cloud');assert.equal(await page.locator('#draft-form [name=syncMode]').isDisabled(),true);await page.locator('#close-library-dialog').click();await page.locator('#library-source').selectOption('all');
 entries[0].syncState='conflict';await page.locator('#refresh').click();await page.locator('.open-library-item[data-id="local:agent-one"]').click();await page.getByRole('heading',{name:'雲端候選 v5'}).waitFor();
 assert.equal(await page.locator('#resolve-copy').isDisabled(),true);await page.locator('#confirm-conflict').check();await page.locator('#resolve-copy').click();await page.waitForFunction(()=>!document.querySelector('#library-dialog').open);
 const resolution=calls.find(c=>c.path==='/api/library/resolve').input;assert.equal(resolution.expectedHash,'hash-local');assert.equal(resolution.remoteRevision,5);assert.equal(resolution.userConfirmation,'確認');
 entries[0].syncState='uncertain';await page.locator('#refresh').click();await page.locator('.open-library-item[data-id="local:agent-one"]').click();await page.getByRole('heading',{name:'雲端候選 v未知'}).waitFor();
 assert.match(await page.locator('#library-dialog-body').textContent(),/同步結果尚未確認.*原先的雲端寫入可能已完成.*另存副本可能保留兩份/);await page.getByRole('heading',{name:'目前本機',exact:true}).waitFor();
 assert.equal(await page.locator('#edit-draft').count(),0);assert.equal(await page.locator('#draft-form').count(),0);assert.equal(await page.locator('#resolve-copy').isDisabled(),true);assert.equal(await page.locator('#resolve-remote').isDisabled(),true);
 await page.locator('#confirm-conflict').check();assert.equal(await page.locator('#resolve-copy').isDisabled(),false);assert.equal(await page.locator('#resolve-remote').isDisabled(),true);await page.locator('#resolve-copy').click();await page.waitForFunction(()=>!document.querySelector('#library-dialog').open);
 const uncertainResolution=calls.filter(c=>c.path==='/api/library/resolve').at(-1).input;assert.deepEqual(uncertainResolution,{id:'local:agent-one',resolution:'copy',userConfirmation:'確認',expectedHash:'hash-local',expectedRevision:1,remoteRevision:null});
 await page.locator('[data-id=docs]').click();await page.locator('#wb-stage .wb-heading').waitFor();assert.equal(await page.locator('[data-id="public-skills"]').count(),1,'public skills remain reachable from Docs');await page.locator('#wb-search').fill('Fixture');await page.getByRole('button',{name:'Fixture Agent',exact:true}).click();await page.locator('#wb-detail[open]').waitFor();
 session={...approved(),access:{status:'disabled'}};await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('heading',{name:'帳號已停用'}).waitFor();assert.equal(await page.locator('#wb-detail-body').textContent(),'');assert.equal(await page.locator('#wb-stage').textContent(),'');assert.equal(await page.locator('#agent-nav').textContent(),'');
 session={...approved(),offline:true};await page.getByRole('button',{name:'重新檢查',exact:true}).click();await page.getByRole('heading',{name:'我的資料庫'}).waitFor();assert.equal(await page.locator('#sync-now').isDisabled(),true);assert.equal(await page.locator('[data-id=docs]').count(),0);
 await page.getByRole('tab',{name:'Skill',exact:true}).click();assert.equal(await page.getByRole('heading',{name:'Independent cloud skill'}).count(),0);await page.getByRole('tab',{name:'Agent',exact:true}).click();
 await page.locator('[data-id="public-skills"]').click();await page.getByRole('heading',{name:'ERP 影片自動化工坊',exact:true}).waitFor();await page.locator('.open-public-skill[data-slug="erp-video-automation"]').click();await page.locator('#library-dialog-title').getByText('ERP 影片自動化工坊',{exact:true}).waitFor();assert.equal(await page.locator('#prepare-public-skill').count(),0);assert.match(await page.locator('#library-dialog-body').textContent(),/重新連線確認帳號權限/);await page.locator('#close-library-dialog').click();await page.locator('[data-id="library"]').click();
 holdState=true;await page.locator('#refresh').click();await new Promise(resolve=>setTimeout(resolve,100));assert.ok(delayedState);await page.locator('#logout').click();await page.getByRole('heading',{name:'申請 VIXO 帳號'}).waitFor();holdState=false;delayedState();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await page.locator('#content').textContent(),'');assert.equal(await page.locator('#library-dialog-body').textContent(),'');
 await page.locator('#auth-toggle').click();await page.locator('[name=username]').fill('fixture_user');await page.locator('[name=password]').fill('fixture-password-only');await page.getByRole('button',{name:'登入',exact:true}).click();await page.getByRole('heading',{name:'我的資料庫'}).waitFor();assert.equal(await page.locator('input[type=password]').count(),0);
 await page.getByRole('tab',{name:'Skill',exact:true}).click();await page.getByRole('heading',{name:'ERP 影片自動化工坊',exact:true}).waitFor();
 for(const width of [1360,390,320]){
   await page.setViewportSize({width,height:width===1360?1000:844});await page.evaluate(()=>window.scrollTo(0,0));
   assert.equal(await page.locator('#library-dialog').evaluate(el=>el.open),false);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,`library Skill/public section fits ${width}px`);
   await page.screenshot({path:path.join(root,`output/public-skills-verification/library-skills-${width}.png`),animations:'disabled'});
 }
 await page.locator('[data-id="public-skills"]').click();await page.getByRole('heading',{name:'公用 Skills',exact:true,level:1}).waitFor();await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(root,'output/public-skills-verification/public-catalog-320.png'),animations:'disabled'});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'mobile layout fits width');
 session={connected:false};await page.evaluate(()=>{const channel=new BroadcastChannel('vixo-cloud-connection');channel.postMessage({type:'identity-changed'});channel.close();});await page.getByRole('heading',{name:'登入 VIXO',exact:true}).waitFor();assert.equal(await page.locator('#content').textContent(),'','another local page disconnect purges content');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log('PASS Dashboard isolated login/pending setup, installed public Skill catalog/detail/reference/prompt/no mutation, local-only preview/commit/no automatic upload, explicit enable-sync with bundle+local hash CAS, actual-copy storage filters, cloud mode lock, guarded conflict/uncertain copy, Docs public navigation, revoked/offline/late-dialog isolation, mobile layout; no real cloud or user sessions');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
