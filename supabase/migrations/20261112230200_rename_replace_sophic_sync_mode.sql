-- Rename the hosted-docs sync mode 'replace_sophic' to 'replace_bread'
-- ("GitHub wins": replace Bread's copy with the repo's). Constraints are
-- swapped in one transaction around the data rewrite.

alter table public.github_hosted_docs_sources
  drop constraint github_hosted_docs_sources_pending_sync_mode_check;
alter table public.monitored_repos
  drop constraint monitored_repos_hosted_docs_last_sync_mode_check,
  drop constraint monitored_repos_hosted_docs_sync_mode_check;

update public.github_hosted_docs_sources
   set pending_sync_mode = 'replace_bread'
 where pending_sync_mode = 'replace_sophic';

update public.monitored_repos
   set hosted_docs_last_sync_mode = 'replace_bread'
 where hosted_docs_last_sync_mode = 'replace_sophic';

update public.monitored_repos
   set hosted_docs_sync_mode = 'replace_bread'
 where hosted_docs_sync_mode = 'replace_sophic';

update public.documents
   set source_metadata = jsonb_set(source_metadata, '{github_hosted_checkpoint_mode}', '"replace_bread"')
 where source_metadata->>'github_hosted_checkpoint_mode' = 'replace_sophic';

alter table public.github_hosted_docs_sources
  add constraint github_hosted_docs_sources_pending_sync_mode_check
  check (pending_sync_mode = any (array['merge'::text, 'replace_bread'::text]));
alter table public.monitored_repos
  add constraint monitored_repos_hosted_docs_last_sync_mode_check
  check (hosted_docs_last_sync_mode = any (array['merge'::text, 'replace_bread'::text])),
  add constraint monitored_repos_hosted_docs_sync_mode_check
  check (hosted_docs_sync_mode = any (array['merge'::text, 'replace_bread'::text]));
