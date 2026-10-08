begin;

create temporary table vixo_account_test (key text primary key, value jsonb not null);
grant select, insert, update on vixo_account_test to anon, authenticated, service_role;
insert into vixo_account_test values ('device',to_jsonb(gen_random_uuid())),
  ('other',to_jsonb(gen_random_uuid())), ('bound',to_jsonb(gen_random_uuid())), ('nondevice',to_jsonb(gen_random_uuid()));
insert into auth.users(id,email,raw_app_meta_data)
  select (value #>> '{}')::uuid, (value #>> '{}') || '@devices.vixo.invalid', '{"vixo_device_identity":true}'::jsonb from vixo_account_test;
update auth.users set email='taken_' || substr(replace(id::text,'-',''),1,20) || '@accounts.vixo.invalid',
  raw_app_meta_data='{"vixo_device_identity":true,"vixo_username":"already_bound"}'::jsonb
  where id=(select (value #>> '{}')::uuid from vixo_account_test where key='bound');
update auth.users set raw_app_meta_data='{}'::jsonb
  where id=(select (value #>> '{}')::uuid from vixo_account_test where key='nondevice');
insert into vixo_account_test values ('username',to_jsonb('test_' || substr(replace(gen_random_uuid()::text,'-',''),1,20)));
create function pg_temp.fixture(p_key text) returns jsonb language sql stable as $$
  select value from pg_temp.vixo_account_test where key=p_key
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

select pg_temp.assert_true((select relrowsecurity from pg_class where oid='public.vixo_account_bind_claims'::regclass),'claims enable RLS');
select pg_temp.assert_true(not has_table_privilege('anon','public.vixo_account_bind_claims','SELECT')
  and not has_table_privilege('authenticated','public.vixo_account_bind_claims','SELECT'),'no client can read claims');
select pg_temp.assert_true(has_table_privilege('service_role','public.vixo_account_bind_claims','SELECT')
  and not has_table_privilege('service_role','public.vixo_account_bind_claims','INSERT')
  and not has_table_privilege('service_role','public.vixo_account_bind_claims','UPDATE')
  and not has_table_privilege('service_role','public.vixo_account_bind_claims','DELETE'),'service reads only, mutations require RPC');
select pg_temp.assert_true(not has_function_privilege('anon','public.vixo_begin_account_bind(uuid,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.vixo_begin_account_bind(uuid,text)','EXECUTE')
  and has_function_privilege('service_role','public.vixo_begin_account_bind(uuid,text)','EXECUTE'),'begin is service-only');
select pg_temp.assert_true(not has_function_privilege('anon','public.vixo_release_account_bind(uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.vixo_release_account_bind(uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.vixo_release_account_bind(uuid,uuid)','EXECUTE'),'release is service-only');
select pg_temp.assert_true((select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
  where oid in ('public.vixo_begin_account_bind(uuid,text)'::regprocedure,'public.vixo_release_account_bind(uuid,uuid)'::regprocedure)),'definers have empty search_path');

set local role anon;
select pg_temp.expect_error('select * from public.vixo_account_bind_claims','42501');
select pg_temp.expect_error('select public.vixo_begin_account_bind(null,''fixture_user'')','42501');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.expect_error('select public.vixo_release_account_bind(null,null)','42501');
reset role;

-- ACL and the function's explicit auth.role check are separate defenses.
set local role service_role;
select pg_temp.expect_error('select public.vixo_begin_account_bind(null,''fixture_user'')','42501','service_role_required');
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.expect_error(format('select public.vixo_begin_account_bind(%L::uuid,''with.dot'')',pg_temp.fixture('device') #>> '{}'),'22023','invalid_username');
select pg_temp.expect_error(format('select public.vixo_begin_account_bind(%L::uuid,''fixture_user'')',pg_temp.fixture('bound') #>> '{}'),'PT409','account_already_bound');
select pg_temp.expect_error(format('select public.vixo_begin_account_bind(%L::uuid,''fixture_user'')',pg_temp.fixture('nondevice') #>> '{}'),'PT409','account_already_bound');
select pg_temp.expect_error(format('select public.vixo_begin_account_bind(%L::uuid,%L)',pg_temp.fixture('device') #>> '{}',
  'taken_' || substr(replace(pg_temp.fixture('bound') #>> '{}','-',''),1,20)),'PT409','username_unavailable');
insert into vixo_account_test values ('claim',public.vixo_begin_account_bind((pg_temp.fixture('device') #>> '{}')::uuid,pg_temp.fixture('username') #>> '{}'));
select pg_temp.assert_true((select username=pg_temp.fixture('username') #>> '{}' and original_email=(pg_temp.fixture('device') #>> '{}') || '@devices.vixo.invalid'
  from public.vixo_account_bind_claims where user_id=(pg_temp.fixture('device') #>> '{}')::uuid),'claim retains original identity and requested username');
select pg_temp.expect_error(format('select public.vixo_begin_account_bind(%L::uuid,''different_user'')',pg_temp.fixture('device') #>> '{}'),'PT409','account_bind_in_progress');
select pg_temp.expect_error(format('select public.vixo_begin_account_bind(%L::uuid,%L)',pg_temp.fixture('other') #>> '{}',pg_temp.fixture('username') #>> '{}'),'PT409','username_unavailable');
select pg_temp.expect_error(format('select public.vixo_release_account_bind(%L::uuid,%L::uuid)',pg_temp.fixture('other') #>> '{}',pg_temp.fixture('claim')->>'claim_id'),'PT409','account_claim_mismatch');
select pg_temp.assert_true((select count(*)=1 from public.vixo_account_bind_claims where user_id=(pg_temp.fixture('device') #>> '{}')::uuid),'failed begin or foreign release leaves claim intact');
select pg_temp.assert_true(public.vixo_release_account_bind((pg_temp.fixture('device') #>> '{}')::uuid,(pg_temp.fixture('claim')->>'claim_id')::uuid)->>'released'='true','definite unchanged failure can release');
select pg_temp.assert_true((select count(*)=0 from public.vixo_account_bind_claims where user_id=(pg_temp.fixture('device') #>> '{}')::uuid),'released claim removed');
update vixo_account_test set value=public.vixo_begin_account_bind((pg_temp.fixture('device') #>> '{}')::uuid,pg_temp.fixture('username') #>> '{}') where key='claim';
reset role;

-- Simulate the Auth-owned email/metadata transition, without any password.
update auth.users set email=(pg_temp.fixture('username') #>> '{}') || '@accounts.vixo.invalid',
  raw_app_meta_data=jsonb_build_object('vixo_device_identity',true,'vixo_username',pg_temp.fixture('username') #>> '{}')
  where id=(pg_temp.fixture('device') #>> '{}')::uuid;
set local role service_role;
select pg_temp.expect_error(format('select public.vixo_release_account_bind(%L::uuid,%L::uuid)',pg_temp.fixture('device') #>> '{}',pg_temp.fixture('claim')->>'claim_id'),'PT409','account_already_bound');
select pg_temp.expect_error(format('select public.vixo_begin_account_bind(%L::uuid,''another_user'')',pg_temp.fixture('device') #>> '{}'),'PT409','account_already_bound');
select pg_temp.assert_true((select count(*)=1 from public.vixo_account_bind_claims where user_id=(pg_temp.fixture('device') #>> '{}')::uuid),'completed claim remains durable');
reset role;

rollback;
