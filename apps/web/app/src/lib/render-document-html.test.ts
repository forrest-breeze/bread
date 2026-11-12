// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { renderDocumentHtml } from "@/lib/render-document-html"

describe("renderDocumentHtml", () => {
  it("treats ordinary editor HTML tags as HTML", () => {
    const out = renderDocumentHtml("<mark>Highlighted</mark>")

    expect(out).toContain("<mark>Highlighted</mark>")
    expect(out).not.toContain("&lt;mark&gt;")
  })

  it("does not mistake placeholder angle tokens in Markdown for HTML", () => {
    const out = renderDocumentHtml(
      [
        "```",
        "GET /api/v1/search?q=<query>",
        "```",
        "",
        "| Name | Description |",
        "|---|---|",
        "| `q` | Natural language search query |",
      ].join("\n"),
    )

    expect(out).toContain("<table>")
    expect(out).toContain("<code>")
    expect(out).toContain("&lt;query&gt;")
    expect(out).not.toContain("|---|")
  })

  it("keeps authenticated /api/media/<id> srcs as-is (no public rewrite in-app)", () => {
    // The in-app surface is authenticated; the RLS-gated /api/media/<id>
    // endpoint works for members, so it must NOT be rewritten to the public one.
    const out = renderDocumentHtml('<img src="/api/media/x1" alt="d">')
    expect(out).toContain('src="/api/media/x1"')
    expect(out).not.toContain("/api/public/media/")
  })

  it("keeps playable video attributes and the authenticated media source", () => {
    const out = renderDocumentHtml(
      '<video src="/api/media/v1" title="Demo" controls playsinline preload="metadata"></video>',
    )
    expect(out).toContain('src="/api/media/v1"')
    expect(out).toContain("controls")
    expect(out).toContain("playsinline")
    expect(out).not.toContain("/api/public/media/")
  })
})
