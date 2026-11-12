import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactNode } from "react"
import { CORE_PRIMITIVE_TYPES } from "@/lib/portal/dsl/registry/defs"
import { validateComposite, type CompositeDef } from "@/lib/portal/dsl/composites"
import type { DslNode } from "@/lib/portal/dsl/node"
import {
  DslNodeView,
  dslRendererTypes,
  expandComposite,
  type DslRenderContext,
} from "./render"

vi.mock("@/components/ui/hover-prefetch-link", () => ({
  HoverPrefetchLink: ({
    href,
    children,
    className,
  }: {
    href: string
    children: ReactNode
    className?: string
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}))

const ctx: DslRenderContext = {
  slug: "x",
  composites: new Map(),
  font: "sans",
  askAiEnabled: false,
}

async function render(node: DslNode, c: DslRenderContext = ctx): Promise<string> {
  const el = await DslNodeView({ node, ctx: c })
  return renderToStaticMarkup(el)
}

describe("DSL renderer", () => {
  it("has a renderer for every core primitive type and vice-versa", () => {
    expect(new Set(dslRendererTypes())).toEqual(new Set(CORE_PRIMITIVE_TYPES))
  })

  it("renders a nested tree of core primitives to static markup", async () => {
    const tree: DslNode = {
      id: "root",
      type: "Stack",
      props: { gap: "md" },
      children: [
        { id: "h", type: "Heading", props: { text: "Hello", level: 1 } },
        { id: "t", type: "Text", props: { text: "World", tone: "muted" } },
        {
          id: "g",
          type: "Grid",
          props: { columns: 3 },
          children: [
            {
              id: "c",
              type: "Card",
              children: [{ id: "b", type: "Badge", props: { text: "New", tone: "accent" } }],
            },
          ],
        },
        { id: "l", type: "Link", props: { label: "Docs", href: "/p/x/doc/y" } },
        { id: "d", type: "Divider" },
      ],
    }
    const html = await render(tree)
    expect(html).toContain("Hello")
    expect(html).toContain("World")
    expect(html).toContain("New")
    expect(html).toContain("Docs")
    expect(html).toContain('href="/p/x/doc/y"')
    expect(html).toContain("<hr")
    expect(html).toContain("<h1")
    expect(html).toContain("grid")
  })

  it("renders an unknown type as nothing", async () => {
    const html = await render({ id: "u", type: "DoesNotExist" })
    expect(html).toBe("")
  })

  it("does not render legacy page-level search leaves", async () => {
    const html = await render({
      id: "search",
      type: "AskAiSearch",
      props: { placeholder: "Secondary search should not render" },
    })
    expect(html).toBe("")
  })

  it("renders an interactive linked checklist when the model selects that pattern", async () => {
    const html = await render({
      id: "onboarding",
      type: "Checklist",
      props: {
        title: "Your first week",
        description: "Complete these steps in order.",
        items: [
          {
            id: "workspace",
            label: "Set up your workspace",
            description: "Choose your profile and notification defaults.",
            href: "/p/x/doc/workspace-setup",
          },
          { id: "team", label: "Meet your team" },
        ],
      },
    })

    expect(html).toContain("Your first week")
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('href="/p/x/doc/workspace-setup"')
    expect(html).toContain("Meet your team")
  })

  it("uses the compact docs treatment for legacy leaves in a DSL tree", async () => {
    const tree: DslNode = {
      id: "root",
      type: "Stack",
      children: [
        {
          id: "hero",
          type: "Hero",
          props: { heading: "API reference" },
        },
        {
          id: "categories",
          type: "CategoryGrid",
          props: {
            items: [
              {
                id: "auth",
                title: "Authentication",
                href: "/p/x/doc/authentication",
                icon: "key-round",
              },
            ],
          },
        },
      ],
    }

    const html = await render(tree, { ...ctx, variant: "docs" })
    expect(html).toContain("text-[34px]")
    expect(html).toContain("min-h-20")
  })

  it("expands and renders a composite, substituting params", async () => {
    const def: CompositeDef = {
      name: "KpiTile",
      params: [
        { name: "label", type: "string" },
        { name: "value", type: "string" },
      ],
      tree: {
        id: "kpi-root",
        type: "Card",
        children: [
          { id: "kpi-label", type: "Text", props: { text: "{{label}}", tone: "muted" } },
          { id: "kpi-value", type: "Heading", props: { text: "{{value}}" } },
        ],
      },
    }
    expect(validateComposite(def).ok).toBe(true)

    const instance: DslNode = {
      id: "k1",
      type: "KpiTile",
      props: { label: "Users", value: "1,200" },
    }
    // expandComposite substitutes placeholders without touching the def.
    const expanded = expandComposite(def, instance)
    const labelNode = expanded.children?.[0]
    expect(labelNode?.props?.text).toBe("Users")

    const html = await render(instance, {
      ...ctx,
      composites: new Map([["KpiTile", def]]),
    })
    expect(html).toContain("Users")
    expect(html).toContain("1,200")
  })
})
