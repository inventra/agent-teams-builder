begin;

create temporary table vixo_device_test (key text primary key, value jsonb not null);
grant select, insert, update on vixo_device_test to anon, authenticated, service_role;
insert into vixo_device_test values
  ('owner', to_jsonb(pg_catalog.gen_random_uuid())),
  ('member', to_jsonb(pg_catalog.gen_random_uuid())),
  ('extra', to_jsonb(pg_catalog.gen_random_uuid()));
insert into vixo_device_test values ('auth_count_before', to_jsonb((select count(*) from auth.users)));
insert into auth.users(id) select (value #>> '{}')::uuid from vixo_device_test where key in ('owner','member','extra');
create function pg_temp.fixture(p_key text) returns jsonb language sql stable as $$
  select value from pg_temp.vixo_device_test where key = p_key
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
    if v_state <> p_state or (p_message is not null and v_message <> p_message) then
      raise exception 'expected %/%; got %/%', p_state, p_message, v_state, v_message;
    end if;
    return;
  end;
  raise exception 'expected SQLSTATE %, command succeeded', p_state;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', pg_temp.fixture('owner') #>> '{}', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
insert into vixo_device_test values ('device', public.vixo_create_device_code());
insert into vixo_device_test values ('workspace', public.vixo_create_workspace('Device rollback fixture'));
insert into vixo_device_test values ('invite', public.vixo_create_invite((pg_temp.fixture('workspace')->>'id')::uuid));
insert into vixo_device_test values ('limited_invite', public.vixo_create_invite((pg_temp.fixture('workspace')->>'id')::uuid));
select pg_temp.assert_true((pg_temp.fixture('device')->>'code') ~ '^[a-f0-9]{64}$', 'device code has 256-bit entropy');
select pg_temp.assert_true((pg_temp.fixture('device')->>'expires_at')::timestamptz between clock_timestamp() + interval '9 minutes 59 seconds' and clock_timestamp() + interval '10 minutes', 'device TTL is ten minutes');
select pg_temp.expect_error('select * from public.vixo_device_codes', '42501');
select pg_temp.expect_error('insert into public.vixo_device_codes(code_hash,expires_at) values(repeat(''a'',64),now())', '42501');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_device_code(%L)', pg_temp.fixture('device')->>'code'), '42501');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_invite(%L,%L::uuid)', pg_temp.fixture('invite')->>'code', pg_temp.fixture('member') #>> '{}'), '42501');
select pg_temp.expect_error('select vixo_private.join_with_invite(repeat(''a'',64),gen_random_uuid())', '42501');
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.expect_error('select public.vixo_create_device_code()', '42501', 'authentication_required');

set local role anon;
select pg_temp.expect_error('select * from public.vixo_device_codes', '42501');
select pg_temp.expect_error('select public.vixo_create_device_code()', '42501');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_device_code(%L)', pg_temp.fixture('device')->>'code'), '42501');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_invite(%L,%L::uuid)', pg_temp.fixture('invite')->>'code', pg_temp.fixture('member') #>> '{}'), '42501');

reset role;
insert into vixo_device_test values ('bootstrap', jsonb_build_object('code', encode(extensions.gen_random_bytes(32),'hex')));
insert into vixo_device_test values ('expired', jsonb_build_object('code', encode(extensions.gen_random_bytes(32),'hex')));
insert into public.vixo_device_codes(code_hash,user_id,expires_at)
values (encode(extensions.digest(pg_temp.fixture('bootstrap')->>'code','sha256'),'hex'),null,now()+interval '10 minutes'),
  (encode(extensions.digest(pg_temp.fixture('expired')->>'code','sha256'),'hex'),null,now()-interval '1 second');
update public.vixo_invites set max_uses=1 where hash=encode(extensions.digest(pg_temp.fixture('limited_invite')->>'code','sha256'),'hex');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
insert into vixo_device_test values ('claimed_device', public.vixo_claim_device_code(pg_temp.fixture('device')->>'code'));
select pg_temp.assert_true((pg_temp.fixture('claimed_device')->>'user_id')::uuid = (pg_temp.fixture('owner') #>> '{}')::uuid, 'existing identity is inherited exactly');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_device_code(%L)', pg_temp.fixture('device')->>'code'), '22023', 'invalid_or_expired_device_code');
insert into vixo_device_test values ('claimed_bootstrap', public.vixo_claim_device_code(pg_temp.fixture('bootstrap')->>'code'));
select pg_temp.assert_true(pg_temp.fixture('claimed_bootstrap')->'user_id' = 'null'::jsonb, 'bootstrap returns null without creating an auth user');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_device_code(%L)', pg_temp.fixture('expired')->>'code'), '22023', 'invalid_or_expired_device_code');
select pg_temp.expect_error('update public.vixo_device_codes set claimed_at=null', '42501');
insert into vixo_device_test values ('joined', public.vixo_claim_invite(pg_temp.fixture('limited_invite')->>'code', (pg_temp.fixture('member') #>> '{}')::uuid));
select pg_temp.assert_true(pg_temp.fixture('joined')->>'id' = pg_temp.fixture('workspace')->>'id', 'service joins the requested new identity to the correct workspace');
select public.vixo_claim_invite(pg_temp.fixture('limited_invite')->>'code', (pg_temp.fixture('member') #>> '{}')::uuid);
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_invite(%L,%L::uuid)', pg_temp.fixture('limited_invite')->>'code', pg_temp.fixture('extra') #>> '{}'), '22023', 'invite_exhausted');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_invite(%L,%L::uuid)', pg_temp.fixture('invite')->>'code', gen_random_uuid()), '22023', 'invalid_user');
select pg_temp.expect_error('select public.vixo_claim_device_code(''bad code'')', '22023', 'invalid_device_code');
select set_config('request.jwt.claim.role', 'authenticated', true);
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_device_code(%L)', pg_temp.fixture('bootstrap')->>'code'), '42501', 'service_role_required');
select pg_temp.expect_error(pg_catalog.format('select public.vixo_claim_invite(%L,%L::uuid)', pg_temp.fixture('invite')->>'code', pg_temp.fixture('extra') #>> '{}'), '42501', 'service_role_required');

reset role;
select pg_temp.assert_true((select count(*) from auth.users) = (pg_temp.fixture('auth_count_before') #>> '{}')::integer + 3, 'claim RPCs never create auth identities');
select pg_temp.assert_true((select claimed_at is null from public.vixo_device_codes where code_hash=encode(extensions.digest(pg_temp.fixture('expired')->>'code','sha256'),'hex')), 'failed expired claim leaves code unconsumed');
select pg_temp.assert_true((select uses=1 from public.vixo_invites where hash=encode(extensions.digest(pg_temp.fixture('limited_invite')->>'code','sha256'),'hex')), 'capacity never exceeded and repeat claim does not consume it');
select pg_temp.assert_true((select role='viewer' from public.vixo_members where workspace_id=(pg_temp.fixture('workspace')->>'id')::uuid and user_id=(pg_temp.fixture('member') #>> '{}')::uuid), 'service claim preserves invite role');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.vixo_claim_device_code(text)','EXECUTE'), 'device claim is not client callable');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.vixo_claim_invite(text,uuid)','EXECUTE'), 'invite claim is not client callable');
select pg_temp.assert_true(not has_function_privilege('anon','public.vixo_claim_invite(text,uuid)','EXECUTE'), 'anonymous cannot choose an identity');
select pg_temp.assert_true(has_table_privilege('service_role','public.vixo_invites','SELECT')
  and not has_table_privilege('service_role','public.vixo_invites','INSERT,UPDATE,DELETE'), 'server invite preflight is SELECT only');
select pg_temp.assert_true(not has_function_privilege('service_role','public.vixo_save_asset(uuid,text,text,text,text,jsonb,uuid,integer,text)','EXECUTE'), 'service key cannot replace an authenticated asset identity');

rollback;
