-- One portal per workspace, served at the workspace root (/p/<workspace>).
--
-- Portals created before this change got a slug with a random suffix (e.g.
-- "breeze-8tfg"), so nothing lived at the root and a "primary project" setting
-- redirected /p/<workspace> to it. That setting is gone. This migration moves
-- each workspace's portal project to the root by renaming its slug to the
-- workspace slug, and clears the old setting.
--
-- Only touches a workspace that has exactly ONE portal project slug and no
-- project at the root yet, so it can never merge two portals or overwrite one.

with candidates as (
  select e.workspace_id, w.slug as root_slug, min(e.slug) as old_slug
  from public.workspace_experiences e
  join public.workspaces w on w.id = e.workspace_id
  where e.kind = 'kb'
    and e.audience = 'public'
    and e.slug is not null
  group by e.workspace_id, w.slug
  having count(distinct e.slug) = 1
     and min(e.slug) <> w.slug
),
moved_experiences as (
  update public.workspace_experiences e
  set slug = c.root_slug, updated_at = now()
  from candidates c
  where e.workspace_id = c.workspace_id
    and e.kind = 'kb'
    and e.audience = 'public'
    and e.slug = c.old_slug
  returning e.workspace_id
),
moved_routes as (
  update public.portal_domain_routes r
  set project_slug = c.root_slug
  from candidates c
  where r.workspace_id = c.workspace_id
    and r.project_slug = c.old_slug
  returning r.workspace_id
)
update public.conversations v
set project_slug = c.root_slug
from candidates c
where v.workspace_id = c.workspace_id
  and v.project_slug = c.old_slug;

-- The "primary project" redirect setting no longer exists.
update public.workspaces
set settings = settings - 'kb_primary_project'
where settings ? 'kb_primary_project';
