begin;

-- Business revision conflicts are custom HTTP 409 errors, not PostgreSQL
-- serialization failures. Preserve row-lock/CAS behavior and existing ACLs.
-- https://docs.postgrest.org/en/v16/references/errors.html#raise-errors-with-http-status-codes

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

commit;
