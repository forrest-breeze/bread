-- OpenAPI sources: API reference specs pushed to this tool (from CI with a
-- workspace API key, or uploaded in Settings -> Integrations -> OpenAPI).
-- Replaces ReadMe as the destination of Breeze's "Publish OpenAPI Specs"
-- workflow. Each upload regenerates one page per operation under a folder
-- per spec and a subfolder per tag (see src/lib/openapi/openapi-source.ts).

create table if not exists public.openapi_sources (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  -- Stable name used in the upload URL: PUT /api/v1/openapi/<slug>.
  slug              text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title             text not null,
  version           text,
  operation_count   integer not null default 0,
  root_folder_id    uuid references public.folders (id) on delete set null,
  last_synced_at    timestamptz not null default now(),
  -- 'api' for CI uploads, 'user:<uuid>' for uploads from Settings.
  last_synced_by    text not null,
  created_at        timestamptz not null default now(),
  unique (workspace_id, slug)
);

alter table public.openapi_sources enable row level security;

-- Members read; all writes go through the server (service role).
-- Safe to run after 20261113120000_readme_github_sync.sql created the table.
drop policy if exists "workspace members can read openapi sources" on public.openapi_sources;
create policy "workspace members can read openapi sources"
  on public.openapi_sources for select
  using (workspace_id in (select public.get_user_workspace_ids()));

revoke all on public.openapi_sources from anon;
grant select on public.openapi_sources to authenticated;
grant all on public.openapi_sources to service_role;
