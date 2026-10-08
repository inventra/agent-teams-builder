begin;

-- Existing identity transfer. A null user_id is a server-created bootstrap
-- capability; this migration never creates an auth user or sends an email.
create table public.vixo_device_codes (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid references auth.users(id),
  expires_at timestamptz not null,
  claimed_at timestamptz
);
alter table public.vixo_device_codes enable row level security;
revoke all on public.vixo_device_codes from public, anon, authenticated, service_role;
grant usage on schema public to service_role;
-- Edge/root may seed a hashed bootstrap capability without client visibility.
grant select, insert on public.vixo_device_codes to service_role;
-- Server-side preflight may inspect a hash/expiry before creating an identity.
-- The atomic claim RPC still owns membership insertion and usage accounting.
revoke all on public.vixo_invites from service_role;
grant select on public.vixo_invites to service_role;

create function public.vixo_create_device_code()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid(); v_code text; v_expires timestamptz;
begin
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  v_code := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := pg_catalog.clock_timestamp() + interval '10 minutes';
  insert into public.vixo_device_codes(code_hash, user_id, expires_at)
  values (pg_catalog.encode(extensions.digest(v_code, 'sha256'), 'hex'), v_actor, v_expires);
  return pg_catalog.jsonb_build_object('code', v_code, 'expires_at', v_expires);
end $$;

create function public.vixo_claim_device_code(p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_code text; v_device public.vixo_device_codes;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  v_code := pg_catalog.lower(pg_catalog.btrim(p_code));
  if v_code is null or v_code !~ '^[a-f0-9]{64}$' then raise exception 'invalid_device_code' using errcode = '22023'; end if;
  select d.* into v_device from public.vixo_device_codes d
  where d.code_hash = pg_catalog.encode(extensions.digest(v_code, 'sha256'), 'hex') for update;
  if not found or v_device.claimed_at is not null or v_device.expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'invalid_or_expired_device_code' using errcode = '22023';
  end if;
  update public.vixo_device_codes set claimed_at = pg_catalog.clock_timestamp() where code_hash = v_device.code_hash;
  return pg_catalog.jsonb_build_object('user_id', v_device.user_id);
end $$;

-- One implementation for normal authenticated joins and service-only Edge
-- joins. No caller can execute this private helper or choose another user.
create function vixo_private.join_with_invite(p_code text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_code text; v_invite public.vixo_invites; v_workspace public.vixo_workspaces;
begin
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'invalid_user' using errcode = '22023';
  end if;
  v_code := pg_catalog.lower(pg_catalog.btrim(p_code));
  if v_code is null or v_code !~ '^[a-f0-9]{64}$' then raise exception 'invalid_invite' using errcode = '22023'; end if;
  select i.* into v_invite from public.vixo_invites i
  where i.hash = pg_catalog.encode(extensions.digest(v_code, 'sha256'), 'hex') for update;
  if not found or v_invite.expires_at <= pg_catalog.clock_timestamp() then raise exception 'invalid_or_expired_invite' using errcode = '22023'; end if;
  select w.* into v_workspace from public.vixo_workspaces w where w.id = v_invite.workspace_id for update;
  if not found then raise exception 'invalid_invite' using errcode = '22023'; end if;
  if v_invite.expires_at <= pg_catalog.clock_timestamp() then raise exception 'invalid_or_expired_invite' using errcode = '22023'; end if;
  if exists (select 1 from public.vixo_members m where m.workspace_id = v_workspace.id and m.user_id = p_user_id) then
    return pg_catalog.to_jsonb(v_workspace);
  end if;
  if v_invite.uses >= v_invite.max_uses then raise exception 'invite_exhausted' using errcode = '22023'; end if;
  insert into public.vixo_members(workspace_id, user_id, role) values (v_workspace.id, p_user_id, v_invite.role);
  update public.vixo_invites set uses = uses + 1 where hash = v_invite.hash;
  return pg_catalog.to_jsonb(v_workspace);
end $$;
revoke all on function vixo_private.join_with_invite(text, uuid) from public, anon, authenticated, service_role;

create or replace function public.vixo_join_workspace(p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  return vixo_private.join_with_invite(p_code, v_actor);
end $$;

create function public.vixo_claim_invite(p_code text, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$ begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  return vixo_private.join_with_invite(p_code, p_user_id);
end $$;

revoke all on function public.vixo_create_device_code() from public, anon, authenticated, service_role;
revoke all on function public.vixo_claim_device_code(text) from public, anon, authenticated, service_role;
revoke all on function public.vixo_claim_invite(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.vixo_join_workspace(text) from public, anon, authenticated, service_role;
grant execute on function public.vixo_create_device_code(), public.vixo_join_workspace(text) to authenticated;
grant execute on function public.vixo_claim_device_code(text), public.vixo_claim_invite(text, uuid) to service_role;

commit;
