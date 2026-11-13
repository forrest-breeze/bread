# `@bread/app` — the docs hosting app

Docs hosting: an editor for documents and folders, GitHub-hosted docs sync, published
portals with search, custom domains (including sub-folder mounts through the Cloudflare
Worker in `templates/cloudflare-portal-subfolder-proxy`), workspaces, and billing.

Next.js 16 (App Router), React 19, Tailwind 4, on port 3001 in development.

## Layout

- `src/app/api/` — route handlers: `documents/`, `folders/`, `portal/`, `public/`,
  `github/`, `cloudflare/`, `import/`, `search/`, `v1/` (API-key REST API),
  `workspace/`.
- `src/lib/` — domain logic: `db/workspace.ts` (workspace resolution), `portal/` (portal
  layout, publishing, analytics), `github/` (App JWT, installation tokens, hosted-docs
  sync), `import/` (Notion, Confluence, Obsidian, website), `security/token-crypto.ts`
  (AES-256-GCM integration-token encryption), `billing/` (plan limits; all
  workspaces get full access), `embeddings.ts`.
- `src/rag/` — retrieval and ingestion glue (`retrieve.ts`, `ingest.ts`).
- `src/tiptap/extensions/` — editor extensions.
- `src/components/`, `src/hooks/` — UI and client hooks. `hooks/swr.ts` is the sanctioned
  way to fetch workspace-scoped data.
- `src/proxy.ts` — the middleware (Next 16 renamed `middleware.ts` to `proxy.ts`; its
  absence is not evidence of a dormant proxy).
- `scripts/` — one-off maintenance scripts. Run them with
  `npx tsx --conditions=react-server`; see `.claude/CLAUDE.md` for why.

## The rules that bite

- **Workspace-scope every query.** Resolve with `getActiveWorkspace()`
  (`src/lib/db/workspace.ts`); never `workspace_members.limit(1).single()`. On the
  frontend use the SWR hooks so data refetches on workspace switch.
- **Auth-gate every route.** Call `requireRouteUser()` (`@/lib/auth/route-auth`) and
  return its `response` before touching data.
- **Pick the right Supabase client.** `@/lib/supabase/client` (browser),
  `@/lib/supabase/server` (server / routes), `@/lib/supabase/admin` (service role,
  server-only, sparingly).

## Tests

`npx vitest run --root apps/web/app`. Running Vitest from the repo root discovers suite
copies under `.claude/worktrees` and reports spurious `@/` import-resolution failures.

## Breeze internal setup (toy project)

This build is a Breeze internal demo. Use it with fake data only: under the
Internal Tool Review Policy, anything touching real merchant/customer data, or
storing real data, needs an IT/Security review (Linear IT ticket, 7 questions)
first.

### What is different from upstream

- **Breeze accounts only.** Sign-in is Google or an email link, limited to
  `@breeze.com` and `@breeze.cash`. Enforced in the database by
  `supabase/migrations/20261112200000_restrict_auth_users_to_breeze.sql` (a
  trigger on `auth.users` plus a `before_user_created` hook), and again on every
  request in `src/lib/auth/allowed-email.ts` (route auth, server renders, the
  session proxy, the auth callback, Supabase bearer tokens). No GitHub login.
- **No AI subprocessors.** Embeddings (`src/lib/embeddings.ts`) return `null`
  and make no network call; search is keyword-only (title match,
  `grep_documents`, and the full-text lane of
  `match_document_section_chunks_hybrid`, see
  `20261112200100_embeddings_optional_keyword_search.sql`). The portal agent,
  "Ask AI", translation and AI website synthesis were removed; website import
  saves crawled pages verbatim. The `ai` / `@ai-sdk/*` packages are gone.
- **Vercel, not Netlify.** `vercel.json` in this folder; hosted-docs sync runs
  under `after()` with `maxDuration = 300`.

### Supabase (a new, Breeze-owned project)

1. Create the project in Breeze's Supabase org, not a personal account.
2. `npx supabase link` then `npm run db:push` from the repo root.
3. Authentication → Hooks: enable **Before User Created** →
   `public.before_user_created_breeze_only`. (The trigger blocks non-Breeze
   signups even without it; the hook gives a readable error.)
4. Authentication → Providers: enable **Google** (OAuth client from IT, not from
   the prod GCP project) and **Email**. Leave every other provider off.
5. Authentication → URL Configuration: set Site URL to the Vercel URL and add
   `https://<your-domain>/auth/callback` to the redirect allow-list.
6. Use the new API keys (publishable `sb_publishable_…`, secret `sb_secret_…`).

### Vercel

1. From the repo root: `npx vercel link` and pick the **Breeze** team.
2. Project Settings → General → Root Directory: `apps/web/app`.
3. Keep Deployment Protection (Vercel Authentication) on.
4. Add the environment variables below, then `npm run deploy:preview` or
   `npm run deploy:prod`.
5. The cron jobs are GitHub Actions (`.github/workflows/cron-*.yml`); point their
   app-URL secret at the Vercel URL and set the same `CRON_SECRET` in both.

### Environment variables

Required:

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…`. Must keep the `NEXT_PUBLIC_` prefix. |
| `SUPABASE_SECRET_KEY` | `sb_secret_…`. Server only; never `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_APP_URL` | The deployed URL, e.g. `https://<project>.vercel.app`. |
| `CRON_SECRET` | `openssl rand -hex 32`. Only if the cron workflows run. |

Optional: `BREAD_TOKEN_ENC_KEY` (needed to connect token-based integrations),
the `GITHUB_APP_*` set (GitHub docs sync), `LOGIN_ACCESS_CODE`.

GitHub docs sync replaces ReadMe's GitHub integration: it reads and writes the
same repository layout, and ties `reference/` definitions to the OpenAPI
integration. Setup, behaviour and limits are in
`docs/development/github-readme-sync.md`.

Leave unset for the demo (each is an extra third party): every AI key (Gemini,
DeepSeek, Kimi, OpenAI, Anthropic, OpenRouter, Groq), PostHog, Resend,
Upstash, S3/R2 and the Cloudflare OAuth client. There is no billing: every
workspace has full access.

Local dev: put these in `apps/web/app/.env.local` (Next.js does not read the
repo-root `.env.local`).
