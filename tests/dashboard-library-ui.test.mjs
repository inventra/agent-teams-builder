import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardSessionMode,visibleLibrary,validateAccountInput,draftBundleTemplate,libraryWithAgentChildren,libraryLocation,SYNC_LABELS} from '../plugins/agent-teams-builder/web/workbench-model.js';
const approved={connected:true,user:{id:'fixture-user'},access:{status:'approved'}};
test('Dashboard requires approved identity before exposing any library',()=>{
  for(const session of [null,{}, {...approved,connected:false},{...approved,user:null},{...approved,access:{status:'pending'}},{...approved,access:{status:'disabled'}},{...approved,access:null}]){
    assert.notEqual(dashboardSessionMode(session),'approved');assert.deepEqual(visibleLibrary([{id:'cloud:one',kind:'agent'}],session),[]);
  }
  assert.equal(dashboardSessionMode(approved),'approved');
});
test('offline library limits views to local drafts and requested kind',()=>{
  assert.deepEqual(visibleLibrary([{id:'cloud:one',kind:'agent'},{id:'legacy:one',kind:'agent'},{id:'local:one',kind:'agent'},{id:'local:two',kind:'skill'}],{...approved,offline:true},'agent').map(row=>row.id),['local:one']);
});
test('nested skills and workflows preserve their parent identity and sync state',()=>{
  const rows=libraryWithAgentChildren([{id:'local:one',kind:'agent',title:'Parent',syncState:'pending'}],[{id:'local:one',skills:[{id:'check',name:'Check'}],workflows:[{id:'run',name:'Run'}]}]);
  assert.equal(rows.length,3);assert.equal(rows[1].parentId,'local:one');assert.equal(rows[1].syncState,'pending');assert.equal(rows[2].kind,'workflow');
});
test('cloud storage labels require an existing remote copy, not merely consent or a pending upload',()=>{
  for(const syncState of ['local-only','pending','uncertain','error']) {
    const location=libraryLocation({id:'local:draft',assetId:null,syncMode:syncState==='local-only'?'local-only':'cloud',syncState});
    assert.equal(location.cloudLinked,false,`${syncState} is not proof of an existing cloud copy`);
    assert.equal(location.storage,'僅存本機');
    assert.equal(location.execution,'本機執行');
    assert.notEqual(SYNC_LABELS[syncState],SYNC_LABELS.synced);
  }
  for(const entry of [{id:'cloud:remote',syncState:'synced'},{id:'local:bound',assetId:'remote',syncState:'pending'}]) {
    assert.equal(libraryLocation(entry).cloudLinked,true);
    assert.equal(libraryLocation(entry).storage,'本機＋雲端');
    assert.equal(libraryLocation(entry).execution,'本機執行');
  }
  assert.equal(libraryLocation({id:'legacy:agent',syncState:'local'}).cloudLinked,false);
});
test('embedded Skills and Workflows inherit actual parent cloud provenance for source filters',()=>{
  for(const binding of [{syncMode:'local-only',assetId:null,workspaceId:null,syncState:'local-only'},{syncMode:'cloud',assetId:null,workspaceId:null,syncState:'pending'},{syncMode:'cloud',assetId:'remote-parent',workspaceId:'team-one',syncState:'synced'}]) {
    const parent={id:'local:parent',kind:'agent',title:'Parent',revision:3,...binding};
    const rows=libraryWithAgentChildren([parent],[{id:parent.id,skills:[{id:'check',name:'Check'}],workflows:[{id:'run',name:'Run'}]}]);
    for(const child of rows.slice(1)) {
      for(const key of ['syncMode','assetId','workspaceId','syncState','revision'])assert.equal(child[key],parent[key]);
      assert.equal(child.parentId,parent.id);
      assert.deepEqual(libraryLocation(child),libraryLocation(parent));
    }
  }
  assert.deepEqual(libraryWithAgentChildren([],[{id:'unbound-private-agent',skills:[{id:'private-skill',name:'Private'}]}]),[],'a parent absent from the allowed library cannot leak child rows');
});
test('team sharing is described as pending until the first cloud copy exists',()=>{
  const pending={id:'local:team-draft',workspaceId:'team-one',assetId:null,syncMode:'cloud',syncState:'pending'};
  assert.equal(libraryLocation(pending).scope,'待同步至團隊');
  assert.equal(libraryLocation({...pending,assetId:'confirmed-remote'}).scope,'團隊共享');
  assert.equal(libraryLocation({id:'cloud:team-draft',workspaceId:'team-one'}).scope,'團隊共享');
  assert.equal(libraryLocation({...pending,workspaceId:null}).scope,'私人內容');
});
test('registration validates complete unicode passwords without truncating them',()=>{
  const value={username:'fixture_user',password:'測'.repeat(24),confirmation:'測'.repeat(24),displayName:'Fixture'};
  assert.equal(validateAccountInput(value,'register'),'');assert.match(validateAccountInput({...value,password:'測'.repeat(25)},'register'),/縮短/);
  assert.match(validateAccountInput({...value,username:'fixture.user'},'register'),/帳號/);
  assert.match(validateAccountInput({...value,confirmation:'different'},'register'),/不一致/);
});
test('draft templates include complete editable SOP files and required collection shapes',()=>{
  for(const kind of ['agent','skill','workflow']){const bundle=draftBundleTemplate(kind);assert.equal(bundle.kind,kind);assert.equal(bundle.formatVersion,1);assert.ok(bundle.files[0].content);assert.ok(Array.isArray(bundle.requirements.tools));assert.ok(bundle.spec.id);}
});
