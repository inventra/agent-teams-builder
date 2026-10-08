begin;

-- Check capability deadlines using the wall clock after row-lock waits,
-- and bound bundle file validation work. Existing rows and function ACLs stay.

create or replace function public.vixo_create_invite(p_workspace_id uuid, p_role text default 'viewer')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid(); v_owner uuid; v_code text; v_expires timestamptz;
begin
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('editor', 'viewer') then raise exception 'invalid_invite_role' using errcode = '22023'; end if;
  select w.owner_id into v_owner from public.vixo_workspaces w where w.id = p_workspace_id for update;
  if v_owner is distinct from v_actor then raise exception 'workspace_owner_required' using errcode = '42501'; end if;
  v_code := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := pg_catalog.clock_timestamp() + interval '7 days';
  insert into public.vixo_invites(hash, workspace_id, role, expires_at, created_by)
  values (pg_catalog.encode(extensions.digest(v_code, 'sha256'), 'hex'), p_workspace_id, p_role, v_expires, v_actor);
  return pg_catalog.jsonb_build_object('code', v_code, 'expires_at', v_expires);
end $$;

create or replace function public.vixo_save_asset(
  p_id uuid default null, p_kind text default 'agent', p_slug text default '',
  p_title text default '', p_description text default '', p_bundle jsonb default '{}',
  p_workspace_id uuid default null, p_expected_revision integer default 0, p_message text default ''
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid(); v_existing public.vixo_assets; v_saved public.vixo_assets;
  v_file jsonb; v_path text; v_paths text[] := array[]::text[];
begin
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('agent', 'skill', 'workflow') then raise exception 'invalid_asset_kind' using errcode = '22023'; end if;
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9_-]{0,127}$' then raise exception 'invalid_asset_slug' using errcode = '22023'; end if;
  if p_title is null or p_title <> pg_catalog.btrim(p_title) or pg_catalog.length(p_title) not between 1 and 200 then
    raise exception 'invalid_asset_title' using errcode = '22023';
  end if;
  if p_description is null or pg_catalog.length(p_description) > 4000 or p_message is null or pg_catalog.length(p_message) > 2000 then
    raise exception 'invalid_asset_text' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then raise exception 'invalid_expected_revision' using errcode = '22023'; end if;
  if p_bundle is null or pg_catalog.jsonb_typeof(p_bundle) is distinct from 'object'
    or p_bundle->'formatVersion' is distinct from '1'::jsonb or p_bundle->>'kind' is distinct from p_kind
    or pg_catalog.jsonb_typeof(p_bundle->'spec') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_bundle->'files') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_bundle->'dependencies') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_bundle->'requirements') is distinct from 'object'
    or pg_catalog.octet_length(pg_catalog.convert_to(p_bundle::text, 'UTF8')) > 5242880 then
    raise exception 'invalid_bundle' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_bundle->'files') > 1000 then raise exception 'too_many_bundle_files' using errcode = '22023'; end if;
  for v_file in select value from pg_catalog.jsonb_array_elements(p_bundle->'files') loop
    if pg_catalog.jsonb_typeof(v_file) is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_file->'path') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_file->'content') is distinct from 'string' then
      raise exception 'invalid_bundle_file' using errcode = '22023';
    end if;
    v_path := v_file->>'path';
    if pg_catalog.length(v_path) not between 1 and 1024 or v_path <> pg_catalog.btrim(v_path)
      or v_path ~ '(^/|^[A-Za-z]:|(^|/)\.{1,2}(/|$)|//|/$)' or pg_catalog.strpos(v_path, E'\\') > 0
      or v_path = any(v_paths) then raise exception 'invalid_bundle_path' using errcode = '22023'; end if;
    v_paths := pg_catalog.array_append(v_paths, v_path);
  end loop;
  if p_id is null then
    if p_expected_revision <> 0 then raise exception 'revision_conflict' using errcode = '40001'; end if;
    if p_workspace_id is not null then
      -- Serialize member removal and team writes using the workspace row.
      perform 1 from public.vixo_workspaces w where w.id = p_workspace_id for update;
      if not found or coalesce(vixo_private.member_role(p_workspace_id), '') not in ('owner', 'editor') then
        raise exception 'asset_write_forbidden' using errcode = '42501';
      end if;
    end if;
    insert into public.vixo_assets(owner_id, workspace_id, kind, slug, title, description, bundle, revision)
    values (v_actor, p_workspace_id, p_kind, p_slug, p_title, p_description, p_bundle, 1) returning * into v_saved;
  else
    select a.* into v_existing from public.vixo_assets a where a.id = p_id for update;
    if not found then raise exception 'asset_not_found' using errcode = 'P0002'; end if;
    if v_existing.workspace_id is null then
      if v_existing.owner_id <> v_actor then raise exception 'asset_write_forbidden' using errcode = '42501'; end if;
    else
      perform 1 from public.vixo_workspaces w where w.id = v_existing.workspace_id for update;
      if coalesce(vixo_private.member_role(v_existing.workspace_id), '') not in ('owner', 'editor') then
        raise exception 'asset_write_forbidden' using errcode = '42501';
      end if;
    end if;
    if p_kind <> v_existing.kind or p_workspace_id is distinct from v_existing.workspace_id then
      raise exception 'immutable_asset_scope' using errcode = '22023';
    end if;
    if p_expected_revision <> v_existing.revision then raise exception 'revision_conflict' using errcode = '40001'; end if;
    update public.vixo_assets set slug = p_slug, title = p_title, description = p_description,
      bundle = p_bundle, revision = revision + 1, updated_at = pg_catalog.now()
    where id = p_id returning * into v_saved;
  end if;
  insert into public.vixo_asset_revisions(asset_id, revision, bundle, title, description, created_by, message)
  values (v_saved.id, v_saved.revision, v_saved.bundle, v_saved.title, v_saved.description, v_actor, p_message);
  return pg_catalog.to_jsonb(v_saved);
end $$;

create or replace function public.vixo_create_device_code()
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

create or replace function public.vixo_claim_device_code(p_code text)
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

create or replace function vixo_private.join_with_invite(p_code text, p_user_id uuid)
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

-- Supabase may install this DDL event-trigger helper with PUBLIC EXECUTE.
-- Preserve the event trigger and its owner; it is not a client-callable RPC.
do $$
declare v_function record;
begin
  for v_function in
    select p.oid::pg_catalog.regprocedure as signature
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
      and p.prorettype = 'pg_catalog.event_trigger'::pg_catalog.regtype
  loop
    execute pg_catalog.format('revoke execute on function %s from public, anon, authenticated', v_function.signature);
  end loop;
end $$;

commit;
