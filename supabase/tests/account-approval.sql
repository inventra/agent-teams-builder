begin;

create temporary table vixo_approval_test(key text primary key,value jsonb not null);
grant select,insert,update on vixo_approval_test to anon,authenticated,service_role;
insert into vixo_approval_test values ('owner',to_jsonb(gen_random_uuid())),('staff',to_jsonb(gen_random_uuid())),
  ('pending',to_jsonb(gen_random_uuid())),('disabled',to_jsonb(gen_random_uuid())),('other_admin',to_jsonb(gen_random_uuid()));
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
  select (value #>> '{}')::uuid,(value #>> '{}')||'@devices.vixo.invalid',
    jsonb_build_object('vixo_device_identity',true,'vixo_username','qa_'||substr(replace(value #>> '{}','-',''),1,20),'is_admin',true,'status','approved'),
    '{"is_admin":true,"status":"approved","role":"admin"}'::jsonb from vixo_approval_test;
insert into vixo_approval_test values ('named',to_jsonb(gen_random_uuid())),('bind_pending',to_jsonb(gen_random_uuid()));
insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
  values ((select (value #>> '{}')::uuid from vixo_approval_test where key='named'),
    (select (value #>> '{}')||'@devices.vixo.invalid' from vixo_approval_test where key='named'),
    '{"vixo_username":"named_fallback"}'::jsonb,'{"display_name":"  測試同仁  ","is_admin":true,"status":"approved"}'::jsonb);
insert into auth.users(id,email,raw_app_meta_data)
  select (value #>> '{}')::uuid,(value #>> '{}')||'@devices.vixo.invalid','{"vixo_device_identity":true}'::jsonb
  from vixo_approval_test where key='bind_pending';
create function pg_temp.fixture(p_key text) returns jsonb language sql stable as $$
  select value from pg_temp.vixo_approval_test where key=p_key
$$;
create function pg_temp.uid(p_key text) returns uuid language sql stable as $$ select (pg_temp.fixture(p_key) #>> '{}')::uuid $$;
create function pg_temp.bundle() returns jsonb language sql as $$
  select jsonb_build_object('formatVersion',1,'kind','agent','spec','{}'::jsonb,'files','[]'::jsonb,'dependencies','[]'::jsonb,'requirements','{}'::jsonb)
$$;
create function pg_temp.assert_true(p_condition boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_condition is distinct from true then raise exception 'assertion_failed: %',p_message; end if;
end $$;
create function pg_temp.expect_error(p_sql text,p_state text,p_message text default null)
returns void language plpgsql as $$ declare actual_state text; actual_message text; begin
  begin execute p_sql; exception when others then
    get stacked diagnostics actual_state=returned_sqlstate,actual_message=message_text;
    if actual_state<>p_state or (p_message is not null and actual_message<>p_message) then
      raise exception 'expected %/% got %/%',p_state,p_message,actual_state,actual_message;
    end if;
    return;
  end;
  raise exception 'expected failure, command succeeded';
end $$;
create function pg_temp.business_blocked(p_message text)
returns void language plpgsql as $$ declare statement text; begin
  foreach statement in array array[
    'select public.vixo_create_workspace(''Blocked fixture'')',
    format('select public.vixo_create_invite(%L::uuid)',pg_temp.fixture('workspace')->>'id'),
    format('select public.vixo_join_workspace(%L)',pg_temp.fixture('invite')->>'code'),
    format('select public.vixo_remove_member(%L::uuid,%L::uuid)',pg_temp.fixture('workspace')->>'id',pg_temp.uid('staff')),
    'select public.vixo_save_asset(p_slug=>''blocked-fixture'',p_title=>''Blocked'',p_bundle=>pg_temp.bundle())',
    'select public.vixo_create_device_code()'
  ] loop perform pg_temp.expect_error(statement,'PT403',p_message); end loop;
end $$;

select pg_temp.assert_true((select count(*)=5 and bool_and(status='pending' and not is_admin)
  from public.vixo_account_access where user_id in (pg_temp.uid('owner'),pg_temp.uid('staff'),pg_temp.uid('pending'),pg_temp.uid('disabled'),pg_temp.uid('other_admin'))),'Auth INSERT forces every fixture pending despite forged metadata');
select pg_temp.assert_true((select display_name like 'qa_%' from public.vixo_account_access where user_id=pg_temp.uid('pending')),'display name may use username but never grants authority');
select pg_temp.assert_true((select display_name='測試同仁' and status='pending' and not is_admin from public.vixo_account_access where user_id=pg_temp.uid('named')),'trimmed human display name is preserved without trusting metadata status');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.vixo_account_access','UPDATE')
  and not has_table_privilege('authenticated','public.vixo_account_access','SELECT')
  and not has_table_privilege('anon','public.vixo_account_access','SELECT'),'clients use status RPCs, never direct access mutation or lists');
select pg_temp.assert_true((select count(*)=4 and bool_and(not polpermissive) from pg_policy
  where polname in ('vixo_workspaces_account_approved','vixo_members_account_approved','vixo_assets_account_approved','vixo_asset_revisions_account_approved')),'approval RLS is restrictive on all four data tables');
select pg_temp.assert_true((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
  where pronamespace in ('public'::regnamespace,'vixo_private'::regnamespace) and proname like 'vixo_%' and prosecdef),'every public VIXO definer uses empty search_path');
select pg_temp.assert_true((select bool_and(not has_function_privilege('authenticated',p.oid,'EXECUTE')
  or p.proname=any(array['vixo_create_workspace','vixo_create_invite','vixo_join_workspace','vixo_remove_member','vixo_save_asset','vixo_create_device_code','vixo_my_access','vixo_admin_list_accounts','vixo_admin_set_account_status']))
  from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'vixo_%' and p.prosecdef),'no extra public implementation is client callable');
select pg_temp.assert_true(not has_function_privilege('authenticated','vixo_private.join_with_invite(text,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','vixo_private.account_access_json(uuid)','EXECUTE')
  and not has_function_privilege('service_role','vixo_private.join_with_invite(text,uuid)','EXECUTE'),'private identity and invite implementations cannot bypass public gates');

set local role anon;
select pg_temp.expect_error('select public.vixo_my_access()','42501');
select pg_temp.expect_error('select public.vixo_admin_list_accounts()','42501');
select pg_temp.expect_error('select public.vixo_create_workspace(''Anon'')','42501');
select pg_temp.expect_error('select public.vixo_claim_registration_quota(null)','42501');
select pg_temp.expect_error('select * from public.vixo_account_access','42501');
reset role;

-- Trusted test-only seed. No production UUID or metadata grants are used.
update public.vixo_account_access set status='approved',is_admin=true,approved_by=user_id
  where user_id in (pg_temp.uid('owner'),pg_temp.uid('other_admin'));
update public.vixo_account_access set status='disabled' where user_id=pg_temp.uid('disabled');
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',pg_temp.uid('owner')::text,true);
select pg_temp.assert_true(public.vixo_my_access()->>'isAdmin'='true','trusted initial admin remains same UUID');
select pg_temp.assert_true(jsonb_array_length(public.vixo_admin_list_accounts())>=5,'admin can list account status records');
select pg_temp.expect_error(format('select public.vixo_admin_set_account_status(%L::uuid,''disabled'')',pg_temp.uid('owner')),'PT403','admin_account_protected');
select pg_temp.expect_error(format('select public.vixo_admin_set_account_status(%L::uuid,''disabled'')',pg_temp.uid('other_admin')),'PT403','admin_account_protected');
select pg_temp.expect_error(format('select public.vixo_admin_set_account_status(%L::uuid,''pending'')',pg_temp.uid('staff')),'22023','invalid_account_status');
insert into vixo_approval_test values ('workspace',public.vixo_create_workspace('Approval rollback fixture'));
insert into vixo_approval_test values ('invite',public.vixo_create_invite((pg_temp.fixture('workspace')->>'id')::uuid));
insert into vixo_approval_test values ('owner_asset',public.vixo_save_asset(p_slug=>'approval-owner',p_title=>'Owner private',p_bundle=>pg_temp.bundle()));
insert into vixo_approval_test values ('team_asset',public.vixo_save_asset(p_slug=>'approval-team',p_title=>'Team private',p_bundle=>pg_temp.bundle(),p_workspace_id=>(pg_temp.fixture('workspace')->>'id')::uuid));
insert into vixo_approval_test values ('owner_device',public.vixo_create_device_code());
select pg_temp.assert_true(public.vixo_admin_set_account_status(pg_temp.uid('staff'),'approved')->>'status'='approved','administrator can approve a pending colleague');
select set_config('request.jwt.claim.sub',pg_temp.uid('staff')::text,true);
select pg_temp.assert_true(public.vixo_my_access()->>'isAdmin'='false','metadata cannot make approved colleague an administrator');
select pg_temp.expect_error('select public.vixo_admin_list_accounts()','PT403','admin_required');
select pg_temp.expect_error(format('select public.vixo_admin_set_account_status(%L::uuid,''approved'')',pg_temp.uid('pending')),'PT403','admin_required');
insert into vixo_approval_test values ('staff_asset',public.vixo_save_asset(p_slug=>'approval-staff',p_title=>'Staff private',p_bundle=>pg_temp.bundle()));
select public.vixo_join_workspace(pg_temp.fixture('invite')->>'code');
select pg_temp.assert_true((select count(*)=1 from public.vixo_assets where id=(pg_temp.fixture('team_asset')->>'id')::uuid),'approved member can still read team asset');
select set_config('request.jwt.claim.sub',pg_temp.uid('owner')::text,true);
select pg_temp.assert_true((select count(*)=0 from public.vixo_assets where id=(pg_temp.fixture('staff_asset')->>'id')::uuid),'administrator cannot read another user private asset');
select pg_temp.assert_true((select count(*)=0 from public.vixo_asset_revisions where asset_id=(pg_temp.fixture('staff_asset')->>'id')::uuid),'administrator cannot read private revision bundles');
reset role;

-- A pending identity can have inherited ownership/membership, yet every cloud
-- data read and every old business RPC remains gated.
insert into public.vixo_assets(owner_id,kind,slug,title,bundle,revision) values(pg_temp.uid('pending'),'agent','approval-pending','Pending inherited',pg_temp.bundle(),1);
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
insert into vixo_approval_test values ('pending_join',public.vixo_claim_invite(pg_temp.fixture('invite')->>'code',pg_temp.uid('pending')));
select pg_temp.assert_true(pg_temp.fixture('pending_join')='{"joined":true}'::jsonb,'pending invite response contains no workspace or bundle data');
select pg_temp.expect_error(format('select public.vixo_claim_invite(%L,%L::uuid)',pg_temp.fixture('invite')->>'code',pg_temp.uid('disabled')),'PT403','account_disabled');
insert into vixo_approval_test values ('pending_bind',public.vixo_begin_account_bind(pg_temp.uid('bind_pending'),
  'bind_'||substr(replace(pg_temp.uid('bind_pending')::text,'-',''),1,20)));
select pg_temp.assert_true(pg_temp.fixture('pending_bind')->>'claim_id' is not null,'pending identity can set first credentials');
select public.vixo_release_account_bind(pg_temp.uid('bind_pending'),(pg_temp.fixture('pending_bind')->>'claim_id')::uuid);
select pg_temp.expect_error(format('select public.vixo_begin_account_bind(%L::uuid,''disabled_name'')',pg_temp.uid('disabled')),'PT403','account_disabled');
reset role;
insert into vixo_approval_test values ('pending_device',jsonb_build_object('code',encode(extensions.gen_random_bytes(32),'hex'))),
  ('disabled_device',jsonb_build_object('code',encode(extensions.gen_random_bytes(32),'hex'))),('bootstrap',jsonb_build_object('code',encode(extensions.gen_random_bytes(32),'hex')));
insert into public.vixo_device_codes(code_hash,user_id,expires_at) values
  (encode(extensions.digest(pg_temp.fixture('pending_device')->>'code','sha256'),'hex'),pg_temp.uid('pending'),clock_timestamp()+interval '10 minutes'),
  (encode(extensions.digest(pg_temp.fixture('disabled_device')->>'code','sha256'),'hex'),pg_temp.uid('disabled'),clock_timestamp()+interval '10 minutes'),
  (encode(extensions.digest(pg_temp.fixture('bootstrap')->>'code','sha256'),'hex'),null,clock_timestamp()+interval '10 minutes');
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.assert_true(public.vixo_claim_device_code(pg_temp.fixture('pending_device')->>'code')->>'user_id'=pg_temp.uid('pending')::text,'pending existing device can obtain identity without approval');
select pg_temp.assert_true(public.vixo_claim_device_code(pg_temp.fixture('bootstrap')->>'code')->'user_id'='null'::jsonb,'new bootstrap still allows initial pending identity');
select pg_temp.expect_error(format('select public.vixo_claim_device_code(%L)',pg_temp.fixture('disabled_device')->>'code'),'PT403','account_disabled');
reset role;
select pg_temp.assert_true((select claimed_at is null from public.vixo_device_codes where code_hash=encode(extensions.digest(pg_temp.fixture('disabled_device')->>'code','sha256'),'hex')),'disabled code rejection leaves capability unconsumed');

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',pg_temp.uid('pending')::text,true);
select pg_temp.assert_true(public.vixo_my_access()->>'status'='pending' and public.vixo_my_access()->>'isAdmin'='false','pending can view only own true approval state');
select pg_temp.expect_error('select public.vixo_admin_list_accounts()','PT403','admin_required');
select pg_temp.expect_error('update public.vixo_account_access set status=''approved'',is_admin=true','42501');
select pg_temp.business_blocked('account_pending');
select pg_temp.assert_true((select count(*)=0 from public.vixo_assets),'pending reads zero assets even inherited own or joined team');
select pg_temp.assert_true((select count(*)=0 from public.vixo_asset_revisions),'pending reads zero revision bundles');
select pg_temp.assert_true((select count(*)=0 from public.vixo_workspaces),'pending reads zero joined workspaces');
select pg_temp.assert_true((select count(*)=0 from public.vixo_members),'pending reads zero memberships');
select set_config('request.jwt.claim.sub',pg_temp.uid('disabled')::text,true);
select pg_temp.assert_true(public.vixo_my_access()->>'status'='disabled','disabled can view own state for UI recovery');
select pg_temp.business_blocked('account_disabled');
select pg_temp.assert_true((select count(*)=0 from public.vixo_assets),'disabled reads zero assets');
select pg_temp.expect_error('select public.vixo_claim_registration_quota(null)','42501');
select set_config('request.jwt.claim.sub',pg_temp.uid('owner')::text,true);
select public.vixo_admin_set_account_status(pg_temp.uid('staff'),'disabled');
select set_config('request.jwt.claim.sub',pg_temp.uid('staff')::text,true);
select pg_temp.business_blocked('account_disabled');
select pg_temp.assert_true((select count(*)=0 from public.vixo_assets),'revocation blocks same existing JWT identity immediately on next request');
select pg_temp.assert_true((select count(*)=0 from public.vixo_asset_revisions),'revocation blocks old private and team revisions');
select set_config('request.jwt.claim.sub',pg_temp.uid('owner')::text,true);
select public.vixo_admin_set_account_status(pg_temp.uid('staff'),'approved');
select set_config('request.jwt.claim.sub',pg_temp.uid('staff')::text,true);
select pg_temp.assert_true((select count(*)=1 from public.vixo_assets where id=(pg_temp.fixture('staff_asset')->>'id')::uuid),'reapproval restores the same UUID original private asset');
select pg_temp.assert_true((select owner_id=pg_temp.uid('staff') and revision=1 from public.vixo_assets where id=(pg_temp.fixture('staff_asset')->>'id')::uuid),'approval never rewrites asset owner or revision');
reset role;
select pg_temp.assert_true((select count(*)=3 and bool_and(actor_id=pg_temp.uid('owner')) from public.vixo_account_access_audit where user_id=pg_temp.uid('staff')),'approve disable reapprove append three trusted-actor audit rows');
select pg_temp.expect_error(format('update public.vixo_account_access_audit set new_status=''disabled'' where user_id=%L::uuid',pg_temp.uid('staff')),'42501','account_audit_immutable');
select pg_temp.expect_error(format('delete from public.vixo_account_access_audit where user_id=%L::uuid',pg_temp.uid('staff')),'42501','account_audit_immutable');
select pg_temp.assert_true((select count(*)=0 from public.vixo_assets where slug='blocked-fixture'),'denied RPCs never create an asset');

rollback;
