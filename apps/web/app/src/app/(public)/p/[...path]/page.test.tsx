import { beforeEach, describe, expect, it, vi } from "vitest"

// Breeze internal tool: portal surfaces require a Breeze user. Default to an
// allowed caller; individual tests override to check the refusal.
const breezeGate = vi.hoisted(() => ({
  breezeOnlyResponse: vi.fn(async (): Promise<Response | null> => null),
  requireBreezeViewer: vi.fn(async () => ({ id: "u1", email: "u1@breeze.com" })),
}))
vi.mock("@/lib/auth/require-breeze", () => breezeGate)

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("not found")
  }),
  redirect: vi.fn(() => {
    throw new Error("redirect")
  }),
  headers: vi.fn(),
  requirePortal: vi.fn(),
  portalPublicNextPath: vi.fn(),
  getPublicDocument: vi.fn(),
  getPublicDocuments: vi.fn(),
  getPublicDocumentsWithContent: vi.fn(),
  getPublicFolderDetail: vi.fn(),
  getPublicTaxonomy: vi.fn(),
  isDocInScope: vi.fn(),
  isFolderInScope: vi.fn(),
  getPortalEntitlementsForWorkspace: vi.fn(),
  isPortalAiBuilderEnabledForWorkspace: vi.fn(),
  isPortalReportingEnabledForWorkspace: vi.fn(),
  portalHomeView: vi.fn(),
  portalDocView: vi.fn(),
  portalFolderView: vi.fn(),
  portalApiReferenceView: vi.fn(),
  portalChangelogView: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}))
vi.mock("next/headers", () => ({ headers: mocks.headers }))
vi.mock("@/lib/public-kb", () => ({
  getPublicDocument: mocks.getPublicDocument,
  getPublicDocuments: mocks.getPublicDocuments,
  getPublicDocumentsWithContent: mocks.getPublicDocumentsWithContent,
  getPublicFolderDetail: mocks.getPublicFolderDetail,
  getPublicTaxonomy: mocks.getPublicTaxonomy,
  isDocInScope: mocks.isDocInScope,
  isFolderInScope: mocks.isFolderInScope,
}))
vi.mock("@/lib/public-kb-route", () => ({
  requirePortal: mocks.requirePortal,
}))
vi.mock("@/lib/portal/login-return", () => ({
  portalPublicNextPath: mocks.portalPublicNextPath,
}))
vi.mock("@/lib/db/subscription", () => ({
  getPortalEntitlementsForWorkspace:
    mocks.getPortalEntitlementsForWorkspace,
  isPortalAiBuilderEnabledForWorkspace:
    mocks.isPortalAiBuilderEnabledForWorkspace,
  isPortalReportingEnabledForWorkspace:
    mocks.isPortalReportingEnabledForWorkspace,
}))
vi.mock("@/components/public-kb/portal/portal-doc-view", () => ({
  PortalDocView: mocks.portalDocView,
  DOC_REF_RE: /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,199}$/,
}))
vi.mock("@/components/public-kb/portal/portal-api-reference-view", () => ({
  PortalApiReferenceView: mocks.portalApiReferenceView,
}))
vi.mock("@/components/public-kb/portal/portal-changelog-view", () => ({
  PortalChangelogView: mocks.portalChangelogView,
}))

vi.mock("@/lib/portal/canonical-url.server", () => ({
  resolvePortalCanonicalBaseUrl: vi.fn(async () => "https://docs.acme.com"),
}))

import PortalCatchAllPage, { generateMetadata } from "./page"

const workspace = {
  id: "workspace-1",
  name: "Acme",
  slug: "acme",
  iconUrl: null,
  isPublic: true,
  primaryProjectSlug: null,
  portalChromeScope: "workspace",
  branding: {
    name: "Acme",
    tagline: "Answers",
    logoUrl: "",
    accentColor: "#334455",
  },
}
const changelogPage = {
  id: "release-page",
  title: "Changelog",
  slug: "changelog",
  scope: [{ doc: "release-1" }],
  presentation: "changelog" as const,
}
const layout = {
  schemaVersion: 1,
  theme: {
    brandName: "Acme",
    tagline: "Answers",
    logoUrl: "",
    accentColor: "#334455",
    navLinks: [],
    cta: null,
    font: "sans",
    appearance: "auto",
  },
  header: {
    id: "header",
    type: "portal-header",
    search: { enabled: true, placeholder: "Search" },
  },
  body: [],
  pages: [changelogPage],
}
const taxonomy = { topics: [], rootFolders: [] }
const releaseSummary = {
  id: "release-1",
  slug: "faster-preview",
  title: "Faster preview",
  source: null,
  updated_at: "2026-08-18T00:00:00Z",
  folder_id: "releases-folder",
}
const release = { ...releaseSummary, content: "## Faster loading", author: null }
const homeScope = [{ folder: "docs-folder" }]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.headers.mockResolvedValue({ get: vi.fn(() => null) })
  mocks.portalPublicNextPath.mockResolvedValue(
    "/p/acme/developers/page/changelog/faster-preview",
  )
  mocks.requirePortal.mockResolvedValue({
    workspace,
    base: "acme/developers",
    experienceId: "experience-1",
    scope: homeScope,
    contentScope: [
      { folder: "docs-folder" },
      { doc: "release-1" },
    ],
    layout,
    rootRedirectSlug: null,
  })
  mocks.getPortalEntitlementsForWorkspace.mockResolvedValue({
    portalBrandingRemoval: true,
  })
  mocks.isPortalAiBuilderEnabledForWorkspace.mockResolvedValue(false)
  mocks.isPortalReportingEnabledForWorkspace.mockResolvedValue(false)
  mocks.getPublicTaxonomy.mockResolvedValue(taxonomy)
  mocks.getPublicDocuments.mockResolvedValue([releaseSummary])
  mocks.getPublicDocument.mockResolvedValue(release)
  mocks.isDocInScope.mockResolvedValue(true)
})

describe("public changelog page entries", () => {
  it("renders a nested changelog entry instead of the generic docs reader", async () => {
    const element = await PortalCatchAllPage({
      params: Promise.resolve({
        path: [
          "acme",
          "developers",
          "page",
          "changelog",
          "faster-preview",
        ],
      }),
      searchParams: Promise.resolve({}),
    })

    expect(element.type).toBe(mocks.portalChangelogView)
    expect(element.props).toMatchObject({
      workspace,
      base: "acme/developers",
      hrefBase: "/p/acme/developers",
      page: changelogPage,
      taxonomy,
      documents: [releaseSummary],
      activeDocument: release,
    })
    expect(element.type).not.toBe(mocks.portalDocView)
    expect(element.type).not.toBe(mocks.portalHomeView)
    expect(mocks.isDocInScope).toHaveBeenCalledWith(
      "workspace-1",
      { id: "release-1", folder_id: "releases-folder" },
      changelogPage.scope,
    )
  })

  it("rejects a nested release outside the changelog page scope", async () => {
    mocks.isDocInScope.mockResolvedValue(false)

    await expect(
      PortalCatchAllPage({
        params: Promise.resolve({
          path: [
            "acme",
            "developers",
            "page",
            "changelog",
            "faster-preview",
          ],
        }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("not found")

    expect(mocks.portalChangelogView).not.toHaveBeenCalled()
  })

  it("uses Home's selective scope when a page inherits its docs", async () => {
    const inheritedPage = { ...changelogPage, scope: null }
    mocks.requirePortal.mockResolvedValue({
      workspace,
      base: "acme/developers",
      experienceId: "experience-1",
      scope: homeScope,
      contentScope: homeScope,
      layout: { ...layout, pages: [inheritedPage] },
      rootRedirectSlug: null,
    })

    const element = await PortalCatchAllPage({
      params: Promise.resolve({
        path: [
          "acme",
          "developers",
          "page",
          "changelog",
          "faster-preview",
        ],
      }),
      searchParams: Promise.resolve({}),
    })

    expect(element.type).toBe(mocks.portalChangelogView)
    expect(mocks.getPublicTaxonomy).toHaveBeenCalledWith(
      "workspace-1",
      homeScope,
    )
    expect(mocks.getPublicDocuments).toHaveBeenCalledWith(
      "workspace-1",
      homeScope,
    )
    expect(mocks.isDocInScope).toHaveBeenCalledWith(
      "workspace-1",
      { id: "release-1", folder_id: "releases-folder" },
      homeScope,
    )
  })
})

describe("document and folder navigation scope", () => {
  const contentScope = [{ folder: "docs-folder" }, { doc: "release-1" }]

  it("gates a document on the content scope but builds its rail from Home's", async () => {
    const element = await PortalCatchAllPage({
      params: Promise.resolve({
        path: ["acme", "developers", "doc", "faster-preview"],
      }),
      searchParams: Promise.resolve({}),
    })

    expect(element.type).toBe(mocks.portalDocView)
    // The widened scope only decides reachability; feeding it to the layout
    // builder drags every page's content into the documentation rail.
    expect(element.props).toMatchObject({
      scope: contentScope,
      navScope: homeScope,
    })
  })

  it("rejects removed folder pages", async () => {
    await expect(PortalCatchAllPage({
      params: Promise.resolve({ path: ["acme", "developers", "folder", "folder-1"] }),
      searchParams: Promise.resolve({}),
    })).rejects.toThrow("not found")
  })

  it("opens the first document at the portal root", async () => {
    await expect(PortalCatchAllPage({
      params: Promise.resolve({ path: ["acme", "developers"] }),
      searchParams: Promise.resolve({}),
    })).rejects.toThrow("redirect")
    expect(mocks.redirect).toHaveBeenCalledWith("/p/acme/developers/doc/faster-preview")
    expect(mocks.getPublicDocuments).toHaveBeenCalledWith(workspace.id, homeScope)
  })

  it("shows an empty state when the collection contains no documents", async () => {
    mocks.getPublicDocuments.mockResolvedValue([])
    const element = await PortalCatchAllPage({
      params: Promise.resolve({ path: ["acme", "developers"] }),
      searchParams: Promise.resolve({}),
    })
    expect((element.props as { children: string }).children).toBe("No published documents yet.")
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

})

describe("portal browser titles", () => {
  const metadata = (path: string[]) => generateMetadata({
    params: Promise.resolve({ path }),
    searchParams: Promise.resolve({}),
  })

  it.each([true, false])("uses the document title (public: %s)", async (isPublic) => {
    const portal = await mocks.requirePortal()
    mocks.requirePortal.mockResolvedValue({ ...portal, workspace: { ...workspace, isPublic } })
    mocks.getPublicDocument.mockResolvedValue({ ...release, title: "Introduction" })
    const result = await metadata(["acme", "developers", "doc", "introduction"])
    expect(result.title).toEqual({ absolute: "Introduction" })
    if (!isPublic) expect(result.alternates).toBeUndefined()
  })

  it("does not generate metadata for removed folder pages", async () => {
    expect(await metadata(["acme", "folder", "folder-1"])).toEqual({})
  })

  it("uses the selected page or nested document title", async () => {
    expect((await metadata(["acme", "page", "changelog"])).title).toEqual({ absolute: "Changelog" })
    expect((await metadata(["acme", "page", "changelog", "faster-preview"])).title).toEqual({ absolute: "Faster preview" })
  })

  it("does not expose titles for documents outside the portal scope", async () => {
    mocks.isDocInScope.mockResolvedValue(false)
    expect(await metadata(["acme", "doc", "introduction"])).toEqual({})
  })
})


describe("Breeze-only access", () => {
  it("checks for a Breeze viewer before rendering a portal page or its metadata", async () => {
    breezeGate.requireBreezeViewer.mockRejectedValueOnce(new Error("NEXT_REDIRECT:/login"))
    await expect(
      PortalCatchAllPage({ params: Promise.resolve({ path: ["acme"] }) } as never),
    ).rejects.toThrow("NEXT_REDIRECT:/login")
    breezeGate.requireBreezeViewer.mockRejectedValueOnce(new Error("NEXT_REDIRECT:/login"))
    await expect(
      generateMetadata({ params: Promise.resolve({ path: ["acme"] }) } as never),
    ).rejects.toThrow("NEXT_REDIRECT:/login")
  })
})
