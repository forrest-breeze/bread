-- ReadMe-compatible GitHub bidirectional sync.
--
-- The hosted-docs link gains a repository format. 'bread' is the existing
-- strict format (title + bread_document_id frontmatter, publish through a
-- pull request). 'readme' reads and writes the layout ReadMe's GitHub
-- integration uses (docs/, reference/, recipes/, custom_pages/, changelogs/,
-- _order.yaml, index.md, YAML frontmatter), so a repository that was synced
-- with ReadMe can be linked as-is.
--
-- See apps/web/app/src/lib/github/readme/.

alter table public.github_hosted_docs_sources
  add column if not exists format text not null default 'bread',
  add column if not exists publish_mode text not null default 'pull_request',
  add column if not exists branch text,
  add column if not exists sync_state jsonb not null default '{}'::jsonb;

alter table public.github_hosted_docs_sources
  drop constraint if exists github_hosted_docs_sources_format_check,
  add constraint github_hosted_docs_sources_format_check
    check (format = any (array['bread'::text, 'readme'::text])),
  drop constraint if exists github_hosted_docs_sources_publish_mode_check,
  add constraint github_hosted_docs_sources_publish_mode_check
    check (publish_mode = any (array['pull_request'::text, 'direct'::text])),
  drop constraint if exists github_hosted_docs_sources_branch_check,
  add constraint github_hosted_docs_sources_branch_check
    check (
      branch is null
      or (
        char_length(branch) between 1 and 255
        and branch !~ '[[:cntrl:][:space:]~^:?*\[\\]'
        and branch !~ '(^/|/$|//|\.\.|@\{|\.lock$|^-)'
      )
    );

comment on column public.github_hosted_docs_sources.format is
  'Repository layout: bread (strict Bread frontmatter) or readme (ReadMe bi-directional sync layout).';
comment on column public.github_hosted_docs_sources.publish_mode is
  'How workspace edits reach GitHub: pull_request, or direct commits to the synced branch (ReadMe behaviour).';
comment on column public.github_hosted_docs_sources.branch is
  'Synced branch. Null means the repository default branch.';
comment on column public.github_hosted_docs_sources.sync_state is
  'Format-specific reconciliation state recorded by the last sync (order files, managed paths).';

-- Folders mirror repository directories in the readme format. The directory
-- path and the state of its index.md are kept here so a folder can be renamed
-- or moved in the workspace without losing its link to the repository.
alter table public.folders
  add column if not exists source_metadata jsonb not null default '{}'::jsonb;

comment on column public.folders.source_metadata is
  'Link to an external source. For GitHub readme-format sync: kind, repo_id, path and index.md state.';

-- OpenAPI sources can live in the linked repository (reference/<slug>.json or
-- .yaml). The raw spec is kept so an upload from CI or Settings can be written
-- to the repository, and so the file can be re-created after a relink.
--
-- The table comes from 20261112200300_openapi_sources.sql. That migration is
-- dated before the baseline, so `supabase db push` skips it on a database that
-- started from the baseline (it needs --include-all), and the baseline dump
-- does not contain the table. Create it here when it is missing, with the same
-- definition, so this migration works either way.
create table if not exists public.openapi_sources (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  slug              text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  title             text not null,
  version           text,
  operation_count   integer not null default 0,
  root_folder_id    uuid references public.folders (id) on delete set null,
  last_synced_at    timestamptz not null default now(),
  last_synced_by    text not null,
  created_at        timestamptz not null default now(),
  unique (workspace_id, slug)
);

alter table public.openapi_sources enable row level security;

drop policy if exists "workspace members can read openapi sources" on public.openapi_sources;
create policy "workspace members can read openapi sources"
  on public.openapi_sources for select
  using (workspace_id in (select public.get_user_workspace_ids()));

revoke all on public.openapi_sources from anon;
grant select on public.openapi_sources to authenticated;
grant all on public.openapi_sources to service_role;

alter table public.openapi_sources
  add column if not exists spec_raw text,
  add column if not exists repo_path text,
  add column if not exists repo_blob_sha text;

comment on column public.openapi_sources.spec_raw is
  'The spec exactly as last uploaded or read from the repository (JSON or YAML).';
comment on column public.openapi_sources.repo_path is
  'Path of this spec in the linked GitHub repository, when it is synced there.';
comment on column public.openapi_sources.repo_blob_sha is
  'Git blob SHA of the spec at repo_path as of the last sync or push.';
