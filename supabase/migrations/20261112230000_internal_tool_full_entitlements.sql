-- Bread is now an internal tool: Stripe billing, plans and trials are removed.
-- The plan-limit triggers (enforce_free_document_limit, enforce_kb_capacity,
-- media storage quota) still read `subscriptions`, so give every workspace the
-- top (enterprise) row and make that the default for new rows.

alter table public.subscriptions alter column tier set default 'enterprise';
alter table public.subscriptions alter column plan_id set default 'enterprise';

update public.subscriptions
   set tier = 'enterprise',
       plan_id = 'enterprise',
       status = 'active',
       billing_interval = null,
       updated_at = now();

-- Backfill a row for any workspace that has none.
insert into public.subscriptions (workspace_id, tier, plan_id, status)
select w.id, 'enterprise', 'enterprise', 'active'
  from public.workspaces w
 where not exists (
   select 1 from public.subscriptions s where s.workspace_id = w.id
 );
