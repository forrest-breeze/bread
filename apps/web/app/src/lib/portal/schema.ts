import { z } from "zod"
import { isSafeHref } from "@/lib/portal/href"
import { dslNodeStructuralSchema } from "@/lib/portal/dsl/node"
import { compositeDefSchema } from "@/lib/portal/dsl/composites"
import { validateDslTree } from "@/lib/portal/dsl/validate"
import { portalScopeEntrySchema } from "@/lib/validation/primitives"

// ---------------------------------------------------------------------------
// Public KB portal layout schema.
//
// The portal renders from a validated, versioned block layout (PortalLayout).
// Phase 1 only ever renders the layout produced by `buildDefaultPortalLayout`,
// but every render still flows through this schema so the contract is fixed:
// when persisted/agent-edited layouts land (see
// docs/plans/public-kb-portal-builder-prd.md), they validate against the same
// shapes before rendering. Unknown block types / unsafe hrefs are rejected here,
// before anything reaches the DOM.
//
// This is the Phase-1 standalone home for the spec. When the umbrella
// `workspace_experiences` infra ships, PortalLayout serializes into a
// WorkspaceExperienceSpec (kind:"kb", audience:"public") row; the block shapes
// below remain the source of truth for the portal renderer.
// ---------------------------------------------------------------------------

export const PORTAL_SCHEMA_VERSION = 1 as const
// v2 adds the optional open-ended DSL `tree` (+ `components`, `enabledPacks`)
// and `theme.tokens` additively. v1 layouts are unchanged and still validate;
// the bump is what flags a layout as carrying a tree.
export const PORTAL_SCHEMA_VERSION_V2 = 2 as const

export const PORTAL_TRANSLATION_LANGUAGES = ["es", "fr", "zh"] as const
export type PortalTranslationLanguage =
  (typeof PORTAL_TRANSLATION_LANGUAGES)[number]
export const PORTAL_LANGUAGES = ["en", ...PORTAL_TRANSLATION_LANGUAGES] as const
export type PortalLanguage = (typeof PORTAL_LANGUAGES)[number]

// Allowlisted icons the renderer can resolve to a lucide component. Stored as a
// name (never an arbitrary component) so a layout is pure, serializable data.
export const PORTAL_ICONS = [
  "file-text",
  "folder",
  "hash",
  "book-open",
  "pen-line",
  "sparkles",
  "compass",
  "puzzle",
  "life-buoy",
  "graduation-cap",
  "layers",
  "search",
  "terminal",
  "credit-card",
  "shield-check",
  "chart-no-axes-combined",
  "messages-square",
  "send",
  "building-2",
  "mouse-pointer-click",
  "upload",
  "link",
  "refresh-ccw",
  // Callout (admonition) tone icons.
  "info",
  "triangle-alert",
  "circle-check",
  "octagon-alert",
] as const
export type PortalIconName = (typeof PORTAL_ICONS)[number]

// Icons are now a FREE string (resolved to a lucide component at render with a
// FileText fallback — see dsl/icon.tsx). PORTAL_ICONS stays exported as the
// RECOMMENDED list (the agent prompt + the picker prefer it) but is no longer
// enforced; unknown names degrade gracefully.
const iconSchema = z.string().min(1).max(60)

// Re-exported from `./href` (extracted so the DSL registry/validator can share
// the same-origin/http(s) guard without an import cycle through this module).
// The header/footer chrome imports this to defensively filter nav/cta/footer
// hrefs rendered outside the validated body.
export { isSafeHref }

const hrefSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isSafeHref, "href must be a same-origin path or an http(s) URL")

const navLinkSchema = z.object({
  label: z.string().min(1).max(60),
  href: hrefSchema,
})
export type NavLink = z.infer<typeof navLinkSchema>

const portalAssistantSchema = z.object({
  enabled: z.boolean().default(false),
  placement: z.enum(["header", "corner"]).default("corner"),
  label: z.string().min(1).max(60).default("Ask AI"),
})
export type PortalAssistant = z.infer<typeof portalAssistantSchema>

// ----- placement (drives the 2-column body layout; see PortalRenderer) -------
const placementSchema = z.enum(["full", "main", "aside"]).default("full")
export type BlockPlacement = z.infer<typeof placementSchema>

// ----- singleton chrome blocks ----------------------------------------------
const headerSearchSchema = z.object({
  enabled: z.boolean().default(true),
  placeholder: z.string().max(120).default("Search or ask AI"),
})

export const PORTAL_HEADER_ITEMS = ["links", "cta", "language"] as const
export type PortalHeaderItem = (typeof PORTAL_HEADER_ITEMS)[number]
export const DEFAULT_PORTAL_HEADER_ITEM_ORDER: PortalHeaderItem[] = [
  "links",
  "cta",
  "language",
]

export const PORTAL_LANGUAGE_PLACEMENTS = ["actions", "brand"] as const
export type PortalLanguagePlacement =
  (typeof PORTAL_LANGUAGE_PLACEMENTS)[number]
export const DEFAULT_PORTAL_LANGUAGE_PLACEMENT: PortalLanguagePlacement =
  "actions"

const headerItemOrderSchema = z
  .array(z.enum(PORTAL_HEADER_ITEMS))
  .length(PORTAL_HEADER_ITEMS.length)
  .refine((items) => new Set(items).size === PORTAL_HEADER_ITEMS.length, {
    message: "itemOrder must contain links, cta, and language exactly once",
  })

const headerBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal("portal-header"),
  search: headerSearchSchema.default({ enabled: true, placeholder: "Search or ask AI" }),
  // Optional for layouts published before header items became reorderable.
  // The renderer resolves an omitted value to DEFAULT_PORTAL_HEADER_ITEM_ORDER.
  itemOrder: headerItemOrderSchema.optional(),
  // Optional for layouts published before the selector could move beside the
  // brand. "actions" keeps the historical far-right placement.
  languagePlacement: z.enum(PORTAL_LANGUAGE_PLACEMENTS).optional(),
})
export type HeaderBlock = z.infer<typeof headerBlockSchema>

export const storedHeaderSchema = z
  .object({
    search: headerSearchSchema.optional(),
    navLinks: z.array(navLinkSchema).max(8).optional(),
    cta: navLinkSchema.nullable().optional(),
    itemOrder: headerItemOrderSchema.optional(),
    languagePlacement: z.enum(PORTAL_LANGUAGE_PLACEMENTS).optional(),
  })
  .strict()
export type StoredHeader = z.infer<typeof storedHeaderSchema>

export function parseStoredHeader(input: unknown): StoredHeader | null {
  const result = storedHeaderSchema.safeParse(input)
  if (!result.success) return null
  const data = result.data
  if (
    !data.search &&
    data.navLinks === undefined &&
    data.cta === undefined &&
    data.itemOrder === undefined &&
    data.languagePlacement === undefined
  ) {
    return null
  }
  return data
}

const sidebarItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(160),
  href: hrefSchema,
})
export type SidebarItem = z.infer<typeof sidebarItemSchema>

export interface SidebarGroup {
  id: string
  label: string
  icon?: string
  href?: string
  items: SidebarItem[]
  children?: SidebarGroup[]
}

const sidebarGroupSchema: z.ZodType<SidebarGroup> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    label: z.string().min(1).max(80),
    icon: iconSchema.optional(),
    href: hrefSchema.optional(),
    items: z.array(sidebarItemSchema).max(100),
    children: z.array(sidebarGroupSchema).max(30).optional(),
  }),
)

const sidebarBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal("sidebar-nav"),
  groups: z.array(sidebarGroupSchema).max(30),
  // Whether root groups render their icons. Unset falls back to the template's
  // default (docs hides them, help/default show them); explicit values win in
  // both directions. Persists through the folder-driven sidebar regeneration.
  showIcons: z.boolean().optional(),
})
export type SidebarBlock = z.infer<typeof sidebarBlockSchema>

// Per-folder presentation overrides, keyed by folder id (a sidebar group's id
// IS its folder id). Folder-driven surfaces are regenerated from the folder
// tree on every render — the nav rail's groups and the home page's generated
// category cards both — so an icon or label edited in place is overwritten on
// the next normalize. An override re-icons / relabels the folder on every one
// of those surfaces and PERSISTS through the regeneration (applied by
// build-default's normalize). This is what makes them agent-editable without
// breaking folder sync.
const sidebarOverrideSchema = z
  .object({
    icon: z.string().min(1).max(60).optional(),
    label: z.string().min(1).max(80).optional(),
  })
  .strict()
export type SidebarOverride = z.infer<typeof sidebarOverrideSchema>

// Recognized social platforms for the footer social row. Each maps to an icon
// in PortalFooter.
export const FOOTER_SOCIAL_PLATFORMS = [
  "x",
  "linkedin",
  "github",
  "youtube",
  "instagram",
] as const
export type FooterSocialPlatform = (typeof FOOTER_SOCIAL_PLATFORMS)[number]

// One labeled column of links in the rich (multi-column) footer — e.g.
// "Resources" → [Docs, Blog, Pricing]. Mirrors a marketing-site footer column.
const footerColumnSchema = z.object({
  heading: z.string().min(1).max(60),
  links: z.array(navLinkSchema).max(12),
})
export type FooterColumn = z.infer<typeof footerColumnSchema>

const footerSocialSchema = z.object({
  platform: z.enum(FOOTER_SOCIAL_PLATFORMS),
  href: hrefSchema,
})
export type FooterSocial = z.infer<typeof footerSocialSchema>

// Social list that silently drops entries for platforms we no longer support
// (e.g. facebook/bluesky/website saved before they were removed), so an old
// stored footer or layout keeps validating instead of being rejected wholesale.
const footerSocialListSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter(
          (entry) =>
            !(entry && typeof entry === "object" && "platform" in entry) ||
            (FOOTER_SOCIAL_PLATFORMS as readonly unknown[]).includes(
              (entry as { platform: unknown }).platform,
            ),
        )
      : value,
  z.array(footerSocialSchema).max(8),
)

// The footer data persisted on a workspace (settings.kb_footer) — the crawled
// columns/social/note, without the block id/type/credit. buildDefaultFooter
// folds this into the rendered FooterBlock. Validated with the SAME column/
// social schemas as the block, so a stored footer can never produce a layout the
// renderer would reject.
export const storedFooterSchema = z.object({
  columns: z.array(footerColumnSchema).max(5).optional(),
  social: footerSocialListSchema.optional(),
  note: z.string().max(200).optional(),
})
export type StoredFooter = z.infer<typeof storedFooterSchema>

/**
 * Validate an untrusted stored-footer value (from workspace settings). Returns
 * null when invalid OR when it carries no columns and no social (nothing to
 * render), so callers can treat "no footer" and "empty footer" the same.
 */
export function parseStoredFooter(input: unknown): StoredFooter | null {
  const result = storedFooterSchema.safeParse(input)
  if (!result.success) return null
  const data = result.data
  if (!data.columns?.length && !data.social?.length && !data.note?.trim()) {
    return null
  }
  return data
}

const footerBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal("footer"),
  note: z.string().max(200).optional(),
  // Legacy flat link row, kept for back-compat. The rich footer prefers
  // `columns`; when present, these render in the slim bottom bar.
  links: z.array(navLinkSchema).max(20).optional(),
  // Multi-column link layout (Image #2 style). When set, PortalFooter renders
  // the rich footer; absent, it renders the slim single-row footer.
  columns: z.array(footerColumnSchema).max(5).optional(),
  // Social/profile links rendered as icons in the rich footer.
  social: footerSocialListSchema.optional(),
  showPoweredBy: z.boolean().default(true),
})
export type FooterBlock = z.infer<typeof footerBlockSchema>

/**
 * Does a footer carry real, renderable content (columns / social / note /
 * legacy links)? The "Powered by Bread" credit alone does NOT count — a portal
 * with no configured footer links renders no footer band at all. Accepts both
 * the rendered FooterBlock and the workspace-level StoredFooter.
 */
export function footerHasContent(
  footer:
    | Pick<FooterBlock, "columns" | "social" | "links" | "note">
    | StoredFooter
    | null
    | undefined,
): boolean {
  if (!footer) return false
  const columns = (footer.columns ?? []).filter((c) =>
    c.links.some((l) => isSafeHref(l.href)),
  )
  const social = (footer.social ?? []).filter((s) => isSafeHref(s.href))
  const links = ("links" in footer ? (footer.links ?? []) : []).filter((l) =>
    isSafeHref(l.href),
  )
  return (
    columns.length > 0 || social.length > 0 || links.length > 0 || !!footer.note?.trim()
  )
}

// ----- body content blocks (discriminated union by `type`) -------------------
const heroBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal("hero"),
  placement: placementSchema,
  eyebrow: z.string().max(80).optional(),
  heading: z.string().min(1).max(160),
  subtitle: z.string().max(300).optional(),
})
export type HeroBlock = z.infer<typeof heroBlockSchema>

const askAiSearchBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal("ask-ai-search"),
  placement: placementSchema,
  placeholder: z.string().max(160).default("Ask, search, or explain…"),
})
export type AskAiSearchBlock = z.infer<typeof askAiSearchBlockSchema>

const categoryItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  description: z.string().max(240).optional(),
  icon: iconSchema.optional(),
  href: hrefSchema,
})
export type CategoryItem = z.infer<typeof categoryItemSchema>

const categoryGridBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal("category-grid"),
  placement: placementSchema,
  items: z.array(categoryItemSchema).max(60),
})
export type CategoryGridBlock = z.infer<typeof categoryGridBlockSchema>

const articleItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  href: hrefSchema,
  description: z.string().max(240).optional(),
  source: z.string().nullable().optional(),
  readTimeMinutes: z.number().int().min(1).max(999).optional(),
  // ISO timestamp of the underlying document's publication (or last update).
  // Only surfaced by the dated "changelog" list variant.
  date: z.string().max(40).optional(),
})
export type ArticleItem = z.infer<typeof articleItemSchema>

const articleListBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal("article-list"),
  placement: placementSchema,
  title: z.string().max(80).optional(),
  // "changelog" renders a dated release feed (month headers + per-entry
  // dates). Absent = the default link list. Layouts stored with the removed
  // "blog" variant read as the default list.
  variant: z.preprocess(
    (value) => (value === "blog" ? undefined : value),
    z.enum(["default", "changelog"]).optional(),
  ),
  items: z.array(articleItemSchema).max(60),
})
export type ArticleListBlock = z.infer<typeof articleListBlockSchema>

const richTextBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal("rich-text"),
  placement: placementSchema,
  // Sanitized again at render time via the shared public-kb-render pipeline.
  html: z.string().max(100_000),
})
export type RichTextBlock = z.infer<typeof richTextBlockSchema>

// Admonition / callout block. `tone` drives the color + icon; `body` is HTML
// re-sanitized at render through the shared public-kb-render denylist (same as
// rich-text). `title` is plain text. Demonstrates the additive-block pattern.
export const CALLOUT_TONES = ["info", "warn", "success", "danger"] as const
export type CalloutTone = (typeof CALLOUT_TONES)[number]

const calloutBlockSchema = z.object({
  id: z.string().min(1),
  type: z.literal("callout"),
  placement: placementSchema,
  tone: z.enum(CALLOUT_TONES).default("info"),
  title: z.string().max(120).optional(),
  body: z.string().min(1).max(20_000),
})
export type CalloutBlock = z.infer<typeof calloutBlockSchema>

export const portalBlockSchema = z.discriminatedUnion("type", [
  heroBlockSchema,
  askAiSearchBlockSchema,
  categoryGridBlockSchema,
  articleListBlockSchema,
  richTextBlockSchema,
  calloutBlockSchema,
])
export type PortalBlock = z.infer<typeof portalBlockSchema>
export type PortalBlockType = PortalBlock["type"]

// Same shape as `portalBlockSchema` but with `id` optional — used by the portal
// agent's addBlock tool. The model is told to omit `id` so addBlock can derive a
// deterministic one; a required-id schema would reject those tool calls before
// they reach addBlock. addBlock validates the full layout (with the derived id)
// against portalBlockSchema, so this looser input never weakens the stored data.
export const portalBlockInputSchema = z.discriminatedUnion("type", [
  heroBlockSchema.extend({ id: z.string().optional() }),
  askAiSearchBlockSchema.extend({ id: z.string().optional() }),
  categoryGridBlockSchema.extend({ id: z.string().optional() }),
  articleListBlockSchema.extend({ id: z.string().optional() }),
  richTextBlockSchema.extend({ id: z.string().optional() }),
  calloutBlockSchema.extend({ id: z.string().optional() }),
])
export type PortalBlockInput = z.infer<typeof portalBlockInputSchema>

// ----- theme tokens ----------------------------------------------------------
// Free-form color / radius / font tokens that re-point the portal's CSS vars
// (--portal-bg, --portal-surface, …). Defensively guarded: a token only ever
// lands in a `--portal-*` CSS variable, never raw CSS, so reject anything that
// could break out of a var value (mirrors sanitize-dom's UNSAFE_STYLE spirit).
const UNSAFE_THEME_TOKEN = /url\(|expression|javascript:|[;}<]|\/\*/i
function isSafeThemeToken(value: string): boolean {
  return !UNSAFE_THEME_TOKEN.test(value)
}
const themeTokenSchema = z
  .string()
  .max(64)
  .refine(isSafeThemeToken, "unsafe theme token value")
const portalThemeTokensSchema = z
  .object({
    bg: themeTokenSchema.optional(),
    surface: themeTokenSchema.optional(),
    text: themeTokenSchema.optional(),
    muted: themeTokenSchema.optional(),
    border: themeTokenSchema.optional(),
    accent: themeTokenSchema.optional(),
    radius: themeTokenSchema.optional(),
    fontFamily: themeTokenSchema.optional(),
  })
  .strict()
export type PortalThemeTokens = z.infer<typeof portalThemeTokensSchema>

// ----- theme customization --------------------------------------------------
// Optional appearance settings layered on the core theme (modeled on what docs
// platforms such as Mintlify expose). Every field is optional so layouts saved
// before they existed keep validating unchanged.

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color like #2f5520")

/** A Google Fonts family name, e.g. "Inter" or "Playfair Display". */
export const portalFontFamilySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/, "must be a Google Fonts family name")

/**
 * A self-hosted font file (https, woff2/woff/ttf/otf). Used instead of Google
 * Fonts for that family, e.g. a licensed brand typeface.
 */
export const portalFontSourceSchema = z
  .string()
  .trim()
  .max(2048)
  .regex(
    /^https:\/\/[^\s"'()]+\.(woff2|woff|ttf|otf)(\?[^\s"'()]*)?$/i,
    "must be an https URL to a .woff2, .woff, .ttf or .otf file",
  )

const portalFontsSchema = z
  .object({
    heading: portalFontFamilySchema.optional(),
    body: portalFontFamilySchema.optional(),
    headingSource: portalFontSourceSchema.optional(),
    bodySource: portalFontSourceSchema.optional(),
    // Fonts the workspace added to the shared heading/body picker. Choosing
    // one copies its file (if any) into headingSource / bodySource.
    custom: z
      .array(
        z
          .object({
            family: portalFontFamilySchema,
            source: portalFontSourceSchema.optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
export type PortalFonts = z.infer<typeof portalFontsSchema>

export const PORTAL_BACKGROUND_DECORATIONS = ["none", "gradient", "grid"] as const
const portalBackgroundSchema = z
  .object({
    light: hexColorSchema.optional(),
    dark: hexColorSchema.optional(),
    decoration: z.enum(PORTAL_BACKGROUND_DECORATIONS).optional(),
  })
  .strict()
export type PortalBackground = z.infer<typeof portalBackgroundSchema>

export const PORTAL_BANNER_TONES = ["brand", "info", "warning", "critical"] as const
const portalBannerSchema = z
  .object({
    text: z.string().trim().min(1).max(240),
    linkLabel: z.string().trim().max(40).optional(),
    linkHref: z.union([z.literal(""), hrefSchema]).optional(),
    tone: z.enum(PORTAL_BANNER_TONES).optional(),
    dismissible: z.boolean().optional(),
  })
  .strict()
export type PortalBanner = z.infer<typeof portalBannerSchema>

// ----- theme ----------------------------------------------------------------
const portalThemeSchema = z.object({
  brandName: z.string().min(1).max(80),
  tagline: z.string().max(180),
  // `logoUrl` remains the light/default logo for backwards compatibility.
  // The optional branding fields were added later so already-published portal
  // layouts continue to validate unchanged.
  logoUrl: z.string().max(2048), // "" when unset
  darkLogoUrl: z.string().max(2048).optional(),
  faviconUrl: z.string().max(2048).optional(),
  faviconShape: z.enum(["rounded", "circle"]).optional(),
  logoText: z.string().max(80).optional(),
  logoLink: z.union([z.literal(""), hrefSchema]).optional(),
  circularLogo: z.boolean().optional(),
  accentColor: z.string().max(32),
  // Emoji shown next to the project in the builder's project switcher. Optional;
  // experiences-write defaults it per template when unset.
  icon: z.string().max(8).optional(),
  navLinks: z.array(navLinkSchema).max(8).default([]),
  cta: navLinkSchema.nullable().default(null),
  // Optional for backwards compatibility with already-published layouts.
  // The customize UI writes the full object when an admin enables it.
  assistant: portalAssistantSchema.optional(),
  font: z.enum(["sans", "serif"]).default("sans"),
  appearance: z.enum(["light", "dark", "auto"]).default("auto"),
  // Optional custom token overrides (v2). Absent → the built-in accent var path.
  tokens: portalThemeTokensSchema.optional(),
  // Accent used in dark mode. Absent → `accentColor` in both modes.
  accentColorDark: hexColorSchema.optional(),
  // Hide the visitor light/dark toggle and always render `appearance`.
  appearanceLocked: z.boolean().optional(),
  // Google Fonts for headings / body text. Overrides `font` when set.
  fonts: portalFontsSchema.optional(),
  background: portalBackgroundSchema.optional(),
  // "dark" (default) keeps code blocks dark in both modes; "system" follows the
  // portal's light/dark mode.
  codeBlocks: z.enum(["dark", "system"]).optional(),
  // Announcement bar above the header.
  banner: portalBannerSchema.optional(),
  // Show each document's "last updated" date. Absent → shown.
  showLastUpdated: z.boolean().optional(),
  // Header logo size. Absent → "md".
  logoSize: z.enum(["sm", "md", "lg"]).optional(),
})
export type PortalTheme = z.infer<typeof portalThemeSchema>

export const PORTAL_CHROME_MODES = ["workspace", "custom"] as const
export type PortalChromeMode = (typeof PORTAL_CHROME_MODES)[number]

const portalChromeSchema = z
  .object({
    headerMode: z.enum(PORTAL_CHROME_MODES).optional(),
    footerMode: z.enum(PORTAL_CHROME_MODES).optional(),
  })
  .strict()
export type PortalChrome = z.infer<typeof portalChromeSchema>

// ----- localization ---------------------------------------------------------
// English is the source language and is always available. `enabledLanguages`
// contains the optional translated variants exposed to visitors. A translated
// default must also be enabled so a saved layout can never point at a language
// the selector does not offer.
const portalLocalizationSchema = z
  .object({
    enabledLanguages: z
      .array(z.enum(PORTAL_TRANSLATION_LANGUAGES))
      .max(PORTAL_TRANSLATION_LANGUAGES.length)
      .refine(
        (languages) => new Set(languages).size === languages.length,
        "enabledLanguages must not contain duplicates",
      ),
    defaultLanguage: z.enum(PORTAL_LANGUAGES).default("en"),
  })
  .strict()
  .refine(
    (localization) =>
      localization.defaultLanguage === "en" ||
      localization.enabledLanguages.includes(localization.defaultLanguage),
    {
      message: "defaultLanguage must be English or an enabled language",
      path: ["defaultLanguage"],
    },
  )
export type PortalLocalization = z.infer<typeof portalLocalizationSchema>

// ----- project pages -------------------------------------------------------
// A portal page is a project-local landing page with its own included-content
// scope. It shares the project's chrome/theme but normalizes the home layout
// against a different set of folders/documents.

export const PORTAL_PAGE_PRESENTATIONS = [
  "landing",
  "api_reference",
  "changelog",
] as const
export type PortalPagePresentation =
  (typeof PORTAL_PAGE_PRESENTATIONS)[number]

export const portalPageSchema = z
  .object({
    id: z.string().min(1).max(120),
    title: z.string().trim().min(1).max(60),
    slug: z
      .string()
      .min(1)
      .max(50)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/,
        "slug must contain lowercase letters, numbers, or hyphens",
      ),
    // null means all content already included by the parent project. An array
    // selects folders/documents independently from Home.
    scope: z.array(portalScopeEntrySchema).max(200).nullable(),
    // Optional for pages saved before page-specific presentation modes existed.
    presentation: z.enum(PORTAL_PAGE_PRESENTATIONS).optional(),
  })
  .strict()
export type PortalPage = z.infer<typeof portalPageSchema>

/**
 * Existing pages named `api-reference` predate the presentation field. Treat
 * that one conventional slug as a reference page so upgrading does not turn a
 * user's current API Reference back into a generic landing page.
 *
 * No equivalent inference for `changelog`: that presentation shipped after the
 * field existed, so a stored page slugged "changelog" was authored as — and
 * must stay — a landing page until its owner opts in.
 */
export function portalPagePresentation(
  page: PortalPage,
): PortalPagePresentation {
  return page.presentation ??
    (page.slug === "api-reference" ? "api_reference" : "landing")
}

const portalPagesSchema = z
  .array(portalPageSchema)
  .max(8)
  .superRefine((pages, ctx) => {
    const ids = new Set<string>()
    const slugs = new Set<string>()
    pages.forEach((page, index) => {
      if (ids.has(page.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "page ids must be unique",
        })
      }
      if (slugs.has(page.slug)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "slug"],
          message: "page slugs must be unique",
        })
      }
      ids.add(page.id)
      slugs.add(page.slug)
    })
  })

// ----- top-level layout -----------------------------------------------------
export const portalLayoutSchema = z.object({
  // v1 and v2 both validate (additive bump). v2 layouts carry a `tree`.
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  theme: portalThemeSchema,
  // Business/Enterprise portal language configuration. Public rendering and
  // the translation API additionally re-check the live subscription before
  // honoring this stored preference.
  localization: portalLocalizationSchema.optional(),
  header: headerBlockSchema,
  // Workspace/custom inheritance for chrome controlled by the builder. Missing
  // values are inferred during normalization for backwards compatibility.
  chrome: portalChromeSchema.optional(),
  sidebar: sidebarBlockSchema.optional(),
  // Legacy: portals could once hide the nav rail. The rail is now always on and
  // this flag is ignored; kept optional so stored layouts still parse.
  sidebarEnabled: z.boolean().optional(),
  // Per-folder icon/label overrides, keyed by folder id (a sidebar group's id
  // IS its folder id), applied during normalize so they survive the
  // folder-driven regeneration. Named for the nav rail it started as, but it
  // governs every surface that renders a folder — home category cards included.
  sidebarOverrides: z.record(z.string(), sidebarOverrideSchema).optional(),
  // Ordered project-local pages rendered in the navigation row below the
  // global portal header. Optional so previously published layouts keep
  // validating unchanged.
  pages: portalPagesSchema.optional(),
  body: z.array(portalBlockSchema).max(40),
  footer: footerBlockSchema.optional(),
  // ----- v2 DSL (additive, optional) — the open-ended component tree ---------
  // `tree`, when present, is the render source (see PortalRenderer); `body` is
  // kept for back-compat. `components` are per-layout composites that extend the
  // primitive vocabulary. Structural validation here; the registry-aware tree
  // gate runs in validatePortalLayout below.
  tree: dslNodeStructuralSchema.optional(),
  components: z.array(compositeDefSchema).max(50).optional(),
  enabledPacks: z.array(z.string().min(1).max(40)).max(20).optional(),
})
export type PortalLayout = z.infer<typeof portalLayoutSchema>

export type PortalLayoutValidation =
  | { ok: true; data: PortalLayout }
  | { ok: false; error: string }

/** Validate an untrusted layout. Used by the renderer before anything is shown. */
export function validatePortalLayout(input: unknown): PortalLayoutValidation {
  const result = portalLayoutSchema.safeParse(input)
  if (!result.success) {
    const error = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    return { ok: false, error }
  }
  // The whole-layout gate also covers the DSL tree (registry-aware): a layout
  // with a `tree` only validates if every node resolves to a known primitive or
  // a declared composite with valid props. Structural shape was already checked
  // by the schema above; this is the semantic pass.
  const layout = result.data
  if (layout.tree) {
    const treeResult = validateDslTree(layout.tree, { composites: layout.components })
    if (!treeResult.ok) {
      return { ok: false, error: `tree: ${treeResult.error}` }
    }
  }
  return { ok: true, data: layout }
}
