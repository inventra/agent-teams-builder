begin;

create temporary table vixo_cas_test (key text primary key, value jsonb not null);
grant select, insert, update on vixo_cas_test to authenticated;
insert into vixo_cas_test values ('owner',to_jsonb(gen_random_uuid()));
insert into auth.users(id) select (value #>> '{}')::uuid from vixo_cas_test;
create function pg_temp.fixture(p_key text) returns jsonb language sql stable as $$
  select value from pg_temp.vixo_cas_test where key=p_key
$$;
create function pg_temp.bundle() returns jsonb language sql as $$
  select jsonb_build_object('formatVersion',1,'kind','agent','spec','{}'::jsonb,'files','[]'::jsonb,'dependencies','[]'::jsonb,'requirements','{}'::jsonb)
$$;
create function pg_temp.assert_true(p_condition boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_condition is distinct from true then raise exception 'assertion_failed: %',p_message; end if;
end $$;
create function pg_temp.expect_http_conflict(p_sql text)
returns void language plpgsql as $$
declare v_state text; v_message text;
begin
  begin execute p_sql;
  exception when others then
    get stacked diagnostics v_state=returned_sqlstate,v_message=message_text;
    if v_state <> 'PT409' or v_message <> 'revision_conflict' then
      raise exception 'expected PT409/revision_conflict; got %/%',v_state,v_message;
    end if;
    return;
  end;
  raise exception 'expected PT409, command succeeded';
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',pg_temp.fixture('owner') #>> '{}',true);
insert into vixo_cas_test values ('v1',public.vixo_save_asset(p_slug=>'cas-fixture',p_title=>'First',p_bundle=>pg_temp.bundle()));
insert into vixo_cas_test values ('v2',public.vixo_save_asset(p_id=>(pg_temp.fixture('v1')->>'id')::uuid,p_slug=>'cas-fixture',p_title=>'Second',p_bundle=>pg_temp.bundle(),p_expected_revision=>1));
select pg_temp.expect_http_conflict(format('select public.vixo_save_asset(p_id=>%L::uuid,p_slug=>''cas-fixture'',p_title=>''Stale'',p_bundle=>pg_temp.bundle(),p_expected_revision=>1)',pg_temp.fixture('v1')->>'id'));
select pg_temp.expect_http_conflict('select public.vixo_save_asset(p_slug=>''bad-insert-revision'',p_title=>''Conflict'',p_bundle=>pg_temp.bundle(),p_expected_revision=>1)');
select pg_temp.assert_true((select revision=2 and title='Second' from public.vixo_assets where id=(pg_temp.fixture('v1')->>'id')::uuid),'stale write does not change latest asset');
select pg_temp.assert_true((select count(*)=2 from public.vixo_asset_revisions where asset_id=(pg_temp.fixture('v1')->>'id')::uuid),'stale write does not append revision');
select pg_temp.assert_true((select count(*)=0 from public.vixo_assets where slug='bad-insert-revision'),'conflicting create does not insert asset');
reset role;
select pg_temp.assert_true(has_function_privilege('authenticated','public.vixo_save_asset(uuid,text,text,text,text,jsonb,uuid,integer,text)','EXECUTE')
  and not has_function_privilege('anon','public.vixo_save_asset(uuid,text,text,text,text,jsonb,uuid,integer,text)','EXECUTE')
  and not has_function_privilege('service_role','public.vixo_save_asset(uuid,text,text,text,text,jsonb,uuid,integer,text)','EXECUTE'),'forward migration preserves authenticated-only RPC access');

rollback;
