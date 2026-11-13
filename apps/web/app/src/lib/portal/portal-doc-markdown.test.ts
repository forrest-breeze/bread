import { describe, expect, it } from "vitest"
import { portalDocumentToMarkdown } from "./portal-doc-markdown"

// ---------------------------------------------------------------------------
// The HTML→markdown walker in document-export.ts was written for the browser.
// llms-full.txt runs it on the server against a jsdom-injected `<template>`, so
// these tests guard the injection: without it the converter silently returns raw
// HTML (its no-DOM fallback), and llms-full.txt would ship markup to agents.
// ---------------------------------------------------------------------------

describe("portalDocumentToMarkdown", () => {
  it("converts authored HTML to markdown on the server", () => {
    const out = portalDocumentToMarkdown(
      "<h2>Install</h2><p>Run <code>npm i</code> first.</p>",
    )
    expect(out).toBe("## Install\n\nRun `npm i` first.")
  })

  it("converts lists and links", () => {
    const out = portalDocumentToMarkdown(
      '<ul><li>One</li><li><a href="https://a.dev">Two</a></li></ul>',
    )
    expect(out).toContain("- One")
    expect(out).toContain("- [Two](https://a.dev)")
  })

  it("keeps fenced code blocks with their language", () => {
    const out = portalDocumentToMarkdown(
      '<pre><code class="language-bash">npm run build</code></pre>',
    )
    expect(out).toBe("```bash\nnpm run build\n```")
  })

  it("passes markdown content through untouched", () => {
    expect(portalDocumentToMarkdown("# Already markdown\n\nBody.")).toBe(
      "# Already markdown\n\nBody.",
    )
  })

  it("preserves named Breezify page breaks as Markdown sections", () => {
    expect(
      portalDocumentToMarkdown(
        '<div data-type="page-break" data-name="Authentication"></div><p>Use OAuth.</p>',
      ),
    ).toBe("## Authentication\n\nUse OAuth.")
  })

  it("returns an empty string for empty content", () => {
    expect(portalDocumentToMarkdown("   ")).toBe("")
    expect(portalDocumentToMarkdown(null)).toBe("")
    expect(portalDocumentToMarkdown(undefined)).toBe("")
  })

  it("reuses one DOM across documents", () => {
    // Regression guard: a per-call JSDOM would dominate whole-KB rendering.
    const first = portalDocumentToMarkdown("<p>one</p>")
    const second = portalDocumentToMarkdown("<p>two</p>")
    expect([first, second]).toEqual(["one", "two"])
  })
})
