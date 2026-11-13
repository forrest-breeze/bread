# GitHub bidirectional sync (ReadMe format)

A workspace can be linked to a GitHub repository in the layout ReadMe's GitHub
integration reads and writes. Pushes to the repository update the workspace;
changes made in the workspace are published back as commits. A repository that
ReadMe has been syncing can be linked as it is, with no conversion step.

This sits beside the older Breezify-format link (strict `breezify_document_id`
frontmatter, pull-request publishing). A workspace has one link, in one format.

Code: `apps/web/app/src/lib/github/readme/`. UI: Settings → Integrations →
GitHub.

## Repository layout

```
docs/_order.yaml                     order of the guide categories
docs/<Category>/_order.yaml          order of the pages in a category
docs/<Category>/<page>.md            a page; the file name is its URL slug
docs/<Category>/<page>/index.md      a page that has child pages
reference/<name>.json|.yaml          OpenAPI / Swagger definitions
reference/**/*.md                    reference pages
recipes/  custom_pages/  changelogs/
```

| Repository | Workspace |
| --- | --- |
| A folder in `docs/` | Top-level folder. The name is kept as written (`Core Integration Guide`), or prettified when it is a slug. |
| A loose page in `docs/` | Document with no folder. |
| `reference/`, `recipes/`, `custom_pages/`, `changelogs/` | One top-level folder each, created only when it holds pages. |
| `<dir>/index.md` | The folder's landing content; its `title` is the folder name. |
| `_order.yaml` | `sort_order` of folders and documents. |
| `title` | Document title. A file without one is titled from its file name. |
| `hidden: true` | Status `Draft`; otherwise `Published`. |
| `slug` | Public slug, falling back to the file name. Made unique per workspace. |
| `date` (changelog) | Publication date. |
| Every other key (`excerpt`, `metadata`, `next`, `deprecated`, `icon`, `link`, ...) | Stored and written back unchanged. Not interpreted. |

Left alone in the repository, never imported, rewritten or deleted:

- API reference stubs (frontmatter `api.file` / `api.operationId` /
  `api.webhook`), the empty `index.md` and the `_order.yaml` files ReadMe
  generates for each tag. Breezify builds the API reference from the definition.
- ReadMe's reference settings pages (`api_config: ...`).
- `custom_blocks/`, `.html` custom pages, and anything outside the sections.

## How a sync works

Repository → workspace runs on the GitHub push webhook, on the scheduled sweep,
and when Settings is opened with a newer commit on the branch.

- Only blobs whose SHA changed since the last sync are downloaded.
- A page changed only on GitHub replaces the workspace copy; the previous
  version is kept in the document's history.
- A page changed on both sides is a **conflict**: Breezify keeps its version and
  flags the document. Publishing asks before overwriting GitHub; "Use GitHub"
  takes the repository's version everywhere.
- A renamed or moved file keeps its document (matched by identical content,
  then by file name).
- A file deleted on GitHub removes its document, unless the document was edited
  in Breezify, in which case it is kept and flagged.
- A document deleted in Breezify is not imported again by a later push; its file
  is removed by the next publish.
- A file that cannot be read (invalid YAML frontmatter, too large) is skipped
  and listed in Settings. It never fails the sync or removes a document.

Workspace → repository happens when someone publishes from the workspace's
GitHub control.

- **Commit directly** (default): one commit on the synced branch, as ReadMe
  does. A protected branch must let the Breezify GitHub App bypass its rules.
- **Open a pull request**: changes go to a `breezify/readme-sync-*` branch and one
  pull request, which later publishes extend. Merging it links the new pages.

A page nobody edited in Breezify is never rewritten. An edited page is written as
frontmatter (unchanged except `title`, `hidden`, and a changelog `date`) plus
the Markdown from the editor. New folders and pages are written under `docs/`.
Reordering rewrites `_order.yaml`, keeping entries Breezify does not mirror.
Folders restricted to some workspace roles are never written to GitHub.

Publishing is refused while GitHub has commits Breezify has not pulled yet.

## OpenAPI

Definitions in `reference/` (JSON or YAML) go through the same source sync as
`PUT /api/v1/openapi/<name>` and appear under Settings → Integrations → OpenAPI.

- The source name is the file name (`reference/openapi.json` → `openapi`). If
  exactly one already-uploaded source has the same `info.title`, the file is
  linked to that source instead, so the API reference is not duplicated.
- An upload (CI or Settings) is committed to the file the source is linked to,
  or to `reference/<name>.json|yaml` for a new one. The response reports it
  under `github`. The file keeps its format: a JSON upload to a YAML file is
  written as YAML. In pull-request mode the file is part of the next publish.
- Deleting a source deletes its file. Deleting the file removes the source.
- The upload endpoints now accept YAML as well as JSON.

## Setup

1. Apply `supabase/migrations/20261113120000_readme_github_sync.sql`. It is
   idempotent and creates `openapi_sources` if the database does not have it
   yet (the migration that introduced that table is dated before the baseline,
   so `supabase db push` only applies it with `--include-all`).
2. GitHub App: repository permissions **Contents** read and write,
   **Pull requests** read and write, **Metadata** read. Subscribe to **Push**
   and **Pull request** events, webhook URL `<app>/api/github/webhook`. Set the
   `GITHUB_APP_*` variables and `GITHUB_WEBHOOK_SECRET`.
3. If ReadMe was syncing the repository, remove ReadMe's GitHub App from it
   first so two integrations are not both writing.
4. Settings → Integrations → GitHub: connect, choose the repository, the branch
   (empty follows the default branch) and the folder (empty is the repository
   root), and how to publish.

## Differences from ReadMe

- One branch per workspace. ReadMe maps every branch to a docs version; here
  the link follows one branch, and other branches are ignored.
- ReadMe's MDX components (`<Callout>`, `<Tabs>`, `<Anchor>`, `<Image>`,
  `<Table>`) and legacy magic blocks are converted to Markdown when imported.
  A page keeps its components in the repository until it is edited in Breezify;
  from then on it is written back as plain Markdown.
- Breezify does not create the per-operation stub pages ReadMe writes into
  `reference/`, and Markdown added to a stub is not shown.
- No per-file revert, and conflicts are resolved for the whole workspace
  (publish with Breezify winning, or "Use GitHub"), not per document.
- Limits: 1,000 pages, 512 KB per page, 2 MB and 500 operations per definition.

## Tests

`npx vitest run src/lib/github/readme` from `apps/web/app`. The round-trip tests
run the real sync and publish code against an in-memory repository and
workspace (`src/test/readme-sync-fixtures.ts`).

To check against a checkout of a real ReadMe-synced repository:

```
README_SYNC_FIXTURE_DIR=/path/to/checkout npx vitest run \
  src/lib/github/readme/readme-real-repository.test.ts --silent=false
```

It asserts that after importing the repository Breezify wants to change nothing in
it, and that editing one page changes exactly one file.
