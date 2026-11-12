// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { renderDocumentHtml } from "@/lib/render-document-html"
import { enhanceDocumentTabs } from "@/lib/enhance-document-tabs"
import { normalizeDocumentTabs } from "@/lib/document-tabs"

const source = `<Tabs>
<Tab title="Webhooks">
Receive **events**. [Guide](https://example.com)
</Tab>
<Tab title="Customers">
Manage customers.
</Tab>
</Tabs>`

describe("document tabs", () => {
  it("renders Markdown inside MDX and GitBook tab groups", () => {
    for (const input of [source, normalizeDocumentTabs(source)]) {
      const html = renderDocumentHtml(input)
      expect(html).toContain('data-document-tab="Webhooks"')
      expect(html).toContain("<strong>events</strong>")
      expect(html).toContain('href="https://example.com"')
    }
  })

  it("switches independent groups with clicks and keyboard, and cleans up", () => {
    const root = document.createElement("div")
    document.body.append(root)
    root.innerHTML = renderDocumentHtml(`${source}\n\n${source}`)
    const cleanup = enhanceDocumentTabs(root)
    const buttons = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    const panels = root.querySelectorAll<HTMLElement>('[role="tabpanel"]')
    expect(panels[1].hidden).toBe(true)
    buttons[1].click()
    expect(panels[0].hidden).toBe(true)
    expect(panels[1].hidden).toBe(false)
    expect(panels[2].hidden).toBe(false)
    buttons[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(document.activeElement).toBe(buttons[0])
    expect(buttons[0].getAttribute("aria-selected")).toBe("true")
    expect(new Set(Array.from(buttons, (button) => button.id)).size).toBe(4)
    cleanup()
    expect(root.querySelector('[role="tablist"]')).toBeNull()
    expect(Array.from(panels).every((panel) => !panel.hidden)).toBe(true)
    root.remove()
  })

  it("leaves fenced examples and malformed groups readable", () => {
    expect(renderDocumentHtml('```md\n' + source + '\n```')).not.toContain('data-document-tabs=')
    expect(renderDocumentHtml(source.replace('</Tabs>', ''))).not.toContain('data-document-tabs=')
  })

  it("supports nested groups", () => {
    const html = renderDocumentHtml(source.replace('Manage customers.', source))
    expect(html.match(/data-document-tabs=/g)).toHaveLength(2)
  })

  it("escapes labels and does not execute Markdown links", () => {
    const html = renderDocumentHtml('{% tabs %}\n{% tab title="&quot; onclick=alert(1)" %}\n[bad](javascript:alert(1))\n{% endtab %}\n{% endtabs %}')
    const root = document.createElement('div')
    root.innerHTML = html
    expect(root.querySelector('[onclick]')).toBeNull()
    expect(root.querySelector('a')).toBeNull()
  })
})
