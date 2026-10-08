begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema vixo_private;
revoke all on schema vixo_private from public, anon, authenticated;
grant usage on schema vixo_private to authenticated;

create table public.vixo_workspaces (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  name text not null check (name = pg_catalog.btrim(name) and pg_catalog.length(name) between 1 and 120),
  owner_id uuid not null references auth.users(id),
  created_at timestamptz not null default pg_catalog.now()
);

create table public.vixo_members (
  workspace_id uuid not null references public.vixo_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  primary key (workspace_id, user_id)
);
create index vixo_members_user_workspace_idx on public.vixo_members(user_id, workspace_id);

-- Raw codes are returned once by the owner-only RPC. Neither codes nor hashes
-- are client-readable; SHA-256 is appropriate for these 256-bit random tokens.
create table public.vixo_invites (
  hash text primary key check (hash ~ '^[a-f0-9]{64}$'),
  workspace_id uuid not null references public.vixo_workspaces(id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  expires_at timestamptz not null,
  max_uses integer not null default 10 check (max_uses between 1 and 1000),
  uses integer not null default 0 check (uses between 0 and max_uses),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default pg_catalog.now()
);
create index vixo_invites_workspace_idx on public.vixo_invites(workspace_id);

create table public.vixo_assets (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  workspace_id uuid references public.vixo_workspaces(id),
  kind text not null check (kind in ('agent', 'skill', 'workflow')),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  title text not null check (title = pg_catalog.btrim(title) and pg_catalog.length(title) between 1 and 200),
  description text not null default '' check (pg_catalog.length(description) <= 4000),
  bundle jsonb not null check (pg_catalog.jsonb_typeof(bundle) = 'object'
    and pg_catalog.octet_length(pg_catalog.convert_to(bundle::text, 'UTF8')) <= 5242880),
  revision integer not null check (revision > 0),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);
create unique index vixo_assets_private_slug_idx on public.vixo_assets(owner_id, kind, slug) where workspace_id is null;
create unique index vixo_assets_workspace_slug_idx on public.vixo_assets(workspace_id, kind, slug) where workspace_id is not null;
create index vixo_assets_workspace_updated_idx on public.vixo_assets(workspace_id, updated_at desc) where workspace_id is not null;
create index vixo_assets_owner_updated_idx on public.vixo_assets(owner_id, updated_at desc) where workspace_id is null;

create table public.vixo_asset_revisions (
  asset_id uuid not null references public.vixo_assets(id),
  revision integer not null check (revision > 0),
  bundle jsonb not null,
  title text not null,
  description text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default pg_catalog.now(),
  message text not null default '' check (pg_catalog.length(message) <= 2000),
  primary key (asset_id, revision)
);

-- The helper reads membership as the table owner, avoiding recursive RLS on
-- vixo_members. Its only identity is auth.uid(), never a caller-supplied user.
create function vixo_private.member_role(p_workspace_id uuid)
returns text language sql stable security definer set search_path = ''
as $$
  select m.role from public.vixo_members m
  where m.workspace_id = p_workspace_id and m.user_id = (select auth.uid())
    and (select auth.uid()) is not null
$$;
revoke all on function vixo_private.member_role(uuid) from public, anon, authenticated;
grant execute on function vixo_private.member_role(uuid) to authenticated;

alter table public.vixo_workspaces enable row level security;
alter table public.vixo_members enable row level security;
alter table public.vixo_invites enable row level security;
alter table public.vixo_assets enable row level security;
alter table public.vixo_asset_revisions enable row level security;

create policy vixo_workspaces_read on public.vixo_workspaces for select to authenticated
using (vixo_private.member_role(id) is not null);
create policy vixo_members_read on public.vixo_members for select to authenticated
using (vixo_private.member_role(workspace_id) is not null);
-- Invites intentionally have no client policy or SELECT grant.
create policy vixo_assets_read on public.vixo_assets for select to authenticated
using ((workspace_id is null and owner_id = (select auth.uid()))
  or (workspace_id is not null and vixo_private.member_role(workspace_id) is not null));
create policy vixo_asset_revisions_read on public.vixo_asset_revisions for select to authenticated
using (exists (select 1 from public.vixo_assets a where a.id = asset_id));

revoke all on public.vixo_workspaces, public.vixo_members, public.vixo_invites,
  public.vixo_assets, public.vixo_asset_revisions from public, anon, authenticated, service_role;
grant usage on schema public to authenticated;
grant select on public.vixo_workspaces, public.vixo_members, public.vixo_assets,
  public.vixo_asset_revisions to authenticated;

create function vixo_private.immutable_revision()
returns trigger language plpgsql security definer set search_path = ''
as $$ begin raise exception 'immutable_revision' using errcode = '42501'; end $$;
revoke all on function vixo_private.immutable_revision() from public, anon, authenticated;
create trigger vixo_revisions_append_only before update or delete on public.vixo_asset_revisions
for each row execute function vixo_private.immutable_revision();

create function public.vixo_create_workspace(p_name text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid(); v_workspace public.vixo_workspaces;
begin
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  if p_name is null or pg_catalog.length(pg_catalog.btrim(p_name)) not between 1 and 120 then
    raise exception 'invalid_workspace_name' using errcode = '22023';
  end if;
  insert into public.vixo_workspaces(name, owner_id) values (pg_catalog.btrim(p_name), v_actor) returning * into v_workspace;
  insert into public.vixo_members(workspace_id, user_id, role) values (v_workspace.id, v_actor, 'owner');
  return pg_catalog.to_jsonb(v_workspace);
end $$;

create function public.vixo_create_invite(p_workspace_id uuid, p_role text default 'viewer')
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

create function public.vixo_join_workspace(p_code text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid(); v_code text; v_invite public.vixo_invites; v_workspace public.vixo_workspaces;
begin
  if v_actor is null then raise exception 'authentication_required' using errcode = '42501'; end if;
  v_code := pg_catalog.lower(pg_catalog.btrim(p_code));
  if v_code is null or v_code !~ '^[a-f0-9]{64}$' then raise exception 'invalid_invite' using errcode = '22023'; end if;
  select i.* into v_invite from public.vixo_invites i
  where i.hash = pg_catalog.encode(extensions.digest(v_code, 'sha256'), 'hex') for update;
  if not found or v_invite.expires_at <= pg_catalog.clock_timestamp() then raise exception 'invalid_or_expired_invite' using errcode = '22023'; end if;
  select w.* into v_workspace from public.vixo_workspaces w where w.id = v_invite.workspace_id for update;
  if not found then raise exception 'invalid_invite' using errcode = '22023'; end if;
  if v_invite.expires_at <= pg_catalog.clock_timestamp() then raise exception 'invalid_or_expired_invite' using errcode = '22023'; end if;
  -- A repeated redemption never consumes capacity or upgrades an existing role.
  if exists (select 1 from public.vixo_members m where m.workspace_id = v_workspace.id and m.user_id = v_actor) then
    return pg_catalog.to_jsonb(v_workspace);
  end if;
  if v_invite.uses >= v_invite.max_uses then raise exception 'invite_exhausted' using errcode = '22023'; end if;
  insert into public.vixo_members(workspace_id, user_id, role) values (v_workspace.id, v_actor, v_invite.role);
  update public.vixo_invites set uses = uses + 1 where hash = v_invite.hash;
  return pg_catalog.to_jsonb(v_workspace);
end $$;

create function public.vixo_remove_member(p_workspace_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid(); v_owner uuid;
begin
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

create function public.vixo_save_asset(
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

revoke all on function public.vixo_create_workspace(text) from public, anon, authenticated, service_role;
revoke all on function public.vixo_create_invite(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.vixo_join_workspace(text) from public, anon, authenticated, service_role;
revoke all on function public.vixo_remove_member(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.vixo_save_asset(uuid, text, text, text, text, jsonb, uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.vixo_create_workspace(text), public.vixo_create_invite(uuid, text),
  public.vixo_join_workspace(text), public.vixo_remove_member(uuid, uuid),
  public.vixo_save_asset(uuid, text, text, text, text, jsonb, uuid, integer, text) to authenticated;

commit;
