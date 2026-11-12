import { describe, expect, it } from "vitest"
import { PortalLayoutOpError } from "@/lib/portal/builder-ops"
import { setTheme } from "@/lib/portal/builder-ops"
import type { PortalLayout } from "@/lib/portal/schema"
import type { DslNode } from "@/lib/portal/dsl/node"
import type { CompositeDef } from "@/lib/portal/dsl/composites"
import {
  defineComponent,
  deriveNodeId,
  ensureTree,
  insertNode,
  moveNode,
  removeComponent,
  removeNode,
  updateNode,
} from "./tree-ops"

function tree(): DslNode {
  return {
    id: "root",
    type: "Stack",
    children: [
      { id: "h", type: "Heading", props: { text: "Hi" } },
      {
        id: "card",
        type: "Card",
        children: [{ id: "b", type: "Badge", props: { text: "x" } }],
      },
    ],
  }
}

function layout(): PortalLayout {
  return {
    schemaVersion: 1,
    theme: {
      brandName: "Acme",
      tagline: "",
      logoUrl: "",
      accentColor: "#2f5520",
      navLinks: [],
      cta: null,
      font: "sans",
      appearance: "auto",
    },
    header: { id: "header", type: "portal-header", search: { enabled: true, placeholder: "Search" } },
    body: [{ id: "hero", type: "hero", placement: "full", heading: "How can we help?" }],
  }
}

const kpiTile: CompositeDef = {
  name: "KpiTile",
  params: [
    { name: "label", type: "string" },
    { name: "value", type: "string" },
  ],
  tree: {
    id: "kpi-root",
    type: "Card",
    children: [
      { id: "kpi-label", type: "Text", props: { text: "{{label}}" } },
      { id: "kpi-value", type: "Heading", props: { text: "{{value}}" } },
    ],
  },
}

describe("tree-ops", () => {
  it("inserts a node into a container", () => {
    const next = insertNode(tree(), "card", { id: "t", type: "Text", props: { text: "yo" } })
    const card = next.children?.find((c) => c.id === "card")
    expect(card?.children?.map((c) => c.id)).toEqual(["b", "t"])
  })

  it("rejects inserting into a leaf node", () => {
    expect(() => insertNode(tree(), "h", { id: "x", type: "Text", props: { text: "a" } })).toThrow(
      PortalLayoutOpError,
    )
  })

  it("rejects inserting a node with a duplicate id", () => {
    expect(() => insertNode(tree(), "card", { id: "h", type: "Text", props: { text: "a" } })).toThrow(
      PortalLayoutOpError,
    )
  })

  it("updates a node's props", () => {
    const next = updateNode(tree(), "h", { text: "Bye" })
    const h = next.children?.find((c) => c.id === "h")
    expect(h?.props?.text).toBe("Bye")
  })

  it("rejects updating an unknown id", () => {
    expect(() => updateNode(tree(), "nope", { text: "x" })).toThrow(PortalLayoutOpError)
  })

  it("moves a node under a new parent", () => {
    const next = moveNode(tree(), "b", "root", 0)
    expect(next.children?.[0]?.id).toBe("b")
    const card = next.children?.find((c) => c.id === "card")
    expect(card?.children ?? []).toHaveLength(0)
  })

  it("rejects moving the root", () => {
    expect(() => moveNode(tree(), "root", "card", 0)).toThrow(PortalLayoutOpError)
  })

  it("rejects moving a node into its own subtree", () => {
    expect(() => moveNode(tree(), "card", "b", 0)).toThrow(PortalLayoutOpError)
  })

  it("removes a node", () => {
    const next = removeNode(tree(), "card")
    expect(next.children?.map((c) => c.id)).toEqual(["h"])
  })

  it("rejects removing the root", () => {
    expect(() => removeNode(tree(), "root")).toThrow(PortalLayoutOpError)
  })

  it("derives deterministic unused node ids", () => {
    expect(deriveNodeId(tree(), "Card")).toBe("card-2")
    expect(deriveNodeId(tree(), "Text")).toBe("text")
  })

  it("defines a composite and rejects shadowing / duplicates", () => {
    const withComp = defineComponent(layout(), kpiTile)
    expect(withComp.components?.map((c) => c.name)).toEqual(["KpiTile"])
    // shadows a core primitive type
    expect(() => defineComponent(layout(), { ...kpiTile, name: "Card" })).toThrow(
      PortalLayoutOpError,
    )
    // duplicate name
    expect(() => defineComponent(withComp, kpiTile)).toThrow(PortalLayoutOpError)
  })

  it("removes a composite", () => {
    const withComp = defineComponent(layout(), kpiTile)
    const without = removeComponent(withComp, "KpiTile")
    expect(without.components ?? []).toHaveLength(0)
    expect(() => removeComponent(layout(), "Nope")).toThrow(PortalLayoutOpError)
  })

  it("ensureTree upgrades a legacy body and is deterministic + idempotent", () => {
    const upgraded = ensureTree(layout())
    expect(upgraded.schemaVersion).toBe(2)
    expect(upgraded.tree?.type).toBe("Stack")
    expect(upgraded.body).toEqual([])
    // deterministic
    expect(JSON.stringify(ensureTree(layout()))).toBe(JSON.stringify(upgraded))
    // idempotent on an already-tree layout
    const again = ensureTree(upgraded)
    expect(JSON.stringify(again.tree)).toBe(JSON.stringify(upgraded.tree))
  })

  it("setTheme accepts a tokens patch", () => {
    const next = setTheme(layout(), { tokens: { accent: "#123456" } })
    expect(next.theme.tokens?.accent).toBe("#123456")
  })
})
