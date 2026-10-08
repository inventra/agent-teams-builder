import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardSessionMode,visibleLibrary,validateAccountInput,draftBundleTemplate,libraryWithAgentChildren} from '../plugins/agent-teams-builder/web/workbench-model.js';
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
test('registration validates complete unicode passwords without truncating them',()=>{
  const value={username:'fixture_user',password:'測'.repeat(24),confirmation:'測'.repeat(24),displayName:'Fixture'};
  assert.equal(validateAccountInput(value,'register'),'');assert.match(validateAccountInput({...value,password:'測'.repeat(25)},'register'),/縮短/);
  assert.match(validateAccountInput({...value,username:'fixture.user'},'register'),/帳號/);
  assert.match(validateAccountInput({...value,confirmation:'different'},'register'),/不一致/);
});
test('draft templates include complete editable SOP files and required collection shapes',()=>{
  for(const kind of ['agent','skill','workflow']){const bundle=draftBundleTemplate(kind);assert.equal(bundle.kind,kind);assert.equal(bundle.formatVersion,1);assert.ok(bundle.files[0].content);assert.ok(Array.isArray(bundle.requirements.tools));assert.ok(bundle.spec.id);}
});
