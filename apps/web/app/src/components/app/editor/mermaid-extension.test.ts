// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { MermaidDiagram } from "./mermaid-extension"

const editors: Editor[] = []

function createEditor(content: string | Record<string, unknown>): Editor {
  const editor = new Editor({
    extensions: [StarterKit, MermaidDiagram],
    content,
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

describe("MermaidDiagram Tiptap node", () => {
  it.each(["mermaid", "plaintext", ""])("imports a %s sequence code block as a diagram", (language) => {
    const editor = createEditor(`<pre><code class="language-${language}">sequenceDiagram\nA-&gt;&gt;B: Ping</code></pre>`)
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "mermaidDiagram",
      attrs: { source: "sequenceDiagram\nA->>B: Ping" },
    })
  })

  it("keeps ordinary code blocks as code", () => {
    expect(createEditor('<pre><code class="language-js">const x = 1</code></pre>').getJSON().content?.[0].type).toBe("codeBlock")
  })

  it("round-trips Mermaid source through persisted editor HTML", () => {
    const source = 'flowchart TD\n  A["Quoted & safe"] --> B[Finish]'
    const html = createEditor({
      type: "doc",
      content: [{ type: "mermaidDiagram", attrs: { source } }],
    }).getHTML()

    expect(html).toContain('data-type="mermaid-diagram"')
    expect(html).toContain("language-mermaid")

    const restored = createEditor(html)
    expect(restored.getJSON()).toMatchObject({
      content: [{ type: "mermaidDiagram", attrs: { source } }],
    })
  })
})
