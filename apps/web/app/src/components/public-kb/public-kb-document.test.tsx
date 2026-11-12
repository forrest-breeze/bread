// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/use-document-headings", () => ({
  useDocumentHeadings: () => ({ headings: [], activeId: null }),
}))
vi.mock("@/components/kb/kb-reading-toc", () => ({
  KbReadingToc: () => <nav aria-label="On this page" />,
}))
vi.mock("@/components/kb/kb-cross-links", () => ({ KbCrossLinks: () => null }))
vi.mock("@/components/public-kb/public-prose", () => ({
  PublicProse: ({ html }: { html: string }) => (
    <div dangerouslySetInnerHTML={{ __html: html }} />
  ),
}))
vi.mock("@/components/public-kb/portal/portal-page-feedback", () => ({
  PortalPageFeedback: () => null,
}))
vi.mock("@/components/public-kb/portal/portal-document-scroll-reset", () => ({
  PortalDocumentScrollReset: () => null,
}))

import { PublicKbDocument } from "./public-kb-document"

function props(): React.ComponentProps<typeof PublicKbDocument> {
  return {
    slug: "acme/docs",
    documentId: "doc-1",
    title: "Quickstart",
    html: "<p>Install the CLI.</p>",
    source: null,
    author: null,
    updated: "",
    breadcrumbs: [{ label: "Quickstart" }],
    outbound: [],
    inbound: [],
  }
}

describe("PublicKbDocument", () => {
  it("offers editing for the document initially displayed in preview", () => {
    render(<PublicKbDocument {...props()} editable />)
    expect(screen.getByRole("link", { name: "Edit document" })).toHaveAttribute("data-portal-document-ref", "doc-1")
  })

  it("keeps editing controls out of public documents", () => {
    render(<PublicKbDocument {...props()} />)
    expect(screen.queryByRole("link", { name: "Edit document" })).toBeNull()
  })

  it("offers Copy page when the surface opts in", () => {
    render(<PublicKbDocument {...props()} copyPageEnabled />)

    expect(screen.getByRole("button", { name: "Copy page" })).toBeInTheDocument()
  })

  it("hides Copy page by default", () => {
    render(<PublicKbDocument {...props()} />)

    expect(screen.queryByRole("button", { name: "Copy page" })).toBeNull()
  })
})
