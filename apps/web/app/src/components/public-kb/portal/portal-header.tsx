import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { KbBrandMark } from "@/components/kb/kb-brand-mark"
import {
  DEFAULT_PORTAL_HEADER_ITEM_ORDER,
  DEFAULT_PORTAL_LANGUAGE_PLACEMENT,
  isSafeHref,
  type HeaderBlock,
  type PortalPage,
  type PortalTheme,
} from "@/lib/portal/schema"
import { publicPortalHref } from "@/lib/portal/public-base-path"
import { cn } from "@/lib/utils"
import { PortalThemeToggle, type PortalThemeControl } from "./portal-theme-toggle"
import { PortalSearch } from "./portal-search"
import { PortalMobileNavButton } from "./portal-mobile-nav"
import { PortalLanguageSelector } from "./portal-translation"
import type { PortalPreviewThemeMode } from "@/lib/portal/preview-theme-message"

// Global portal chrome: brand mark + name (left), centered search (center),
// configured nav links + CTA (right). Server component; the only client island
// is the theme toggle. Empty nav/CTA render blank on customer portals; only the
// first-party Bread workspace falls back to the Bread marketing links (nav/CTA
// aren't workspace-configurable yet — Phase 3).
const DEFAULT_NAV_LINKS: PortalTheme["navLinks"] = []

const DEFAULT_CTA: NonNullable<PortalTheme["cta"]> | null = null

function externalLinkProps(href: string): {
  target?: "_blank"
  rel?: "noreferrer"
} {
  return href.startsWith("http://") || href.startsWith("https://")
    ? { target: "_blank", rel: "noreferrer" }
    : {}
}

export function PortalHeader({
  slug,
  hrefBase,
  theme,
  header,
  showThemeToggle = true,
  previewThemeMode,
  pages = [],
  activePageSlug = null,
  previewProjectSlug,
  isFirstParty = false,
  askAiEnabled = false,
  themeControl,
  onNavigate,
  compact = false,
}: {
  slug: string
  hrefBase?: string
  theme: PortalTheme
  header: HeaderBlock
  showThemeToggle?: boolean
  previewThemeMode?: PortalPreviewThemeMode
  pages?: PortalPage[]
  /** A page slug selects that section; home and ordinary docs/folders select Home. */
  activePageSlug?: string | null
  /** Defined only in the authenticated preview iframe. */
  previewProjectSlug?: string | null
  isFirstParty?: boolean
  askAiEnabled?: boolean
  /** Builder frame only: the toggle drives the editor-owned appearance. */
  themeControl?: PortalThemeControl
  /**
   * Builder frame only: where search results navigate, instead of the app
   * router. Also turns off search's global ⌘K so it can't take over the app's.
   */
  onNavigate?: (href: string) => void
  /**
   * Builder frame only: force the phone layout regardless of the browser
   * viewport. The editor frame renders inline (not in an iframe), so its
   * `md:`/`xl:` breakpoints would otherwise follow the builder window.
   */
  compact?: boolean
}): React.ReactElement {
  // Chrome hrefs are rendered outside the validated body, so re-apply the href
  // gate here — keeps this safe once nav/cta become configurable (Phase 3).
  const configuredLinks = theme.navLinks.filter((link) => isSafeHref(link.href))
  // Customer portals render blank nav/CTA when unconfigured; only the first-party
  // Bread portal falls back to the Bread marketing links.
  const navLinks =
    configuredLinks.length > 0
      ? configuredLinks
      : isFirstParty
        ? DEFAULT_NAV_LINKS
        : []
  const cta =
    theme.cta && isSafeHref(theme.cta.href)
      ? theme.cta
      : isFirstParty
        ? DEFAULT_CTA
        : null
  const publicBase = hrefBase ?? `/p/${slug}`
  const brandHref =
    theme.logoLink && isSafeHref(theme.logoLink) ? theme.logoLink : publicBase
  const logoText = theme.logoText ?? theme.brandName
  const brandLinkIsExternal =
    brandHref.startsWith("http://") || brandHref.startsWith("https://")
  const headerItems = header.itemOrder ?? DEFAULT_PORTAL_HEADER_ITEM_ORDER
  const languagePlacement =
    header.languagePlacement ?? DEFAULT_PORTAL_LANGUAGE_PLACEMENT
  const previewHref = (pageSlug?: string): string => {
    const params = new URLSearchParams({
      theme: previewThemeMode ?? "light",
      slug,
    })
    if (previewProjectSlug) params.set("project", previewProjectSlug)
    if (pageSlug) params.set("page", pageSlug)
    return `/portal-preview?${params.toString()}`
  }
  const homeHref =
    previewThemeMode !== undefined ? previewHref() : publicBase
  const pageHref = (pageSlug: string): string =>
    previewThemeMode !== undefined
      ? previewHref(pageSlug)
      : publicPortalHref(publicBase, `/page/${pageSlug}`)

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
      <div
        className={cn(
          "grid h-14 w-full items-center gap-3 px-4",
          !compact && "sm:px-8 md:h-16 md:gap-4",
          // Mobile: one row — brand, a search bar filling the middle, actions.
          header.search.enabled
            ? compact
              ? "grid-cols-[auto_minmax(0,1fr)_auto]"
              : "grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_auto_auto] xl:grid-cols-[1fr_minmax(240px,640px)_1fr]"
            : "grid-cols-[minmax(0,1fr)_auto]",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <PortalMobileNavButton className="-ml-2 -mr-1" />
          <HoverPrefetchLink
            href={brandHref}
            disableHoverPrefetch={brandLinkIsExternal}
            className={cn(
              "flex min-w-0 shrink items-center gap-2.5 rounded-lg outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring",
              compact ? "max-w-[9rem]" : "max-w-[40vw] md:max-w-none",
            )}
            {...externalLinkProps(brandHref)}
          >
            <KbBrandMark
              name={logoText || theme.brandName}
              logoUrl={theme.logoUrl || null}
              darkLogoUrl={theme.darkLogoUrl || null}
              accentColor={theme.accentColor}
              circular={theme.circularLogo === true}
              className={cn(
                theme.logoSize === "sm" ? "size-5" : theme.logoSize === "lg" ? "size-8" : "size-6",
                "shadow-none",
                theme.circularLogo ? "rounded-full" : "rounded-md",
              )}
            />
            {logoText ? (
              <span data-portal-brand-text className="truncate text-base font-semibold">
                {logoText}
              </span>
            ) : null}
          </HoverPrefetchLink>
          {languagePlacement === "brand" ? (
            <div
              data-header-item="language"
              data-header-region="brand"
              className="shrink-0"
            >
              <PortalLanguageSelector />
            </div>
          ) : null}
        </div>

        {header.search.enabled && (
          <div className="flex min-w-0 items-center justify-center gap-2">
            <PortalSearch
              slug={slug}
              hrefBase={publicBase}
              placeholder={header.search.placeholder}
              askAiEnabled={askAiEnabled}
              onNavigate={onNavigate}
              globalShortcut={onNavigate ? false : undefined}
            />
          </div>
        )}

        <div className={cn("flex shrink-0 items-center justify-end gap-4", !compact && "lg:gap-5")}>
          {headerItems.map((item) => {
            if (item === "links") {
              if (navLinks.length === 0 || compact) return null
              return (
                <nav
                  key={item}
                  data-header-item={item}
                  aria-label="Site"
                  className="hidden items-center gap-4 text-sm font-medium text-muted-foreground md:flex lg:gap-5"
                >
                  {navLinks.map((link) => (
                    <a
                      key={`${link.label}:${link.href}`}
                      href={link.href}
                      className="whitespace-nowrap transition-colors hover:text-foreground"
                      {...externalLinkProps(link.href)}
                    >
                      {link.label}
                    </a>
                  ))}
                </nav>
              )
            }
            if (item === "cta") {
              if (!cta || compact) return null
              return (
                <a
                  key={item}
                  data-header-item={item}
                  href={cta.href}
                  className="hidden whitespace-nowrap rounded-xl bg-foreground/35 px-4 py-2 text-foreground transition-colors hover:bg-foreground/45 md:inline-flex"
                  {...externalLinkProps(cta.href)}
                >
                  {cta.label}
                </a>
              )
            }
            if (languagePlacement !== "actions") return null
            return (
              <div key={item} data-header-item={item} className="contents">
                <PortalLanguageSelector />
              </div>
            )
          })}
          {showThemeToggle ? (
            <PortalThemeToggle
              appearance={theme.appearance}
              previewMode={previewThemeMode}
              control={themeControl}
            />
          ) : null}
        </div>
      </div>
      {pages.length > 0 ? (
        <nav
          aria-label="Portal pages"
          data-portal-page-nav
          className={cn(
            "flex min-h-12 items-end gap-8 overflow-x-auto border-t border-border/70 text-sm font-medium",
            compact ? "px-4" : "px-6 sm:px-8",
          )}
        >
          <HoverPrefetchLink
            href={homeHref}
            disableHoverPrefetch={previewThemeMode !== undefined}
            aria-current={activePageSlug === null ? "page" : undefined}
            className={cn(
              "flex h-12 shrink-0 items-center border-b-2 transition-colors",
              activePageSlug === null
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            Documents
          </HoverPrefetchLink>
          {pages.map((page) => {
            const active = activePageSlug === page.slug
            return (
              <HoverPrefetchLink
                key={page.id}
                href={pageHref(page.slug)}
                disableHoverPrefetch={previewThemeMode !== undefined}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-12 shrink-0 items-center border-b-2 transition-colors",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {page.title}
              </HoverPrefetchLink>
            )
          })}
        </nav>
      ) : null}
    </header>
  )
}
