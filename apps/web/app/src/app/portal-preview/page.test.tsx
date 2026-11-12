import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("not found")
  }),
  cookies: vi.fn(),
  getAuthUser: vi.fn(),
  createClient: vi.fn(),
  getActiveWorkspace: vi.fn(),
  getPortalWorkspaceById: vi.fn(),
  getPublicTaxonomyFresh: vi.fn(),
  getPublicDocumentsFresh: vi.fn(),
  getPublicDocumentsWithContent: vi.fn(),
  getOrCreateDraft: vi.fn(),
  validatePortalLayout: vi.fn(),
  getPortalEntitlementsForWorkspace: vi.fn(),
  withWorkspaceLogo: vi.fn(),
  portalShell: vi.fn(),
  portalDocView: vi.fn(),
  portalApiReferenceView: vi.fn(),
  portalChangelogView: vi.fn(),
}))

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }))
vi.mock("next/headers", () => ({ cookies: mocks.cookies }))
vi.mock("@/lib/auth/get-auth-user", () => ({ getAuthUser: mocks.getAuthUser }))
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }))
vi.mock("@/lib/db/workspace", () => ({
  getActiveWorkspace: mocks.getActiveWorkspace,
}))
vi.mock("@/lib/public-kb", () => ({
  getPortalWorkspaceById: mocks.getPortalWorkspaceById,
  getPublicTaxonomyFresh: mocks.getPublicTaxonomyFresh,
  getPublicDocumentsFresh: mocks.getPublicDocumentsFresh,
  getPublicDocumentsWithContent: mocks.getPublicDocumentsWithContent,
}))
vi.mock("@/lib/portal/experiences-write", () => ({
  getOrCreateDraft: mocks.getOrCreateDraft,
}))
vi.mock("@/lib/portal/schema", () => ({
  validatePortalLayout: mocks.validatePortalLayout,
  portalPagePresentation: (page: {
    slug: string
    presentation?: "landing" | "api_reference" | "changelog"
  }) =>
    page.presentation ??
    (page.slug === "api-reference" ? "api_reference" : "landing"),
}))
vi.mock("@/lib/db/subscription", () => ({
  getPortalEntitlementsForWorkspace: mocks.getPortalEntitlementsForWorkspace,
}))
vi.mock("@/lib/public-kb-route", () => ({
  withWorkspaceLogo: mocks.withWorkspaceLogo,
}))
vi.mock("@/components/public-kb/portal/portal-shell", () => ({
  PortalShell: mocks.portalShell,
}))
vi.mock("@/components/public-kb/portal/portal-doc-view", () => ({
  PortalDocView: mocks.portalDocView,
}))
vi.mock("@/components/public-kb/portal/portal-api-reference-view", () => ({
  PortalApiReferenceView: mocks.portalApiReferenceView,
}))
vi.mock("@/components/public-kb/portal/portal-changelog-view", () => ({
  PortalChangelogView: mocks.portalChangelogView,
}))

import PortalPreviewPage from "./page"

interface RenderedChild {
  type: unknown
  props: Record<string, unknown>
}

/**
 * The shell also renders the page-sync reporter alongside the presentation, so
 * the rendered view is the last child rather than `children` itself.
 */
function contentChild(element: { props: unknown }): RenderedChild {
  const { children } = element.props as {
    children: RenderedChild | RenderedChild[]
  }
  return Array.isArray(children)
    ? (children[children.length - 1] as RenderedChild)
    : children
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
  localization: { enabledLanguages: ["es"], defaultLanguage: "es" },
}

const workspace = {
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
  primaryProjectSlug: null,
  portalChromeScope: "workspace",
}

const taxonomy = {
  topics: [],
  rootFolders: [],
  allFolders: [],
  promotedRootIds: [],
}
const documents = [{ id: "doc-1", title: "Install", source: null }]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cookies.mockResolvedValue({ get: vi.fn(() => undefined) })
  mocks.getAuthUser.mockResolvedValue({ id: "user-1" })
  mocks.createClient.mockResolvedValue({ client: true })
  mocks.getActiveWorkspace.mockResolvedValue({
    workspace_id: "workspace-1",
    role: "owner",
  })
  mocks.getPortalWorkspaceById.mockResolvedValue({ kind: "workspace", workspace })
  mocks.getPortalEntitlementsForWorkspace.mockResolvedValue({
    portalAiBuilder: true,
    portalBrandingRemoval: true,
    portalTranslations: true,
  })
  mocks.getOrCreateDraft.mockResolvedValue({
    id: "draft-1",
    spec: layout,
    slug: "guides",
    scope: ["folder-1"],
  })
  mocks.validatePortalLayout.mockReturnValue({ ok: true, data: layout })
  mocks.getPublicTaxonomyFresh.mockResolvedValue(taxonomy)
  mocks.getPublicDocumentsFresh.mockResolvedValue(documents)
  mocks.getPublicDocumentsWithContent.mockResolvedValue([
    { ...documents[0], content: "## Authentication" },
  ])
  mocks.withWorkspaceLogo.mockReturnValue(layout)
})

describe("PortalPreviewPage", () => {
  it("renders draft data through the production shell and document view", async () => {
    const element = await PortalPreviewPage({
      searchParams: Promise.resolve({
        theme: "dark",
        slug: "acme/guides",
        project: "guides",
      }),
    })

    const props = element.props as Record<string, unknown>

    expect(element.type).toBe(mocks.portalShell)
    expect(props).toMatchObject({
      workspace,
      published: layout,
      base: "acme/guides",
      hrefBase: "/p/acme/guides",
      askAiEnabled: true,
      canRemoveBreadBranding: true,
      translationsEnabled: true,
      preferredLanguage: null,
      preview: { themeMode: "dark", projectSlug: "guides" },
    })

    const home = contentChild(element)
    expect(home.type).toBe(mocks.portalDocView)
    expect(home.props).toMatchObject({
      workspace,
      base: "acme/guides",
      hrefBase: "/p/acme/guides",
      scope: ["folder-1"],
      publishedLayout: layout,
      refId: "doc-1",
      preview: true,
    })
    expect(mocks.getPublicTaxonomyFresh).toHaveBeenCalledWith(
      "workspace-1",
      ["folder-1"],
    )
    expect(mocks.getPublicDocumentsFresh).toHaveBeenCalledWith(
      "workspace-1",
      ["folder-1"],
    )
  })

  it("renders a selected page with its own included-doc scope", async () => {
    const pageLayout = {
      ...layout,
      pages: [
        {
          id: "release-page",
          title: "Changelog",
          slug: "changelog",
          scope: [{ doc: "doc-1" }],
        },
      ],
    }
    mocks.getOrCreateDraft.mockResolvedValue({
      id: "draft-1",
      spec: pageLayout,
      slug: "guides",
      scope: ["folder-1"],
    })
    mocks.validatePortalLayout.mockReturnValue({ ok: true, data: pageLayout })
    mocks.withWorkspaceLogo.mockReturnValue(pageLayout)

    const element = await PortalPreviewPage({
      searchParams: Promise.resolve({
        theme: "light",
        slug: "acme/guides",
        project: "guides",
        page: "changelog",
      }),
    })
    const props = element.props as {
      preview: { activePageSlug: string | null }
    }
    const content = contentChild(element)

    expect(props.preview.activePageSlug).toBe("changelog")
    expect(content.type).toBe(mocks.portalDocView)
    expect(content.props).toMatchObject({
      scope: [{ doc: "doc-1" }],
      preview: true,
      publishedLayout: pageLayout,
      refId: "doc-1",
    })
  })

  it("lets a null page scope inherit Home's included docs", async () => {
    const pageLayout = {
      ...layout,
      pages: [
        {
          id: "overview-page",
          title: "Overview",
          slug: "overview",
          scope: null,
        },
      ],
    }
    mocks.getOrCreateDraft.mockResolvedValue({
      id: "draft-1",
      spec: pageLayout,
      slug: "guides",
      scope: ["folder-1"],
    })
    mocks.validatePortalLayout.mockReturnValue({ ok: true, data: pageLayout })
    mocks.withWorkspaceLogo.mockReturnValue(pageLayout)

    const element = await PortalPreviewPage({
      searchParams: Promise.resolve({
        theme: "light",
        slug: "acme/guides",
        project: "guides",
        page: "overview",
      }),
    })
    const content = contentChild(element)

    expect(content.type).toBe(mocks.portalDocView)
    expect(content.props.scope).toEqual(["folder-1"])
    expect(mocks.getPublicTaxonomyFresh).toHaveBeenLastCalledWith(
      "workspace-1",
      ["folder-1"],
    )
    expect(mocks.getPublicDocumentsFresh).toHaveBeenLastCalledWith(
      "workspace-1",
      ["folder-1"],
    )
  })

  it("renders an API-reference page through the reference presentation", async () => {
    const apiPage = {
      id: "api-page",
      title: "API Reference",
      slug: "api-reference",
      scope: [{ doc: "doc-1" }],
      presentation: "api_reference" as const,
    }
    const pageLayout = { ...layout, pages: [apiPage] }
    mocks.getOrCreateDraft.mockResolvedValue({
      id: "draft-1",
      spec: pageLayout,
      slug: "guides",
      scope: ["folder-1"],
    })
    mocks.validatePortalLayout.mockReturnValue({ ok: true, data: pageLayout })
    mocks.withWorkspaceLogo.mockReturnValue(pageLayout)

    const element = await PortalPreviewPage({
      searchParams: Promise.resolve({
        slug: "acme/guides",
        project: "guides",
        page: "api-reference",
      }),
    })
    const content = contentChild(element)

    expect(content.type).toBe(mocks.portalApiReferenceView)
    expect(content.props).toMatchObject({
      page: apiPage,
      taxonomy,
      documents: [{ ...documents[0], content: "## Authentication" }],
      preview: true,
    })
    expect(mocks.getPublicDocumentsWithContent).toHaveBeenCalledWith(
      "workspace-1",
      [{ doc: "doc-1" }],
    )
  })

  it("renders a changelog page through the release-feed presentation", async () => {
    const changelogPage = {
      id: "release-page",
      title: "Release notes",
      slug: "releases",
      scope: [{ doc: "doc-1" }],
      presentation: "changelog" as const,
    }
    const pageLayout = { ...layout, pages: [changelogPage] }
    mocks.getOrCreateDraft.mockResolvedValue({
      id: "draft-1",
      spec: pageLayout,
      slug: "guides",
      scope: ["folder-1"],
    })
    mocks.validatePortalLayout.mockReturnValue({ ok: true, data: pageLayout })
    mocks.withWorkspaceLogo.mockReturnValue(pageLayout)

    const element = await PortalPreviewPage({
      searchParams: Promise.resolve({
        slug: "acme/guides",
        project: "guides",
        page: "releases",
      }),
    })
    const content = contentChild(element)

    expect(content.type).toBe(mocks.portalChangelogView)
    expect(content.props).toMatchObject({
      page: changelogPage,
      publishedLayout: pageLayout,
      taxonomy,
      documents,
      preview: true,
    })
    // The dated feed only needs summaries — no body fetch.
    expect(mocks.getPublicDocumentsWithContent).not.toHaveBeenCalled()
  })

  it("keeps a selected changelog entry inside the preview page", async () => {
    const changelogPage = {
      id: "release-page",
      title: "Release notes",
      slug: "releases",
      scope: [{ doc: "doc-1" }],
      presentation: "changelog" as const,
    }
    const pageLayout = { ...layout, pages: [changelogPage] }
    const documentWithContent = {
      ...documents[0],
      slug: "install",
      content: "## Authentication",
    }
    mocks.getOrCreateDraft.mockResolvedValue({
      id: "draft-1",
      spec: pageLayout,
      slug: "guides",
      scope: ["folder-1"],
    })
    mocks.validatePortalLayout.mockReturnValue({ ok: true, data: pageLayout })
    mocks.withWorkspaceLogo.mockReturnValue(pageLayout)
    mocks.getPublicDocumentsWithContent.mockResolvedValue([
      documentWithContent,
    ])

    const element = await PortalPreviewPage({
      searchParams: Promise.resolve({
        theme: "dark",
        slug: "acme/guides",
        project: "guides",
        page: "releases",
        doc: "install",
      }),
    })
    const content = contentChild(element)

    expect(content.type).toBe(mocks.portalChangelogView)
    expect(content.props).toMatchObject({
      page: changelogPage,
      activeDocument: documentWithContent,
      preview: true,
    })
    const entryHref = content.props.entryHref as (
      documentSlug: string | null,
    ) => string
    expect(entryHref(null)).toBe(
      "/portal-preview?theme=dark&slug=acme%2Fguides&project=guides&page=releases",
    )
    expect(entryHref("next-release")).toBe(
      "/portal-preview?theme=dark&slug=acme%2Fguides&project=guides&page=releases&doc=next-release",
    )
    expect(mocks.getPublicDocumentsWithContent).toHaveBeenCalledWith(
      "workspace-1",
      [{ doc: "doc-1" }],
    )
  })
})
