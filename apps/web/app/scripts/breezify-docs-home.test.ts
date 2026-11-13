import { describe, expect, it } from "vitest"
import { validateDslTree } from "../src/lib/portal/dsl/validate"
import { validatePortalLayout } from "../src/lib/portal/schema"
import type { DslNode } from "../src/lib/portal/dsl/node"
import {
  buildBreezifyDocsHomeTree,
  type BreezifyDocsHomeInput,
} from "./breezify-docs-home"

const SECTIONS = [
  { key: "getting-started", title: "Getting Started", icon: "graduation-cap" },
  { key: "using-breezify", title: "Using Breezify", icon: "book-open" },
  { key: "integrations", title: "Integrations", icon: "puzzle" },
  { key: "publishing", title: "Publishing", icon: "send" },
  { key: "developers", title: "Developers & AI", icon: "terminal" },
  { key: "administration", title: "Administration", icon: "shield-check" },
]

/** Every document the home page links, as the seed script would resolve them. */
const DOC_PATHS = [
  "getting-started/quickstart.md",
  "getting-started/core-concepts.md",
  "using-breezify/create-and-edit-documents.md",
  "using-breezify/organize-your-knowledge-base.md",
  "using-breezify/capture-knowledge.md",
  "using-breezify/review-librarian-proposals.md",
  "using-breezify/search-and-ask-ai.md",
  "integrations/overview.md",
  "publishing/create-a-docs-project.md",
  "publishing/customize-and-publish.md",
  "publishing/custom-domains-and-paths.md",
  "developers/mcp/overview.md",
  "developers/mcp/connect-ai-tools.md",
  "developers/api/overview.md",
  "developers/api/authentication.md",
]

function input(overrides: Partial<BreezifyDocsHomeInput> = {}): BreezifyDocsHomeInput {
  return {
    base: "/p/breezify/docs",
    assetOrigin: "https://app.example.com",
    folderIds: new Map(
      SECTIONS.map((section, index) => [section.key, `folder-${index}`]),
    ),
    docSlugs: new Map(
      DOC_PATHS.map((path) => [path, path.split("/").pop()!.replace(/\.md$/, "")]),
    ),
    sections: SECTIONS,
    includeChangelogPage: true,
    assets: new Set([
      "home-workflow.webp",
      "home-search.webp",
      "home-publish.webp",
    ]),
    ...overrides,
  }
}

function walk(node: DslNode, visit: (node: DslNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function collect(tree: DslNode, type: string): DslNode[] {
  const found: DslNode[] = []
  walk(tree, (node) => {
    if (node.type === type) found.push(node)
  })
  return found
}

function hrefs(tree: DslNode): string[] {
  const out: string[] = []
  walk(tree, (node) => {
    const href = node.props?.href
    if (typeof href === "string") out.push(href)
  })
  return out
}

describe("buildBreezifyDocsHomeTree", () => {
  it("produces a tree the portal validator accepts", () => {
    const result = validateDslTree(buildBreezifyDocsHomeTree(input()))
    expect(result.ok ? null : result.error).toBeNull()
  })

  it("validates as a published v2 layout", () => {
    const layout = validatePortalLayout({
      schemaVersion: 2,
      theme: {
        brandName: "Breezify Docs",
        tagline: "",
        logoUrl: "",
        accentColor: "#3f6212",
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
      body: [],
      tree: buildBreezifyDocsHomeTree(input()),
    })
    expect(layout.ok ? null : layout.error).toBeNull()
  })

  it("links only documents and sections it was given", () => {
    const tree = buildBreezifyDocsHomeTree(input())
    for (const href of hrefs(tree)) {
      expect(href).not.toContain("undefined")
    }
    const docLinks = hrefs(tree).filter((href) => href.includes("/doc/"))
    expect(docLinks.length).toBeGreaterThan(0)
    for (const href of docLinks) {
      const slug = href.slice(href.lastIndexOf("/doc/") + "/doc/".length)
      expect([...input().docSlugs.values()]).toContain(slug)
    }
  })

  it("throws when a linked document was not published", () => {
    const docSlugs = new Map(input().docSlugs)
    docSlugs.delete("using-breezify/review-librarian-proposals.md")
    expect(() => buildBreezifyDocsHomeTree(input({ docSlugs }))).toThrow(
      /document slug.*review-librarian-proposals/,
    )
  })

  it("omits a section visual whose asset was never shipped", () => {
    const images = collect(
      buildBreezifyDocsHomeTree(input({ assets: new Set(["home-search.webp"]) })),
      "Image",
    )
    expect(images.map((image) => String(image.props?.src))).toEqual([
      "https://app.example.com/portal/docs/home-search.webp",
    ])
    // The page still reads without them — no empty <Image> placeholders.
    expect(collect(buildBreezifyDocsHomeTree(input({ assets: new Set() })), "Image")).toEqual([])
  })

  it("serves images from an absolute origin so proxied portals resolve them", () => {
    const images = collect(buildBreezifyDocsHomeTree(input()), "Image")
    expect(images.length).toBeGreaterThan(0)
    for (const image of images) {
      expect(String(image.props?.src)).toMatch(
        /^https:\/\/app\.example\.com\/portal\/docs\/[a-z-]+\.webp$/,
      )
      expect(String(image.props?.alt ?? "")).not.toBe("")
    }
  })

  it("keeps the curated section grid out of the generated-grid sync", () => {
    const grids = collect(buildBreezifyDocsHomeTree(input()), "CategoryGrid")
    expect(grids).toHaveLength(1)
    // `n-categories` is the id normalize keeps in lockstep with every root
    // folder in scope, which would append the changelog feed to this list.
    expect(grids[0]!.id).not.toBe("n-categories")
    expect(grids[0]!.props?.items).toHaveLength(SECTIONS.length)
  })

  it("omits the changelog link while that page is held back", () => {
    const withPage = hrefs(buildBreezifyDocsHomeTree(input()))
    expect(withPage).toContain("/p/breezify/docs/page/changelog")

    const withoutPage = hrefs(
      buildBreezifyDocsHomeTree(input({ includeChangelogPage: false })),
    )
    expect(withoutPage).not.toContain("/p/breezify/docs/page/changelog")
  })
})
