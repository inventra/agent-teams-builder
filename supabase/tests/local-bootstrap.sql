-- Disposable LOCAL PostgreSQL only. Never apply this fixture to Supabase.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
$$;
grant usage on schema auth to service_role;
grant execute on function auth.role() to anon, authenticated, service_role;
-- Supabase may grant new public objects to API roles by default. The migrations
-- must explicitly strip those broad defaults before applying least privilege.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
