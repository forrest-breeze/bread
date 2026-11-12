import { describe, expect, it } from "vitest"
import { DSL_MAX_DEPTH, DSL_MAX_NODES, type DslNode } from "./node"
import { validateDslTree } from "./validate"
import { validateComposite, type CompositeDef } from "./composites"

// A small valid tree: Stack > [Heading, Grid > [Card > Text, Card > Text]].
function sampleTree(): DslNode {
  return {
    id: "root",
    type: "Stack",
    props: { gap: "lg" },
    children: [
      { id: "h", type: "Heading", props: { text: "Engineering Docs", level: 1 } },
      {
        id: "grid",
        type: "Grid",
        props: { columns: 2, gap: "md" },
        children: [
          {
            id: "c1",
            type: "Card",
            props: { pad: "lg", border: true },
            children: [{ id: "t1", type: "Text", props: { text: "Getting started", tone: "muted" } }],
          },
          {
            id: "c2",
            type: "Card",
            props: { pad: "lg", border: true },
            children: [{ id: "t2", type: "Text", props: { text: "API reference", tone: "muted" } }],
          },
        ],
      },
    ],
  }
}

describe("validateDslTree", () => {
  it("accepts a valid nested primitive tree", () => {
    const result = validateDslTree(sampleTree())
    expect(result.ok).toBe(true)
  })

  it("rejects an unknown node type", () => {
    const tree = sampleTree()
    tree.children![0].type = "Sparkle3000"
    const result = validateDslTree(tree)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('unknown node type "Sparkle3000"')
  })

  it("rejects unknown props on a primitive (strict schema)", () => {
    const result = validateDslTree({
      id: "x",
      type: "Text",
      props: { text: "hi", colour: "red" },
    })
    expect(result.ok).toBe(false)
  })

  it("rejects a wrong-typed prop value", () => {
    const result = validateDslTree({
      id: "x",
      type: "Grid",
      props: { columns: 99 },
    })
    expect(result.ok).toBe(false)
  })

  it("rejects an unsafe href", () => {
    const result = validateDslTree({
      id: "x",
      type: "Link",
      props: { label: "evil", href: "javascript:alert(1)" },
    })
    expect(result.ok).toBe(false)
  })

  it("rejects children on a leaf primitive", () => {
    const result = validateDslTree({
      id: "x",
      type: "Text",
      props: { text: "hi" },
      children: [{ id: "y", type: "Text", props: { text: "no" } }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("cannot have children")
  })

  it("rejects duplicate node ids", () => {
    const result = validateDslTree({
      id: "dup",
      type: "Stack",
      children: [
        { id: "dup", type: "Text", props: { text: "a" } },
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("duplicate node id")
  })

  it("enforces the max-depth cap", () => {
    // Build a Stack chain deeper than DSL_MAX_DEPTH.
    let node: DslNode = { id: "leaf", type: "Text", props: { text: "deep" } }
    for (let i = 0; i < DSL_MAX_DEPTH + 2; i += 1) {
      node = { id: `s${i}`, type: "Stack", children: [node] }
    }
    const result = validateDslTree(node)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("max depth")
  })

  it("enforces the max-node-count cap", () => {
    const children: DslNode[] = []
    // Exceed DSL_MAX_NODES via a wide tree (children capped at 60/level, so nest
    // a few Stacks each holding 60 leaves).
    let total = 0
    const groups: DslNode[] = []
    let g = 0
    while (total <= DSL_MAX_NODES + 60) {
      const leaves: DslNode[] = []
      for (let i = 0; i < 60; i += 1) {
        leaves.push({ id: `n${g}_${i}`, type: "Divider" })
        total += 1
      }
      groups.push({ id: `g${g}`, type: "Stack", children: leaves })
      g += 1
    }
    void children
    const result = validateDslTree({ id: "root", type: "Stack", children: groups })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("max node count")
  })

  it("accepts a tree that uses a registered composite", () => {
    const composites: CompositeDef[] = [
      {
        name: "KpiTile",
        params: [
          { name: "label", type: "string" },
          { name: "value", type: "string", required: true },
        ],
        tree: {
          id: "kpi-root",
          type: "Card",
          children: [
            { id: "kpi-label", type: "Text", props: { text: "{{label}}", tone: "muted" } },
            { id: "kpi-value", type: "Heading", props: { text: "{{value}}" } },
          ],
        },
      },
    ]
    const result = validateDslTree(
      {
        id: "root",
        type: "Stack",
        children: [{ id: "k1", type: "KpiTile", props: { value: "1,240" } }],
      },
      { composites },
    )
    expect(result.ok).toBe(true)
  })

  it("rejects a composite node missing a required param", () => {
    const composites: CompositeDef[] = [
      {
        name: "KpiTile",
        params: [{ name: "value", type: "string", required: true }],
        tree: { id: "r", type: "Heading", props: { text: "{{value}}" } },
      },
    ]
    const result = validateDslTree(
      { id: "root", type: "KpiTile", props: {} },
      { composites },
    )
    expect(result.ok).toBe(false)
  })

  it("rejects a composite that shadows a core primitive", () => {
    const composites: CompositeDef[] = [
      { name: "Card", params: [], tree: { id: "r", type: "Box" } },
    ]
    const result = validateDslTree({ id: "root", type: "Box" }, { composites })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("shadows a core primitive")
  })
})

describe("validateComposite", () => {
  it("accepts a composite whose tree uses only core primitives", () => {
    const result = validateComposite({
      name: "StatusBanner",
      params: [{ name: "text", type: "string", required: true }],
      tree: {
        id: "r",
        type: "Card",
        props: { bg: "muted" },
        children: [{ id: "t", type: "Text", props: { text: "{{text}}" } }],
      },
    })
    expect(result.ok).toBe(true)
  })

  it("rejects a composite whose tree references another composite", () => {
    const result = validateComposite({
      name: "Outer",
      params: [],
      tree: { id: "r", type: "KpiTile" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("only use core primitives")
  })

  it("rejects a non-PascalCase composite name", () => {
    const result = validateComposite({
      name: "kpiTile",
      params: [],
      tree: { id: "r", type: "Box" },
    })
    expect(result.ok).toBe(false)
  })
})
