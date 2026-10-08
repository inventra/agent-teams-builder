begin;

create temporary table vixo_hardening_test (key text primary key, value jsonb not null);
grant select, insert, update on vixo_hardening_test to authenticated, service_role;
insert into vixo_hardening_test values ('owner', to_jsonb(gen_random_uuid())), ('member', to_jsonb(gen_random_uuid()));
insert into auth.users(id) select (value #>> '{}')::uuid from vixo_hardening_test;
create function pg_temp.fixture(p_key text) returns jsonb language sql stable as $$
  select value from pg_temp.vixo_hardening_test where key = p_key
$$;
create function pg_temp.assert_true(p_condition boolean, p_message text)
returns void language plpgsql as $$ begin
  if p_condition is distinct from true then raise exception 'assertion_failed: %', p_message; end if;
end $$;
create function pg_temp.expect_error(p_sql text, p_state text, p_message text)
returns void language plpgsql as $$
declare v_state text; v_message text;
begin
  begin execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    if v_state <> p_state or v_message <> p_message then
      raise exception 'expected %/%; got %/%', p_state, p_message, v_state, v_message;
    end if;
    return;
  end;
  raise exception 'expected SQLSTATE %, command succeeded', p_state;
end $$;
create function pg_temp.bundle(p_files integer) returns jsonb language sql as $$
  select jsonb_build_object('formatVersion',1,'kind','agent','spec','{}'::jsonb,
    'files',(select jsonb_agg(jsonb_build_object('path','file-'||i,'content','')) from generate_series(1,p_files) i),
    'dependencies','[]'::jsonb,'requirements','{}'::jsonb)
$$;

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', pg_temp.fixture('owner') #>> '{}', true);
insert into vixo_hardening_test values ('workspace', public.vixo_create_workspace('Runtime hardening rollback fixture'));
insert into vixo_hardening_test values ('invite', public.vixo_create_invite((pg_temp.fixture('workspace')->>'id')::uuid));
insert into vixo_hardening_test values ('device', public.vixo_create_device_code());
insert into vixo_hardening_test values ('boundary_bundle', public.vixo_save_asset(p_slug=>'thousand-files',p_title=>'Boundary fixture',p_bundle=>pg_temp.bundle(1000)));
select pg_temp.assert_true((pg_temp.fixture('boundary_bundle')->>'revision')::integer=1, '1000 files are accepted');
select pg_temp.expect_error('select public.vixo_save_asset(p_slug=>''too-many-files'',p_title=>''Rejected'',p_bundle=>pg_temp.bundle(1001))', '22023', 'too_many_bundle_files');

reset role;
-- These expire AFTER the transaction started but BEFORE either claim. Using
-- transaction-stable now() here would incorrectly accept both capabilities.
update public.vixo_invites set expires_at=clock_timestamp()+interval '20 milliseconds'
where hash=encode(extensions.digest(pg_temp.fixture('invite')->>'code','sha256'),'hex');
update public.vixo_device_codes set expires_at=clock_timestamp()+interval '20 milliseconds'
where code_hash=encode(extensions.digest(pg_temp.fixture('device')->>'code','sha256'),'hex');
select pg_sleep(0.04);

set local role authenticated;
select set_config('request.jwt.claim.sub', pg_temp.fixture('member') #>> '{}', true);
select pg_temp.expect_error(format('select public.vixo_join_workspace(%L)', pg_temp.fixture('invite')->>'code'), '22023', 'invalid_or_expired_invite');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.expect_error(format('select public.vixo_claim_invite(%L,%L::uuid)', pg_temp.fixture('invite')->>'code', pg_temp.fixture('member') #>> '{}'), '22023', 'invalid_or_expired_invite');
select pg_temp.expect_error(format('select public.vixo_claim_device_code(%L)', pg_temp.fixture('device')->>'code'), '22023', 'invalid_or_expired_device_code');

reset role;
select pg_temp.assert_true((select uses=0 from public.vixo_invites where hash=encode(extensions.digest(pg_temp.fixture('invite')->>'code','sha256'),'hex')), 'expired invite is unconsumed');
select pg_temp.assert_true((select claimed_at is null from public.vixo_device_codes where code_hash=encode(extensions.digest(pg_temp.fixture('device')->>'code','sha256'),'hex')), 'expired device is unconsumed');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.vixo_claim_device_code(text)','EXECUTE'), 'hardening preserves service-only device claim');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.vixo_claim_invite(text,uuid)','EXECUTE'), 'hardening preserves service-only invite claim');
select pg_temp.assert_true(not has_function_privilege('service_role','public.vixo_save_asset(uuid,text,text,text,text,jsonb,uuid,integer,text)','EXECUTE'), 'hardening preserves authenticated-only asset writes');
select pg_temp.assert_true(coalesce((select bool_and(
  not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
  and not exists (select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='rls_auto_enable' and p.prorettype='event_trigger'::regtype),true), 'platform event-trigger helper is not client-callable when present');

rollback;
