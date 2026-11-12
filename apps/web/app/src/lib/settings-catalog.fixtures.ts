/**
 * Probe fixture for settings semantic-search regression coverage.
 *
 * Each row is a (query, expected catalog id) pair. The probe set is sized to
 * cover both keyword-driven hits ("dark mode" → preferences via the `dark`
 * keyword) and pure-semantic hits ("make the screen darker" → preferences
 * with no shared substring). When tuning the catalog, run
 * `npm run regen-settings-embeddings` and the fixture-based test will
 * exercise the whole probe set against the freshly committed embeddings.
 */

export interface SettingsProbe {
  query: string
  expectedId: string
  /** Hint for which path is expected to win — drives a sanity assertion in tests. */
  expectedPath: "keyword" | "semantic"
}

export const SETTINGS_PROBES: readonly SettingsProbe[] = [
  // Profile
  { query: "change my password", expectedId: "profile", expectedPath: "keyword" },
  { query: "update my email", expectedId: "profile", expectedPath: "keyword" },
  { query: "change my display name", expectedId: "profile", expectedPath: "keyword" },

  // Preferences (theme is the canonical use case)
  { query: "dark mode", expectedId: "preferences", expectedPath: "keyword" },
  { query: "switch to dark theme", expectedId: "preferences", expectedPath: "keyword" },
  { query: "light mode", expectedId: "preferences", expectedPath: "keyword" },
  { query: "make the screen darker", expectedId: "preferences", expectedPath: "semantic" },
  { query: "change appearance", expectedId: "preferences", expectedPath: "keyword" },

  // Workspace
  { query: "rename workspace", expectedId: "workspace", expectedPath: "keyword" },
  { query: "delete workspace", expectedId: "workspace", expectedPath: "keyword" },

  // Members
  { query: "invite a teammate", expectedId: "members", expectedPath: "keyword" },
  { query: "manage team members", expectedId: "members", expectedPath: "keyword" },
  { query: "change member role", expectedId: "members", expectedPath: "keyword" },

  // Integrations
  { query: "openapi spec", expectedId: "integrations.openapi", expectedPath: "keyword" },

  // Developer
  { query: "create webhook", expectedId: "developer", expectedPath: "keyword" },
  { query: "oauth setup", expectedId: "developer", expectedPath: "keyword" },
]
