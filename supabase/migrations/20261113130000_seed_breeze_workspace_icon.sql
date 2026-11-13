-- Seed the Breeze icon as the workspace logo.
--
-- Breezify hosts only Breeze's docs. Workspaces with no uploaded icon get the
-- official Breeze icon (apps/web/app/public/breeze-icon.png, from the Breeze
-- brand guide). The app serves it at /breeze-icon.png; public portals make it
-- absolute on NEXT_PUBLIC_APP_URL so it also loads on custom domains.
--
-- Only NULL icons are touched, so an uploaded logo is never overwritten.
-- Removing the icon in Settings clears it back to NULL and it is not re-seeded.

update public.workspaces
set icon_url = '/breeze-icon.png',
    updated_at = now()
where icon_url is null;
