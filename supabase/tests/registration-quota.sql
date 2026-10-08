begin;

-- Run before opening public registration. Counters are temporarily locked and
-- reset inside this rollback transaction; concurrent quota calls wait for it.
lock table public.vixo_registration_limits in exclusive mode;
delete from public.vixo_registration_limits;
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
select pg_temp.assert_true(not has_table_privilege('authenticated','public.vixo_registration_limits','SELECT')
  and not has_table_privilege('service_role','public.vixo_registration_limits','UPDATE'),'quota counters cannot be reset by client or direct service UPDATE');
select pg_temp.assert_true(not has_function_privilege('anon','public.vixo_claim_registration_quota(text)','EXECUTE')
  and not has_function_privilege('authenticated','public.vixo_claim_registration_quota(text)','EXECUTE')
  and has_function_privilege('service_role','public.vixo_claim_registration_quota(text)','EXECUTE'),'only service role can claim quota');
set local role service_role;
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.expect_error('select public.vixo_claim_registration_quota(null)','42501','service_role_required');
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.expect_error('select public.vixo_claim_registration_quota(''raw-ip'')','22023','invalid_registration_ip_hash');
do $$ declare n integer; result jsonb; begin
  for n in 1..5 loop
    result:=public.vixo_claim_registration_quota(repeat('a',64));
    perform pg_temp.assert_true(result->>'allowed'='true','first five IP attempts allowed');
  end loop;
  result:=public.vixo_claim_registration_quota(repeat('a',64));
  perform pg_temp.assert_true(result->>'allowed'='false' and (result->>'retry_after_seconds')::integer between 1 and 900,'sixth IP attempt denied with retry deadline');
end $$;
select pg_temp.assert_true((select attempts=6 from public.vixo_registration_limits where bucket='global'),'IP denied attempt still consumes global quota');
do $$ declare n integer; result jsonb; begin
  for n in 7..50 loop
    result:=public.vixo_claim_registration_quota(null);
    perform pg_temp.assert_true(result->>'allowed'='true','missing IP cannot bypass global accounting');
  end loop;
  result:=public.vixo_claim_registration_quota(null);
  perform pg_temp.assert_true(result->>'allowed'='false' and (result->>'retry_after_seconds')::integer between 1 and 3600,'global attempt 51 denied even without IP');
  result:=public.vixo_claim_registration_quota(repeat('b',64));
  perform pg_temp.assert_true(result->>'allowed'='false','rotating IP cannot bypass global cap');
end $$;
select pg_temp.assert_true((select attempts=52 from public.vixo_registration_limits where bucket='global'),'denied global attempts remain counted');
reset role;
update public.vixo_registration_limits set window_started_at=clock_timestamp()-interval '1 hour 1 second' where bucket='global';
update public.vixo_registration_limits set window_started_at=clock_timestamp()-interval '15 minutes 1 second' where bucket='ip:'||repeat('a',64);
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.assert_true(public.vixo_claim_registration_quota(repeat('a',64))->>'allowed'='true','both expired windows restart according to DB wall clock');
select pg_temp.assert_true((select attempts=1 and window_started_at>clock_timestamp()-interval '1 second' from public.vixo_registration_limits where bucket='global'),'reset global window starts with one charged attempt');
select pg_temp.assert_true((select attempts=1 from public.vixo_registration_limits where bucket='ip:'||repeat('a',64)),'reset IP window starts with one charged attempt');
reset role;

rollback;
