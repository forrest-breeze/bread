import { describe, expect, it } from "vitest"
import type { PortalBlock } from "@/lib/portal/schema"
import { validateDslTree } from "./validate"
import { bodyToTree } from "./body-to-tree"

function sampleBody(): PortalBlock[] {
  return [
    { id: "hero", type: "hero", placement: "full", heading: "How can we help?" },
    { id: "ask", type: "ask-ai-search", placement: "main", placeholder: "Ask…" },
    {
      id: "cats",
      type: "category-grid",
      placement: "main",
      items: [
        { id: "c1", title: "Guides", icon: "folder", href: "/p/acme/folder/c1" },
        { id: "c2", title: "API", href: "/p/acme/folder/c2" },
      ],
    },
    {
      id: "trending",
      type: "article-list",
      placement: "aside",
      title: "Trending",
      items: [{ id: "a1", title: "Intro", href: "/p/acme/doc/a1" }],
    },
    { id: "note", type: "callout", placement: "full", tone: "info", body: "Heads up." },
  ]
}

function collectTypes(node: { type: string; children?: { type: string }[] }): string[] {
  const out = [node.type]
  for (const child of node.children ?? []) {
    out.push(...collectTypes(child as { type: string; children?: { type: string }[] }))
  }
  return out
}

describe("bodyToTree", () => {
  it("produces a tree that passes validateDslTree", () => {
    const tree = bodyToTree(sampleBody())
    const result = validateDslTree(tree)
    expect(result.ok).toBe(true)
  })

  it("wraps full blocks in the root stack and main/aside in a 2-col grid", () => {
    const tree = bodyToTree(sampleBody())
    expect(tree.type).toBe("Stack")
    const types = collectTypes(tree)
    expect(types).toContain("Hero")
    expect(types).toContain("Callout")
    expect(types).toContain("AskAiSearch")
    expect(types).toContain("CategoryGrid")
    expect(types).toContain("ArticleList")
    // main + aside both present → a Grid split with two Stacks.
    expect(types).toContain("Grid")
  })

  it("stacks main blocks without a split when there is no aside", () => {
    const tree = bodyToTree([
      { id: "hero", type: "hero", placement: "full", heading: "Hi" },
      { id: "cats", type: "category-grid", placement: "main", items: [] },
    ])
    expect(collectTypes(tree)).not.toContain("Grid")
    expect(validateDslTree(tree).ok).toBe(true)
  })

  it("assigns unique ids and is deterministic across calls", () => {
    const a = bodyToTree(sampleBody())
    const b = bodyToTree(sampleBody())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))

    const ids: string[] = []
    const walk = (n: { id: string; children?: { id: string }[] }): void => {
      ids.push(n.id)
      for (const c of n.children ?? []) walk(c as { id: string; children?: { id: string }[] })
    }
    walk(a as { id: string; children?: { id: string }[] })
    expect(new Set(ids).size).toBe(ids.length)
  })
})
