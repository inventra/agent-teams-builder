begin;

-- New and existing identities start pending. The initial administrator is
-- seeded separately by a trusted migration identity, never from user metadata.
create table public.vixo_account_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','disabled')),
  is_admin boolean not null default false,
  display_name text not null default '' check (pg_catalog.length(display_name) <= 80),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  approved_by uuid references auth.users(id) on delete set null
);
create table public.vixo_account_access_audit (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  actor_id uuid not null,
  user_id uuid not null,
  old_status text not null check (old_status in ('pending','approved','disabled')),
  new_status text not null check (new_status in ('approved','disabled')),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table public.vixo_account_access enable row level security;
alter table public.vixo_account_access_audit enable row level security;
revoke all on public.vixo_account_access, public.vixo_account_access_audit from public, anon, authenticated, service_role;
grant select on public.vixo_account_access, public.vixo_account_access_audit to service_role;

create function vixo_private.initialize_account_access()
returns trigger language plpgsql security definer set search_path = '' as $$ begin
  insert into public.vixo_account_access(user_id,display_name)
    values (new.id,pg_catalog.left(coalesce(nullif(pg_catalog.btrim(case
      when pg_catalog.jsonb_typeof(new.raw_user_meta_data->'display_name')='string'
      then new.raw_user_meta_data->>'display_name' else '' end),''),new.raw_app_meta_data->>'vixo_username',''),80));
  return new;
end $$;
revoke all on function vixo_private.initialize_account_access() from public, anon, authenticated, service_role;
create trigger vixo_initialize_account_access after insert on auth.users
  for each row execute function vixo_private.initialize_account_access();
insert into public.vixo_account_access(user_id,display_name)
  select u.id,pg_catalog.left(coalesce(nullif(pg_catalog.btrim(case
    when pg_catalog.jsonb_typeof(u.raw_user_meta_data->'display_name')='string'
    then u.raw_user_meta_data->>'display_name' else '' end),''),u.raw_app_meta_data->>'vixo_username',''),80) from auth.users u
  on conflict (user_id) do nothing;

create function vixo_private.immutable_account_audit()
returns trigger language plpgsql security definer set search_path = '' as $$ begin
  raise exception 'account_audit_immutable' using errcode='42501';
end $$;
revoke all on function vixo_private.immutable_account_audit() from public, anon, authenticated, service_role;
create trigger vixo_account_audit_append_only before update or delete on public.vixo_account_access_audit
  for each row execute function vixo_private.immutable_account_audit();

create function vixo_private.is_approved()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.vixo_account_access a where a.user_id=auth.uid() and a.status='approved'
  )
$$;
revoke all on function vixo_private.is_approved() from public, anon, authenticated, service_role;
grant execute on function vixo_private.is_approved() to authenticated;

create function vixo_private.require_approved()
returns void language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); account_status text;
begin
  if actor is null then raise exception 'authentication_required' using errcode='42501'; end if;
  -- Hold approval through the entire write RPC, so disable waits for any
  -- operation already admitted rather than returning before it can commit.
  select a.status into account_status from public.vixo_account_access a where a.user_id=actor for share;
  if account_status='disabled' then raise exception 'account_disabled' using errcode='PT403'; end if;
  if account_status is distinct from 'approved' then raise exception 'account_pending' using errcode='PT403'; end if;
end $$;
revoke all on function vixo_private.require_approved() from public, anon, authenticated, service_role;

create function vixo_private.require_admin()
returns void language plpgsql security definer set search_path = '' as $$ begin
  if auth.uid() is null or not exists (select 1 from public.vixo_account_access a
      where a.user_id=auth.uid() and a.status='approved' and a.is_admin) then
    raise exception 'admin_required' using errcode='PT403';
  end if;
end $$;
revoke all on function vixo_private.require_admin() from public, anon, authenticated, service_role;

create function vixo_private.assert_not_disabled(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare account_status text;
begin
  select a.status into account_status from public.vixo_account_access a where a.user_id=p_user_id for share;
  if account_status='disabled' then
    raise exception 'account_disabled' using errcode='PT403';
  end if;
end $$;
revoke all on function vixo_private.assert_not_disabled(uuid) from public, anon, authenticated, service_role;

create function vixo_private.account_access_json(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('userId',a.user_id,'status',a.status,'isAdmin',a.is_admin,
    'username',u.raw_app_meta_data->>'vixo_username',
    'displayName',coalesce(nullif(a.display_name,''),u.raw_app_meta_data->>'vixo_username',''),
    'createdAt',a.created_at,'updatedAt',a.updated_at)
  from public.vixo_account_access a join auth.users u on u.id=a.user_id where a.user_id=p_user_id
$$;
revoke all on function vixo_private.account_access_json(uuid) from public, anon, authenticated, service_role;

-- Restrictive policies AND the new status gate with existing owner/member
-- policies. Administrator status never broadens private-asset visibility.
create policy vixo_workspaces_account_approved on public.vixo_workspaces as restrictive
  for select to authenticated using ((select vixo_private.is_approved()));
create policy vixo_members_account_approved on public.vixo_members as restrictive
  for select to authenticated using ((select vixo_private.is_approved()));
create policy vixo_assets_account_approved on public.vixo_assets as restrictive
  for select to authenticated using ((select vixo_private.is_approved()));
create policy vixo_asset_revisions_account_approved on public.vixo_asset_revisions as restrictive
  for select to authenticated using ((select vixo_private.is_approved()));

create function public.vixo_my_access()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'authentication_required' using errcode='42501'; end if;
  result:=vixo_private.account_access_json(auth.uid());
  if result is null then raise exception 'account_pending' using errcode='PT403'; end if;
  return result;
end $$;

create function public.vixo_admin_list_accounts()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform vixo_private.require_admin();
  select coalesce(pg_catalog.jsonb_agg(vixo_private.account_access_json(a.user_id)
    order by a.created_at,a.user_id),'[]'::jsonb) into result from public.vixo_account_access a;
  return result;
end $$;

create function public.vixo_admin_set_account_status(p_user_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); target public.vixo_account_access;
begin
  perform vixo_private.require_admin();
  if p_status is null or p_status not in ('approved','disabled') then
    raise exception 'invalid_account_status' using errcode='22023';
  end if;
  select a.* into target from public.vixo_account_access a where a.user_id=p_user_id for update;
  if not found then raise exception 'account_not_found' using errcode='P0002'; end if;
  if target.is_admin or target.user_id=actor then
    raise exception 'admin_account_protected' using errcode='PT403';
  end if;
  if target.status is distinct from p_status then
    update public.vixo_account_access set status=p_status,updated_at=pg_catalog.clock_timestamp(),
      approved_by=case when p_status='approved' then actor else approved_by end where user_id=p_user_id;
    insert into public.vixo_account_access_audit(actor_id,user_id,old_status,new_status)
      values (actor,p_user_id,target.status,p_status);
  end if;
  return vixo_private.account_access_json(p_user_id);
end $$;

revoke all on function public.vixo_my_access(), public.vixo_admin_list_accounts(),
  public.vixo_admin_set_account_status(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.vixo_my_access(), public.vixo_admin_list_accounts(),
  public.vixo_admin_set_account_status(uuid,text) to authenticated;

-- Global quota is mandatory even when an IP is missing or forged. The IP hash
-- is only an additional throttle; the Edge must never treat raw XFF as identity.
create table public.vixo_registration_limits (
  bucket text primary key check (bucket='global' or bucket ~ '^ip:[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts between 0 and 1000000)
);
alter table public.vixo_registration_limits enable row level security;
revoke all on public.vixo_registration_limits from public, anon, authenticated, service_role;
grant select on public.vixo_registration_limits to service_role;

create function public.vixo_claim_registration_quota(p_ip_hash text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare counter public.vixo_registration_limits; stamp timestamptz; count_now integer; retry integer; key text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid_registration_ip_hash' using errcode='22023';
  end if;
  insert into public.vixo_registration_limits(bucket,window_started_at,attempts)
    values ('global',pg_catalog.clock_timestamp(),0) on conflict (bucket) do nothing;
  select r.* into counter from public.vixo_registration_limits r where r.bucket='global' for update;
  stamp:=pg_catalog.clock_timestamp();
  if counter.window_started_at+interval '1 hour'<=stamp then
    counter.window_started_at:=stamp; count_now:=1;
  else count_now:=least(counter.attempts+1,1000000); end if;
  update public.vixo_registration_limits set window_started_at=counter.window_started_at,attempts=count_now where bucket='global';
  if count_now>50 then
    retry:=greatest(1,pg_catalog.ceil(extract(epoch from (counter.window_started_at+interval '1 hour'-stamp)))::integer);
    return pg_catalog.jsonb_build_object('allowed',false,'retry_after_seconds',retry);
  end if;
  -- Clean expired IP counters only; the global counter survives every attempt.
  delete from public.vixo_registration_limits where bucket<>'global' and window_started_at<stamp-interval '1 day';
  if p_ip_hash is not null then
    key:='ip:'||p_ip_hash;
    insert into public.vixo_registration_limits(bucket,window_started_at,attempts)
      values (key,stamp,0) on conflict (bucket) do nothing;
    select r.* into counter from public.vixo_registration_limits r where r.bucket=key for update;
    stamp:=pg_catalog.clock_timestamp();
    if counter.window_started_at+interval '15 minutes'<=stamp then
      counter.window_started_at:=stamp; count_now:=1;
    else count_now:=least(counter.attempts+1,1000000); end if;
    update public.vixo_registration_limits set window_started_at=counter.window_started_at,attempts=count_now where bucket=key;
    if count_now>5 then
      retry:=greatest(1,pg_catalog.ceil(extract(epoch from (counter.window_started_at+interval '15 minutes'-stamp)))::integer);
      return pg_catalog.jsonb_build_object('allowed',false,'retry_after_seconds',retry);
    end if;
  end if;
  return pg_catalog.jsonb_build_object('allowed',true,'retry_after_seconds',0);
end $$;
revoke all on function public.vixo_claim_registration_quota(text) from public, anon, authenticated, service_role;
grant execute on function public.vixo_claim_registration_quota(text) to service_role;

-- Explicit replacements below retain existing validation, locks, CAS and ACLs.


create or replace function public.vixo_create_workspace(p_name text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid(); v_workspace public.vixo_workspaces;
begin
  perform vixo_private.require_approved();
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_name is null or pg_catalog.length(pg_catalog.btrim(p_name)) not between 1 and 120 then
    raise exception 'invalid_workspace_name' using errcode = '22023';
  end if;
  insert into public.vixo_workspaces(name, owner_id) values (pg_catalog.btrim(p_name), v_actor) returning * into v_workspace;
  insert into public.vixo_members(workspace_id, user_id, role) values (v_workspace.id, v_actor, 'owner');
  return pg_catalog.to_jsonb(v_workspace);
end $$;

create or replace function public.vixo_create_invite(p_workspace_id uuid, p_role text default 'viewer')
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid(); v_owner uuid; v_code text; v_expires timestamptz;
begin
  perform vixo_private.require_approved();
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

create or replace function public.vixo_join_workspace(p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid();
begin
  perform vixo_private.require_approved();
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  return vixo_private.join_with_invite(p_code, v_actor);
end $$;

create or replace function public.vixo_remove_member(p_workspace_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid(); v_owner uuid;
begin
  perform vixo_private.require_approved();
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  select w.owner_id into v_owner from public.vixo_workspaces w where w.id = p_workspace_id for update;
  if v_owner is distinct from v_actor then raise exception 'workspace_owner_required' using errcode = '42501'; end if;
  if p_user_id is null then raise exception 'invalid_member' using errcode = '22023'; end if;
  if p_user_id = v_owner or exists (select 1 from public.vixo_members m
      where m.workspace_id = p_workspace_id and m.user_id = p_user_id and m.role = 'owner') then
    raise exception 'cannot_remove_owner' using errcode = '22023';
  end if;
  delete from public.vixo_members where workspace_id = p_workspace_id and user_id = p_user_id;
  return pg_catalog.jsonb_build_object('removed', found);
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
  perform vixo_private.require_approved();
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
    if p_expected_revision <> 0 then raise exception 'revision_conflict' using errcode = 'PT409'; end if;
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
    if p_expected_revision <> v_existing.revision then raise exception 'revision_conflict' using errcode = 'PT409'; end if;
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
  perform vixo_private.require_approved();
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
  if v_device.user_id is not null then perform vixo_private.assert_not_disabled(v_device.user_id); end if;
  update public.vixo_device_codes set claimed_at = pg_catalog.clock_timestamp() where code_hash = v_device.code_hash;
  return pg_catalog.jsonb_build_object('user_id', v_device.user_id);
end $$;

create or replace function public.vixo_begin_account_bind(p_user_id uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account record;
  claim uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  perform vixo_private.assert_not_disabled(p_user_id);
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

create or replace function public.vixo_release_account_bind(p_user_id uuid, p_claim_id uuid)
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

create or replace function public.vixo_claim_invite(p_code text,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; account_status text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
  perform vixo_private.assert_not_disabled(p_user_id);
  result:=vixo_private.join_with_invite(p_code,p_user_id);
  select a.status into account_status from public.vixo_account_access a where a.user_id=p_user_id;
  if account_status='approved' then return result; end if;
  return pg_catalog.jsonb_build_object('joined',true);
end $$;

-- Reassert the complete RPC boundary; no copied public implementation exists.
revoke all on function public.vixo_create_workspace(text),public.vixo_create_invite(uuid,text),
  public.vixo_join_workspace(text),public.vixo_remove_member(uuid,uuid),
  public.vixo_save_asset(uuid,text,text,text,text,jsonb,uuid,integer,text),public.vixo_create_device_code()
  from public,anon,authenticated,service_role;
grant execute on function public.vixo_create_workspace(text),public.vixo_create_invite(uuid,text),
  public.vixo_join_workspace(text),public.vixo_remove_member(uuid,uuid),
  public.vixo_save_asset(uuid,text,text,text,text,jsonb,uuid,integer,text),public.vixo_create_device_code() to authenticated;
revoke all on function public.vixo_claim_device_code(text),public.vixo_claim_invite(text,uuid),
  public.vixo_begin_account_bind(uuid,text),public.vixo_release_account_bind(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.vixo_claim_device_code(text),public.vixo_claim_invite(text,uuid),
  public.vixo_begin_account_bind(uuid,text),public.vixo_release_account_bind(uuid,uuid) to service_role;
revoke all on function vixo_private.join_with_invite(text,uuid) from public,anon,authenticated,service_role;
commit;
