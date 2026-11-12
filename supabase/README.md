# Supabase

Database schema for the Breeze build (Bread). Hosted project ref: `jzpefsnshwsvxveavviz`.

## Layout

- `config.toml`: Supabase CLI config, for local dev only.
- `migrations/`: the schema history. `20261112210000_baseline.sql` is the full schema as of 2026-11-12. It replaces the old migration chain. Every later change gets its own migration after it.

## Making a schema change

1. `npm run db:migration:new -- <name>`, then write the SQL. Prefer idempotent statements (`if not exists`, `create or replace`, `drop policy if exists`).
2. Preview it: `npm run db:push:dry`
3. Apply it: `npm run db:push`

Don't edit the schema in the dashboard's SQL or Table editor. Don't edit a migration once it's applied; add a new one instead.

## Linking the CLI

```bash
npm run supabase -- login
npm run supabase -- link --project-ref jzpefsnshwsvxveavviz
```

`supabase/.temp` holds the link and is gitignored. Never commit tokens or database passwords.

## Settings that live outside migrations

Set these in the dashboard on any hosted project:

- **Authentication → Hooks → Before User Created:** `public.before_user_created_breeze_only`. Without it, the `enforce_breeze_auth_email` trigger still blocks non-Breeze signups, but users get a generic error.
- **Authentication → Hooks → Customize Access Token:** `public.mcp_access_token_hook`, if MCP OAuth is in use.
