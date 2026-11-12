import { describe, expect, it } from "vitest"
import type {
  PublicDocSummary,
  PublicFolderSummary,
  PublicTaxonomy,
  PublicWorkspace,
} from "@/lib/public-kb"
import {
  firstPortalDocument,
  buildDefaultFooter,
  buildDefaultPortalLayout,
  buildPortalTheme,
  buildWorkspaceHeaderDefaults,
  normalizePortalLayoutForPublicData,
  withWorkspaceFooterFallback,
} from "./build-default"
import { setSidebarOverride } from "./builder-ops"
import { validatePortalLayout, type PortalLayout } from "./schema"

function workspace(overrides: Partial<PublicWorkspace> = {}): PublicWorkspace {
  return {
    id: "ws1",
    name: "Acme",
    slug: "acme",
    iconUrl: null,
    isPublic: true,
    primaryProjectSlug: null,
    portalChromeScope: "workspace",
    branding: {
      name: "Acme Docs",
      tagline: "",
      logoUrl: "",
      accentColor: "#2f5520",
    },
    ...overrides,
  }
}

function folder(
  id: string,
  display_name: string,
  kind: PublicFolderSummary["kind"],
  parent_folder_id: string | null = null,
): PublicFolderSummary {
  return {
    id,
    display_name,
    kind,
    parent_folder_id,
    document_count: 2,
    sort_order: null,
    updated_at: "2026-01-01T00:00:00Z",
  }
}

function doc(
  id: string,
  title: string,
  slug?: string,
  folder_id?: string | null,
  overrides: Partial<PublicDocSummary> = {},
): PublicDocSummary {
  return {
    id,
    slug,
    title,
    description: `Preview for ${title}`,
    source: "Onboarding",
    updated_at: "2026-01-01T00:00:00Z",
    folder_id: folder_id ?? null,
    ...overrides,
  }
}

const emptyTaxonomy: PublicTaxonomy = { topics: [], rootFolders: [] }

describe("normalizePortalLayoutForPublicData sidebar overrides", () => {
  it("applies a sidebar icon/label override to the matching group and persists it", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [folder("f1", "Developer", "user"), folder("f2", "Guides", "user")],
    }
    const base: PortalLayout = {
      schemaVersion: 1,
      theme: buildPortalTheme(workspace()),
      header: {
        id: "header",
        type: "portal-header",
        search: { enabled: true, placeholder: "Search" },
      },
      body: [],
      sidebarOverrides: { f1: { icon: "rocket", label: "Dev Zone" } },
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy,
      documents: [doc("d1", "Intro", "intro", "f1")],
    })

    const groups = normalized.sidebar?.groups ?? []
    const f1 = groups.find((g) => g.id === "f1")
    const f2 = groups.find((g) => g.id === "f2")
    expect(f1?.icon).toBe("rocket")
    expect(f1?.label).toBe("Dev Zone")
    // a non-overridden group matches the generic folder icon in the editor
    expect(f2?.icon).toBe("folder")
    // the override survives the folder-driven regeneration
    expect(normalized.sidebarOverrides?.f1?.icon).toBe("rocket")
  })

  it("honors a folder's stored icon, with a layout override still winning", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [
        { ...folder("f1", "Zebra", "user"), icon: "terminal" },
        { ...folder("f2", "Quokka", "user"), icon: "send" },
      ],
    }
    const base: PortalLayout = {
      schemaVersion: 1,
      theme: buildPortalTheme(workspace()),
      header: {
        id: "header",
        type: "portal-header",
        search: { enabled: true, placeholder: "Search" },
      },
      body: [],
      sidebarOverrides: { f2: { icon: "compass" } },
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy,
      documents: [doc("d1", "Intro", "intro", "f1")],
    })

    const groups = normalized.sidebar?.groups ?? []
    expect(groups.find((g) => g.id === "f1")?.icon).toBe("terminal")
    // sidebarOverrides beat the folder's own icon
    expect(groups.find((g) => g.id === "f2")?.icon).toBe("compass")
    const categories = normalized.body.find((block) => block.type === "category-grid")
    if (categories?.type !== "category-grid") {
      throw new Error("expected category-grid")
    }
    // Homepage cards use the editor's folder icons, and the SAME override wins
    // there too — it is a per-portal override of the folder's presentation, not
    // a rail-only one, so a rail-less help center can still re-icon a section.
    // The folder record itself is untouched (f2 still stores "send").
    expect(categories.items.map((item) => item.icon)).toEqual([
      "terminal",
      "compass",
    ])
    // an explicitly chosen icon implies the rail renders icons (else the docs
    // template's text-only default would swallow the choice)
    expect(normalized.sidebar?.showIcons).toBe(true)
  })

  it("does not inherit a stale generated sidebar icon for a plain folder", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [folder("plans", "Plans", "user")],
    }
    const base: PortalLayout = {
      schemaVersion: 1,
      theme: buildPortalTheme(workspace()),
      header: {
        id: "header",
        type: "portal-header",
        search: { enabled: true, placeholder: "Search" },
      },
      body: [],
      sidebar: {
        id: "sidebar",
        type: "sidebar-nav",
        groups: [
          {
            id: "plans",
            label: "Plans",
            icon: "book-open",
            href: "/p/acme/folder/plans",
            items: [],
          },
        ],
      },
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy,
      documents: [doc("d1", "Webhook Fail Fast Secrets", undefined, "plans")],
    })

    expect(normalized.sidebar?.groups[0]?.icon).toBe("folder")
  })

  it("leaves showIcons unset without explicit icons and honors an explicit false", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [folder("f1", "Guides", "user")],
    }
    const base: PortalLayout = {
      schemaVersion: 1,
      theme: buildPortalTheme(workspace()),
      header: {
        id: "header",
        type: "portal-header",
        search: { enabled: true, placeholder: "Search" },
      },
      body: [],
    }
    const documents = [doc("d1", "Intro", "intro", "f1")]

    const plain = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy,
      documents,
    })
    expect(plain.sidebar?.showIcons).toBeUndefined()

    const hidden = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: {
        ...base,
        sidebar: { id: "sidebar", type: "sidebar-nav", groups: [], showIcons: false },
        sidebarOverrides: { f1: { icon: "terminal" } },
      },
      taxonomy,
      documents,
    })
    // an explicit publisher choice to hide icons wins over the implication
    expect(hidden.sidebar?.showIcons).toBe(false)
  })
})

describe("normalizePortalLayoutForPublicData sidebar enablement", () => {
  const taxonomy: PublicTaxonomy = {
    topics: [],
    rootFolders: [folder("f1", "Guides", "user")],
  }
  const documents = [doc("d1", "Intro", "intro", "f1")]
  const withStoredRail: PortalLayout = {
    schemaVersion: 1,
    theme: buildPortalTheme(workspace()),
    header: {
      id: "header",
      type: "portal-header",
      search: { enabled: true, placeholder: "Search" },
    },
    body: [],
    sidebar: {
      id: "sidebar",
      type: "sidebar-nav",
      groups: [{ id: "f1", label: "Guides", href: "/p/acme/folder/f1", items: [] }],
    },
  }

  it("keeps the rail even when a legacy layout stored sidebarEnabled false", () => {
    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: { ...withStoredRail, sidebarEnabled: false },
      taxonomy,
      documents,
    })
    expect(normalized.sidebar).toBeDefined()
  })

  it("keeps the rail for docs portals by default", () => {
    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: withStoredRail,
      taxonomy,
      documents,
    })
    expect(normalized.sidebar?.groups.map((g) => g.id)).toEqual(["f1"])
  })
})

describe("buildDefaultFooter", () => {
  it("returns a slim footer (credit only) with no workspace footer", () => {
    expect(buildDefaultFooter()).toEqual({
      id: "footer",
      type: "footer",
      showPoweredBy: true,
    })
    // A workspace without a crawled footer is the same as none.
    expect(buildDefaultFooter(workspace())).toEqual({
      id: "footer",
      type: "footer",
      showPoweredBy: true,
    })
  })

  it("folds a crawled workspace footer into columns + social + note", () => {
    const footer = buildDefaultFooter(
      workspace({
        footer: {
          columns: [
            { heading: "Resources", links: [{ label: "Docs", href: "https://acme.com/docs" }] },
          ],
          social: [{ platform: "github", href: "https://github.com/acme" }],
          note: "© Acme",
        },
      }),
    )
    expect(footer.columns).toHaveLength(1)
    expect(footer.social).toEqual([{ platform: "github", href: "https://github.com/acme" }])
    expect(footer.note).toBe("© Acme")
    expect(footer.showPoweredBy).toBe(true)
    // The result must be a valid layout footer (it ships inside a PortalLayout).
    const layout = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace({
        footer: {
          columns: [
            { heading: "Resources", links: [{ label: "Docs", href: "https://acme.com/docs" }] },
          ],
        },
      }),
      taxonomy: { rootFolders: [], allFolders: [] } as unknown as PublicTaxonomy,
      rootDocs: [],
    })
    expect(validatePortalLayout(layout).ok).toBe(true)
  })
})

describe("buildPortalTheme", () => {
  it("derives the theme from branding with empty nav/cta defaults", () => {
    const theme = buildPortalTheme(workspace({ branding: { name: "Brand", tagline: "Tag", logoUrl: "/l.png", accentColor: "#abc" } }))
    expect(theme).toMatchObject({
      brandName: "Brand",
      tagline: "Tag",
      logoUrl: "/l.png",
      accentColor: "#abc",
      navLinks: [],
      cta: null,
      font: "sans",
      appearance: "auto",
    })
  })

  it("points header nav/CTA at the workspace's own landing page when set", () => {
    const theme = buildPortalTheme(workspace({ websiteUrl: "https://acme.com" }))
    // Only the Home link the admin actually entered — no guessed Pricing link
    // (onboarding never captures a pricing URL, so the convention would 404).
    expect(theme.navLinks).toEqual([
      { label: "Home", href: "https://acme.com/" },
    ])
    expect(theme.cta).toEqual({ label: "Visit website", href: "https://acme.com/" })
  })

  it("links Home to the exact landing page URL the admin entered, path and all", () => {
    const theme = buildPortalTheme(workspace({ websiteUrl: "https://acme.com/welcome" }))
    expect(theme.navLinks).toEqual([
      { label: "Home", href: "https://acme.com/welcome" },
    ])
  })
})

describe("withWorkspaceFooterFallback", () => {
  const workspaceFooter = {
    columns: [
      {
        heading: "Resources",
        links: [{ label: "Docs", href: "https://acme.com/docs" }],
      },
    ],
    social: [{ platform: "github" as const, href: "https://github.com/acme" }],
    note: "© Acme",
  }

  it("fills an empty layout footer from the workspace footer", () => {
    expect(
      withWorkspaceFooterFallback(
        { id: "footer", type: "footer", showPoweredBy: false },
        workspaceFooter,
      ),
    ).toEqual({
      id: "footer",
      type: "footer",
      showPoweredBy: false,
      columns: workspaceFooter.columns,
      social: workspaceFooter.social,
      note: workspaceFooter.note,
    })
  })

  it("keeps authored layout footer content instead of replacing it", () => {
    const authoredFooter = {
      id: "footer",
      type: "footer" as const,
      showPoweredBy: true,
      columns: [
        {
          heading: "Company",
          links: [{ label: "About", href: "https://acme.com/about" }],
        },
      ],
    }

    expect(withWorkspaceFooterFallback(authoredFooter, workspaceFooter, "custom")).toBe(
      authoredFooter,
    )
  })

  it("ignores authored footer links when workspace mode is selected", () => {
    const footer = withWorkspaceFooterFallback(
      {
        id: "footer",
        type: "footer",
        showPoweredBy: false,
        columns: [
          {
            heading: "Company",
            links: [{ label: "About", href: "https://acme.com/about" }],
          },
        ],
      },
      workspaceFooter,
      "workspace",
    )

    expect(footer?.showPoweredBy).toBe(false)
    expect(footer?.columns).toEqual(workspaceFooter.columns)
  })
})

describe("buildDefaultPortalLayout", () => {
  it("surfaces documents owned by a hidden project root as top-level navigation", () => {
    const root = folder("root", "Developer Docs", "user")
    const child = folder("child", "API", "user", "root")
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [child],
      allFolders: [root, child],
      promotedRootIds: [root.id],
    }
    const layout = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy,
      rootDocs: [
        doc("root-doc", "Overview", "overview", root.id),
        doc("child-doc", "Authentication", "authentication", child.id),
      ],
    })

    expect(layout.sidebar?.groups.map((group) => group.id)).toEqual([
      "child",
      "documents",
    ])
    expect(layout.sidebar?.groups[0]?.items.map((item) => item.label)).toEqual([
      "Authentication",
    ])
    expect(layout.sidebar?.groups[1]?.items.map((item) => item.label)).toEqual([
      "Overview",
    ])
  })

  it("maps folders to sidebar groups and category grid without dumping all documents", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [folder("t1", "Deploys", "topic")],
      rootFolders: [folder("f1", "Guides", "user")],
      allFolders: [folder("f1", "Guides", "user")],
    }
    const rootDocs = [
      doc("d1", "Getting Started", "getting-started", "f1"),
      doc("d2", "FAQ", undefined, "f1"),
    ]
    const layout = buildDefaultPortalLayout({ slug: "acme", workspace: workspace(), taxonomy, rootDocs })

    // sidebar: topics are intentionally not exposed in the portal
    expect(layout.sidebar?.groups.map((g) => g.id)).toEqual(["f1"])
    expect(layout.sidebar?.groups[0]).toMatchObject({
      label: "Guides",
    })
    expect(layout.sidebar?.groups[0]?.items.map((item) => item.href)).toEqual([
      "/p/acme/doc/getting-started",
      "/p/acme/doc/d2",
    ])

    // category grid: folders only, with correct hrefs + icons
    const grid = layout.body.find((b) => b.type === "category-grid")
    expect(grid?.type).toBe("category-grid")
    if (grid?.type === "category-grid") {
      expect(grid.placement).toBe("main")
      expect(grid.items.map((i) => i.id)).toEqual(["f1"])
      // An unset folder icon matches the generic folder glyph in the editor.
      expect(grid.items[0]).toMatchObject({ icon: "folder", href: "/p/acme/folder/f1" })
      // Cards no longer carry generated doc-count descriptions.
      expect(grid.items[0]?.description).toBeUndefined()
    }

    expect(layout.body.some((b) => b.type === "article-list")).toBe(false)

    // The landing page relies on the global header search, so its content starts
    // directly with the hero and categories.
    const hero = layout.body.find((b) => b.type === "hero")
    expect(hero?.placement).toBe("full")
    if (hero?.type === "hero") {
      expect(hero.eyebrow).toBeUndefined()
      expect(hero.heading).toBe("Documentation")
      expect(hero.subtitle).toBe("Guides, references, and answers for working with Acme Docs.")
    }
    expect(layout.body.some((b) => b.type === "ask-ai-search")).toBe(false)

    expect(validatePortalLayout(layout).ok).toBe(true)
  })

  it("falls back to documents as categories when there are no folders", () => {
    const layout = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [doc("d1", "Getting Started")],
    })
    expect(layout.sidebar?.groups.map((g) => g.id)).toEqual(["documents"])
    const grid = layout.body.find((b) => b.type === "category-grid")
    if (grid?.type === "category-grid") {
      expect(grid.items[0]).toMatchObject({ id: "d1", icon: "file-text", href: "/p/acme/doc/d1" })
    } else {
      throw new Error("expected category-grid")
    }
    expect(validatePortalLayout(layout).ok).toBe(true)
  })

  it("keeps child folders nested in the sidebar instead of flattening their docs", () => {
    const developer = folder("developer", "Developer", "user")
    const mcp = folder("mcp", "MCP", "user", "developer")
    const api = folder("api", "API", "user", "developer")
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [developer],
      allFolders: [developer, mcp, api],
    }
    const layout = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy,
      rootDocs: [
        doc("mcp-tools", "MCP Tools", "mcp-tools", "mcp"),
        doc("api-search", "Search", "search", "api"),
        doc("cli", "Connect your AI tools", "connect-ai-tools", "developer"),
      ],
    })

    const developerGroup = layout.sidebar?.groups[0]
    expect(developerGroup?.label).toBe("Developer")
    expect(developerGroup?.items.map((item) => item.label)).toEqual([
      "Connect your AI tools",
    ])
    expect(developerGroup?.children?.map((group) => group.label)).toEqual([
      "API",
      "MCP",
    ])
    expect(developerGroup?.children?.[0]?.items.map((item) => item.label)).toEqual([
      "Search",
    ])
    expect(developerGroup?.children?.[1]?.items.map((item) => item.label)).toEqual([
      "MCP Tools",
    ])
    expect(validatePortalLayout(layout).ok).toBe(true)
  })

  it("renders an empty state with no sidebar and only the hero", () => {
    const layout = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    expect(layout.sidebar).toBeUndefined()
    expect(layout.body.map((b) => b.type)).toEqual(["hero"])
    const hero = layout.body[0]
    if (hero?.type === "hero") {
      expect(hero.subtitle).toBe(
        "Your knowledge base is ready. Publish your first docs from Bread to share them here.",
      )
    }
    expect(validatePortalLayout(layout).ok).toBe(true)
  })

  it("prefers a configured tagline as the hero subtitle", () => {
    const layout = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace({ branding: { name: "Acme", tagline: "Everything about Acme.", logoUrl: "", accentColor: "#2f5520" } }),
      taxonomy: emptyTaxonomy,
      rootDocs: [doc("d1", "X")],
    })
    const hero = layout.body[0]
    if (hero?.type === "hero") {
      expect(hero.subtitle).toBe("Everything about Acme.")
    }
  })
})

describe("normalizePortalLayoutForPublicData", () => {
  it("applies workspace header and footer when chrome modes are workspace", () => {
    const base = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace({ websiteUrl: "https://old.example.com" }),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.chrome = { headerMode: "workspace", footerMode: "workspace" }
    base.theme.navLinks = [{ label: "Old", href: "https://old.example.com" }]
    base.theme.cta = { label: "Old CTA", href: "https://old.example.com/contact" }
    base.header.search.placeholder = "Old search"
    base.header.languagePlacement = "actions"
    base.footer = {
      id: "footer",
      type: "footer",
      showPoweredBy: false,
      columns: [
        {
          heading: "Old",
          links: [{ label: "Old", href: "https://old.example.com/footer" }],
        },
      ],
    }

    const workspaceFooter = {
      columns: [
        {
          heading: "Resources",
          links: [{ label: "Docs", href: "https://acme.com/docs" }],
        },
      ],
      note: "© Acme",
    }
    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy: emptyTaxonomy,
      documents: [],
      workspaceHeader: buildWorkspaceHeaderDefaults({
        websiteUrl: "https://acme.com",
        header: { languagePlacement: "brand" },
      }),
      workspaceFooter,
    })

    expect(normalized.chrome).toEqual({
      headerMode: "workspace",
      footerMode: "workspace",
    })
    expect(normalized.header.search.placeholder).toBe("Search or ask AI")
    expect(normalized.header.languagePlacement).toBe("brand")
    expect(normalized.theme.navLinks).toEqual([{ label: "Home", href: "https://acme.com/" }])
    expect(normalized.theme.cta).toEqual({ label: "Visit website", href: "https://acme.com/" })
    expect(normalized.footer?.showPoweredBy).toBe(false)
    expect(normalized.footer?.columns).toEqual(workspaceFooter.columns)
    expect(normalized.footer?.note).toBe("© Acme")
  })

  it("preserves project header and footer when chrome modes are custom", () => {
    const base = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace({ websiteUrl: "https://workspace.example.com" }),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.chrome = { headerMode: "custom", footerMode: "custom" }
    base.theme.navLinks = [{ label: "Project", href: "https://project.example.com" }]
    base.theme.cta = { label: "Project CTA", href: "https://project.example.com/contact" }
    base.header.search.placeholder = "Search project docs"
    base.footer = {
      id: "footer",
      type: "footer",
      showPoweredBy: true,
      note: "Project footer",
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy: emptyTaxonomy,
      documents: [],
      workspaceHeader: buildWorkspaceHeaderDefaults({ websiteUrl: "https://acme.com" }),
      workspaceFooter: {
        columns: [
          {
            heading: "Workspace",
            links: [{ label: "Docs", href: "https://acme.com/docs" }],
          },
        ],
      },
    })

    expect(normalized.chrome).toEqual({
      headerMode: "custom",
      footerMode: "custom",
    })
    expect(normalized.header.search.placeholder).toBe("Search project docs")
    expect(normalized.theme.navLinks).toEqual(base.theme.navLinks)
    expect(normalized.theme.cta).toEqual(base.theme.cta)
    expect(normalized.footer?.note).toBe("Project footer")
    expect(normalized.footer?.columns).toBeUndefined()
  })

  it("forces shared chrome when the workspace setting is workspace", () => {
    const base = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace({ websiteUrl: "https://workspace.example.com" }),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.chrome = { headerMode: "custom", footerMode: "custom" }
    base.theme.navLinks = [{ label: "Project", href: "https://project.example.com" }]
    base.header.search.placeholder = "Project search"
    base.footer = {
      id: "footer",
      type: "footer",
      showPoweredBy: true,
      note: "Project footer",
    }

    const workspaceFooter = {
      columns: [
        {
          heading: "Workspace",
          links: [{ label: "Docs", href: "https://acme.com/docs" }],
        },
      ],
    }
    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy: emptyTaxonomy,
      documents: [],
      workspaceHeader: buildWorkspaceHeaderDefaults({ websiteUrl: "https://acme.com" }),
      workspaceFooter,
      workspaceChromeScope: "workspace",
    })

    expect(normalized.chrome).toEqual({
      headerMode: "workspace",
      footerMode: "workspace",
    })
    expect(normalized.header.search.placeholder).toBe("Search or ask AI")
    expect(normalized.theme.navLinks).toEqual([{ label: "Home", href: "https://acme.com/" }])
    expect(normalized.footer?.columns).toEqual(workspaceFooter.columns)
    expect(normalized.footer?.note).toBeUndefined()
  })

  it("forces project chrome when the workspace setting is project", () => {
    const base = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace({ websiteUrl: "https://workspace.example.com" }),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.chrome = { headerMode: "workspace", footerMode: "workspace" }
    base.theme.navLinks = [{ label: "Project", href: "https://project.example.com" }]
    base.header.search.placeholder = "Project search"
    base.footer = {
      id: "footer",
      type: "footer",
      showPoweredBy: true,
      note: "Project footer",
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy: emptyTaxonomy,
      documents: [],
      workspaceHeader: buildWorkspaceHeaderDefaults({ websiteUrl: "https://acme.com" }),
      workspaceFooter: {
        columns: [
          {
            heading: "Workspace",
            links: [{ label: "Docs", href: "https://acme.com/docs" }],
          },
        ],
      },
      workspaceChromeScope: "project",
    })

    expect(normalized.chrome).toEqual({
      headerMode: "custom",
      footerMode: "custom",
    })
    expect(normalized.header.search.placeholder).toBe("Project search")
    expect(normalized.theme.navLinks).toEqual(base.theme.navLinks)
    expect(normalized.footer?.note).toBe("Project footer")
    expect(normalized.footer?.columns).toBeUndefined()
  })

  it("removes stale topic navigation and keeps docs categorized by folder", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [folder("topic-1", "Streaming", "topic")],
      rootFolders: [folder("folder-1", "Bread Help Center", "user")],
      allFolders: [
        folder("folder-1", "Bread Help Center", "user"),
        folder("child-1", "Setup", "user", "folder-1"),
      ],
    }
    const documents = [
      doc("doc-1", "Install Bread", "install-bread", "child-1"),
      doc("doc-2", "Invite teammates", undefined, "folder-1"),
      doc("doc-3", "Publish docs", undefined, null),
    ]
    const stale = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    stale.theme.font = "sans"
    stale.header.search.placeholder = "Search or ask AI"
    stale.body = [
      {
        id: "hero",
        type: "hero",
        placement: "full",
        heading: "How can we help?",
        subtitle: "Browse answers from 7 documents.",
      },
      {
        id: "ask",
        type: "ask-ai-search",
        placement: "full",
        placeholder: "Ask, search, or explain…",
      },
      {
        id: "categories",
        type: "category-grid",
        placement: "main",
        items: [
          {
            id: "topic-1",
            title: "streaming",
            description: "0 documents",
            icon: "hash",
            href: "/p/acme/folder/topic-1",
          },
          {
            id: "folder-1",
            title: "Bread Help Center",
            description: "12 documents",
            icon: "folder",
            href: "/p/acme/folder/folder-1",
          },
        ],
      },
    ]
    stale.sidebar = {
      id: "sidebar",
      type: "sidebar-nav",
      groups: [
        {
          id: "topics",
          label: "Topics",
          icon: "hash",
          items: [{ id: "topic-1", label: "streaming", href: "/p/acme/folder/topic-1" }],
        },
      ],
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: stale,
      taxonomy,
      documents,
    })

    const hero = normalized.body.find((block) => block.type === "hero")
    expect(hero?.type).toBe("hero")
    if (hero?.type === "hero") {
      expect(hero.heading).toBe("How can we help 👋")
      expect(hero.subtitle).toBe(
        "We're here to help! Browse our help center for answers to your questions.",
      )
    }

    const categories = normalized.body.find((block) => block.type === "category-grid")
    expect(categories?.type).toBe("category-grid")
    if (categories?.type === "category-grid") {
      expect(categories.items.map((item) => item.id)).toEqual(["folder-1"])
    }

    const docs = normalized.body.find((block) => block.type === "article-list")
    expect(docs).toBeUndefined()

    expect(normalized.sidebar?.groups.map((group) => group.id)).toEqual([
      "folder-1",
      "documents",
    ])
    expect(normalized.sidebar?.groups[0]?.items.map((item) => item.href)).toEqual([
      "/p/acme/doc/doc-2",
    ])
    expect(normalized.sidebar?.groups[0]?.children?.map((group) => group.id)).toEqual([
      "child-1",
    ])
    expect(
      normalized.sidebar?.groups[0]?.children?.[0]?.items.map((item) => item.href),
    ).toEqual(["/p/acme/doc/install-bread"])
    expect(normalized.sidebar?.groups[1]?.items.map((item) => item.href)).toEqual([
      "/p/acme/doc/doc-3",
    ])
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })

  it("repopulates an empty seeded category-grid from the scoped root folders", () => {
    // A stored spec can ship an EMPTY category-grid meant to fill at render
    // time. Normalize must repopulate it from the (scoped) taxonomy
    // instead of dropping the block, so a topic grid still renders.
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [
        folder("f-getting-started", "Getting Started", "user"),
        folder("f-billing", "Billing", "user"),
      ],
    }
    const documents = [doc("d1", "Install Bread", "install-bread")]
    const base = buildDefaultPortalLayout({
      slug: "bread-help",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    // Force an empty category-grid block (the seeded spec's shape).
    base.body = [
      {
        id: "categories",
        type: "category-grid",
        placement: "main",
        items: [],
      },
    ]

    const normalized = normalizePortalLayoutForPublicData({
      slug: "bread-help",
      layout: base,
      taxonomy,
      documents,
    })

    const grid = normalized.body.find((b) => b.type === "category-grid")
    expect(grid?.type).toBe("category-grid")
    if (grid?.type === "category-grid") {
      expect(grid.items.map((i) => i.id)).toEqual([
        "f-getting-started",
        "f-billing",
      ])
      expect(grid.items[0]).toMatchObject({
        icon: "folder",
        href: "/p/bread-help/folder/f-getting-started",
      })
      expect(grid.items[0]?.description).toBeUndefined()
    }
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })

  it("adds newly-created folders to an existing generated quick-link grid", () => {
    const originalTaxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [folder("f-guides", "Guides", "user")],
    }
    const base = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy: originalTaxonomy,
      rootDocs: [],
    })
    const originalGrid = base.body.find((block) => block.type === "category-grid")
    if (originalGrid?.type !== "category-grid") {
      throw new Error("expected category-grid")
    }
    originalGrid.items[0] = {
      ...originalGrid.items[0]!,
      title: "Read the guides",
      description: "Publisher-authored copy",
      // Simulate the old name-inferred icon that did not match the editor.
      icon: "book-open",
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy: {
        topics: [],
        rootFolders: [
          folder("f-guides", "Guides", "user"),
          folder("f-api", "API Reference", "user"),
        ],
      },
      documents: [],
    })

    const grid = normalized.body.find((block) => block.type === "category-grid")
    if (grid?.type !== "category-grid") throw new Error("expected category-grid")
    expect(grid.items.map((item) => item.id)).toEqual(["f-guides", "f-api"])
    expect(grid.items[0]).toMatchObject({
      title: "Read the guides",
      description: "Publisher-authored copy",
      icon: "folder",
      href: "/p/acme/folder/f-guides",
    })
    expect(grid.items[1]).toMatchObject({
      title: "API Reference",
      href: "/p/acme/folder/f-api",
    })
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })

  it("replaces generated document fallbacks with folder quick links", () => {
    const base = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [doc("d1", "Getting Started")],
    })

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy: {
        topics: [],
        rootFolders: [folder("f1", "Getting Started", "user")],
      },
      documents: [doc("d1", "Getting Started", undefined, "f1")],
    })

    const grid = normalized.body.find((block) => block.type === "category-grid")
    if (grid?.type !== "category-grid") throw new Error("expected category-grid")
    expect(grid.items.map((item) => item.id)).toEqual(["f1"])
    expect(grid.items[0]?.href).toBe("/p/acme/folder/f1")
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })

  it("drops an empty category-grid when there are no folders to populate it", () => {
    const base = buildDefaultPortalLayout({
      slug: "bread-help",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.body = [
      { id: "categories", type: "category-grid", placement: "main", items: [] },
    ]

    const normalized = normalizePortalLayoutForPublicData({
      slug: "bread-help",
      layout: base,
      taxonomy: emptyTaxonomy,
      documents: [],
    })

    expect(normalized.body.some((b) => b.type === "category-grid")).toBe(false)
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })

  it("filters stale-base links from body/tree/HTML while keeping the scoped sidebar", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [folder("folder-keep", "Guides", "user")],
      allFolders: [folder("folder-keep", "Guides", "user")],
    }
    const documents = [doc("doc-keep", "Install", "install", "folder-keep")]
    const base = buildDefaultPortalLayout({
      slug: "acme/help",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.body = [
      {
        id: "categories",
        type: "category-grid",
        placement: "main",
        items: [
          {
            id: "folder-keep",
            title: "Guides",
            icon: "folder",
            href: "/p/old-project/folder/folder-keep",
          },
          {
            id: "folder-drop",
            title: "Private",
            icon: "folder",
            href: "/p/old-workspace/old-project/folder/folder-drop",
          },
        ],
      },
      {
        id: "links",
        type: "rich-text",
        placement: "main",
        html: [
          '<a href="/p/old-workspace/old-project/doc/install">Install</a>',
          '<a href="/p/old-workspace/old-project/doc/private">Private</a>',
        ].join(""),
      },
    ]
    base.tree = {
      id: "root",
      type: "Stack",
      children: [
        {
          id: "keep-link",
          type: "Link",
          props: { label: "Install", href: "/p/old-workspace/old-project/doc/install" },
        },
        {
          id: "drop-link",
          type: "Link",
          props: { label: "Private", href: "/p/old-workspace/old-project/doc/private" },
        },
      ],
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme/help",
      layout: base,
      taxonomy,
      documents,
    })
    const categories = normalized.body.find((block) => block.type === "category-grid")
    const richText = normalized.body.find((block) => block.type === "rich-text")

    expect(categories?.type).toBe("category-grid")
    if (categories?.type === "category-grid") {
      expect(categories.items.map((item) => item.href)).toEqual([
        "/p/acme/help/folder/folder-keep",
      ])
    }
    expect(richText?.type).toBe("rich-text")
    if (richText?.type === "rich-text") {
      expect(richText.html).toContain('href="/p/acme/help/doc/install"')
      expect(richText.html).toContain("<a>Private</a>")
    }
    expect(normalized.tree?.children?.map((child) => child.id)).toEqual(["keep-link"])
    expect(normalized.tree?.children?.[0]?.props?.href).toBe("/p/acme/help/doc/install")
    expect(normalized.sidebar?.groups.map((group) => group.id)).toEqual(["folder-keep"])
    expect(normalized.sidebar?.groups[0]?.items[0]?.href).toBe(
      "/p/acme/help/doc/install",
    )
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })
})

describe("category card doc-count removal", () => {
  it("builds category cards without a generated doc-count description", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [folder("root", "Developer", "user")],
      allFolders: [
        folder("root", "Developer", "user"),
        folder("child-a", "Guides", "user", "root"),
      ],
    }
    const layout = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy,
      rootDocs: [],
    })
    const grid = layout.body.find((b) => b.type === "category-grid")
    if (grid?.type !== "category-grid") throw new Error("expected category-grid")
    expect(grid.items[0]?.description).toBeUndefined()
  })

  it("normalize strips stale generated count descriptions but preserves curated copy", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [folder("root", "Developer", "user")],
      allFolders: [
        folder("root", "Developer", "user"),
        folder("child", "Guides", "user", "root"),
      ],
    }
    const base = buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.body = [
      {
        id: "categories",
        type: "category-grid",
        placement: "main",
        items: [
          {
            id: "stale",
            title: "Developer",
            description: "0 documents",
            icon: "puzzle",
            href: "/p/acme/folder/root",
          },
          {
            id: "curated",
            title: "Developer handbook",
            description: "Everything you need to build",
            icon: "folder",
            href: "/p/acme/folder/root",
          },
        ],
      },
    ]

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme",
      layout: base,
      taxonomy,
      documents: [],
    })

    const grid = normalized.body.find((b) => b.type === "category-grid")
    if (grid?.type !== "category-grid") throw new Error("expected category-grid")
    expect(grid.items[0]?.description).toBeUndefined()
    expect(grid.items[1]?.description).toBe("Everything you need to build")
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })
})

describe("empty tree CategoryGrid refill", () => {
  it("repopulates an empty CategoryGrid tree node from the scoped root folders", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [
        folder("f1", "Getting Started", "user"),
        folder("f2", "Integrations", "user"),
      ],
      allFolders: [
        folder("f1", "Getting Started", "user"),
        folder("f2", "Integrations", "user"),
      ],
    }
    const base = buildDefaultPortalLayout({
      slug: "acme/docs",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.tree = {
      id: "root",
      type: "Stack",
      children: [
        { id: "hero", type: "Hero", props: { heading: "Docs" } },
        { id: "n-categories", type: "CategoryGrid", props: { items: [] } },
        {
          id: "curated",
          type: "CategoryGrid",
          props: {
            items: [
              { id: "f1", title: "Start here", icon: "rocket", href: "/p/acme/docs/folder/f1" },
            ],
          },
        },
      ],
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme/docs",
      layout: base,
      taxonomy,
      documents: [],
    })

    const grids = (normalized.tree?.children ?? []).filter(
      (child) => child.type === "CategoryGrid",
    )
    const filledItems = grids[0]?.props?.items as { title: string; href: string }[]
    expect(filledItems.map((item) => item.title)).toEqual([
      "Getting Started",
      "Integrations",
    ])
    expect(filledItems.map((item) => item.href)).toEqual([
      "/p/acme/docs/folder/f1",
      "/p/acme/docs/folder/f2",
    ])
    // a curated, non-empty grid is left alone
    const curatedItems = grids[1]?.props?.items as { title: string }[]
    expect(curatedItems.map((item) => item.title)).toEqual(["Start here"])
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })

  it("adds new folders to the generated tree grid without changing curated grids", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [
        folder("f1", "Getting Started", "user"),
        folder("f2", "Integrations", "user"),
      ],
    }
    const base = buildDefaultPortalLayout({
      slug: "acme/docs",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.tree = {
      id: "root",
      type: "Stack",
      children: [
        {
          id: "n-categories",
          type: "CategoryGrid",
          props: {
            items: [
              {
                id: "f1",
                title: "Start here",
                icon: "rocket",
                href: "/p/old-base/folder/f1",
              },
            ],
          },
        },
        {
          id: "curated",
          type: "CategoryGrid",
          props: {
            items: [
              {
                id: "f1",
                title: "Curated start",
                icon: "star",
                href: "/p/old-base/folder/f1",
              },
            ],
          },
        },
      ],
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme/docs",
      layout: base,
      taxonomy,
      documents: [],
    })

    const grids = (normalized.tree?.children ?? []).filter(
      (child) => child.type === "CategoryGrid",
    )
    const generatedItems = grids[0]?.props?.items as {
      id: string
      title: string
      icon: string
      href: string
    }[]
    expect(generatedItems.map((item) => item.id)).toEqual(["f1", "f2"])
    expect(generatedItems[0]).toMatchObject({
      title: "Start here",
      icon: "folder",
      href: "/p/acme/docs/folder/f1",
    })
    expect(generatedItems[1]?.href).toBe("/p/acme/docs/folder/f2")

    const curatedItems = grids[1]?.props?.items as { id: string; title: string }[]
    expect(curatedItems).toEqual([
      expect.objectContaining({ id: "f1", title: "Curated start" }),
    ])
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })

  it("re-icons a generated tree card from the folder override", () => {
    // The rail-less help center path: its category cards ARE the navigation, so
    // the folder override is the only way to change their icons — an icon set
    // on the card node is overwritten by the folder-driven regeneration above.
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [
        folder("f1", "Getting Started", "user"),
        folder("f2", "Integrations", "user"),
      ],
    }
    const base = buildDefaultPortalLayout({
      slug: "acme/help",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.sidebarOverrides = { f1: { icon: "rocket", label: "Start here" } }
    base.tree = {
      id: "root",
      type: "Stack",
      children: [
        {
          id: "n-categories",
          type: "CategoryGrid",
          props: {
            items: [
              {
                id: "f1",
                title: "Getting Started",
                icon: "folder",
                href: "/p/acme/help/folder/f1",
              },
            ],
          },
        },
      ],
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme/help",
      layout: base,
      taxonomy,
      documents: [],
    })

    const items = (normalized.tree?.children ?? [])[0]?.props?.items as {
      id: string
      title: string
      icon: string
    }[]
    expect(items[0]).toMatchObject({
      id: "f1",
      title: "Start here",
      icon: "rocket",
    })
    // A folder with no override still mirrors the folder editor.
    expect(items[1]).toMatchObject({ id: "f2", icon: "folder" })
    expect(validatePortalLayout(normalized).ok).toBe(true)
  })

  it("leaves an empty tree grid empty when the scope has no root folders", () => {
    const base = buildDefaultPortalLayout({
      slug: "acme/docs",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
    base.tree = {
      id: "root",
      type: "Stack",
      children: [{ id: "n-categories", type: "CategoryGrid", props: { items: [] } }],
    }

    const normalized = normalizePortalLayoutForPublicData({
      slug: "acme/docs",
      layout: base,
      taxonomy: emptyTaxonomy,
      documents: [],
    })

    const grid = normalized.tree?.children?.find((child) => child.type === "CategoryGrid")
    expect(grid?.props?.items).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Folder icons are stored on the FOLDER, and a portal-level override outranks
// them. The agent's setFolderIcon writes the folder record and clears any
// override for it — without that clearing step a stale override would silently
// mask the icon just set. These pin both halves of that contract.
// ---------------------------------------------------------------------------
describe("folder icon vs portal override", () => {
  const taxonomy: PublicTaxonomy = {
    topics: [],
    rootFolders: [{ ...folder("f1", "Billing", "user"), icon: "credit-card" }],
  }

  function normalizeWith(layout: PortalLayout): PortalLayout {
    return normalizePortalLayoutForPublicData({
      slug: "acme",
      layout,
      taxonomy,
      documents: [],
    })
  }

  function base(): PortalLayout {
    return buildDefaultPortalLayout({
      slug: "acme",
      workspace: workspace(),
      taxonomy: emptyTaxonomy,
      rootDocs: [],
    })
  }

  function gridIcons(layout: PortalLayout): (string | undefined)[] {
    const grid = layout.body.find((b) => b.type === "category-grid")
    if (grid?.type !== "category-grid") throw new Error("expected category-grid")
    return grid.items.map((item) => item.icon)
  }

  it("shows the folder's own icon when nothing overrides it", () => {
    expect(gridIcons(normalizeWith(base()))).toEqual(["credit-card"])
  })

  it("lets a stale override mask the folder icon until it is cleared", () => {
    const overridden = setSidebarOverride(base(), "f1", { icon: "compass" })
    expect(gridIcons(normalizeWith(overridden))).toEqual(["compass"])

    // What setFolderIcon does after writing folders.icon.
    const cleared = setSidebarOverride(overridden, "f1", { icon: undefined })
    expect(cleared.sidebarOverrides?.f1?.icon).toBeUndefined()
    expect(gridIcons(normalizeWith(cleared))).toEqual(["credit-card"])
  })

  it("keeps a label override when only the icon override is cleared", () => {
    const both = setSidebarOverride(base(), "f1", {
      icon: "compass",
      label: "Plans & Billing",
    })
    const cleared = setSidebarOverride(both, "f1", { icon: undefined })

    expect(cleared.sidebarOverrides?.f1?.label).toBe("Plans & Billing")
    const grid = normalizeWith(cleared).body.find((b) => b.type === "category-grid")
    if (grid?.type !== "category-grid") throw new Error("expected category-grid")
    expect(grid.items[0]).toMatchObject({
      title: "Plans & Billing",
      icon: "credit-card",
    })
  })
})


describe("document-only portal entry", () => {
  it("keeps README documents in the navigation and selects by reading order", () => {
    const documents = [
      doc("later", "Later", "later", "f1", { sort_order: 2 }),
      doc("readme", "README", "readme", "f1", { sort_order: 0 }),
    ]
    const taxonomy: PublicTaxonomy = {
      topics: [], rootFolders: [folder("f1", "Guides", "user")],
    }
    const layout = buildDefaultPortalLayout({ slug: "acme", workspace: workspace(), taxonomy, rootDocs: documents })
    expect(layout.sidebar?.groups[0]?.href).toBeUndefined()
    expect(layout.sidebar?.groups[0]?.items.map((item) => item.id)).toEqual(["readme", "later"])
    expect(firstPortalDocument(taxonomy, documents)?.id).toBe("readme")
    expect(firstPortalDocument(taxonomy, [])).toBeUndefined()
  })
})
