import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type {
  PublicDocSummary,
  PublicTaxonomy,
  PublicWorkspace,
} from "@/lib/public-kb"
import type { PortalPage } from "@/lib/portal/schema"

vi.mock("@/components/ui/hover-prefetch-link", () => ({
  HoverPrefetchLink: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))
vi.mock("./portal-document-scroll-reset", () => ({
  PortalDocumentScrollReset: () => null,
}))

import { PortalChangelogView } from "./portal-changelog-view"

const workspace: PublicWorkspace = {
  id: "workspace-1",
  name: "Acme",
  slug: "acme",
  iconUrl: null,
  isPublic: true,
  primaryProjectSlug: null,
  portalChromeScope: "workspace",
  branding: {
    name: "Acme Docs",
    tagline: "Product updates",
    logoUrl: "",
    accentColor: "#334455",
  },
}
const taxonomy: PublicTaxonomy = { topics: [], rootFolders: [] }
const page: PortalPage = {
  id: "release-page",
  title: "Changelog",
  slug: "changelog",
  scope: null,
  presentation: "changelog",
}

function release(
  id: string,
  title: string,
  updatedAt: string,
): PublicDocSummary {
  return {
    id,
    slug: id,
    title,
    source: null,
    updated_at: updatedAt,
  }
}

describe("PortalChangelogView", () => {
  it("keeps feed links inside the changelog page on a proxy mount", () => {
    const html = renderToStaticMarkup(
      <PortalChangelogView
        workspace={workspace}
        base="acme/developers"
        hrefBase="/docs"
        page={page}
        publishedLayout={null}
        taxonomy={taxonomy}
        documents={[
          release("release-one", "Release one", "2026-08-01T00:00:00Z"),
        ]}
        canRemoveBreadBranding
        preview
      />,
    )

    expect(html).toContain('href="/docs/page/changelog/release-one"')
    expect(html).not.toContain('href="/docs/doc/release-one"')
  })

  it("renders a page-local release reader with feed and neighbor links", () => {
    const documents = [
      release("newer", "Newer release", "2026-08-03T00:00:00Z"),
      release("current", "Current release", "2026-08-02T00:00:00Z"),
      release("older", "Older release", "2026-08-01T00:00:00Z"),
    ]
    const html = renderToStaticMarkup(
      <PortalChangelogView
        workspace={workspace}
        base="acme/developers"
        hrefBase="/docs"
        page={page}
        publishedLayout={null}
        taxonomy={taxonomy}
        documents={documents}
        activeDocument={{ ...documents[1]!, content: "## Faster previews" }}
        canRemoveBreadBranding
        preview
      />,
    )

    expect(html).toContain('href="/docs/page/changelog"')
    expect(html).toContain('href="/docs/page/changelog/newer"')
    expect(html).toContain('href="/docs/page/changelog/older"')
    expect(html).toContain("Current release")
    expect(html).toContain("Faster previews")
    expect(html).not.toContain("Was this page helpful?")
  })
})
