begin;

-- This server-only claim spans the Auth HTTP update. It deliberately has no
-- timeout: a lost update response must not permit a second password overwrite.
create table public.vixo_account_bind_claims (
  user_id uuid primary key references auth.users(id),
  claim_id uuid not null unique default pg_catalog.gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z][a-z0-9_-]{2,31}$'),
  original_email text not null,
  claimed_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table public.vixo_account_bind_claims enable row level security;
revoke all on public.vixo_account_bind_claims from public, anon, authenticated, service_role;
grant select on public.vixo_account_bind_claims to service_role;

create function public.vixo_begin_account_bind(p_user_id uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account record;
  claim uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_username is null or p_username !~ '^[a-z][a-z0-9_-]{2,31}$' then
    raise exception 'invalid_username' using errcode = '22023';
  end if;
  select u.email, u.raw_app_meta_data into account from auth.users u
    where u.id = p_user_id for update;
  if not found or account.raw_app_meta_data -> 'vixo_device_identity' is distinct from 'true'::jsonb
      or account.raw_app_meta_data ? 'vixo_username'
      or account.email is null or account.email !~ '^[^@[:space:]]+@devices\.vixo\.invalid$' then
    raise exception 'account_already_bound' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.vixo_account_bind_claims c where c.user_id = p_user_id) then
    raise exception 'account_bind_in_progress' using errcode = 'PT409';
  end if;
  -- A cheap server-side preflight improves ordinary name-collision errors.
  -- Concurrent users can still race; Auth's unique email remains authoritative.
  if exists (select 1 from auth.users u where u.id <> p_user_id
      and pg_catalog.lower(u.email) = p_username || '@accounts.vixo.invalid') then
    raise exception 'username_unavailable' using errcode = 'PT409';
  end if;
  begin
    insert into public.vixo_account_bind_claims(user_id, username, original_email)
      values (p_user_id, p_username, account.email) on conflict (user_id) do nothing
      returning claim_id into claim;
  exception when unique_violation then
    -- The user row lock serializes same-user attempts; the username unique
    -- constraint also excludes different UUIDs racing for one username.
    raise exception 'username_unavailable' using errcode = 'PT409';
  end;
  if claim is null then
    raise exception 'account_bind_in_progress' using errcode = 'PT409';
  end if;
  return pg_catalog.jsonb_build_object('claim_id', claim);
end;
$$;

create function public.vixo_release_account_bind(p_user_id uuid, p_claim_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account record;
  claim record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  -- Use the same auth-user-before-claim lock order as begin. Only a definitely
  -- rejected Auth update, followed by fresh verification, may request release.
  select u.email, u.raw_app_meta_data into account from auth.users u
    where u.id = p_user_id for update;
  if not found then
    raise exception 'account_claim_mismatch' using errcode = 'PT409';
  end if;
  select c.* into claim from public.vixo_account_bind_claims c
    where c.user_id = p_user_id and c.claim_id = p_claim_id for update;
  if not found then
    raise exception 'account_claim_mismatch' using errcode = 'PT409';
  end if;
  if account.raw_app_meta_data -> 'vixo_device_identity' is distinct from 'true'::jsonb
      or account.raw_app_meta_data ? 'vixo_username'
      or account.email is distinct from claim.original_email then
    raise exception 'account_already_bound' using errcode = 'PT409';
  end if;
  delete from public.vixo_account_bind_claims where user_id = p_user_id and claim_id = p_claim_id;
  return pg_catalog.jsonb_build_object('released', true);
end;
$$;

revoke all on function public.vixo_begin_account_bind(uuid, text) from public, anon, authenticated;
revoke all on function public.vixo_release_account_bind(uuid, uuid) from public, anon, authenticated;
grant execute on function public.vixo_begin_account_bind(uuid, text) to service_role;
grant execute on function public.vixo_release_account_bind(uuid, uuid) to service_role;

comment on table public.vixo_account_bind_claims is
  'Durable one-time device-to-account bind claims; never stores passwords. Retain after successful or ambiguous Auth updates.';
commit;
