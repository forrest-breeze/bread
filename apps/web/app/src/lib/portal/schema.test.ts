import { describe, expect, it } from "vitest"
import {
  PORTAL_SCHEMA_VERSION,
  parseStoredHeader,
  portalDefaultPage,
  portalNavEntries,
  portalPagePresentation,
  resolvePortalNavRoute,
  validatePortalLayout,
  type PortalLayout,
} from "./schema"

function validLayout(): PortalLayout {
  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    theme: {
      brandName: "Acme",
      tagline: "",
      logoUrl: "",
      accentColor: "#2f5520",
      navLinks: [],
      cta: null,
      font: "sans",
      appearance: "auto",
    },
    header: {
      id: "header",
      type: "portal-header",
      search: { enabled: true, placeholder: "Search or ask AI" },
    },
    sidebar: {
      id: "sidebar",
      type: "sidebar-nav",
      groups: [
        {
          id: "documents",
          label: "Documents",
          icon: "file-text",
          items: [{ id: "d1", label: "Doc", href: "/p/acme/doc/d1" }],
        },
      ],
    },
    body: [
      { id: "hero", type: "hero", placement: "full", heading: "How can we help?" },
      { id: "ask", type: "ask-ai-search", placement: "full", placeholder: "Ask…" },
      {
        id: "cats",
        type: "category-grid",
        placement: "main",
        items: [{ id: "c1", title: "Guides", icon: "folder", href: "/p/acme/folder/c1" }],
      },
    ],
    footer: { id: "footer", type: "footer", showPoweredBy: true },
  }
}

describe("validatePortalLayout", () => {
  it("accepts a well-formed layout", () => {
    const result = validatePortalLayout(validLayout())
    expect(result.ok).toBe(true)
  })

  it("applies defaults for omitted optional fields", () => {
    const result = validatePortalLayout({
      schemaVersion: PORTAL_SCHEMA_VERSION,
      theme: { brandName: "Acme", tagline: "", logoUrl: "", accentColor: "#000" },
      header: { id: "h", type: "portal-header" },
      body: [{ id: "hero", type: "hero", heading: "Hi" }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.theme.font).toBe("sans")
    expect(result.data.theme.navLinks).toEqual([])
    expect(result.data.theme.cta).toBeNull()
    expect(result.data.theme.assistant).toBeUndefined()
    expect(result.data.header.search.enabled).toBe(true)
    expect(result.data.header.itemOrder).toBeUndefined()
    expect(result.data.header.languagePlacement).toBeUndefined()
    expect(result.data.body[0]?.placement).toBe("full")
  })

  it("accepts a complete custom header item order", () => {
    const result = validatePortalLayout({
      ...validLayout(),
      header: {
        ...validLayout().header,
        itemOrder: ["language", "links", "cta"],
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.header.itemOrder).toEqual(["language", "links", "cta"])
  })

  it("rejects incomplete or duplicate header item orders", () => {
    const base = validLayout()
    expect(
      validatePortalLayout({
        ...base,
        header: { ...base.header, itemOrder: ["links", "cta"] },
      }).ok,
    ).toBe(false)
    expect(
      validatePortalLayout({
        ...base,
        header: { ...base.header, itemOrder: ["links", "cta", "cta"] },
      }).ok,
    ).toBe(false)
  })

  it("parses a persisted workspace header item order", () => {
    expect(
      parseStoredHeader({ itemOrder: ["cta", "language", "links"] }),
    ).toEqual({ itemOrder: ["cta", "language", "links"] })
    expect(parseStoredHeader({ itemOrder: ["links", "links", "cta"] })).toBeNull()
  })

  it("validates and parses language selector placement", () => {
    const result = validatePortalLayout({
      ...validLayout(),
      header: { ...validLayout().header, languagePlacement: "brand" },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.header.languagePlacement).toBe("brand")
    expect(parseStoredHeader({ languagePlacement: "brand" })).toEqual({
      languagePlacement: "brand",
    })
    expect(parseStoredHeader({ languagePlacement: "middle" })).toBeNull()
  })

  it("accepts a configurable portal assistant", () => {
    const layout = validLayout()
    const result = validatePortalLayout({
      ...layout,
      theme: {
        ...layout.theme,
        assistant: { enabled: true, placement: "header", label: "Ask Acme" },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.theme.assistant).toEqual({
      enabled: true,
      placement: "header",
      label: "Ask Acme",
    })
  })

  it("accepts ordered project pages backed by public content", () => {
    const result = validatePortalLayout({
      ...validLayout(),
      pages: [
        {
          id: "api-page",
          title: "API Reference",
          slug: "api-reference",
          scope: ["11111111-1111-4111-8111-111111111111"],
          presentation: "api_reference",
        },
        {
          id: "changes-page",
          title: "Changelog",
          slug: "changelog",
          scope: [{ doc: "22222222-2222-4222-8222-222222222222" }],
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.pages?.map((page) => page.slug)).toEqual([
      "api-reference",
      "changelog",
    ])
    expect(result.data.pages?.[0]?.presentation).toBe("api_reference")
  })

  it("upgrades an existing api-reference page to the reference presentation", () => {
    expect(
      portalPagePresentation({
        id: "api-page",
        title: "API Reference",
        slug: "api-reference",
        scope: null,
      }),
    ).toBe("api_reference")
  })

  it("accepts the changelog presentation without inferring it from the slug", () => {
    const result = validatePortalLayout({
      ...validLayout(),
      pages: [
        {
          id: "release-page",
          title: "Release notes",
          slug: "releases",
          scope: ["11111111-1111-4111-8111-111111111111"],
          presentation: "changelog",
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.pages?.[0]?.presentation).toBe("changelog")

    // A page authored before the presentation existed stays a landing page even
    // when its slug happens to be "changelog".
    expect(
      portalPagePresentation({
        id: "changes-page",
        title: "Changelog",
        slug: "changelog",
        scope: null,
      }),
    ).toBe("landing")
  })

  it("rejects duplicate or invalid project page slugs", () => {
    const scope = ["11111111-1111-4111-8111-111111111111"]
    expect(
      validatePortalLayout({
        ...validLayout(),
        pages: [
          { id: "one", title: "One", slug: "updates", scope },
          { id: "two", title: "Two", slug: "updates", scope },
        ],
      }).ok,
    ).toBe(false)
    expect(
      validatePortalLayout({
        ...validLayout(),
        pages: [
          { id: "one", title: "One", slug: "API Reference", scope },
        ],
      }).ok,
    ).toBe(false)
    expect(
      validatePortalLayout({
        ...validLayout(),
        pages: [
          {
            id: "one",
            title: "One",
            slug: "updates",
            scope,
            presentation: "spreadsheet",
          },
        ],
      }).ok,
    ).toBe(false)
  })

  it("accepts enabled portal translations and a translated default", () => {
    const result = validatePortalLayout({
      ...validLayout(),
      localization: {
        enabledLanguages: ["es", "fr", "zh"],
        defaultLanguage: "fr",
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.localization).toEqual({
      enabledLanguages: ["es", "fr", "zh"],
      defaultLanguage: "fr",
    })
  })

  it("rejects a translated default that is not enabled", () => {
    expect(
      validatePortalLayout({
        ...validLayout(),
        localization: {
          enabledLanguages: ["es"],
          defaultLanguage: "fr",
        },
      }).ok,
    ).toBe(false)
  })

  it("rejects duplicate or unsupported portal languages", () => {
    expect(
      validatePortalLayout({
        ...validLayout(),
        localization: {
          enabledLanguages: ["es", "es"],
          defaultLanguage: "es",
        },
      }).ok,
    ).toBe(false)
    expect(
      validatePortalLayout({
        ...validLayout(),
        localization: {
          enabledLanguages: ["de"],
          defaultLanguage: "en",
        },
      }).ok,
    ).toBe(false)
  })

  it("accepts light and dark brand assets and logo presentation settings", () => {
    const layout = validLayout()
    const result = validatePortalLayout({
      ...layout,
      theme: {
        ...layout.theme,
        logoUrl: "https://cdn.example.com/logo-light.svg",
        darkLogoUrl: "https://cdn.example.com/logo-dark.svg",
        faviconUrl: "https://cdn.example.com/favicon.svg",
        faviconShape: "circle",
        logoText: "Acme Help",
        logoLink: "https://www.example.com",
        circularLogo: true,
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.theme.darkLogoUrl).toContain("logo-dark.svg")
    expect(result.data.theme.faviconShape).toBe("circle")
    expect(result.data.theme.circularLogo).toBe(true)
  })

  it("rejects an unsafe logo link", () => {
    const layout = validLayout()
    expect(
      validatePortalLayout({
        ...layout,
        theme: { ...layout.theme, logoLink: "javascript:alert(1)" },
      }).ok,
    ).toBe(false)
  })

  it("rejects an unknown portal assistant placement", () => {
    const layout = validLayout()
    expect(
      validatePortalLayout({
        ...layout,
        theme: {
          ...layout.theme,
          assistant: { enabled: true, placement: "sidebar", label: "Ask AI" },
        },
      }).ok,
    ).toBe(false)
  })

  it("rejects an unknown block type", () => {
    const layout = validLayout()
    const bad = {
      ...layout,
      body: [...layout.body, { id: "x", type: "iframe-embed", placement: "full" }],
    }
    expect(validatePortalLayout(bad).ok).toBe(false)
  })

  it("rejects an unsafe href (javascript: scheme)", () => {
    const layout = validLayout()
    const bad = {
      ...layout,
      body: [
        {
          id: "cats",
          type: "category-grid",
          placement: "main",
          items: [{ id: "c1", title: "x", href: "javascript:alert(1)" }],
        },
      ],
    }
    expect(validatePortalLayout(bad).ok).toBe(false)
  })

  it("accepts schema version 2", () => {
    expect(validatePortalLayout({ ...validLayout(), schemaVersion: 2 }).ok).toBe(true)
  })

  it("rejects a wrong schema version", () => {
    expect(validatePortalLayout({ ...validLayout(), schemaVersion: 99 }).ok).toBe(false)
  })

  it("accepts a free-string icon outside the recommended list", () => {
    const layout = validLayout()
    const result = validatePortalLayout({
      ...layout,
      body: [
        {
          id: "cats",
          type: "category-grid",
          placement: "main",
          items: [{ id: "c1", title: "Rockets", icon: "rocket", href: "/p/acme/folder/c1" }],
        },
      ],
    })
    expect(result.ok).toBe(true)
  })

  it("accepts a v2 layout with a DSL tree", () => {
    const result = validatePortalLayout({
      ...validLayout(),
      schemaVersion: 2,
      tree: {
        id: "root",
        type: "Stack",
        props: { gap: "md" },
        children: [
          { id: "h", type: "Heading", props: { text: "Hi" } },
          { id: "t", type: "Text", props: { text: "Body copy" } },
        ],
      },
    })
    expect(result.ok).toBe(true)
  })

  it("accepts a v2 tree that uses a declared composite", () => {
    const result = validatePortalLayout({
      ...validLayout(),
      schemaVersion: 2,
      components: [
        {
          name: "KpiTile",
          params: [
            { name: "label", type: "string" },
            { name: "value", type: "string" },
          ],
          tree: {
            id: "kpi-root",
            type: "Card",
            children: [
              { id: "kpi-label", type: "Text", props: { text: "{{label}}" } },
              { id: "kpi-value", type: "Heading", props: { text: "{{value}}" } },
            ],
          },
        },
      ],
      tree: {
        id: "root",
        type: "Grid",
        props: { columns: 2 },
        children: [{ id: "k1", type: "KpiTile", props: { label: "Users", value: "1.2k" } }],
      },
    })
    expect(result.ok).toBe(true)
  })

  it("rejects a v2 tree that uses an unknown primitive type", () => {
    const result = validatePortalLayout({
      ...validLayout(),
      schemaVersion: 2,
      tree: {
        id: "root",
        type: "Stack",
        children: [{ id: "x", type: "Frobnicate" }],
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("tree:")
  })

  it("accepts sidebar overrides and rejects an unknown override field", () => {
    const layout = validLayout()
    expect(
      validatePortalLayout({
        ...layout,
        sidebarOverrides: { documents: { icon: "rocket", label: "Docs" } },
      }).ok,
    ).toBe(true)
    expect(
      validatePortalLayout({
        ...layout,
        sidebarOverrides: { documents: { color: "red" } },
      }).ok,
    ).toBe(false)
  })

  it("rejects theme tokens with an unsafe value", () => {
    const layout = validLayout()
    const result = validatePortalLayout({
      ...layout,
      schemaVersion: 2,
      theme: { ...layout.theme, tokens: { accent: "red; }" } },
    })
    expect(result.ok).toBe(false)
  })

  it("accepts same-origin and https hrefs but not protocol-relative", () => {
    const base = validLayout()
    const withHref = (href: string): unknown => ({
      ...base,
      sidebar: {
        id: "sidebar",
        type: "sidebar-nav",
        groups: [
          { id: "g", label: "G", items: [{ id: "i", label: "i", href }] },
        ],
      },
    })
    expect(validatePortalLayout(withHref("/p/acme/doc/1")).ok).toBe(true)
    expect(validatePortalLayout(withHref("https://docs.acme.com")).ok).toBe(true)
    expect(validatePortalLayout(withHref("//evil.com")).ok).toBe(false)
  })

  it("accepts nested sidebar folder groups", () => {
    const layout = validLayout()
    const result = validatePortalLayout({
      ...layout,
      sidebar: {
        id: "sidebar",
        type: "sidebar-nav",
        groups: [
          {
            id: "developer",
            label: "Developer",
            icon: "folder",
            href: "/p/acme/folder/developer",
            items: [],
            children: [
              {
                id: "mcp",
                label: "MCP",
                icon: "folder",
                href: "/p/acme/folder/mcp",
                items: [
                  { id: "tools", label: "MCP Tools", href: "/p/acme/doc/tools" },
                ],
              },
            ],
          },
        ],
      },
    })

    expect(result.ok).toBe(true)
  })

  it("accepts a callout block and applies the default tone", () => {
    const layout = validLayout()
    const withCallout = {
      ...layout,
      body: [
        ...layout.body,
        { id: "cta-note", type: "callout", placement: "full", body: "Heads up." },
      ],
    }
    const result = validatePortalLayout(withCallout)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const callout = result.data.body.find((b) => b.type === "callout")
    expect(callout?.type === "callout" && callout.tone).toBe("info")
  })

  it("rejects a callout with an unknown tone", () => {
    const layout = validLayout()
    const bad = {
      ...layout,
      body: [
        { id: "c", type: "callout", placement: "full", tone: "explode", body: "x" },
      ],
    }
    expect(validatePortalLayout(bad).ok).toBe(false)
  })
})

describe("portal nav order", () => {
  const pages = [
    { id: "a", title: "API", slug: "api", scope: null },
    { id: "b", title: "Changelog", slug: "changelog", scope: null },
  ]

  it("defaults to Home in the first slot", () => {
    expect(portalNavEntries({ pages })[0]).toEqual({ kind: "home" })
    expect(portalDefaultPage({ pages })).toBeNull()
    expect(resolvePortalNavRoute({ pages }, "home")).toEqual({ kind: "home" })
  })

  it("serves the first page at the root and moves Home to /page/home", () => {
    const layout = { pages, homePosition: 1 }
    expect(portalNavEntries(layout).map((e) => e.kind)).toEqual([
      "page",
      "home",
      "page",
    ])
    expect(portalDefaultPage(layout)?.slug).toBe("api")
    expect(resolvePortalNavRoute(layout, "home")).toEqual({
      kind: "page",
      page: pages[0],
    })
    expect(resolvePortalNavRoute(layout, "page", "home")).toEqual({
      kind: "home",
    })
    expect(resolvePortalNavRoute(layout, "page", "missing")).toBeNull()
  })

  it("clamps an out-of-range home position", () => {
    expect(portalNavEntries({ pages: [], homePosition: 5 })).toEqual([
      { kind: "home" },
    ])
  })
})
