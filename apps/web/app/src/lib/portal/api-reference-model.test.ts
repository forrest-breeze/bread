import { describe, expect, it, vi } from "vitest"
import type { PublicDocWithContent, PublicTaxonomy } from "@/lib/public-kb"
import {
  buildApiReferenceSections,
  findApiReferenceSection,
  parseApiOperation,
} from "./api-reference-model"

describe("parseApiOperation", () => {
  it("reads an HTTP method and path from an endpoint title", () => {
    expect(parseApiOperation("POST /v1/documents/{id}")).toEqual({
      method: "POST",
      path: "/v1/documents/{id}",
    })
  })

  it("does not confuse a prose title beginning with Get for a GET operation", () => {
    expect(parseApiOperation("Get current user")).toEqual({
      method: null,
      path: null,
    })
  })

  it.each([
    "<h2>GET /v1/balances/payin</h2><p>Pay-in funds.</p>",
    '<p>Balances</p><h2><strong>GET</strong>&nbsp;<code>/v1/balances/payin</code></h2>',
    "## GET /v1/balances/payin\n\nPay-in funds.",
  ])("retains the GET badge for imported and visually edited endpoints", (content) => {
    expect(parseApiOperation("Get pay-in balance", content)).toEqual({
      method: "GET",
      path: "/v1/balances/payin",
    })
  })

  it("falls back to an operation heading in the document body", () => {
    expect(
      parseApiOperation("Create a document", "## POST /api/v1/documents\n"),
    ).toEqual({ method: "POST", path: "/api/v1/documents" })
  })
})

describe("buildApiReferenceSections", () => {
  it("groups, orders, and renders scoped reference documents", () => {
    const taxonomy: PublicTaxonomy = {
      topics: [],
      rootFolders: [],
      allFolders: [
        {
          id: "auth",
          display_name: "Authentication",
          kind: "user",
          parent_folder_id: null,
          sort_order: 1,
          icon: null,
          document_count: 1,
          updated_at: "2026-01-01",
        },
        {
          id: "docs",
          display_name: "Documents",
          kind: "user",
          parent_folder_id: null,
          sort_order: 2,
          icon: null,
          document_count: 1,
          updated_at: "2026-01-01",
        },
      ],
    }
    const documents: PublicDocWithContent[] = [
      {
        id: "create",
        slug: "create",
        title: "POST /v1/documents",
        source: null,
        folder_id: "docs",
        content: "Create one.",
      },
      {
        id: "me",
        slug: "me",
        title: "GET /v1/me",
        source: null,
        folder_id: "auth",
        content: "Current user.",
      },
    ]
    const renderHtml = vi.fn((content: string) => `<p>${content}</p>`)

    const sections = buildApiReferenceSections(documents, taxonomy, renderHtml)

    expect(sections.map((section) => section.groupLabel)).toEqual([
      "Authentication",
      "Documents",
    ])
    expect(sections.map((section) => section.method)).toEqual(["GET", "POST"])
    // Each endpoint carries the slug its own page is addressed by.
    expect(sections.map((section) => section.slug)).toEqual(["me", "create"])
    expect(renderHtml).toHaveBeenCalledTimes(2)
  })
})

describe("findApiReferenceSection", () => {
  const sections = [
    { id: "me-id", slug: "me" },
    { id: "create-id", slug: "create" },
  ]

  it("selects the first endpoint for the reference root", () => {
    expect(findApiReferenceSection(sections, null)?.slug).toBe("me")
  })

  it("resolves an endpoint by slug or by id", () => {
    expect(findApiReferenceSection(sections, "create")?.id).toBe("create-id")
    expect(findApiReferenceSection(sections, "create-id")?.slug).toBe("create")
  })

  it("resolves nothing for an unknown ref so the route can 404", () => {
    expect(findApiReferenceSection(sections, "nope")).toBeNull()
    expect(findApiReferenceSection([], null)).toBeNull()
  })
})
