import { describe, expect, it } from "vitest"
import {
  publicPortalBasePath,
  publicPortalHref,
  withPublicPortalBase,
} from "./public-base-path"
import type { PortalLayout } from "@/lib/portal/schema"

describe("public portal base paths", () => {
  it("uses only a valid reverse-proxy mount", () => {
    expect(publicPortalBasePath("acme/blog", "/blog/")).toBe("/blog")
    expect(publicPortalBasePath("acme/blog", null)).toBe("/p/acme/blog")
    expect(publicPortalBasePath("acme/blog", "/")).toBe("/p/acme/blog")
    expect(publicPortalBasePath("acme/blog", "/p/other")).toBe("/p/acme/blog")
    expect(publicPortalHref("/blog", "doc/launch?q=1")).toBe(
      "/blog/doc/launch?q=1",
    )
  })

  it("rewrites authored layout links without mutating the stored layout", () => {
    const layout = {
      body: [
        {
          type: "rich-text",
          id: "one",
          placement: "main",
          html: '<p><a href="/p/acme/blog/doc/launch">Launch</a></p>',
        },
      ],
      sidebar: {
        groups: [
          { id: "guides", label: "Guides", href: "/p/acme/blog/folder/guides" },
        ],
      },
    } as unknown as PortalLayout

    const rewritten = withPublicPortalBase(layout, "acme/blog", "/blog")
    expect(rewritten.sidebar?.groups[0]?.href).toBe("/blog/folder/guides")
    expect(rewritten.body[0]).toMatchObject({
      html: '<p><a href="/blog/doc/launch">Launch</a></p>',
    })
    expect(layout.sidebar?.groups[0]?.href).toBe("/p/acme/blog/folder/guides")
  })
})
