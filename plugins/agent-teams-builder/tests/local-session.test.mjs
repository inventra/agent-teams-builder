import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPreview, commitPreview } from '../src/store.mjs';
import { exportSpecBundle } from '../src/cloud-bundle.mjs';
import { cloudRoot, cloudStatus, requireAccount, libraryState, listSourceAgents, importLegacy, previewLibraryEntry, commitSourcePreview, enableLibrarySync, prepareSourceRun, syncLibrary, invalidateAccountView } from '../src/cloud-service.mjs';
import { createDashboardServer } from '../src/dashboard-server.mjs';
const a = '10000000-0000-4000-8000-000000000001', b = '10000000-0000-4000-8000-000000000002', assetId = '20000000-0000-4000-8000-000000000001';
const spec = {id:'local-demo',displayName:'本機測試助理',description:'測試',purpose:'整理',systemPrompt:'整理測試資料',memory:'',skills:[{id:'summarize',name:'摘要',description:'讀取資料',triggers:['摘要'],steps:['整理資料'],successCriteria:['完成摘要']}],workflows:[]};
const bundle = () => exportSpecBundle({kind:'agent',spec});
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'vixo-local-session-')), previousRoot=process.env.AGENT_TEAMS_HOME, previousFetch=globalThis.fetch;
  process.env.AGENT_TEAMS_HOME=root;
  let user=a, status='approved', offline=false, asset=null, requests=0, downloads=0, uploads=0;
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(input);if(url.hostname==='127.0.0.1')return previousFetch(input,options);
    requests++;if(offline)throw new TypeError('fetch network unavailable');
    if(url.pathname==='/auth/v1/user')return Response.json({id:user,email:'fixture@accounts.vixo.invalid',app_metadata:{vixo_username:'fixture'}});
    if(url.pathname==='/rest/v1/rpc/vixo_my_access')return Response.json({userId:user,status,isAdmin:false});
    if(url.pathname==='/rest/v1/vixo_assets'){
      const present=asset&&asset.owner_id===user&&status==='approved'&&Number(url.searchParams.get('offset')||0)===0;
      if(url.searchParams.get('select')==='*')downloads++;
      return Response.json(present?[asset]:[]);
    }
    if(url.pathname==='/rest/v1/vixo_asset_revisions')return Response.json([]);
    if(url.pathname==='/rest/v1/rpc/vixo_save_asset'){
      assert.equal(status,'approved'); const body=JSON.parse(options.body); uploads++;
      asset={id:assetId,owner_id:user,workspace_id:body.p_workspace_id,kind:body.p_kind,slug:body.p_slug,title:body.p_title,description:body.p_description,revision:(asset?.revision||0)+1,bundle:body.p_bundle};
      return Response.json(asset);
    }
    throw Error('Unexpected fixture request: '+url.pathname);
  };
  const login=id=>{user=id;fs.writeFileSync(path.join(cloudRoot(),'session.json'),JSON.stringify({access_token:`fixture-${id}`,expires_at:Date.now()/1000+3600,user:{id},user_verified_at:Date.now()}));invalidateAccountView();};
  return {root,login,setStatus:(v,{invalidate=true}={})=>{status=v;if(invalidate)invalidateAccountView();},setOffline:v=>{offline=v;invalidateAccountView();},setAsset:v=>{asset=v;},counts:()=>({requests,downloads,uploads}),cleanup(){globalThis.fetch=previousFetch;if(previousRoot===undefined)delete process.env.AGENT_TEAMS_HOME;else process.env.AGENT_TEAMS_HOME=previousRoot;fs.rmSync(root,{recursive:true,force:true});}};
}
test('homepage APIs require VIXO sign-in; legacy data needs explicit ownership and remains isolated after account switch',async()=>{
  const f=fixture();let server;
  try{
    const draft=createPreview({action:'create',spec});commitPreview({token:draft.token,userConfirmation:'確認'});
    ({server}=createDashboardServer({token:'local-bearer',updateOptions:{fetchImpl:async()=>({ok:false,status:503})}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer local-bearer'};
    assert.equal((await fetch(base+'/api/state',{headers})).status,401);
    assert.equal((await fetch(base+'/api/library',{headers})).status,401);
    assert.equal((await (await fetch(base+'/api/session',{headers})).json()).connected,false);
    f.login(a);assert.equal((await listSourceAgents()).length,0);
    await assert.rejects(importLegacy({userConfirmation:'maybe'}));
    assert.equal((await importLegacy({userConfirmation:'確認'})).imported,1);
    assert.equal((await listSourceAgents())[0].id,'legacy:local-demo');
    const prepared=await prepareSourceRun({agent:'legacy:local-demo',task:'摘要'});assert.equal(prepared.local.userId,a);
    f.login(b);assert.equal((await listSourceAgents()).length,0);
    await assert.rejects(prepareSourceRun({agent:'legacy:local-demo',task:'摘要'}),{status:404});
    await assert.rejects(importLegacy({userConfirmation:'確認'}),{status:403});
    f.setStatus('pending');assert.equal((await fetch(base+'/api/state',{headers})).status,403);
    f.setStatus('disabled');assert.equal((await fetch(base+'/api/library',{headers})).status,403);
    fs.unlinkSync(path.join(cloudRoot(),'session.json'));
    assert.equal((await fetch(base+'/api/state',{headers})).status,401);
  }finally{if(server)await new Promise(r=>server.close(r));f.cleanup();}
});
test('repeated dashboard reads do not re-fetch cloud content; execution rechecks approval and uses validated unchanged bytes',async()=>{
  const f=fixture();
  try{
    f.login(a);f.setAsset({id:assetId,owner_id:a,workspace_id:null,kind:'agent',slug:spec.id,title:spec.displayName,description:spec.description,revision:1,bundle:bundle()});
    await syncLibrary({force:true});await new Promise(setImmediate);const before=f.counts();
    for(let i=0;i<10;i++){assert.equal((await listSourceAgents()).length,1);assert.equal((await libraryState()).entries.length,1);}
    await new Promise(setImmediate);assert.deepEqual(f.counts(),before);
    const prepared=await prepareSourceRun({agent:`cloud:${assetId}`,task:'摘要'});
    assert.equal(prepared.cloud.revision,1);assert.equal(f.counts().downloads,before.downloads);assert.ok(f.counts().requests>before.requests);
    f.setStatus('disabled');await assert.rejects(prepareSourceRun({agent:`cloud:${assetId}`,task:'摘要'}),{code:'account_disabled'});
  }finally{f.cleanup();}
});
test('verified offline account may save private drafts without network writes, but cannot execute or reveal another account cache',async()=>{
  const f=fixture();
  try{
    f.login(a);await cloudStatus({force:true});f.setOffline(true);
    assert.equal((await cloudStatus({force:true})).offline,true);
    const preview=await previewLibraryEntry({bundle:bundle()});const saved=await commitSourcePreview({token:preview.token,userConfirmation:'確認'});
    assert.equal(saved.status,'saved-local');assert.equal(saved.syncMode,'local-only');assert.match(saved.id,/^local:/);
    assert.equal((await libraryState()).entries[0].id,saved.id);
    await assert.rejects(prepareSourceRun({agent:saved.id,task:'摘要'}),{code:'network_error'});
    f.login(b);await assert.rejects(requireAccount({allowOffline:true}),{code:'network_error'});
  }finally{f.cleanup();}
});

test('approved local-only content prepares and edits locally while repeated global sync never uploads it',async()=>{
  const f=fixture();
  try{
    f.login(a);
    const preview=await previewLibraryEntry({bundle:bundle()});assert.equal(preview.syncMode,'local-only');
    const saved=await commitSourcePreview({token:preview.token,userConfirmation:'確認'});
    assert.equal(saved.status,'saved-local');assert.equal(saved.hasCloudCopy,false);assert.equal(saved.assetId,null);
    const editedPreview=await previewLibraryEntry({id:saved.id,bundle:bundle(),title:'只改本機標題'});
    assert.equal(editedPreview.syncMode,'local-only');
    const edited=await commitSourcePreview({token:editedPreview.token,userConfirmation:'確認'});
    assert.equal(edited.status,'saved-local');assert.equal(edited.id,saved.id);
    for(let i=0;i<3;i++)await syncLibrary({force:true});
    const prepared=await prepareSourceRun({agent:edited.id,task:'摘要'});
    assert.equal(prepared.local.id,edited.id);assert.equal(prepared.local.userId,a);assert.equal(prepared.local.syncMode,'local-only');
    assert.equal(prepared.execution.mode,'current-host');assert.match(prepared.prompt,/整理測試資料/);
    assert.equal(f.counts().uploads,0);assert.equal((await libraryState({background:false})).sync.pendingCount,0);
    assert.equal(fs.existsSync(path.join(f.root,spec.id)),false,'new local content never edits a private legacy SOP');
    f.setStatus('disabled');await assert.rejects(prepareSourceRun({agent:edited.id,task:'摘要'}),{code:'account_disabled'});
    f.setStatus('approved');await cloudStatus({force:true});f.setOffline(true);
    await assert.rejects(prepareSourceRun({agent:edited.id,task:'摘要'}),{code:'network_error'});
    assert.equal(f.counts().uploads,0);
  }finally{f.cleanup();}
});

test('enabling local sync requires fresh same-account approval, explicit confirmation and both current hashes',async()=>{
  const f=fixture();
  try{
    f.login(a);
    const preview=await previewLibraryEntry({bundle:bundle()}), saved=await commitSourcePreview({token:preview.token,userConfirmation:'確認'});
    const request={id:saved.id,expectedHash:saved.bundleHash,expectedLocalHash:saved.localHash,userConfirmation:'確認加入同步'};
    await assert.rejects(enableLibrarySync({...request,userConfirmation:'先不要'}),{code:'invalid_request'});
    f.setStatus('pending');await assert.rejects(enableLibrarySync(request),{code:'account_pending'});
    f.setStatus('disabled');await assert.rejects(enableLibrarySync(request),{code:'account_disabled'});
    f.setStatus('approved');await cloudStatus({force:true});f.setOffline(true);
    await assert.rejects(enableLibrarySync(request),{code:'network_error'});
    f.setOffline(false);f.login(b);await assert.rejects(enableLibrarySync(request),{code:'not_found'});
    f.login(a);
    const changedPreview=await previewLibraryEntry({id:saved.id,bundle:bundle(),title:'新標題仍需重新確認上傳'});
    const changed=await commitSourcePreview({token:changedPreview.token,userConfirmation:'確認'});
    assert.equal(changed.bundleHash,saved.bundleHash);assert.notEqual(changed.localHash,saved.localHash);
    await assert.rejects(enableLibrarySync(request),{code:'revision_conflict'});
    await assert.rejects(enableLibrarySync({...request,expectedLocalHash:changed.localHash,expectedHash:'stale'}),{code:'revision_conflict'});
    assert.equal(f.counts().uploads,0);
    const queued=await enableLibrarySync({...request,expectedLocalHash:changed.localHash});
    assert.equal(queued.status,'queued');assert.equal(queued.id,saved.id);assert.equal(queued.syncMode,'cloud');
    await syncLibrary({force:true});await new Promise(setImmediate);
    assert.equal(f.counts().uploads,1);
    const entry=(await libraryState({background:false})).entries.find(item=>item.id===saved.id);
    assert.equal(entry.syncState,'synced');assert.equal(entry.assetId,assetId);assert.equal(entry.hasCloudCopy,true);
    await assert.rejects(enableLibrarySync({...request,expectedLocalHash:entry.localHash}),{code:'sync_mode_locked'});
    assert.equal(f.counts().uploads,1);
  }finally{f.cleanup();}
});

test('public skill HTTP reads require sign-in and invocation rechecks live approval despite a warm approved view',async()=>{
  const f=fixture();let server;
  try{
    ({server}=createDashboardServer({token:'public-fixture-bearer'}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer public-fixture-bearer','content-type':'application/json'};
    const read=(route,authenticated=true)=>fetch(base+route,{headers:authenticated?headers:{}});
    const prepare=()=>fetch(base+'/api/public-skills/prepare',{method:'POST',headers,body:JSON.stringify({slug:'erp-video-automation',task:'分析本次授權影片'})});
    assert.equal((await read('/api/public-skills',false)).status,401);
    assert.equal((await read('/api/public-skills')).status,401);
    assert.equal((await prepare()).status,401);
    f.login(a);
    const listed=await read('/api/public-skills');assert.equal(listed.status,200);
    const skills=await listed.json();assert.equal(skills.length,3);assert.ok(skills.every(skill=>skill.source==='github-bundled'&&skill.availability==='installed'));
    const detailResponse=await read('/api/public-skills/item?slug=erp-video-automation');assert.equal(detailResponse.status,200);
    const detail=await detailResponse.json();assert.match(detail.markdown,/ERP/);assert.ok(detail.references.length>0);
    const reference=await read('/api/public-skills/item?slug=erp-video-automation&reference='+encodeURIComponent(detail.references[0].path));
    assert.equal(reference.status,200);assert.equal(typeof(await reference.json()).markdown,'string');
    const prepared=await prepare();assert.equal(prepared.status,200);
    const prompt=await prepared.json();assert.equal(prompt.execution.mode,'current-host');assert.match(prompt.prompt,/分析本次授權影片/);
    assert.doesNotMatch(JSON.stringify({skills,detail,prompt}),/fixture-access|fixture-refresh|fixture-10000000/);
    // Keep the existing 30-second approved UI view warm. A prepare call must
    // force fresh authorization even when list/read status was just successful.
    f.setStatus('disabled',{invalidate:false});
    const disabled=await prepare();assert.equal(disabled.status,403);assert.equal((await disabled.json()).code,'account_disabled');
    f.setStatus('pending');const pending=await read('/api/public-skills/item?slug=erp-video-automation');assert.equal(pending.status,403);
    f.setStatus('approved');await cloudStatus({force:true});f.setOffline(true);
    const offline=await prepare();assert.notEqual(offline.status,200);assert.equal((await offline.json()).code,'network_error');
    assert.equal(f.counts().uploads,0);assert.equal(fs.existsSync(path.join(f.root,spec.id)),false);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));f.cleanup();}
});

test('HTTP preview accepts a valid multi-file bundle above 1 MiB and rejects oversized UTF-8 requests before creating drafts',async()=>{
  const f=fixture();let server;
  try{
    f.login(a);
    const files=[{path:'skills/summarize/references/large-a.md',content:'A'.repeat(700000)},{path:'skills/summarize/references/large-b.md',content:'B'.repeat(700000)}];
    const portable=exportSpecBundle({kind:'agent',spec,files});
    assert.ok(files.every(file=>Buffer.byteLength(file.content,'utf8')<1024*1024));
    assert.ok(Buffer.byteLength(JSON.stringify(portable),'utf8')>1024*1024);
    ({server}=createDashboardServer({token:'large-preview-bearer'}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url=`http://127.0.0.1:${server.address().port}/api/library/preview`,headers={authorization:'Bearer large-preview-bearer','content-type':'application/json'};
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({bundle:portable,title:'Large portable fixture'})});
    assert.equal(response.status,200);
    const preview=await response.json();assert.match(preview.token,/^local_[a-f0-9]{64}$/);
    for(const file of files)assert.equal(preview.bundle.files.find(resource=>resource.path===file.path).content,file.content,'complete resource bytes survive the HTTP preview');
    const previews=path.join(cloudRoot(),'previews'),before=fs.readdirSync(previews).filter(name=>name.endsWith('.json')).sort();
    assert.deepEqual(before,[`${preview.token}.json`]);
    const preserved=fs.readFileSync(path.join(previews,before[0]),'utf8');
    const oversized=JSON.stringify({bundle:portable,description:'測'.repeat(1700000)});
    assert.ok(oversized.length<6*1024*1024,'the oversized request fits a character-only cap');
    assert.ok(Buffer.byteLength(oversized,'utf8')>6*1024*1024,'UTF-8 bytes must enforce the request cap');
    await assert.rejects(fetch(url,{method:'POST',headers,body:oversized}),TypeError);
    assert.deepEqual(fs.readdirSync(previews).filter(name=>name.endsWith('.json')).sort(),before);
    assert.equal(fs.readFileSync(path.join(previews,before[0]),'utf8'),preserved);
    assert.equal(fs.existsSync(path.join(cloudRoot(),'library',a)),false,'preview and rejected requests cannot create confirmed drafts or a sync queue');
  }finally{if(server)await new Promise(resolve=>server.close(resolve));f.cleanup();}
});
