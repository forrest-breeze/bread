import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { renderApiReferenceHtml } from "./api-reference-html"

describe("API reference Markdown layout", () => {
  it("renders formatted documentation and moves complete example sections into the panel", () => {
    const result = renderApiReferenceHtml([
      "Returns **unsettled** funds.",
      "## Query parameters",
      "- `accountType`: the account to read",
      "## Request example",
      "### Shell",
      '```bash\ncurl https://example.com/balance\n```',
      "## Responses",
      "| Status | Meaning |\n| --- | --- |\n| 200 | Success |",
      "## Response example",
      '```json\n{"balance": 100}\n```',
    ].join("\n\n"))

    expect(result.html).toContain("<strong>unsettled</strong>")
    expect(result.html).toContain("<ul>")
    expect(result.html).toContain("<code>accountType</code>")
    expect(result.html).toContain("<table>")
    expect(result.html).not.toContain("Request example")
    expect(result.examplesHtml).toContain("Request example")
    // The shell-only heading gives way to the language picker.
    expect(result.examplesHtml).not.toContain("<h3>Shell</h3>")
    expect(result.examplesHtml).toContain("data-code-group")
    expect(result.examplesHtml).toContain("Response example")
    expect(result.examplesHtml).toContain("<pre")
    expect(result.examplesHtml).not.toContain("<table>")
  })

  it("keeps ordinary guides and nested example headings in their original layout", () => {
    for (const content of ["## Authentication\n\nUse a token.", "## Guide\n\n### Request example\n\nExample", "## Request example\n\nOnly an example"]) {
      expect(renderApiReferenceHtml(content).examplesHtml).toBe("")
    }
  })

  it("sanitizes editor HTML before organizing either column", () => {
    const result = renderApiReferenceHtml('<p>Description</p><h2>Request example</h2><p onclick="alert(1)">Example</p><script>alert(1)</script><h2>Responses</h2><p>Success</p>')
    expect(result.html).toContain("Responses")
    expect(result.examplesHtml).toContain("Example")
    expect(result.examplesHtml).not.toMatch(/onclick|<script/)
  })

  it("groups a cURL request with generated Node, Ruby, PHP and Python samples", () => {
    const result = renderApiReferenceHtml([
      "Reads the balance.",
      "## Request example",
      "```bash\ncurl --request GET \\\n  --url 'https://api.example.com/v1/balance' \\\n  --user \"${API_KEY}:\"\n```",
      "## Response example",
      '```json\n{"ok": true}\n```',
    ].join("\n\n"))

    const group = /<div data-code-group="">([\s\S]*?)<\/div>/.exec(result.examplesHtml)?.[1] ?? ""
    const languages = [...group.matchAll(/data-language="([^"]+)"/g)].map((match) => match[1])
    expect(languages).toEqual(["cURL", "Node", "Ruby", "PHP", "Python"])
    // Responses keep a single tagged block; nothing to switch between.
    expect(result.examplesHtml).toContain('data-language="JSON"')
    expect(result.examplesHtml.match(/data-code-group/g)).toHaveLength(1)
  })

  it("groups authored runs of adjacent blocks in different languages without generating", () => {
    const result = renderApiReferenceHtml([
      "Docs.",
      "## Request example",
      "```python\nprint(1)\n```",
      "```ruby\nputs 1\n```",
    ].join("\n\n"))
    const languages = [...result.examplesHtml.matchAll(/data-language="([^"]+)"/g)].map((match) => match[1])
    expect(languages).toEqual(["Python", "Ruby"])
    expect(result.examplesHtml).toContain("data-code-group")
  })

  it("leaves unparseable cURL commands as a single tagged block", () => {
    const result = renderApiReferenceHtml("Docs.\n\n## Request example\n\n```bash\ncurl --form a=b https://x.test\n```")
    expect(result.examplesHtml).toContain('data-language="cURL"')
    expect(result.examplesHtml).not.toContain("data-code-group")
  })
})
