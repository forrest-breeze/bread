// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { PortalLayout } from "@/lib/portal/schema"
import { PortalPagesControls } from "./portal-pages-controls"

const folderId = "11111111-1111-4111-8111-111111111111"
const documentId = "22222222-2222-4222-8222-222222222222"

function layout(): PortalLayout {
  return {
    schemaVersion: 1,
    theme: {
      brandName: "Acme",
      tagline: "",
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
  }
}

describe("PortalPagesControls", () => {
  it("creates an empty page without exposing document-assignment controls", async () => {
    const user = userEvent.setup()
    const onLayoutChange = vi.fn()
    render(
      <PortalPagesControls
        layout={layout()}
        activePageSlug={null}
        onLayoutChange={onLayoutChange}
        onActivePageChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Add page" }))

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(
      screen.queryByText("All content included by this project"),
    ).not.toBeInTheDocument()

    await user.type(
      screen.getByRole("textbox", { name: "Navigation label" }),
      "API Reference",
    )
    expect(screen.getByRole("textbox", { name: "URL path" })).toHaveValue(
      "api-reference",
    )
    await user.click(screen.getByRole("button", { name: "API reference" }))
    await user.click(screen.getByRole("button", { name: "Add page" }))

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onLayoutChange.mock.calls[0]?.[0].pages).toEqual([
      {
        id: "page-api-reference",
        title: "API Reference",
        slug: "api-reference",
        scope: [],
        presentation: "api_reference",
      },
    ])
  })

  it("preserves a page's included docs while editing its metadata", async () => {
    const user = userEvent.setup()
    const onLayoutChange = vi.fn()
    const current = layout()
    current.pages = [
      {
        id: "release-page",
        title: "Release notes",
        slug: "releases",
        scope: [
          { id: folderId, rootOnly: true, explicitDocs: true },
          { doc: documentId },
        ],
        presentation: "landing",
      },
    ]
    render(
      <PortalPagesControls
        layout={current}
        activePageSlug="releases"
        onLayoutChange={onLayoutChange}
        onActivePageChange={vi.fn()}
      />,
    )

    expect(screen.queryByText("In preview")).not.toBeInTheDocument()
    expect(
      screen.queryByRole("textbox", { name: "Navigation label" }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Edit Release notes" }))
    await user.clear(screen.getByRole("textbox", { name: "Navigation label" }))
    await user.type(
      screen.getByRole("textbox", { name: "Navigation label" }),
      "Changelog",
    )
    await user.click(screen.getByRole("button", { name: "Changelog" }))
    await user.click(screen.getByRole("button", { name: "Save page" }))

    expect(onLayoutChange.mock.calls[0]?.[0].pages).toEqual([
      {
        id: "release-page",
        title: "Changelog",
        slug: "releases",
        scope: [
          { id: folderId, rootOnly: true, explicitDocs: true },
          { doc: documentId },
        ],
        presentation: "changelog",
      },
    ])
  })

  it("reorders pages without changing their included docs", async () => {
    const user = userEvent.setup()
    const onLayoutChange = vi.fn()
    const current = layout()
    current.pages = [
      {
        id: "api-page",
        title: "API Reference",
        slug: "api-reference",
        scope: [folderId],
        presentation: "api_reference",
      },
      {
        id: "changes-page",
        title: "Changelog",
        slug: "changelog",
        scope: [{ doc: documentId }],
      },
    ]
    render(
      <PortalPagesControls
        layout={current}
        activePageSlug={null}
        onLayoutChange={onLayoutChange}
        onActivePageChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Move Changelog up" }))

    expect(onLayoutChange.mock.calls[0]?.[0].pages).toEqual([
      current.pages[1],
      current.pages[0],
    ])
  })
})

describe("PortalPagesControls ordering", () => {
  const apiPage = {
    id: "page-api",
    title: "API Reference",
    slug: "api-reference",
    scope: [],
    presentation: "api_reference" as const,
  }

  it("lists Home first as the default and lets it move below a page", async () => {
    const user = userEvent.setup()
    const onLayoutChange = vi.fn()
    const current = layout()
    current.pages = [apiPage]
    render(
      <PortalPagesControls
        layout={current}
        activePageSlug={null}
        onLayoutChange={onLayoutChange}
        onActivePageChange={vi.fn()}
      />,
    )

    expect(screen.getAllByText("Default")).toHaveLength(1)
    expect(screen.queryByText("In preview")).not.toBeInTheDocument()
    // Home can be reordered but never edited or removed.
    expect(screen.queryByRole("button", { name: "Remove Home" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Edit Home" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Move Home down" }))
    const next = onLayoutChange.mock.calls[0]?.[0] as PortalLayout
    expect(next.pages).toEqual([apiPage])
    expect(next.homePosition).toBe(1)
  })

  it("asks for confirmation before deleting a page", async () => {
    const user = userEvent.setup()
    const onLayoutChange = vi.fn()
    const current = layout()
    current.pages = [apiPage]
    current.homePosition = 1
    render(
      <PortalPagesControls
        layout={current}
        activePageSlug={null}
        onLayoutChange={onLayoutChange}
        onActivePageChange={vi.fn()}
      />,
    )

    await user.click(
      screen.getByRole("button", { name: "Remove API Reference" }),
    )
    expect(onLayoutChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Delete page" }))

    const next = onLayoutChange.mock.calls[0]?.[0] as PortalLayout
    // Deleting the default page returns the first slot to Home.
    expect(next.pages).toBeUndefined()
    expect(next.homePosition).toBeUndefined()
  })

  it("reserves the home path", async () => {
    const user = userEvent.setup()
    render(
      <PortalPagesControls
        layout={layout()}
        activePageSlug={null}
        onLayoutChange={vi.fn()}
        onActivePageChange={vi.fn()}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Add page" }))
    await user.type(
      screen.getByRole("textbox", { name: "Navigation label" }),
      "Home",
    )
    expect(
      screen.getByText("This path is reserved for Home."),
    ).toBeInTheDocument()
  })
})
