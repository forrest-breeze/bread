import { afterEach, describe, expect, it, vi } from "vitest"
import {
  publicPortalBasePath,
  publicPortalHref,
  withPublicPortalBase,
  withPublicPortalHtml,
} from "./public-base-path"
import type { PortalLayout } from "@/lib/portal/schema"

describe("public portal base paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

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
  it("rebases document links written before the workspace slug changed", () => {
    // Imported while the workspace was still "acme-1a2b", so the project sat at
    // the workspace root; the workspace is now "acme".
    const html =
      '<a href="/p/acme-1a2b/doc/intro">Intro</a>' +
      '<a href="/p/acme-1a2b/page/api/create#body">Create</a>' +
      '<a href="/p/acme/acme-1a2b/doc/current">Current</a>' +
      '<a href="/p/acme-1a2b/other">Other</a>' +
      '<a href="https://example.com/p/acme-1a2b/doc/intro">External</a>'

    expect(withPublicPortalHtml(html, "acme/acme-1a2b", "/p/acme/acme-1a2b")).toBe(
      '<a href="/p/acme/acme-1a2b/doc/intro">Intro</a>' +
        '<a href="/p/acme/acme-1a2b/page/api/create#body">Create</a>' +
        '<a href="/p/acme/acme-1a2b/doc/current">Current</a>' +
        '<a href="/p/acme-1a2b/other">Other</a>' +
        '<a href="https://example.com/p/acme-1a2b/doc/intro">External</a>',
    )
    // Behind a reverse-proxy mount both forms land on the mount.
    expect(withPublicPortalHtml(html, "acme/acme-1a2b", "/docs")).toContain(
      '<a href="/docs/doc/intro">Intro</a><a href="/docs/page/api/create#body">Create</a><a href="/docs/doc/current">Current</a>',
    )
    // A root project has no former address to rebase from.
    expect(withPublicPortalHtml(html, "acme", "/p/acme")).toBe(html)
  })
  it("points document links at the public app URL when one is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3001/")
    const html =
      '<a href="/p/acme-1a2b/doc/intro">Old</a>' +
      '<a href="/p/acme/acme-1a2b/doc/current#top">Current</a>' +
      '<a href="/p/acme/other/doc/x">Other project</a>' +
      '<a href="https://example.com/a">External</a>'

    expect(withPublicPortalHtml(html, "acme/acme-1a2b", "/p/acme/acme-1a2b")).toBe(
      '<a href="http://localhost:3001/p/acme/acme-1a2b/doc/intro">Old</a>' +
        '<a href="http://localhost:3001/p/acme/acme-1a2b/doc/current#top">Current</a>' +
        '<a href="/p/acme/other/doc/x">Other project</a>' +
        '<a href="https://example.com/a">External</a>',
    )
    // A reverse-proxy mount is already the public address.
    expect(withPublicPortalHtml(html, "acme/acme-1a2b", "/docs")).toContain(
      '<a href="/docs/doc/intro">Old</a><a href="/docs/doc/current#top">Current</a>',
    )
  })
})
