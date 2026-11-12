// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import {
  buildClipboardHtml,
  buildDocxExport,
  buildHtmlExport,
  buildMarkdownExport,
  documentHtmlToMarkdown,
  makeSafeExportFilename,
} from "./document-export"

describe("document export helpers", () => {
  it("creates safe, stable filenames from document titles", () => {
    expect(makeSafeExportFilename("Q2 Plan / Risks & Mitigations", "md")).toBe(
      "q2-plan-risks-and-mitigations.md",
    )
    expect(makeSafeExportFilename("", ".html")).toBe("untitled.html")
  })

  it("converts common editor HTML to markdown", () => {
    const markdown = documentHtmlToMarkdown(`
      <h2 data-node-id="abc">Overview</h2>
      <p>Hello <strong>bold</strong> <em>world</em>.</p>
      <ul><li>First</li><li data-checked="true"><p>Done</p></li></ul>
      <p><a href="https://example.com/a b">docs</a></p>
      <div data-type="math-block" data-latex="E = mc^2"></div>
      <div data-type="mermaid-diagram" data-source="flowchart TD&#10;  A --&gt; B"><pre data-mermaid-fallback><code class="language-mermaid">flowchart TD
  A --&gt; B</code></pre></div>
    `)

    expect(markdown).toContain("## Overview")
    expect(markdown).toContain("Hello **bold** *world*.")
    expect(markdown).toContain("- First")
    expect(markdown).toContain("- [x] Done")
    expect(markdown).toContain("[docs](https://example.com/a%20b)")
    expect(markdown).toContain("$$\nE = mc^2\n$$")
    expect(markdown).toContain("```mermaid\nflowchart TD\n  A --> B\n```")
  })

  it("builds a full markdown document with title and page names", () => {
    const markdown = buildMarkdownExport({
      title: "Research Notes",
      pages: [
        { name: "Signals", html: "<p>Useful details.</p>" },
        { name: "Decisions", html: "<p>Ship the export.</p>" },
      ],
    })

    expect(markdown.startsWith("# Research Notes")).toBe(true)
    expect(markdown).toContain("## Signals")
    expect(markdown).toContain("Useful details.")
    expect(markdown).toContain("## Decisions")
    expect(markdown).toContain("Ship the export.")
  })

  it("sanitizes active content when building the standalone HTML export", () => {
    const html = buildHtmlExport({
      title: "Unsafe Doc",
      pages: [
        {
          name: "",
          html: '<p onclick="alert(1)">Hello <span data-type="math-inline" data-latex="x^2"></span></p><div data-type="math-block" data-latex="E = mc^2"></div><script>alert(2)</script><a href="javascript:alert(3)">bad</a>',
        },
      ],
    })

    expect(html).toContain("<title>Unsafe Doc</title>")
    expect(html).toContain("@page { margin: 0.7in; }")
    expect(html).toContain('<span class="math-inline">$x^2$</span>')
    expect(html).toContain('class="math-block"')
    expect(html).toContain("E = mc^2")
    expect(html).not.toContain("onclick")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("javascript:")
  })

  it("builds sanitized rich HTML for clipboard copy", () => {
    const html = buildClipboardHtml({
      title: "Copy Me",
      pages: [
        {
          name: "Page One",
          html: '<p onmouseover="alert(1)">Keep this <strong>rich</strong>.</p><a href="javascript:alert(2)">bad</a>',
        },
      ],
    })

    expect(html).toContain("<h1>Copy Me</h1>")
    expect(html).toContain("<h2>Page One</h2>")
    expect(html).toContain("<strong>rich</strong>")
    expect(html).not.toContain("onmouseover")
    expect(html).not.toContain("javascript:")
  })

  it("preserves Mermaid source in standalone HTML exports", () => {
    const html = buildHtmlExport({
      title: "Architecture",
      pages: [
        {
          name: "",
          html: '<div data-type="mermaid-diagram" data-source="sequenceDiagram&#10;  A-&gt;&gt;B: Ping"></div>',
        },
      ],
    })

    expect(html).toContain('class="mermaid-source"')
    expect(html).toContain('class="language-mermaid"')
    expect(html).toContain("sequenceDiagram")
    expect(html).toContain("A-&gt;&gt;B: Ping")
  })

  it("builds a real docx package with document content", async () => {
    const blob = await buildDocxExport({
      title: "Word Export",
      pages: [
        {
          name: "Page One",
          html: '<h2>Overview</h2><p>Hello <strong>docx</strong>.</p><ul><li>First</li></ul>',
        },
      ],
    })

    expect(blob.type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    expect(zip.file("[Content_Types].xml")).toBeTruthy()
    expect(zip.file("word/document.xml")).toBeTruthy()
    expect(zip.file("word/styles.xml")).toBeTruthy()

    const documentXml = await zip.file("word/document.xml")?.async("string")
    expect(documentXml).toContain("Word Export")
    expect(documentXml).toContain("Page One")
    expect(documentXml).toContain("Overview")
    expect(documentXml).toContain("docx")
    expect(documentXml).toContain("- ")
  })
})

it("preserves section tabs in Markdown exports", () => {
  const out = documentHtmlToMarkdown('<div data-document-tabs=""><section data-document-tab="Import"><h2>Import</h2><p>Keep <strong>formatting</strong>.</p></section><section data-document-tab="Export"><p>Save files.</p></section></div>')
  expect(out).toContain('{% tabs %}')
  expect(out).toContain('{% tab title="Import" %}')
  expect(out).toContain('**formatting**')
  expect(out).toContain('{% tab title="Export" %}')
  expect(out).toContain('{% endtabs %}')
})
