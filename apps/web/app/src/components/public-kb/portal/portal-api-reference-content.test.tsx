// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/use-document-headings", () => ({
  useDocumentHeadings: () => ({
    headings: [
      { id: "api-reference-overview", text: "GET /v1/users/{id}", level: 1 },
      { id: "query-parameters", text: "Query parameters", level: 2 },
    ],
    activeId: "query-parameters",
  }),
}))
vi.mock("@/components/ui/hover-prefetch-link", () => ({
  HoverPrefetchLink: ({
    children,
    disableHoverPrefetch: _disableHoverPrefetch,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    disableHoverPrefetch?: boolean
  }) => <a {...props}>{children}</a>,
}))
vi.mock("@/components/kb/kb-reading-toc", () => ({
  KbReadingToc: () => <nav aria-label="Rendered table of contents" />,
}))
vi.mock("@/components/public-kb/public-prose", () => ({
  PublicProse: ({ html }: { html: string }) => (
    <div dangerouslySetInnerHTML={{ __html: html }} />
  ),
}))
vi.mock("@/components/public-kb/portal/portal-footer", () => ({
  PortalFooter: () => <footer>Footer</footer>,
}))

import { PortalApiReferenceContent } from "./portal-api-reference-content"

const items = [
  {
    id: "get-user",
    slug: "get-user",
    title: "GET /v1/users/{id}",
    groupLabel: "Authentication",
    method: "GET" as const,
    path: "/v1/users/{id}",
    href: "/p/acme/page/api-reference",
  },
  {
    id: "create-doc",
    slug: "create-doc",
    title: "POST /v1/documents",
    groupLabel: "Documents",
    method: "POST" as const,
    path: "/v1/documents",
    href: "/p/acme/page/api-reference/create-doc",
  },
]

const chrome = {
  footer: { id: "footer", type: "footer" as const, showPoweredBy: true },
  allowPoweredByRemoval: false,
  brandLogoUrl: null,
  brandDarkLogoUrl: null,
  brandAccentColor: "#334455",
}

describe("PortalApiReferenceContent", () => {
  beforeEach(() => sessionStorage.clear())

  it("preserves expanded and collapsed folders when an endpoint navigation remounts the reference", () => {
    const props = { title: "API Reference", brandName: "Acme", items, active: null, ...chrome }
    const first = render(<PortalApiReferenceContent {...props} />)
    const rail = screen.getByRole("navigation", { name: "API reference sections" })
    fireEvent.click(within(rail).getByRole("button", { name: "Authentication" }))
    fireEvent.click(within(rail).getByRole("button", { name: "Documents" }))
    fireEvent.click(within(rail).getByRole("button", { name: "Authentication" }))
    first.unmount()
    render(<PortalApiReferenceContent {...props} active={{
      ...items[1], anchorId: "api-doc-create-doc", folderId: "docs", html: "<p>Create</p>",
    }} />)
    const nextRail = screen.getByRole("navigation", { name: "API reference sections" })
    expect(within(nextRail).getByRole("button", { name: "Documents" })).toHaveAttribute("aria-expanded", "true")
    expect(within(nextRail).getByRole("button", { name: "Authentication" })).toHaveAttribute("aria-expanded", "false")
    expect(within(nextRail).getByRole("link", { name: /v1\/documents/ })).toHaveAttribute("aria-current", "page")
  })

  it("renders only the addressed endpoint and links the rest to their own pages", () => {
    render(
      <PortalApiReferenceContent
        title="API Reference"
        brandName="Acme"
        items={items}
        active={{
          id: "get-user",
          anchorId: "api-doc-get-user",
          slug: "get-user",
          title: "GET /v1/users/{id}",
          folderId: "auth",
          groupLabel: "Authentication",
          method: "GET",
          path: "/v1/users/{id}",
          html: "<p>Returns the authenticated user.</p>",
        }}
        editable
        updated="Nov 11, 2026"
        {...chrome}
      />,
    )

    expect(screen.getByText("Updated Nov 11, 2026")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Edit document" })).toHaveAttribute("data-portal-document-ref", "get-user")
    for (const link of within(screen.getByRole("navigation", { name: "Endpoint pagination" })).getAllByRole("link")) {
      expect(link).not.toHaveAttribute("data-portal-document-ref")
    }
    const rail = screen.getByRole("navigation", {
      name: "API reference sections",
    })
    const authentication = within(rail).getByRole("button", { name: "Authentication" })
    const documents = within(rail).getByRole("button", { name: "Documents" })
    // The current endpoint's group opens on arrival; other groups stay closed.
    expect(authentication).toHaveAttribute("aria-expanded", "true")
    expect(documents).toHaveAttribute("aria-expanded", "false")
    expect(within(rail).getAllByRole("link")).toHaveLength(1)
    // The active group can still be collapsed and reopened by hand.
    fireEvent.click(authentication)
    expect(authentication).toHaveAttribute("aria-expanded", "false")
    expect(within(rail).queryByRole("link")).not.toBeInTheDocument()
    fireEvent.click(authentication)
    fireEvent.click(documents)
    expect(screen.getByRole("link", { name: "Edit document" })).toHaveAttribute("data-portal-document-ref", "get-user")
    expect(
      within(rail).getByRole("link", { name: /\/v1\/users\/\{id\}/ }),
    ).toHaveAttribute("href", "/p/acme/page/api-reference")
    expect(
      within(rail).getByRole("link", { name: /\/v1\/documents/ }),
    ).toHaveAttribute("href", "/p/acme/page/api-reference/create-doc")

    expect(within(rail).getByRole("link", { name: /\/v1\/documents/ })).not.toHaveAttribute("data-portal-document-ref")
    fireEvent.click(documents)
    expect(documents).toHaveAttribute("aria-expanded", "false")
    expect(within(rail).queryByRole("link", { name: /\/v1\/documents/ })).not.toBeInTheDocument()

    // The addressed endpoint is the page heading; the other one is not rendered.
    expect(
      screen.getByRole("heading", { level: 1, name: "GET /v1/users/{id}" }),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Returns the authenticated user."),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: "POST /v1/documents" }),
    ).not.toBeInTheDocument()
  })

  it("offers a next link to the following endpoint", () => {
    render(
      <PortalApiReferenceContent
        title="API Reference"
        brandName="Acme"
        items={items}
        active={{
          id: "get-user",
          anchorId: "api-doc-get-user",
          slug: "get-user",
          title: "GET /v1/users/{id}",
          folderId: "auth",
          groupLabel: "Authentication",
          method: "GET",
          path: "/v1/users/{id}",
          html: "<p>Returns the authenticated user.</p>",
        }}
        {...chrome}
      />,
    )

    const pagination = screen.getByRole("navigation", {
      name: "Endpoint pagination",
    })
    expect(within(pagination).getByRole("link")).toHaveAttribute(
      "href",
      "/p/acme/page/api-reference/create-doc",
    )
  })

  it("keeps the empty state when the page has no reference docs", () => {
    render(
      <PortalApiReferenceContent
        title="API Reference"
        brandName="Acme"
        items={[]}
        active={null}
        {...chrome}
      />,
    )

    expect(screen.getByText("No reference docs yet")).toBeInTheDocument()
  })
})

 it("renders example content in a labeled panel alongside the documentation", () => {
  render(
    <PortalApiReferenceContent
      title="API Reference"
      brandName="Acme"
      items={items}
      active={{
        ...items[0],
        anchorId: "api-doc-get-user",
        folderId: "auth",
        html: "<h2>Query parameters</h2><p>Account to read.</p>",
        examplesHtml: '<h2>Request example</h2><pre><code>curl /v1/users</code></pre>',
      }}
      {...chrome}
    />,
  )
  const rail = screen.getByRole("navigation", { name: "API reference sections" })
  fireEvent.click(within(rail).getByRole("button", { name: "Authentication" }))
  expect(within(rail).queryByRole("button", { name: "Query parameters" })).not.toBeInTheDocument()
  const examples = screen.getByRole("complementary", { name: "API examples" })
  expect(within(examples).getByText("curl /v1/users")).toBeInTheDocument()
  expect(within(examples).queryByText("Account to read.")).not.toBeInTheDocument()
  expect(screen.queryByRole("navigation", { name: "Rendered table of contents" })).not.toBeInTheDocument()
})
