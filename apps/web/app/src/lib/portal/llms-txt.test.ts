import { describe, expect, it } from "vitest"
import type {
  PublicDocSummary,
  PublicFolderSummary,
  PublicTaxonomy,
} from "@/lib/public-kb"
import {
  buildPortalLlmsFullTxt,
  buildPortalLlmsTxt,
  groupPortalDocuments,
  portalDocUrl,
  selectPortalLlmsFullDocs,
} from "./llms-txt"

// ---------------------------------------------------------------------------
// Portal llms.txt generation. The builders are pure — they shape whatever the
// route hands them, which is already scope-filtered by lib/public-kb.ts. What
// matters here: links resolve, hierarchy survives the flattening, and the full
// variant stays bounded.
// ---------------------------------------------------------------------------

function folder(
  id: string,
  display_name: string,
  overrides: Partial<PublicFolderSummary> = {},
): PublicFolderSummary {
  return {
    id,
    display_name,
    kind: "user",
    parent_folder_id: null,
    document_count: 0,
    sort_order: null,
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function doc(
  id: string,
  title: string,
  overrides: Partial<PublicDocSummary> = {},
): PublicDocSummary {
  return { id, slug: id, title, source: null, ...overrides }
}

function taxonomy(folders: PublicFolderSummary[]): PublicTaxonomy {
  return { topics: [], rootFolders: folders, allFolders: folders }
}

const PORTAL = "https://help.acme.com"

describe("portalDocUrl", () => {
  it("keeps hierarchical slug separators intact", () => {
    expect(portalDocUrl(PORTAL, "guides/setup/install")).toBe(
      "https://help.acme.com/doc/guides/setup/install",
    )
  })

  it("encodes each segment", () => {
    expect(portalDocUrl(PORTAL, "guides/a b")).toBe(
      "https://help.acme.com/doc/guides/a%20b",
    )
  })

  it("tolerates a trailing slash on the portal URL", () => {
    expect(portalDocUrl("https://help.acme.com/", "x")).toBe(
      "https://help.acme.com/doc/x",
    )
  })
})

describe("groupPortalDocuments", () => {
  it("groups by folder in taxonomy order, unfiled docs last", () => {
    const groups = groupPortalDocuments(
      taxonomy([
        folder("f2", "Second", { sort_order: 2 }),
        folder("f1", "First", { sort_order: 1 }),
      ]),
      [
        doc("d1", "In second", { folder_id: "f2" }),
        doc("d2", "In first", { folder_id: "f1" }),
        doc("d3", "Loose"),
      ],
    )

    expect(groups.map((g) => g.heading)).toEqual([
      "First",
      "Second",
      "Other documents",
    ])
    expect(groups[2].docs.map((d) => d.id)).toEqual(["d3"])
  })

  it("renders nested folders as a trail so hierarchy survives flattening", () => {
    const groups = groupPortalDocuments(
      taxonomy([
        folder("root", "Guides"),
        folder("child", "Setup", { parent_folder_id: "root" }),
      ]),
      [doc("d1", "Install", { folder_id: "child" })],
    )
    expect(groups[0].heading).toBe("Guides / Setup")
  })

  it("buckets a doc whose folder is outside the taxonomy without leaking a name", () => {
    const groups = groupPortalDocuments(taxonomy([folder("f1", "Visible")]), [
      doc("d1", "Hidden parent", { folder_id: "unknown-folder" }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].heading).toBe("Other documents")
  })

  it("omits folders with no visible documents", () => {
    const groups = groupPortalDocuments(
      taxonomy([folder("f1", "Empty"), folder("f2", "Full")]),
      [doc("d1", "A", { folder_id: "f2" })],
    )
    expect(groups.map((g) => g.heading)).toEqual(["Full"])
  })

  it("orders documents by sort_order then title", () => {
    const groups = groupPortalDocuments(taxonomy([folder("f1", "F")]), [
      doc("d1", "Zebra", { folder_id: "f1", sort_order: 1 }),
      doc("d2", "Alpha", { folder_id: "f1" }),
      doc("d3", "Beta", { folder_id: "f1" }),
    ])
    expect(groups[0].docs.map((d) => d.title)).toEqual([
      "Zebra",
      "Alpha",
      "Beta",
    ])
  })
})

describe("buildPortalLlmsTxt", () => {
  const out = buildPortalLlmsTxt({
    name: "Acme Help",
    tagline: "Answers for Acme customers",
    portalUrl: PORTAL,
    taxonomy: taxonomy([folder("f1", "Guides")]),
    documents: [
      doc("install", "Install", {
        folder_id: "f1",
        description: "How to install\nthe thing",
      }),
      doc("ref", "Reference", { folder_id: "f1" }),
    ],
  })

  it("uses the branding name and tagline as the H1 and summary", () => {
    expect(out).toContain("# Acme Help")
    expect(out).toContain("> Answers for Acme customers")
  })

  it("links every document at the public mount with its preview as the note", () => {
    expect(out).toContain(
      "- [Install](https://help.acme.com/doc/install): How to install the thing",
    )
    expect(out).toContain("- [Reference](https://help.acme.com/doc/ref)")
  })

  it("states the document count", () => {
    expect(out).toContain("2 published documents")
  })

  it("points at llms-full.txt from an Optional section", () => {
    expect(out).toContain("## Optional")
    expect(out).toContain("https://help.acme.com/llms-full.txt")
  })

  it("falls back to a derived summary when the portal has no tagline", () => {
    const noTagline = buildPortalLlmsTxt({
      name: "Acme Help",
      portalUrl: PORTAL,
      taxonomy: taxonomy([]),
      documents: [],
    })
    expect(noTagline).toContain("> Acme Help knowledge base")
  })

  it("still renders for an empty portal", () => {
    const empty = buildPortalLlmsTxt({
      name: "Acme Help",
      portalUrl: PORTAL,
      taxonomy: taxonomy([]),
      documents: [],
    })
    expect(empty).toContain("# Acme Help")
    expect(empty).toContain("0 published documents")
  })
})

describe("selectPortalLlmsFullDocs", () => {
  it("stops at the document cap", () => {
    const docs = Array.from({ length: 5 }, () => ({ markdown: "x" }))
    const { included, omittedCount } = selectPortalLlmsFullDocs(docs, 3)
    expect(included).toHaveLength(3)
    expect(omittedCount).toBe(2)
  })

  it("stops at the character cap", () => {
    const docs = [{ markdown: "a".repeat(60) }, { markdown: "b".repeat(60) }]
    const { included, omittedCount } = selectPortalLlmsFullDocs(docs, 100, 100)
    expect(included).toHaveLength(1)
    expect(omittedCount).toBe(1)
  })

  it("always includes the first document even when it alone exceeds the budget", () => {
    const docs = [{ markdown: "a".repeat(500) }]
    expect(selectPortalLlmsFullDocs(docs, 100, 10).included).toHaveLength(1)
  })
})

describe("buildPortalLlmsFullTxt", () => {
  const out = buildPortalLlmsFullTxt({
    name: "Acme Help",
    tagline: "Answers",
    portalUrl: PORTAL,
    docs: [
      {
        title: "Install",
        url: "https://help.acme.com/doc/install",
        section: "Guides / Setup",
        markdown: "# Install\n\nRun it.",
        updatedAt: "2026-07-20",
      },
      {
        title: "Empty",
        url: "https://help.acme.com/doc/empty",
        section: "",
        markdown: "   ",
      },
    ],
    omittedCount: 3,
  })

  it("emits each document with its URL, section, and body", () => {
    expect(out).toContain("## Install")
    expect(out).toContain("URL: https://help.acme.com/doc/install")
    expect(out).toContain("Section: Guides / Setup")
    expect(out).toContain("Updated: 2026-07-20")
    expect(out).toContain("Run it.")
  })

  it("separates documents with a horizontal rule", () => {
    expect(out.split("\n---\n").length).toBe(3) // header + 2 docs
  })

  it("says so when documents were truncated, and where the full index is", () => {
    expect(out).toContain("Truncated: 3 further documents are omitted")
    expect(out).toContain("https://help.acme.com/llms.txt")
  })

  it("omits the Section line for a portal-root document", () => {
    const rootOnly = buildPortalLlmsFullTxt({
      name: "N",
      portalUrl: PORTAL,
      docs: [{ title: "T", url: `${PORTAL}/doc/t`, section: "", markdown: "b" }],
    })
    expect(rootOnly).not.toContain("Section:")
  })

  it("marks an empty body instead of emitting a blank section", () => {
    expect(out).toContain("_This document has no content yet._")
  })

  it("says nothing about truncation when everything fit", () => {
    const complete = buildPortalLlmsFullTxt({
      name: "N",
      portalUrl: PORTAL,
      docs: [{ title: "T", url: `${PORTAL}/doc/t`, section: "", markdown: "b" }],
      omittedCount: 0,
    })
    expect(complete).not.toContain("Truncated")
  })
})
