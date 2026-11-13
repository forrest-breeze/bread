# Workflows

One file per pipeline, named `<kind>-<surface>.yml`, with a matching
`name: "<Kind>: <surface>"` so the Actions tab and PR checks read the same way.

| Kind | Purpose | Trigger |
| :--- | :--- | :--- |
| `ci-*` | Verify a surface on every PR and push to `main` | `pull_request`, `push` |
| `release-*` | Publish a surface from a tag | `push` on `<surface>-v*` tags |
| `cron-*` | Scheduled heartbeats and automations | `schedule` (+ `workflow_dispatch`) |
| `bot-*` | Repo automation that reacts to people | issue / PR events |

Surfaces follow the repo layout in the root `README.md`: `workspaces` is
everything Turbo manages (`apps/*`, `packages/*`); `kb` is the
deployed knowledge-base app (`apps/web/app`).

| Workflow | What it does | Secrets |
| :--- | :--- | :--- |
| `ci-workspaces.yml` | Lint for packages affected since the base commit (`turbo --affected`) | — |
| `cron-kb-media-gc.yml` | Daily POST to the production `/api/cron/media-gc` | `BREEZIFY_APP_URL`, `CRON_SECRET` |
| `bot-claude.yml` | Runs Claude Code on `@claude` mentions | `CLAUDE_CODE_OAUTH_TOKEN` |

## Shared setup

Composite actions in `../actions/` keep install steps identical across jobs:

- `setup-workspaces` — Node 22, Turbo cache, `npm ci`, Linux native bindings.
  Use for anything in the npm workspaces.

## Adding a surface

1. Add `ci-<surface>.yml` with a `paths` filter if the surface is outside the
   Turbo graph; inside it, `ci-workspaces.yml` already covers it via
   `--affected`.
2. If it ships somewhere, add `release-<surface>.yml` on `<surface>-v*` tags.
   Tags are prefixed because the repo holds more than one releasable thing.
3. Put install steps in a composite action under `../actions/` rather than
   copying them between jobs.
4. Add a row to the table above.

## Gotchas

- Renaming a workflow file changes the check name in branch protection
  (`<workflow name> / <job name>`); update required status checks to match.
- Cron minutes are deliberately off the hour: GitHub's scheduler drops
  round-time events under load.
- Secrets are not exposed to pull requests from forks; jobs that need them
  skip themselves rather than fail.
