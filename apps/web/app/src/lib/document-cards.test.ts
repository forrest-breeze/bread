// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { renderDocumentHtml } from "@/lib/render-document-html"
import { normalizeDocumentTabs } from "@/lib/document-tabs"
import { documentHtmlToMarkdown } from "@/lib/document-export"
import { sanitizeElementTree } from "@/lib/sanitize-dom"

const mdx = `<CardGroup cols={2}>
<Card title="Webhooks" href="/docs/webhooks">
Receive **signed** events. [More](https://example.com)
</Card>
<Card title="Customers" href="/docs/customers" />
</CardGroup>`

const parse = (html: string) => {
  const root = document.createElement("div")
  root.innerHTML = html
  return root
}

describe("document cards", () => {
  it("renders MDX and directive card groups with title links and Markdown bodies", () => {
    for (const input of [mdx, normalizeDocumentTabs(mdx)]) {
      const root = parse(renderDocumentHtml(input))
      const cards = root.querySelectorAll("[data-document-cards] > [data-document-card]")
      expect(cards).toHaveLength(2)
      expect(cards[0].getAttribute("data-card-href")).toBe("/docs/webhooks")
      expect(cards[0].querySelector("[data-card-title] > a")?.getAttribute("href")).toBe("/docs/webhooks")
      expect(cards[0].querySelector("[data-card-body] strong")?.textContent).toBe("signed")
      expect(cards[1].querySelector("[data-card-title]")?.textContent).toBe("Customers")
    }
  })

  it("renders cards without links and drops unsafe hrefs", () => {
    const root = parse(renderDocumentHtml('{% cards %}\n{% card title="Plain" %}\nText\n{% endcard %}\n{% card title="Bad" href="javascript:alert(1)" %}\nText\n{% endcard %}\n{% endcards %}'))
    expect(root.querySelectorAll("[data-document-card]")).toHaveLength(2)
    expect(root.querySelector("a")).toBeNull()
    expect(root.querySelector("[data-card-href]")).toBeNull()
  })

  it("escapes titles and leaves fenced or malformed groups readable", () => {
    const root = parse(renderDocumentHtml('{% cards %}\n{% card title="&quot; onclick=alert(1)" %}\nx\n{% endcard %}\n{% endcards %}'))
    expect(root.querySelector("[onclick]")).toBeNull()
    expect(renderDocumentHtml("```md\n" + mdx + "\n```")).not.toContain("data-document-cards=")
    expect(renderDocumentHtml(mdx.replace("</CardGroup>", ""))).not.toContain("data-document-cards=")
  })

  it("nests cards inside tabs and round-trips through Markdown export", () => {
    const source = `{% tabs %}\n{% tab title="Guides" %}\n${normalizeDocumentTabs(mdx)}\n{% endtab %}\n{% endtabs %}`
    const html = renderDocumentHtml(source)
    expect(parse(html).querySelector("[data-document-tab] [data-document-cards]")).not.toBeNull()
    const markdown = documentHtmlToMarkdown(html)
    expect(markdown).toContain('{% card title="Webhooks" href="/docs/webhooks" %}')
    expect(markdown).not.toMatch(/^Webhooks$/m)
    expect(renderDocumentHtml(markdown)).toBe(html)
  })

  it("sanitizer strips unsafe stored card hrefs", () => {
    const body = parse('<div data-document-cards=""><section data-document-card="X" data-card-href="javascript:alert(1)"><div data-card-body=""><p>x</p></div></section></div>')
    expect(sanitizeElementTree(body)).not.toContain("data-card-href")
  })
})

describe("card icons", () => {
  it("renders emoji icons, round-trips them, and ignores word icons", () => {
    const html = renderDocumentHtml('{% cards %}\n{% card title="Launch" href="/docs/a" icon="🚀" %}\nGo.\n{% endcard %}\n{% endcards %}')
    const root = parse(html)
    expect(root.querySelector("[data-card-glyph]")?.textContent).toBe("🚀")
    expect(root.querySelector("[data-document-card]")?.getAttribute("data-card-icon")).toBe("🚀")
    const markdown = documentHtmlToMarkdown(html)
    expect(markdown).toContain('{% card title="Launch" href="/docs/a" icon="🚀" %}')
    expect(markdown).not.toContain("\n🚀\n")
    expect(renderDocumentHtml(markdown)).toBe(html)
    expect(normalizeDocumentTabs('<Card title="A" icon="rocket">')).toBe('{% card title="A" %}')
    expect(renderDocumentHtml('{% cards %}\n{% card title="A" icon="<b>x</b>" %}\nx\n{% endcard %}\n{% endcards %}')).not.toContain("data-card-glyph")
  })
})
