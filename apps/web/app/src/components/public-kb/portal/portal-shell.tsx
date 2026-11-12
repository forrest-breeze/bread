import {
  buildDefaultHeader,
  buildPortalTheme,
  buildWorkspaceHeaderDefaults,
  portalChromeModeForScope,
  withWorkspaceHeaderDefaults,
} from "@/lib/portal/build-default"
import { PortalHeader } from "@/components/public-kb/portal/portal-header"
import { PortalNavProgress } from "@/components/public-kb/portal/portal-nav-progress"
import {
  portalFontFaceCss,
  portalGoogleFontsHref,
  portalThemeCssVars,
  portalThemeDataAttributes,
} from "@/lib/portal/theme-vars"
import { isBreadBrandedPortal } from "@/lib/feature-gates"
import { cn } from "@/lib/utils"
import type { PublicWorkspace } from "@/lib/public-kb"
import {
  portalPagePresentation,
  type PortalLayout,
  type PortalPage,
} from "@/lib/portal/schema"
import { PortalBanner } from "@/components/public-kb/portal/portal-banner"
import { PortalAiAssistant } from "@/components/public-kb/portal/portal-ai-assistant"
import { withPublicPortalBase } from "@/lib/portal/public-base-path"
import type { PortalPreviewThemeMode } from "@/lib/portal/preview-theme-message"
import { validPortalLanguage } from "@/lib/portal/language-preference"
import { PortalTranslationProvider } from "./portal-translation"
import { PortalThemeInit } from "./portal-theme-toggle"

interface PortalShellPreview {
  /** Editor-owned mode, kept separate from a real visitor's theme preference. */
  themeMode: PortalPreviewThemeMode
  /** Authorizes translation against this project's draft instead of its live version. */
  projectSlug: string | null
  /** Page selected inside the preview; null is the project home. */
  activePageSlug?: string | null
  /** Document selected beneath a project page, when that presentation has entries. */
  activePageDocRef?: string | null
}

type PortalSurface = "default" | "changelog-feed" | "changelog-entry"

function portalSurface({
  pages,
  activePageSlug,
  activePageDocRef,
}: {
  pages: PortalPage[]
  /** null is Home; undefined is a non-page route such as a document. */
  activePageSlug?: string | null
  activePageDocRef?: string | null
}): PortalSurface {
  const activePage =
    typeof activePageSlug === "string"
      ? pages.find((page) => page.slug === activePageSlug)
      : undefined

  if (activePage && portalPagePresentation(activePage) === "changelog") {
    return activePageDocRef ? "changelog-entry" : "changelog-feed"
  }

  return "default"
}

/**
 * Portal chrome shared by every public-portal view (home / doc / folder): the
 * themed root, header, and footer. Rendered by the `[...path]` route layout so
 * the header persists across in-portal navigation.
 *
 * `base` is the in-portal link prefix — `<workspace>` (default project) or
 * `<workspace>/<project>` (named) — passed to the header as its `slug` so the
 * brand mark and search route back to the correct portal.
 */
export function PortalShell({
  workspace,
  published,
  base,
  hrefBase,
  askAiEnabled,
  canRemoveBreadBranding,
  translationsEnabled,
  preferredLanguage,
  navigationPages,
  activePageSlug,
  activePageDocRef,
  preview,
  children,
}: {
  workspace: PublicWorkspace
  published: PortalLayout | null
  base: string
  hrefBase: string
  askAiEnabled: boolean
  canRemoveBreadBranding: boolean
  translationsEnabled: boolean
  /** Cookie-backed visitor preference, used to prevent a pre-hydration source-language paint. */
  preferredLanguage?: string | null
  /** Scope-filtered project pages. Falls back to the layout when omitted. */
  navigationPages?: PortalPage[]
  /** null = home, string = a project page, undefined = doc/folder. */
  activePageSlug?: string | null
  /** Nested document ref for a page presentation; null/undefined is its root. */
  activePageDocRef?: string | null
  /** Present only in the authenticated editor iframe. */
  preview?: PortalShellPreview
  children: React.ReactNode
}): React.ReactElement {
  const publicPublished = published
    ? withPublicPortalBase(published, base, hrefBase)
    : null
  const effectivePublished = publicPublished
    ? withWorkspaceHeaderDefaults(
        publicPublished,
        buildWorkspaceHeaderDefaults(workspace),
        portalChromeModeForScope(workspace.portalChromeScope),
      )
    : null
  const theme = effectivePublished?.theme ?? buildPortalTheme(workspace)
  const header = effectivePublished?.header ?? buildDefaultHeader()
  // Official Bread docs/help portals are named projects, while personalized
  // projects in the same workspace use customer brand names. Use the rendered
  // brand—not URL depth—so published chrome matches the preview without leaking
  // Bread's marketing links into customer-branded portals.
  const isFirstParty = isBreadBrandedPortal(workspace.id, theme.brandName)
  const localization =
    translationsEnabled && effectivePublished?.localization?.enabledLanguages.length
      ? effectivePublished.localization
      : null
  const initialLanguage = localization
    ? validPortalLanguage(preferredLanguage, [
        "en",
        ...localization.enabledLanguages,
      ]) ?? localization.defaultLanguage
    : "en"
  // A locked appearance ignores visitor (and editor-toolbar) preferences.
  const initialThemeMode =
    ((theme.appearanceLocked ? undefined : preview?.themeMode) ?? theme.appearance) === "dark"
      ? "dark"
      : "light"
  // Visitors can override the portal's appearance (stored preference, or the
  // OS setting when appearance is "auto"). The server can't know either, so it
  // renders `initialThemeMode` and this script corrects the root's class while
  // the HTML is still being parsed — before first paint, so there is no
  // light→dark flip and client-rendered pieces (Mermaid) see the final theme.
  // Mirrors getThemeSnapshot in portal-theme-toggle.tsx. `appearance` is a
  // schema enum; JSON.stringify keeps the interpolation inert regardless.
  const themeInitScript =
    preview || theme.appearanceLocked
      ? null
      : `(function(){try{var r=document.currentScript.parentElement,s=localStorage.getItem("bread-public-portal-theme"),a=${JSON.stringify(theme.appearance)},m=s==="light"||s==="dark"?s:a==="dark"||a==="light"?a:window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";r.classList.toggle("dark",m==="dark");r.classList.toggle("light",m==="light")}catch(e){}})()`
  const googleFontsHref = portalGoogleFontsHref(theme)
  const fontFaceCss = portalFontFaceCss(theme)
  const pages = navigationPages ?? effectivePublished?.pages ?? []
  const surface = portalSurface({
    pages,
    activePageSlug: preview ? (preview.activePageSlug ?? null) : activePageSlug,
    activePageDocRef: preview
      ? (preview.activePageDocRef ?? null)
      : activePageDocRef,
  })

  // Brand accent is exposed as a CSS variable on the portal root so every block
  // reads one token instead of threading the hex through every component.
  const portal = (
    <div
      data-portal-root
      // The init script below may swap the light/dark class before hydration.
      suppressHydrationWarning
      data-portal-translating={
        localization && initialLanguage !== "en" ? "all" : undefined
      }
      data-portal-href-base={hrefBase}
      data-portal-surface={surface}
      {...portalThemeDataAttributes(theme)}
      className={cn(
        "flex min-h-screen flex-col bg-background text-foreground",
        initialThemeMode,
      )}
      style={{
        ...portalThemeCssVars(theme),
        "--portal-header-height": pages.length > 0 ? "calc(7rem + 2px)" : "calc(4rem + 1px)",
      } as React.CSSProperties}
    >
      {themeInitScript ? (
        <PortalThemeInit appearance={theme.appearance} script={themeInitScript} />
      ) : null}
      {googleFontsHref ? (
        // React hoists precedence stylesheets into <head>.
        <link rel="stylesheet" href={googleFontsHref} precedence="default" />
      ) : null}
      {fontFaceCss ? <style>{fontFaceCss}</style> : null}
      {theme.banner ? (
        <PortalBanner banner={theme.banner} scope={base} preview={Boolean(preview)} />
      ) : null}
      <PortalHeader
        slug={base}
        hrefBase={hrefBase}
        theme={theme}
        header={header}
        isFirstParty={isFirstParty}
        previewThemeMode={preview?.themeMode}
        pages={pages}
        activePageSlug={preview ? (preview.activePageSlug ?? null) : activePageSlug}
        previewProjectSlug={preview ? preview.projectSlug : undefined}
        askAiEnabled={askAiEnabled && theme.assistant?.enabled === true}
        showThemeToggle={!theme.appearanceLocked}
      />
      {/* The builder preview intercepts its links; it has its own loader. */}
      {preview ? null : <PortalNavProgress />}
      <main className="flex-1 flex flex-col">{children}</main>
      {askAiEnabled && theme.assistant?.enabled ? (
        <PortalAiAssistant
          slug={base}
          hrefBase={hrefBase}
          label={theme.assistant.label}
        />
      ) : null}
    </div>
  )

  return localization ? (
    <PortalTranslationProvider
      portal={base}
      localization={localization}
      initialLanguage={initialLanguage}
      preview={Boolean(preview)}
      projectSlug={preview?.projectSlug}
    >
      {portal}
    </PortalTranslationProvider>
  ) : (
    portal
  )
}
