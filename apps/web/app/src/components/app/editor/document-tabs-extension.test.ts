// @vitest-environment happy-dom
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { describe, it, expect } from "vitest"
import { DocumentTabs, DocumentTab } from "./document-tabs-extension"

describe("editable document tabs", () => {
  it("preserves tab labels and rich content through editing and reloading", () => {
    const make = (content: string) => new Editor({
      extensions: [StarterKit, DocumentTabs, DocumentTab], content,
    })
    const editor = make('<div data-document-tabs=""><section data-document-tab="Obsidian"><h2>Obsidian</h2><p>Import a <strong>vault</strong>.</p></section><section data-document-tab="Notion"><p>Import pages.</p></section></div>')
    editor.commands.insertContentAt(1, '<p>Choose a source.</p>')
    const html = editor.getHTML()
    expect(html).toContain('data-document-tab="Obsidian"')
    expect(html).toContain('data-document-tab="Notion"')
    expect(html).toContain('<strong>vault</strong>')
    const reloaded = make(html)
    expect(reloaded.getHTML()).toBe(html)
    editor.destroy()
    reloaded.destroy()
  })
})

describe("editable document cards", async () => {
  const { DocumentCards, DocumentCard } = await import("./document-tabs-extension")
  const { renderDocumentHtml } = await import("@/lib/render-document-html")
  it("keeps card titles and links as attributes, not editable content", () => {
    const make = (content: string) => new Editor({
      extensions: [StarterKit, DocumentCards, DocumentCard], content,
    })
    const editor = make(renderDocumentHtml('{% cards %}\n{% card title="Webhooks" href="/docs/webhooks" %}\nReceive **events**.\n{% endcard %}\n{% endcards %}'))
    const html = editor.getHTML()
    expect(html).toContain('data-document-card="Webhooks"')
    expect(html).toContain('data-card-href="/docs/webhooks"')
    expect(html.match(/>Webhooks</g)).toHaveLength(1)
    expect(html).toContain("<strong>events</strong>")
    const reloaded = make(html)
    expect(reloaded.getHTML()).toBe(html)
    editor.destroy()
    reloaded.destroy()
  })
})

describe("inserting card and tab groups", async () => {
  const ext = await import("./document-tabs-extension")
  it("accepts the slash-menu JSON and keeps icons", () => {
    const editor = new Editor({ extensions: [StarterKit, ext.DocumentCards, ext.DocumentCard, ext.DocumentTabs, ext.DocumentTab], content: "<p></p>" })
    editor.commands.insertContent({
      type: "documentCards",
      content: [{ type: "documentCard", attrs: { title: "One", icon: "🚀", href: "/a" }, content: [{ type: "paragraph" }] }],
    })
    editor.commands.insertContent({
      type: "documentTabs",
      content: [{ type: "documentTab", attrs: { title: "Tab one" }, content: [{ type: "paragraph" }] }],
    })
    const html = editor.getHTML()
    expect(html).toContain('data-card-icon="🚀"')
    expect(html).toContain('<span data-card-glyph="" aria-hidden="true" contenteditable="false">🚀</span>')
    expect(html).toContain('data-document-tab="Tab one"')
    editor.destroy()
  })
})
