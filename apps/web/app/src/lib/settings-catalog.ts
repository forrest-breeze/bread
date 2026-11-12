/**
 * Settings catalog — destinations the command palette can jump to.
 *
 * Entries describe top-level settings pages and integration sub-pages. Each
 * entry's `label + description + keywords` is embedded once via the
 * `regen-settings-embeddings` npm script and committed to
 * `settings-catalog.embeddings.json`. Search-time matching combines two
 * paths against this catalog (see `settings-search.ts`):
 *
 *   - Keyword substring path (cheap, deterministic, score = 0.95 on hit).
 *     Lets us highlight the matched substring in the rendered row.
 *   - Semantic cosine path (catches phrasings keywords don't anticipate).
 *
 * Final per-entry score is `Math.max(cosine, keywordHit ? 0.95 : 0)`. Keyword
 * hits always pass; pure-semantic hits must clear `SETTINGS_SEMANTIC_THRESHOLD`.
 * If a probe falls below threshold, *widen the entry's keywords* before
 * lowering the threshold — keyword wins always score 0.95 and never need tuning.
 */

export interface SettingsEntry {
  /** Stable identifier for telemetry, fixtures, and dedup with server settings. */
  id: string
  /** Displayed label in the result row. */
  label: string
  /** Route the palette navigates to on activation. */
  href: string
  /** Subtitle text under the label; also fed into the embedding source. */
  description: string
  /** Synonym haystack for the substring-match path. */
  keywords: string[]
  /** Optional crumb for sub-pages, rendered as muted "Settings › Integrations › Slack". */
  breadcrumb?: string[]
}

export const SETTINGS_CATALOG: readonly SettingsEntry[] = [
  {
    id: "profile",
    label: "Profile",
    href: "/settings/profile",
    description: "Your name, email, password, and account info",
    keywords: [
      "profile",
      "name",
      "email",
      "password",
      "account",
      "avatar",
      "photo",
      "bio",
    ],
  },
  {
    id: "preferences",
    label: "Preferences",
    href: "/settings/preferences",
    description: "Visual theme, appearance, and personal display preferences",
    keywords: [
      "preferences",
      "theme",
      "dark",
      "light",
      "mode",
      "appearance",
      "color",
      "colour",
      "display",
      "night",
      "system",
      "ui",
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    href: "/settings/workspace",
    description: "Workspace name, slug, and icon",
    keywords: [
      "workspace",
      "org",
      "organization",
      "rename",
      "slug",
      "icon",
    ],
  },
  {
    id: "members",
    label: "Members",
    href: "/settings/workspace/members",
    description: "Workspace members, roles, and invites",
    keywords: [
      "team",
      "member",
      "members",
      "invite",
      "invites",
      "role",
      "roles",
      "permissions",
      "add user",
      "remove user",
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    href: "/settings/integrations",
    description: "Publish API reference from OpenAPI",
    keywords: ["integrations", "connect", "connections", "apps", "install"],
  },
  {
    id: "integrations.openapi",
    label: "OpenAPI",
    href: "/settings/integrations/openapi",
    description: "Publish API reference pages from an OpenAPI spec",
    keywords: ["openapi", "swagger", "api reference", "readme", "spec", "endpoints"],
  },
  {
    id: "developer",
    label: "Developer",
    href: "/settings/developer",
    description: "API keys, webhooks, and developer tooling",
    keywords: [
      "developer",
      "api",
      "api key",
      "token",
      "webhook",
      "webhooks",
      "oauth",
    ],
  },
  {
    id: "trash",
    label: "Trash",
    href: "/settings/trash",
    description: "View, restore, or permanently delete notes moved to trash",
    keywords: [
      "trash",
      "deleted",
      "deleted notes",
      "restore",
      "restore note",
      "recover",
      "recover note",
      "permanently delete",
    ],
  },
]

/**
 * Cosine threshold for **pure-semantic** matches (no keyword hit). Set high
 * enough that off-topic queries don't drag in 5 unrelated entries via the
 * semantic path. Relevant semantic matches typically sit at 0.65+; unrelated
 * queries (e.g., "linear" against this catalog) cluster in the 0.45–0.6 band
 * and should be filtered out.
 *
 * Keyword-path hits score 0.95+ and bypass this threshold entirely, so a
 * failing probe should be fixed by adding keywords, not by lowering this.
 */
export const SETTINGS_SEMANTIC_THRESHOLD = 0.65

/**
 * Maximum settings results returned per query. Five matches the existing
 * knowledge `limit=5` default and keeps the rendered section compact.
 */
export const SETTINGS_MATCH_LIMIT = 5

/**
 * The string fed to Gemini at regen time to produce an entry's embedding.
 * Stable order: label, description, keywords joined by space. Drift hash
 * is computed over these strings (NOT the full catalog), so changes to
 * `href` or `breadcrumb` don't trigger needless regenerations.
 */
export function getEmbeddingSource(entry: SettingsEntry): string {
  return `${entry.label}\n${entry.description}\n${entry.keywords.join(" ")}`
}
