begin;

-- All identities, workspaces, assets, invite codes and assertions disappear
-- at ROLLBACK. No SMTP, real credentials, or external service is involved.
create temporary table vixo_test_data (key text primary key, value jsonb not null);
grant select, insert, update on vixo_test_data to authenticated, anon;
insert into vixo_test_data values
  ('alice', to_jsonb(pg_catalog.gen_random_uuid())),
  ('bob', to_jsonb(pg_catalog.gen_random_uuid())),
  ('editor', to_jsonb(pg_catalog.gen_random_uuid()));
insert into auth.users(id) select (value #>> '{}')::uuid from vixo_test_data;

create function pg_temp.fixture(p_key text) returns jsonb language sql stable as $$
  select value from pg_temp.vixo_test_data where key = p_key
$$;
create function pg_temp.user_id(p_key text) returns uuid language sql stable as $$
  select (pg_temp.fixture(p_key) #>> '{}')::uuid
$$;
create function pg_temp.bundle(p_kind text default 'agent', p_content text default 'fixture')
returns jsonb language sql as $$
  select pg_catalog.jsonb_build_object('formatVersion', 1, 'kind', p_kind,
    'spec', pg_catalog.jsonb_build_object('id', 'fixture'),
    'files', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('path', 'SKILL.md', 'content', p_content)),
    'dependencies', '[]'::jsonb, 'requirements', '{}'::jsonb)
$$;
create function pg_temp.assert_true(p_condition boolean, p_message text)
returns void language plpgsql as $$ begin
  if p_condition is distinct from true then raise exception 'assertion_failed: %', p_message; end if;
end $$;
create function pg_temp.expect_error(p_sql text, p_state text, p_message text default null)
returns void language plpgsql as $$
declare v_state text; v_message text;
begin
  begin execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    if not (v_state = any(string_to_array(p_state, '|'))) or (p_message is not null and v_message <> p_message) then
      raise exception 'expected %/%; got %/%', p_state, p_message, v_state, v_message;
    end if;
    return;
  end;
  raise exception 'expected SQLSTATE %, command succeeded', p_state;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', pg_temp.user_id('alice')::text, true);
insert into vixo_test_data values ('workspace', public.vixo_create_workspace('VIXO rollback fixture'));
insert into vixo_test_data values ('viewer_invite', public.vixo_create_invite((pg_temp.fixture('workspace')->>'id')::uuid));
insert into vixo_test_data values ('editor_invite', public.vixo_create_invite((pg_temp.fixture('workspace')->>'id')::uuid, 'editor'));
insert into vixo_test_data values ('alice_private', public.vixo_save_asset(
  p_slug => 'alice-private', p_title => 'Alice private', p_bundle => pg_temp.bundle()));
insert into vixo_test_data values ('team_asset', public.vixo_save_asset(
  p_slug => 'team-agent', p_title => 'Version one', p_bundle => pg_temp.bundle(),
  p_workspace_id => (pg_temp.fixture('workspace')->>'id')::uuid));
select pg_temp.assert_true((pg_temp.fixture('viewer_invite')->>'code') ~ '^[a-f0-9]{64}$', 'invite has 256-bit code');
select pg_temp.expect_error('select * from public.vixo_invites', '42501');
select pg_temp.expect_error('update public.vixo_assets set title = ''bypass''', '42501');
select pg_temp.expect_error('delete from public.vixo_asset_revisions', '42501');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_remove_member(%L::uuid,%L::uuid)',
  pg_temp.fixture('workspace')->>'id', pg_temp.user_id('alice')), '22023', 'cannot_remove_owner');

select set_config('request.jwt.claim.sub', pg_temp.user_id('bob')::text, true);
insert into vixo_test_data values ('bob_private', public.vixo_save_asset(
  p_slug => 'bob-private', p_title => 'Bob private', p_bundle => pg_temp.bundle()));
select pg_temp.assert_true((select count(*) = 0 from public.vixo_assets where id = (pg_temp.fixture('alice_private')->>'id')::uuid), 'Bob cannot read Alice private asset');
select pg_temp.assert_true((select count(*) = 0 from public.vixo_asset_revisions where asset_id = (pg_temp.fixture('alice_private')->>'id')::uuid), 'Bob cannot read Alice private revisions');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_save_asset(p_id=>%L::uuid,p_slug=>''alice-private'',p_title=>''forbidden'',p_bundle=>pg_temp.bundle(),p_expected_revision=>1)',
  pg_temp.fixture('alice_private')->>'id'), '42501', 'asset_write_forbidden');
select pg_temp.assert_true((select count(*) = 0 from public.vixo_workspaces), 'nonmember cannot read workspace');
select public.vixo_join_workspace(pg_temp.fixture('viewer_invite')->>'code');
select public.vixo_join_workspace(pg_temp.fixture('viewer_invite')->>'code');
select public.vixo_join_workspace(pg_temp.fixture('editor_invite')->>'code');
select pg_temp.assert_true((select role = 'viewer' from public.vixo_members where user_id = pg_temp.user_id('bob')), 'repeated or stronger invite does not elevate existing viewer');
select pg_temp.assert_true((select count(*) = 1 from public.vixo_workspaces), 'viewer can read workspace');
select pg_temp.assert_true((select count(*) = 1 from public.vixo_assets where id = (pg_temp.fixture('team_asset')->>'id')::uuid), 'viewer can read team asset');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_create_invite(%L::uuid)', pg_temp.fixture('workspace')->>'id'), '42501', 'workspace_owner_required');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_save_asset(p_slug=>''viewer-new'',p_title=>''forbidden'',p_bundle=>pg_temp.bundle(),p_workspace_id=>%L::uuid)',
  pg_temp.fixture('workspace')->>'id'), '42501', 'asset_write_forbidden');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_save_asset(p_id=>%L::uuid,p_slug=>''team-agent'',p_title=>''forbidden'',p_bundle=>pg_temp.bundle(),p_workspace_id=>%L::uuid,p_expected_revision=>1)',
  pg_temp.fixture('team_asset')->>'id', pg_temp.fixture('workspace')->>'id'), '42501', 'asset_write_forbidden');

select set_config('request.jwt.claim.sub', pg_temp.user_id('alice')::text, true);
select pg_temp.assert_true((select count(*) = 0 from public.vixo_assets where id = (pg_temp.fixture('bob_private')->>'id')::uuid), 'Alice cannot read Bob private asset');
select pg_temp.assert_true((select count(*) = 0 from public.vixo_asset_revisions where asset_id = (pg_temp.fixture('bob_private')->>'id')::uuid), 'Alice cannot read Bob private revisions');

select set_config('request.jwt.claim.sub', pg_temp.user_id('editor')::text, true);
select public.vixo_join_workspace(pg_temp.fixture('editor_invite')->>'code');
insert into vixo_test_data values ('editor_asset', public.vixo_save_asset(
  p_slug => 'editor-created', p_title => 'Editor created', p_bundle => pg_temp.bundle(),
  p_workspace_id => (pg_temp.fixture('workspace')->>'id')::uuid));
insert into vixo_test_data values ('team_v2', public.vixo_save_asset(
  p_id => (pg_temp.fixture('team_asset')->>'id')::uuid, p_slug => 'team-agent', p_title => 'Version two',
  p_bundle => pg_temp.bundle('agent', 'version two'), p_workspace_id => (pg_temp.fixture('workspace')->>'id')::uuid,
  p_expected_revision => 1, p_message => 'editor update'));
select pg_temp.assert_true((pg_temp.fixture('team_v2')->>'revision')::integer = 2, 'editor writes second revision');
select pg_temp.assert_true((pg_temp.fixture('team_v2')->>'owner_id')::uuid = pg_temp.user_id('alice'), 'editor update preserves owner');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_save_asset(p_id=>%L::uuid,p_slug=>''team-agent'',p_title=>''stale'',p_bundle=>pg_temp.bundle(),p_workspace_id=>%L::uuid,p_expected_revision=>1)',
  pg_temp.fixture('team_asset')->>'id', pg_temp.fixture('workspace')->>'id'), '40001|PT409', 'revision_conflict');
select pg_temp.assert_true((select count(*) = 2 from public.vixo_asset_revisions where asset_id = (pg_temp.fixture('team_asset')->>'id')::uuid), 'conflict does not append revision');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_save_asset(p_id=>%L::uuid,p_kind=>''workflow'',p_slug=>''team-agent'',p_title=>''scope change'',p_bundle=>pg_temp.bundle(''workflow''),p_workspace_id=>%L::uuid,p_expected_revision=>2)',
  pg_temp.fixture('team_asset')->>'id', pg_temp.fixture('workspace')->>'id'), '22023', 'immutable_asset_scope');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_save_asset(p_id=>%L::uuid,p_slug=>''team-agent'',p_title=>''scope change'',p_bundle=>pg_temp.bundle(),p_expected_revision=>2)',
  pg_temp.fixture('team_asset')->>'id'), '22023', 'immutable_asset_scope');
insert into vixo_test_data values ('team_restored', public.vixo_save_asset(
  p_id => (pg_temp.fixture('team_asset')->>'id')::uuid, p_slug => 'team-agent', p_title => 'Restored version one',
  p_bundle => (select bundle from public.vixo_asset_revisions where asset_id = (pg_temp.fixture('team_asset')->>'id')::uuid and revision = 1),
  p_workspace_id => (pg_temp.fixture('workspace')->>'id')::uuid, p_expected_revision => 2, p_message => 'restore revision one'));
select pg_temp.assert_true((pg_temp.fixture('team_restored')->>'revision')::integer = 3, 'restore appends revision instead of rewriting history');
select pg_temp.assert_true((select title = 'Version one' from public.vixo_asset_revisions where asset_id = (pg_temp.fixture('team_asset')->>'id')::uuid and revision = 1), 'old revision remains unchanged');

select pg_temp.expect_error('select public.vixo_save_asset(p_slug=>''bad-bundle'',p_title=>''bad'',p_bundle=>''{}''::jsonb)', '22023', 'invalid_bundle');
select pg_temp.expect_error('select public.vixo_save_asset(p_slug=>''bad-kind'',p_title=>''bad'',p_bundle=>pg_temp.bundle(''workflow''))', '22023', 'invalid_bundle');
select pg_temp.expect_error('select public.vixo_save_asset(p_slug=>''too-large'',p_title=>''bad'',p_bundle=>pg_temp.bundle(''agent'',repeat(''x'',5242880)))', '22023', 'invalid_bundle');
select pg_temp.expect_error('select public.vixo_save_asset(p_slug=>''traversal'',p_title=>''bad'',p_bundle=>jsonb_set(pg_temp.bundle(),''{files,0,path}'',''"../escape"''::jsonb))', '22023', 'invalid_bundle_path');
select pg_temp.expect_error('select public.vixo_save_asset(p_slug=>''duplicate-path'',p_title=>''bad'',p_bundle=>jsonb_set(pg_temp.bundle(),''{files}'',(pg_temp.bundle()->''files'')||(pg_temp.bundle()->''files'')))', '22023', 'invalid_bundle_path');
select pg_temp.expect_error('select public.vixo_save_asset(p_slug=>''too-many-files'',p_title=>''bad'',p_bundle=>jsonb_set(pg_temp.bundle(),''{files}'',(select jsonb_agg(jsonb_build_object(''path'',''file-''||i,''content'','''')) from generate_series(1,1001) i)))', '22023', 'too_many_bundle_files');

select set_config('request.jwt.claim.sub', pg_temp.user_id('alice')::text, true);
select public.vixo_remove_member((pg_temp.fixture('workspace')->>'id')::uuid, pg_temp.user_id('editor'));
select set_config('request.jwt.claim.sub', pg_temp.user_id('editor')::text, true);
select pg_temp.assert_true((select count(*) = 0 from public.vixo_workspaces), 'removed member loses workspace read');
select pg_temp.assert_true((select count(*) = 0 from public.vixo_members), 'removed member loses membership read');
select pg_temp.assert_true((select count(*) = 0 from public.vixo_assets where workspace_id = (pg_temp.fixture('workspace')->>'id')::uuid), 'removed creator loses own and other team asset read');
select pg_temp.assert_true((select count(*) = 0 from public.vixo_asset_revisions where asset_id = (pg_temp.fixture('team_asset')->>'id')::uuid), 'removed member loses revision read');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_save_asset(p_id=>%L::uuid,p_slug=>''editor-created'',p_title=>''revoked'',p_bundle=>pg_temp.bundle(),p_workspace_id=>%L::uuid,p_expected_revision=>1)',
  pg_temp.fixture('editor_asset')->>'id', pg_temp.fixture('workspace')->>'id'), '42501', 'asset_write_forbidden');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_remove_member(%L::uuid,%L::uuid)',
  pg_temp.fixture('workspace')->>'id', pg_temp.user_id('bob')), '42501', 'workspace_owner_required');

select set_config('request.jwt.claim.sub', '', true);
select pg_temp.expect_error('select public.vixo_create_workspace(''missing identity'')', '42501', 'authentication_required');
set local role anon;
select pg_temp.expect_error('select * from public.vixo_workspaces', '42501');
select pg_temp.expect_error('select * from public.vixo_members', '42501');
select pg_temp.expect_error('select * from public.vixo_invites', '42501');
select pg_temp.expect_error('select * from public.vixo_assets', '42501');
select pg_temp.expect_error('select * from public.vixo_asset_revisions', '42501');
select pg_temp.expect_error('select public.vixo_create_workspace(''anonymous'')', '42501');
select pg_temp.expect_error('select public.vixo_join_workspace(repeat(''0'',64))', '42501');

reset role;
select pg_temp.assert_true((select uses = 1 from public.vixo_invites where hash = encode(extensions.digest(pg_temp.fixture('viewer_invite')->>'code','sha256'),'hex')), 'repeat join does not consume invite uses');
select pg_temp.assert_true((select uses = 1 from public.vixo_invites where hash = encode(extensions.digest(pg_temp.fixture('editor_invite')->>'code','sha256'),'hex')), 'existing viewer was not upgraded or counted again');
select pg_temp.expect_error(pg_catalog.format('update public.vixo_asset_revisions set title=''tampered'' where asset_id=%L::uuid and revision=1', pg_temp.fixture('team_asset')->>'id'), '42501', 'immutable_revision');
select pg_temp.expect_error(pg_catalog.format('delete from public.vixo_asset_revisions where asset_id=%L::uuid', pg_temp.fixture('team_asset')->>'id'), '42501', 'immutable_revision');

select pg_temp.assert_true((select count(*) = 5 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('vixo_create_workspace','vixo_create_invite','vixo_join_workspace','vixo_remove_member','vixo_save_asset')
    and p.prosecdef and 'search_path=""' = any(p.proconfig)), 'all five public RPCs are security definer with fixed empty search_path');
select pg_temp.assert_true(not pg_catalog.has_table_privilege('authenticated','public.vixo_invites','SELECT'), 'invite table never client-readable');
select pg_temp.assert_true(not pg_catalog.has_table_privilege('authenticated','public.vixo_assets','INSERT,UPDATE,DELETE'), 'asset table client writes revoked');

rollback;
