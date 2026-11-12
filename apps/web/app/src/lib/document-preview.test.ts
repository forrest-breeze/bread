import { describe, expect, it } from "vitest"
import {
  estimateDocumentReadTimeMinutes,
  makeDocumentPreview,
} from "./document-preview"

describe("makeDocumentPreview", () => {
  it("turns editor HTML into readable text", () => {
    expect(
      makeDocumentPreview(
        '<div data-type="page-break" data-node-id="one"></div><h1>Getting started</h1><p>Use <strong>Bread</strong> with your team &amp; agents.</p>',
      ),
    ).toBe("Getting started Use Bread with your team & agents.")
  })

  it("cleans common imported Markdown", () => {
    expect(
      makeDocumentPreview(
        "## Runbook\n\n- Read the [deployment guide](https://example.com).\n- Run `pnpm test`.",
      ),
    ).toBe("Runbook Read the deployment guide. Run pnpm test.")
  })

  it("resolves Markdown escapes left by round-tripped exports", () => {
    expect(
      makeDocumentPreview(
        "\\*\\*Goal:\\*\\* audit every surface. Scope: \\`apps/web/app/src\\` and \\`UX\\_TESTING\\_PLAN.md\\`.",
      ),
    ).toBe("Goal: audit every surface. Scope: apps/web/app/src and UX_TESTING_PLAN.md.")
  })

  it("clips long excerpts at a word boundary", () => {
    expect(makeDocumentPreview("alpha beta gamma delta epsilon", 20)).toBe(
      "alpha beta gamma…",
    )
  })

  it("returns an empty preview for empty editor content", () => {
    expect(makeDocumentPreview("   ")).toBe("")
  })

  it("does not leak Mermaid source syntax into document list previews", () => {
    expect(
      makeDocumentPreview(
        '<p>Architecture notes</p><div data-type="mermaid-diagram" data-source="flowchart TD"><pre data-mermaid-fallback><code>flowchart TD\nA--&gt;B</code></pre></div><p>Current state.</p>',
      ),
    ).toBe("Architecture notes Current state.")
  })

  it("estimates reading time from rendered document text", () => {
    expect(estimateDocumentReadTimeMinutes("short note")).toBe(1)
    expect(estimateDocumentReadTimeMinutes(Array.from({ length: 226 }, () => "word").join(" "))).toBe(2)
  })
})
