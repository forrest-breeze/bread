import { describe, expect, it } from "vitest"
import type { DslNode } from "@/lib/portal/dsl/node"
import { validateDslTree } from "./validate"
import {
  enforceScopedContentLinksTree,
  isKnowledgeContentHref,
  parsePortalContentHref,
  transformKnowledgeHtmlLinks,
  transformTreeContentLinks,
} from "./scope-filter"

const allowed = new Set<string>([
  "/p/acme/doc/in-scope",
  "/p/acme/folder/keep",
])

function tree(): DslNode {
  return {
    id: "root",
    type: "Stack",
    children: [
      { id: "ok-link", type: "Link", props: { label: "Keep", href: "/p/acme/doc/in-scope" } },
      { id: "bad-link", type: "Link", props: { label: "Drop", href: "/p/acme/doc/out" } },
      { id: "ext", type: "Link", props: { label: "External", href: "https://example.com" } },
      {
        id: "grid",
        type: "CategoryGrid",
        props: {
          items: [
            { id: "c1", title: "Keep", href: "/p/acme/folder/keep" },
            { id: "c2", title: "Drop", href: "/p/acme/folder/gone" },
          ],
        },
      },
      {
        id: "checklist",
        type: "Checklist",
        props: {
          items: [
            { id: "step-1", label: "Keep", href: "/p/acme/doc/in-scope" },
            { id: "step-2", label: "Drop", href: "/p/acme/doc/out" },
            { id: "step-3", label: "No link" },
          ],
        },
      },
    ],
  }
}

function childIds(node: DslNode): string[] {
  return (node.children ?? []).map((c) => c.id)
}

describe("enforceScopedContentLinksTree", () => {
  it("drops a leaf whose required href is out of scope, keeps in-scope + external", () => {
    const filtered = enforceScopedContentLinksTree(tree(), allowed)
    const ids = childIds(filtered)
    expect(ids).toContain("ok-link")
    expect(ids).toContain("ext")
    expect(ids).not.toContain("bad-link")
  })

  it("filters out-of-scope items from a CategoryGrid, keeps in-scope items", () => {
    const filtered = enforceScopedContentLinksTree(tree(), allowed)
    const grid = filtered.children?.find((c) => c.id === "grid")
    const items = (grid?.props?.items as Array<{ id: string }>) ?? []
    expect(items.map((i) => i.id)).toEqual(["c1"])
  })

  it("filters scoped checklist links while keeping unlinked steps", () => {
    const filtered = enforceScopedContentLinksTree(tree(), allowed)
    const checklist = filtered.children?.find((c) => c.id === "checklist")
    const items = (checklist?.props?.items as Array<{ id: string }>) ?? []
    expect(items.map((item) => item.id)).toEqual(["step-1", "step-3"])
  })

  it("produces a tree that still validates", () => {
    const filtered = enforceScopedContentLinksTree(tree(), allowed)
    expect(validateDslTree(filtered).ok).toBe(true)
  })

  it("fails closed when the out-of-scope node is the tree root", () => {
    const filtered = enforceScopedContentLinksTree(
      { id: "root-link", type: "Link", props: { label: "Private", href: "/p/acme/doc/out" } },
      allowed,
    )

    expect(filtered).toEqual({ id: "root-link", type: "Stack", props: {}, children: [] })
    expect(validateDslTree(filtered).ok).toBe(true)
  })

  it("recognizes knowledge-content hrefs", () => {
    expect(isKnowledgeContentHref("/p/acme/doc/x")).toBe(true)
    expect(isKnowledgeContentHref("/p/acme/folder/x")).toBe(true)
    expect(isKnowledgeContentHref("/p/acme/help/doc/x")).toBe(true)
    expect(isKnowledgeContentHref("/p/acme/help/folder/x")).toBe(true)
    expect(isKnowledgeContentHref("https://example.com")).toBe(false)
    expect(isKnowledgeContentHref("/p/acme/search?q=1")).toBe(false)
  })

  it("parses one- and two-segment portal bases without including query/hash", () => {
    expect(parsePortalContentHref("/p/acme/doc/guides/install?tab=mac#step-1")).toEqual({
      kind: "doc",
      ref: "guides/install",
    })
    expect(parsePortalContentHref("/p/acme/help/folder/f-1?from=home")).toEqual({
      kind: "folder",
      ref: "f-1",
    })
    expect(parsePortalContentHref("/kb/doc/legacy-doc")).toEqual({
      kind: "doc",
      ref: "legacy-doc",
    })
  })

  it("rehomes in-scope tree links and removes stale out-of-scope links", () => {
    const transformed = transformTreeContentLinks(tree(), (href) => {
      const ref = parsePortalContentHref(href)
      if (!ref || ref.ref === "out" || ref.ref === "gone") return null
      return `/p/acme/help/${ref.kind}/${ref.ref}`
    })
    const okLink = transformed.children?.find((child) => child.id === "ok-link")
    const grid = transformed.children?.find((child) => child.id === "grid")

    expect(okLink?.props?.href).toBe("/p/acme/help/doc/in-scope")
    expect(childIds(transformed)).not.toContain("bad-link")
    expect(grid?.props?.items).toEqual([
      { id: "c1", title: "Keep", href: "/p/acme/help/folder/keep" },
    ])
  })

  it("enforces href parameters on composite component instances", () => {
    const composites = [
      {
        name: "DocCard",
        params: [{ name: "target", type: "href" as const, required: true }],
        tree: {
          id: "component-link",
          type: "Link",
          props: { label: "Read", href: "{{target}}" },
        },
      },
    ]
    const resolve = (href: string): string | null =>
      href.endsWith("/keep") ? "/p/acme/help/doc/keep" : null
    const kept = transformTreeContentLinks(
      { id: "instance", type: "DocCard", props: { target: "/p/old/doc/keep" } },
      resolve,
      composites,
    )
    const dropped = transformTreeContentLinks(
      { id: "instance", type: "DocCard", props: { target: "/p/old/doc/private" } },
      resolve,
      composites,
    )

    expect(kept.props?.target).toBe("/p/acme/help/doc/keep")
    expect(dropped).toEqual({ id: "instance", type: "Stack", props: {}, children: [] })
  })

  it("rewrites or strips embedded HTML knowledge links and preserves external links", () => {
    const html = [
      '<a href="/p/old/help/doc/keep">Keep</a>',
      "<a href='/p/old/help/doc/drop'>Drop</a>",
      '<a href="https://example.com">External</a>',
    ].join("")
    const transformed = transformKnowledgeHtmlLinks(html, (href) =>
      href.endsWith("/keep") ? "/p/acme/help/doc/keep" : null,
    )

    expect(transformed).toContain('href="/p/acme/help/doc/keep"')
    expect(transformed).toContain("<a>Drop</a>")
    expect(transformed).toContain('href="https://example.com"')
  })
})
