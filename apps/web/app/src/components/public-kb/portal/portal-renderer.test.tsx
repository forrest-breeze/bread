import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { PortalLayout, PortalTheme } from "@/lib/portal/schema"
import { PortalRenderer } from "./portal-renderer"
import { DslNodeView } from "./dsl/render"

const theme: PortalTheme = {
  brandName: "Acme",
  tagline: "",
  logoUrl: "",
  accentColor: "#2f5520",
  navLinks: [],
  cta: null,
  font: "sans",
  appearance: "auto",
}

const header: PortalLayout["header"] = {
  id: "header",
  type: "portal-header",
  search: { enabled: true, placeholder: "Search" },
}

function treeLayout(): PortalLayout {
  return {
    schemaVersion: 2,
    theme,
    header,
    body: [],
    tree: {
      id: "root",
      type: "Stack",
      children: [
        { id: "h", type: "Heading", props: { text: "Tree heading" } },
        { id: "t", type: "Text", props: { text: "tree body" } },
      ],
    },
  }
}

function legacyLayout(): PortalLayout {
  return {
    schemaVersion: 1,
    theme,
    header,
    body: [
      { id: "hero", type: "hero", placement: "full", heading: "How can we help?" },
      {
        id: "secondary-search",
        type: "ask-ai-search",
        placement: "full",
        placeholder: "Secondary search should not render",
      },
    ],
  }
}

describe("PortalRenderer", () => {
  it("routes to the DSL renderer when a tree is present", () => {
    const el = PortalRenderer({ slug: "x", layout: treeLayout() })
    expect(el.type).toBe(DslNodeView)
  })

  it("renders the legacy placement body when there is no tree", () => {
    const html = renderToStaticMarkup(PortalRenderer({ slug: "x", layout: legacyLayout() }))
    expect(html).toContain("How can we help?")
    expect(html).not.toContain("Secondary search should not render")
  })
})
