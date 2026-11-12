import { describe, expect, it } from "vitest"
import { PORTAL_SCHEMA_VERSION, type PortalLayout } from "./schema"
import {
  addBlock,
  getPortalLayout,
  PortalLayoutOpError,
  removeBlock,
  reorderBlocks,
  setChromeMode,
  setFooter,
  setFooterPoweredBy,
  setHeader,
  setLocalization,
  setPages,
  setNav,
  setSidebarOverride,
  setTheme,
  updateBlock,
} from "./builder-ops"

function layout(): PortalLayout {
  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    theme: {
      brandName: "Acme",
      tagline: "Docs",
      logoUrl: "",
      accentColor: "#2f5520",
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
    body: [
      { id: "hero", type: "hero", placement: "full", heading: "Welcome" },
      {
        id: "ask",
        type: "ask-ai-search",
        placement: "full",
        placeholder: "Ask…",
      },
    ],
    footer: { id: "footer", type: "footer", showPoweredBy: true },
  }
}

describe("getPortalLayout", () => {
  it("validates and clones a valid layout", () => {
    const result = getPortalLayout(layout())
    expect(result.body).toHaveLength(2)
    expect(result.theme.brandName).toBe("Acme")
  })

  it("throws on an invalid layout", () => {
    expect(() => getPortalLayout({ schemaVersion: 99 })).toThrow(PortalLayoutOpError)
  })
})

describe("setHeader", () => {
  it("updates header search settings", () => {
    const next = setHeader(layout(), {
      search: { enabled: false, placeholder: "Find an answer" },
    })
    expect(next.header.search).toEqual({
      enabled: false,
      placeholder: "Find an answer",
    })
    expect(next.chrome?.headerMode).toBe("custom")
  })

  it("updates the order of links, button, and language controls", () => {
    const next = setHeader(layout(), {
      itemOrder: ["language", "links", "cta"],
    })
    expect(next.header.itemOrder).toEqual(["language", "links", "cta"])
    expect(next.chrome?.headerMode).toBe("custom")
  })

  it("moves the language selector beside the brand", () => {
    const next = setHeader(layout(), { languagePlacement: "brand" })
    expect(next.header.languagePlacement).toBe("brand")
    expect(next.chrome?.headerMode).toBe("custom")
  })

  it("sets header/footer inheritance modes", () => {
    const next = setChromeMode(layout(), {
      headerMode: "workspace",
      footerMode: "workspace",
    })
    expect(next.chrome).toEqual({
      headerMode: "workspace",
      footerMode: "workspace",
    })
  })
})

describe("addBlock", () => {
  it("appends a block when no index is given", () => {
    const next = addBlock(layout(), {
      id: "note",
      type: "callout",
      placement: "main",
      tone: "info",
      body: "Heads up",
    })
    expect(next.body).toHaveLength(3)
    expect(next.body[2].id).toBe("note")
  })

  it("inserts at the given index", () => {
    const next = addBlock(
      layout(),
      { id: "note", type: "callout", placement: "main", tone: "info", body: "x" },
      0,
    )
    expect(next.body[0].id).toBe("note")
  })

  it("derives a deterministic id when none is provided", () => {
    const base = layout()
    const once = addBlock(base, {
      id: "",
      type: "callout",
      placement: "main",
      tone: "info",
      body: "first",
    })
    expect(once.body[2].id).toBe("callout")
    const twice = addBlock(once, {
      id: "",
      type: "callout",
      placement: "main",
      tone: "warn",
      body: "second",
    })
    expect(twice.body[3].id).toBe("callout-2")
  })

  it("derives an id when the id field is omitted entirely (agent path)", () => {
    const next = addBlock(layout(), {
      type: "callout",
      placement: "main",
      tone: "info",
      body: "no id field",
    })
    expect(next.body[2].id).toBe("callout")
  })

  it("reuses a freed id after a middle same-typed block is removed", () => {
    // [callout, callout-2, callout-3] → remove callout-2 → adding another
    // callout must fill the gap ("callout-2"), not collide on a counted
    // "callout-3" (the bug a count-based derivation produced).
    let l = layout()
    l = addBlock(l, { type: "callout", placement: "main", tone: "info", body: "a" })
    l = addBlock(l, { type: "callout", placement: "main", tone: "info", body: "b" })
    l = addBlock(l, { type: "callout", placement: "main", tone: "info", body: "c" })
    l = removeBlock(l, "callout-2")
    const next = addBlock(l, {
      type: "callout",
      placement: "main",
      tone: "info",
      body: "d",
    })
    const ids = next.body.map((b) => b.id)
    expect(ids).toContain("callout-2")
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
  })

  it("rejects a duplicate id", () => {
    expect(() =>
      addBlock(layout(), {
        id: "hero",
        type: "callout",
        placement: "main",
        tone: "info",
        body: "dupe",
      }),
    ).toThrow(PortalLayoutOpError)
  })

  it("rejects a block the schema can't validate", () => {
    expect(() =>
      addBlock(layout(), {
        id: "bad",
        type: "hero",
        placement: "full",
        // missing required `heading`
      } as never),
    ).toThrow(PortalLayoutOpError)
  })
})

describe("updateBlock", () => {
  it("merges a patch into the matching block", () => {
    const next = updateBlock(layout(), "hero", { heading: "Updated" })
    const hero = next.body.find((b) => b.id === "hero")
    expect(hero && hero.type === "hero" && hero.heading).toBe("Updated")
  })

  it("cannot change a block's type or id", () => {
    const next = updateBlock(layout(), "hero", { type: "callout", id: "x" })
    const hero = next.body[0]
    expect(hero.id).toBe("hero")
    expect(hero.type).toBe("hero")
  })

  it("throws when no block matches", () => {
    expect(() => updateBlock(layout(), "nope", { heading: "x" })).toThrow(
      PortalLayoutOpError,
    )
  })

  it("throws when the patch makes the block invalid", () => {
    expect(() => updateBlock(layout(), "hero", { heading: "" })).toThrow(
      PortalLayoutOpError,
    )
  })
})

describe("removeBlock", () => {
  it("removes the matching block", () => {
    const next = removeBlock(layout(), "ask")
    expect(next.body).toHaveLength(1)
    expect(next.body[0].id).toBe("hero")
  })

  it("throws when no block matches", () => {
    expect(() => removeBlock(layout(), "nope")).toThrow(PortalLayoutOpError)
  })
})

describe("reorderBlocks", () => {
  it("reorders to match the provided id permutation", () => {
    const next = reorderBlocks(layout(), ["ask", "hero"])
    expect(next.body.map((b) => b.id)).toEqual(["ask", "hero"])
  })

  it("throws on a wrong-length list", () => {
    expect(() => reorderBlocks(layout(), ["hero"])).toThrow(PortalLayoutOpError)
  })

  it("throws on a duplicate id", () => {
    expect(() => reorderBlocks(layout(), ["hero", "hero"])).toThrow(
      PortalLayoutOpError,
    )
  })

  it("throws on an unknown id", () => {
    expect(() => reorderBlocks(layout(), ["hero", "ghost"])).toThrow(
      PortalLayoutOpError,
    )
  })
})

describe("setTheme", () => {
  it("merges a partial theme", () => {
    const next = setTheme(layout(), { brandName: "Beta", accentColor: "#111111" })
    expect(next.theme.brandName).toBe("Beta")
    expect(next.theme.accentColor).toBe("#111111")
    expect(next.theme.tagline).toBe("Docs")
  })

  it("marks header chrome custom when nav or cta changes", () => {
    const next = setTheme(layout(), {
      navLinks: [{ label: "Home", href: "https://example.com" }],
    })
    expect(next.chrome?.headerMode).toBe("custom")
  })

  it("throws when the merged theme is invalid", () => {
    expect(() => setTheme(layout(), { brandName: "" })).toThrow(PortalLayoutOpError)
  })
})

describe("setLocalization", () => {
  it("sets enabled languages and the default", () => {
    const next = setLocalization(layout(), {
      enabledLanguages: ["es", "fr"],
      defaultLanguage: "es",
    })
    expect(next.localization).toEqual({
      enabledLanguages: ["es", "fr"],
      defaultLanguage: "es",
    })
  })

  it("rejects a default language that is not enabled", () => {
    expect(() =>
      setLocalization(layout(), {
        enabledLanguages: ["es"],
        defaultLanguage: "fr",
      }),
    ).toThrow(PortalLayoutOpError)
  })
})

describe("setPages", () => {
  it("sets and clears ordered project pages", () => {
    const page = {
      id: "api-page",
      title: "API Reference",
      slug: "api-reference",
      scope: ["11111111-1111-4111-8111-111111111111"],
    }
    const withPage = setPages(layout(), [page])
    expect(withPage.pages).toEqual([page])
    expect(setPages(withPage, []).pages).toBeUndefined()
  })
})

describe("setFooterPoweredBy", () => {
  it("marks footer chrome custom when footer content changes", () => {
    const next = setFooter(layout(), {
      note: "© Acme",
    })
    expect(next.footer?.note).toBe("© Acme")
    expect(next.chrome?.footerMode).toBe("custom")
  })

  it("toggles the footer credit", () => {
    const hidden = setFooterPoweredBy(layout(), false)
    expect(hidden.footer?.showPoweredBy).toBe(false)

    const visible = setFooterPoweredBy(hidden, true)
    expect(visible.footer?.showPoweredBy).toBe(true)
  })
})

describe("setNav", () => {
  it("sets the sidebar", () => {
    const next = setNav(layout(), {
      id: "sidebar",
      type: "sidebar-nav",
      groups: [
        {
          id: "g1",
          label: "Topics",
          items: [{ id: "i1", label: "Intro", href: "/p/acme/doc/1" }],
        },
      ],
    })
    expect(next.sidebar?.groups).toHaveLength(1)
  })

  it("normalizes id/type onto the singleton shape", () => {
    const next = setNav(layout(), {
      id: "",
      type: "sidebar-nav",
      groups: [],
    } as never)
    expect(next.sidebar?.id).toBe("sidebar")
    expect(next.sidebar?.type).toBe("sidebar-nav")
  })

  it("removes the sidebar when passed null", () => {
    const withNav = setNav(layout(), {
      id: "sidebar",
      type: "sidebar-nav",
      groups: [],
    })
    const without = setNav(withNav, null)
    expect(without.sidebar).toBeUndefined()
  })

  it("throws when an invalid nav href is provided", () => {
    expect(() =>
      setNav(layout(), {
        id: "sidebar",
        type: "sidebar-nav",
        groups: [
          {
            id: "g1",
            label: "Bad",
            items: [{ id: "i1", label: "x", href: "javascript:alert(1)" }],
          },
        ],
      }),
    ).toThrow(PortalLayoutOpError)
  })
})

describe("setSidebarOverride", () => {
  it("sets, merges, and clears a group override", () => {
    const withIcon = setSidebarOverride(layout(), "f1", { icon: "rocket" })
    expect(withIcon.sidebarOverrides?.f1).toEqual({ icon: "rocket" })

    const withLabel = setSidebarOverride(withIcon, "f1", { label: "Dev" })
    expect(withLabel.sidebarOverrides?.f1).toEqual({ icon: "rocket", label: "Dev" })

    const cleared = setSidebarOverride(withLabel, "f1", { icon: undefined, label: undefined })
    expect(cleared.sidebarOverrides?.f1).toBeUndefined()
  })
})
