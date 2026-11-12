// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { renderDocumentHtml } from "@/lib/render-document-html"

// Exactly what the editor saved when the directive Markdown was pasted in.
const flattened = '<h2>Explore the Docs</h2><p>{% cards %} {% card title="Webhooks" href="/p/x/doc/webhooks_overview" %} Receive <strong>signed</strong> events. {% endcard %} {% card title="Customers" href="/p/x/doc/c" %} Create profiles. {% endcard %} {% endcards %}</p><p>After.</p>'

const parse = (html: string) => {
  const root = document.createElement("div")
  root.innerHTML = html
  return root
}

describe("repairing flattened directives", () => {
  it("rebuilds a card group saved as a single paragraph", () => {
    const root = parse(renderDocumentHtml(flattened))
    const cards = root.querySelectorAll("[data-document-cards] > [data-document-card]")
    expect(cards).toHaveLength(2)
    expect(cards[0].getAttribute("data-card-href")).toBe("/p/x/doc/webhooks_overview")
    expect(cards[0].querySelector("[data-card-body] strong")?.textContent).toBe("signed")
    expect(root.querySelector("h2")?.textContent).toBe("Explore the Docs")
    expect(root.lastElementChild?.textContent).toBe("After.")
    expect(root.textContent).not.toContain("{%")
  })

  it("rebuilds groups spread over several paragraphs, including tabs", () => {
    const html = '<p>{% tabs %}</p><p>{% tab title="One" %}</p><p>First</p><p>{% endtab %}</p><p>{% tab title="Two" %} Second {% endtab %}</p><p>{% endtabs %}</p>'
    const root = parse(renderDocumentHtml(html))
    expect(root.querySelectorAll("[data-document-tab]")).toHaveLength(2)
  })

  it("leaves code examples and unbalanced text alone", () => {
    expect(renderDocumentHtml("<pre><code>{% cards %}\n{% endcards %}</code></pre>")).toContain("{% cards %}")
    expect(renderDocumentHtml("<p>{% cards %} {% card title=\"A\" %} x {% endcard %}</p>")).not.toContain("data-document-cards")
  })
})
