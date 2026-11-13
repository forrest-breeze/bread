-- Rebrand Bread -> Breezify for persisted values:
--   * hosted-docs sync mode 'replace_bread' -> 'replace_breezify'
--   * hosted-docs repository format 'bread' -> 'breezify'
--   * documents.source_metadata key bread_document_id -> breezify_document_id
--   * schema comments
-- Constraints are swapped in one transaction around the data rewrite.

alter table public.github_hosted_docs_sources
  drop constraint github_hosted_docs_sources_pending_sync_mode_check,
  drop constraint github_hosted_docs_sources_format_check;
alter table public.monitored_repos
  drop constraint monitored_repos_hosted_docs_last_sync_mode_check,
  drop constraint monitored_repos_hosted_docs_sync_mode_check;

update public.github_hosted_docs_sources
   set pending_sync_mode = 'replace_breezify'
 where pending_sync_mode = 'replace_bread';

update public.github_hosted_docs_sources
   set format = 'breezify'
 where format = 'bread';

update public.monitored_repos
   set hosted_docs_last_sync_mode = 'replace_breezify'
 where hosted_docs_last_sync_mode = 'replace_bread';

update public.monitored_repos
   set hosted_docs_sync_mode = 'replace_breezify'
 where hosted_docs_sync_mode = 'replace_bread';

update public.documents
   set source_metadata = jsonb_set(source_metadata, '{github_hosted_checkpoint_mode}', '"replace_breezify"')
 where source_metadata->>'github_hosted_checkpoint_mode' = 'replace_bread';

update public.documents
   set source_metadata = (source_metadata - 'bread_document_id')
         || jsonb_build_object('breezify_document_id', source_metadata->'bread_document_id')
 where source_metadata ? 'bread_document_id';

alter table public.github_hosted_docs_sources
  alter column format set default 'breezify',
  add constraint github_hosted_docs_sources_pending_sync_mode_check
  check (pending_sync_mode = any (array['merge'::text, 'replace_breezify'::text])),
  add constraint github_hosted_docs_sources_format_check
  check (format = any (array['breezify'::text, 'readme'::text]));
alter table public.monitored_repos
  add constraint monitored_repos_hosted_docs_last_sync_mode_check
  check (hosted_docs_last_sync_mode = any (array['merge'::text, 'replace_breezify'::text])),
  add constraint monitored_repos_hosted_docs_sync_mode_check
  check (hosted_docs_sync_mode = any (array['merge'::text, 'replace_breezify'::text]));

comment on column public.github_hosted_docs_sources.publish_pull_request_head is
  'Breezify-owned branch for the open ongoing workspace-publish PR.';
comment on column public.github_hosted_docs_sources.publish_last_commit_sha is
  'Last commit Breezify wrote to the workspace-publish branch; guards reviewer edits.';
comment on column public.monitored_repos.sync_path is
  'Repository-relative folder indexed by Breezify. Empty string means the repository root.';
comment on column public.github_hosted_docs_sources.format is
  'Repository layout: breezify (strict Breezify frontmatter) or readme (ReadMe bi-directional sync layout).';
