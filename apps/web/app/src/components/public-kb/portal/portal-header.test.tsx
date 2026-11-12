import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { HeaderBlock, PortalTheme } from "@/lib/portal/schema"

vi.mock("@/components/ui/hover-prefetch-link", () => ({
  HoverPrefetchLink: ({
    children,
    disableHoverPrefetch: _disableHoverPrefetch,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    disableHoverPrefetch?: boolean
  }) => <a {...props}>{children}</a>,
}))
vi.mock("./portal-search", () => ({ PortalSearch: () => null }))
vi.mock("./portal-ai-assistant", () => ({ PortalAiAssistant: () => null }))
vi.mock("./portal-theme-toggle", () => ({ PortalThemeToggle: () => null }))
vi.mock("./portal-translation", () => ({
  PortalLanguageSelector: () => <span>Language</span>,
}))

import { PortalHeader } from "./portal-header"

const theme: PortalTheme = {
  brandName: "Acme",
  tagline: "",
  logoUrl: "",
  accentColor: "#334455",
  navLinks: [{ label: "Docs", href: "/docs" }],
  cta: { label: "Contact", href: "/contact" },
  font: "sans",
  appearance: "light",
}

function renderHeader(
  itemOrder?: HeaderBlock["itemOrder"],
  languagePlacement?: HeaderBlock["languagePlacement"],
): string {
  return renderToStaticMarkup(
    <PortalHeader
      slug="acme"
      theme={theme}
      header={{
        id: "header",
        type: "portal-header",
        search: { enabled: false, placeholder: "Search" },
        ...(itemOrder ? { itemOrder } : {}),
        ...(languagePlacement ? { languagePlacement } : {}),
      }}
      showThemeToggle={false}
    />,
  )
}

function renderedItemOrder(html: string): string[] {
  return [...html.matchAll(/data-header-item="([^"]+)"/g)].map(
    (match) => match[1],
  )
}

describe("PortalHeader item order", () => {
  it("puts the language selector on the right by default", () => {
    expect(renderedItemOrder(renderHeader())).toEqual(["links", "cta", "language"])
  })

  it("renders a saved custom order", () => {
    expect(renderedItemOrder(renderHeader(["language", "links", "cta"]))).toEqual([
      "language",
      "links",
      "cta",
    ])
  })

  it("renders the language selector directly after the brand when selected", () => {
    const html = renderHeader(["links", "cta", "language"], "brand")
    expect(renderedItemOrder(html)).toEqual(["language", "links", "cta"])
    expect(html).toContain('data-header-region="brand"')
  })

  it("renders ordered project pages with a stable active state", () => {
    const html = renderToStaticMarkup(
      <PortalHeader
        slug="acme/developers"
        hrefBase="/p/acme/developers"
        theme={theme}
        header={{
          id: "header",
          type: "portal-header",
          search: { enabled: false, placeholder: "Search" },
        }}
        pages={[
          {
            id: "api-page",
            title: "API Reference",
            slug: "api-reference",
            scope: ["11111111-1111-4111-8111-111111111111"],
          },
          {
            id: "changes-page",
            title: "Changelog",
            slug: "changelog",
            scope: [{ doc: "22222222-2222-4222-8222-222222222222" }],
          },
        ]}
        activePageSlug="api-reference"
        showThemeToggle={false}
      />,
    )

    expect(html).toContain('aria-label="Portal pages"')
    expect(html).toContain('href="/p/acme/developers/page/api-reference"')
    expect(html).toContain('href="/p/acme/developers/page/changelog"')
    expect(html).toMatch(/href="\/p\/acme\/developers\/page\/api-reference"[^>]*aria-current="page"/)
  })
})
