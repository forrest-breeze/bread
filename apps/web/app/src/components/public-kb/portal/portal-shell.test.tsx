import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { PublicWorkspace } from "@/lib/public-kb"
import type { PortalLayout, PortalPage } from "@/lib/portal/schema"

vi.mock("@/components/public-kb/portal/portal-header", () => ({
  PortalHeader: ({
    previewThemeMode,
    showThemeToggle,
    askAiEnabled,
  }: {
    previewThemeMode?: string
    showThemeToggle?: boolean
    askAiEnabled?: boolean
  }) => (
    <header
      data-ask-ai={String(askAiEnabled)}
      data-preview-theme={previewThemeMode ?? "production"}
      data-theme-toggle={String(showThemeToggle ?? true)}
    />
  ),
}))
vi.mock("@/components/public-kb/portal/portal-ai-assistant", () => ({
  PortalAiAssistant: () => <button data-ai-drawer="">Ask AI</button>,
}))
vi.mock("./portal-translation", () => ({
  PortalTranslationProvider: ({
    preview,
    projectSlug,
    initialLanguage,
    children,
  }: {
    preview?: boolean
    projectSlug?: string | null
    initialLanguage?: string | null
    children: React.ReactNode
  }) => (
    <div
      data-translation-preview={String(Boolean(preview))}
      data-translation-project={projectSlug ?? "published"}
      data-translation-language={initialLanguage ?? "default"}
    >
      {children}
    </div>
  ),
}))

import { PortalShell } from "./portal-shell"

const workspace: PublicWorkspace = {
  id: "workspace-1",
  name: "Acme",
  slug: "acme",
  iconUrl: null,
  isPublic: true,
  branding: {
    name: "Acme",
    tagline: "Answers",
    logoUrl: "",
    accentColor: "#334455",
  },
  portalChromeScope: "workspace",
}

const layout: PortalLayout = {
  schemaVersion: 1,
  theme: {
    brandName: "Acme",
    tagline: "Answers",
    logoUrl: "",
    accentColor: "#334455",
    navLinks: [],
    cta: null,
    font: "sans",
    appearance: "light",
  },
  header: {
    id: "header",
    type: "portal-header",
    search: { enabled: true, placeholder: "Search" },
  },
  body: [],
  localization: { enabledLanguages: ["es"], defaultLanguage: "en" },
}

const changelogPage: PortalPage = {
  id: "page-releases",
  title: "Releases",
  slug: "releases",
  scope: null,
  presentation: "changelog",
}

describe("PortalShell preview", () => {
  it.each([true, false])("applies assistant enabled=%s to both the drawer and search", (enabled) => {
    const html = renderToStaticMarkup(
      <PortalShell
        workspace={workspace}
        published={{ ...layout, theme: { ...layout.theme, assistant: { enabled, label: "Ask AI", placement: "corner" } } }}
        base="acme/docs"
        hrefBase="/p/acme/docs"
        askAiEnabled
        canRemoveBreezifyBranding={false}
        translationsEnabled={false}
      >
        <p>Docs</p>
      </PortalShell>,
    )
    expect(html.includes("data-ai-drawer")).toBe(enabled)
    expect(html).toContain(`data-ask-ai="${enabled}"`)
  })

  it.each(["header", "corner"] as const)("renders one drawer for saved %s placement", (placement) => {
    const html = renderToStaticMarkup(
      <PortalShell
        workspace={workspace}
        published={{ ...layout, theme: { ...layout.theme, assistant: { enabled: true, label: "Ask AI", placement } } }}
        base="acme/docs"
        hrefBase="/p/acme/docs"
        askAiEnabled
        canRemoveBreezifyBranding={false}
        translationsEnabled={false}
      >
        <p>Docs</p>
      </PortalShell>,
    )
    expect(html.match(/data-ai-drawer/g)).toHaveLength(1)
  })

  it("uses page presentation and nested document ref for docs changelogs", () => {
    const feed = renderToStaticMarkup(
      <PortalShell
        workspace={workspace}
        published={layout}
        base="acme/docs"
        hrefBase="/p/acme/docs"
        askAiEnabled={false}
        canRemoveBreezifyBranding={false}
        translationsEnabled={false}
        navigationPages={[changelogPage]}
        activePageSlug="releases"
      >
        <p>Release feed</p>
      </PortalShell>,
    )
    const entry = renderToStaticMarkup(
      <PortalShell
        workspace={workspace}
        published={layout}
        base="acme/docs"
        hrefBase="/p/acme/docs"
        askAiEnabled={false}
        canRemoveBreezifyBranding={false}
        translationsEnabled={false}
        navigationPages={[changelogPage]}
        activePageSlug="releases"
        activePageDocRef="v2-0"
      >
        <p>Release entry</p>
      </PortalShell>,
    )

    expect(feed).toContain('data-portal-surface="changelog-feed"')
    expect(entry).toContain('data-portal-surface="changelog-entry"')
  })

  it("derives the surface from the editor preview's active page", () => {
    const html = renderToStaticMarkup(
      <PortalShell
        workspace={workspace}
        published={layout}
        base="acme/docs"
        hrefBase="/p/acme/docs"
        askAiEnabled={false}
        canRemoveBreezifyBranding={false}
        translationsEnabled={false}
        navigationPages={[changelogPage]}
        activePageSlug={null}
        preview={{
          themeMode: "light",
          projectSlug: "docs",
          activePageSlug: "releases",
        }}
      >
        <p>Preview release feed</p>
      </PortalShell>,
    )

    expect(html).toContain('data-portal-surface="changelog-feed"')
  })

  it("keeps production chrome while isolating editor theme and draft translation", () => {
    const html = renderToStaticMarkup(
      <PortalShell
        workspace={workspace}
        published={layout}
        base="acme/guides"
        hrefBase="/p/acme/guides"
        askAiEnabled={false}
        canRemoveBreezifyBranding={false}
        translationsEnabled
        preview={{ themeMode: "dark", projectSlug: "guides" }}
      >
        <p>Production home view</p>
      </PortalShell>,
    )

    expect(html).toContain('data-translation-preview="true"')
    expect(html).toContain('data-translation-project="guides"')
    expect(html).toContain('data-preview-theme="dark"')
    expect(html).toMatch(/data-portal-root="true"[^>]*class="[^"]*dark/)
    expect(html).toContain("Production home view")
  })

  it("server-renders the explicit light class used by the preview client", () => {
    const html = renderToStaticMarkup(
      <PortalShell
        workspace={workspace}
        published={layout}
        base="acme/guides"
        hrefBase="/p/acme/guides"
        askAiEnabled={false}
        canRemoveBreezifyBranding={false}
        translationsEnabled={false}
        preview={{ themeMode: "light", projectSlug: "guides" }}
      >
        <p>Production home view</p>
      </PortalShell>,
    )

    expect(html).toMatch(/data-portal-root="true"[^>]*class="[^"]*\blight\b/)
    expect(html).not.toMatch(/data-portal-root="true"[^>]*class="[^"]*\bdark\b/)
  })

  it("hides server-rendered source text for a remembered translated language", () => {
    const html = renderToStaticMarkup(
      <PortalShell
        workspace={workspace}
        published={layout}
        base="acme"
        hrefBase="/p/acme"
        askAiEnabled={false}
        canRemoveBreezifyBranding={false}
        translationsEnabled
        preferredLanguage="es"
      >
        <p>English source content</p>
      </PortalShell>,
    )

    expect(html).toContain('data-translation-language="es"')
    expect(html).toMatch(
      /data-portal-root="true" data-portal-translating="all"/,
    )
  })

  it("renders the banner, custom fonts, and a locked appearance", () => {
    const html = renderToStaticMarkup(
      <PortalShell
        workspace={workspace}
        published={{
          ...layout,
          theme: {
            ...layout.theme,
            appearance: "dark",
            appearanceLocked: true,
            fonts: { body: "Inter" },
            banner: { text: "v2 is live", tone: "brand" },
          },
        }}
        base="acme"
        hrefBase="/p/acme"
        askAiEnabled={false}
        canRemoveBreezifyBranding={false}
        translationsEnabled={false}
      >
        <p>Docs</p>
      </PortalShell>,
    )

    expect(html).toContain("v2 is live")
    expect(html).toContain('data-theme-toggle="false"')
    expect(html).toContain("data-portal-font-body")
    expect(html).toContain("fonts.googleapis.com/css?family=Inter")
    expect(html).toMatch(/class="[^"]*\bdark\b/)
  })
})
