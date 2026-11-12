import { describe, expect, it } from "vitest"
import { JSDOM } from "jsdom"
import { renderPublicHtml } from "@/lib/public-kb-render"

// renderPublicHtml is the ONLY sanitizer between stored document HTML and the
// public, unauthenticated internet. These tests pin its denylist (shared with
// the client path via sanitize-dom.ts) against known XSS vectors.

describe("renderPublicHtml — XSS hardening", () => {
  it("preserves Mermaid fence metadata for client diagram rendering", () => {
    const out = renderPublicHtml('```mermaid\nflowchart TD\nA-->B\n```')
    const document = new JSDOM(out).window.document
    expect(document.querySelector("pre code.language-mermaid")?.textContent).toContain("flowchart TD")
    expect(document.querySelector("pre.shiki")).toBeNull()
  })

  it("removes <script> tags", () => {
    const out = renderPublicHtml('<p>ok</p><script>alert(1)</script>')
    expect(out).not.toContain("<script")
    expect(out).toContain("ok")
  })

  it("strips javascript: from href", () => {
    const out = renderPublicHtml('<a href="javascript:alert(1)">x</a>')
    expect(out.toLowerCase()).not.toContain("javascript:")
  })

  it("strips case-obfuscated JavaScript: from href", () => {
    const out = renderPublicHtml('<a href="JaVaScRiPt:alert(1)">x</a>')
    expect(out.toLowerCase()).not.toContain("javascript:")
  })

  it("strips data: URLs from href", () => {
    const out = renderPublicHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')
    expect(out).not.toContain("data:text/html")
  })

  it("strips namespaced xlink:href javascript: vectors", () => {
    const out = renderPublicHtml('<a xlink:href="javascript:alert(1)">x</a>')
    expect(out.toLowerCase()).not.toContain("javascript:")
  })

  it("removes raw <svg> entirely (carries namespaced/script vectors)", () => {
    const out = renderPublicHtml('<svg><use xlink:href="javascript:alert(1)"></use></svg><p>after</p>')
    expect(out.toLowerCase()).not.toContain("<svg")
    expect(out.toLowerCase()).not.toContain("javascript:")
    expect(out).toContain("after")
  })

  it("strips formaction javascript: on buttons", () => {
    const out = renderPublicHtml('<button formaction="javascript:alert(1)">x</button>')
    expect(out.toLowerCase()).not.toContain("javascript:")
    expect(out.toLowerCase()).not.toContain("formaction")
  })

  it("strips on* event handlers", () => {
    const out = renderPublicHtml('<img src="https://example.com/a.png" onerror="alert(1)" />')
    expect(out.toLowerCase()).not.toContain("onerror")
    expect(out.toLowerCase()).not.toContain("alert(1)")
  })

  it("strips srcdoc", () => {
    const out = renderPublicHtml('<div srcdoc="<script>alert(1)</script>">x</div>')
    expect(out.toLowerCase()).not.toContain("srcdoc")
  })

  it("removes iframe / object / embed / form / template / math / noscript", () => {
    const out = renderPublicHtml(
      '<iframe src="https://evil"></iframe><object></object><embed><form></form><template></template><math></math><noscript></noscript><p>safe</p>',
    )
    for (const tag of ["<iframe", "<object", "<embed", "<form", "<template", "<math", "<noscript"]) {
      expect(out.toLowerCase()).not.toContain(tag)
    }
    expect(out).toContain("safe")
  })

  it("preserves safe content, links, and math data attributes", () => {
    const out = renderPublicHtml(
      '<h1 data-node-id="abc">Title</h1><p>Body</p><a href="https://example.com">link</a><a href="/rel">rel</a><span data-type="math-inline" data-latex="x^2">x</span><code>const a = 1</code>',
    )
    expect(out).toContain("Title")
    expect(out).toContain("https://example.com")
    expect(out).toContain('href="/rel"')
    expect(out).toContain('data-node-id="abc"')
    expect(out).toContain('data-latex="x^2"')
    expect(out).toContain("<code>")
  })

  it("renders plain text / markdown input", () => {
    const out = renderPublicHtml("# Heading\n\nsome **bold** text")
    expect(out).toContain("<h1")
    expect(out).toContain("Heading")
    expect(out).toContain("<strong>")
  })

  it("treats ordinary editor HTML tags as HTML", () => {
    const out = renderPublicHtml("<mark>Highlighted</mark>")

    expect(out).toContain("<mark>Highlighted</mark>")
    expect(out).not.toContain("&lt;mark&gt;")
  })

  it("does not mistake placeholder angle tokens in Markdown for HTML", () => {
    const out = renderPublicHtml(
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

  it("returns a placeholder for empty input", () => {
    expect(renderPublicHtml("")).toBe("<p>No content.</p>")
    expect(renderPublicHtml("   ")).toBe("<p>No content.</p>")
  })

  it("syntax-highlights fenced code blocks (Shiki) and survives sanitize", () => {
    const out = renderPublicHtml("```javascript\nconst x = 1\n```")
    expect(out).toContain('class="shiki')
    expect(out).toContain("--shiki-light")
    expect(out).toContain("<span")
  })

  it("tags each code block with its language, and cURL commands as cURL", () => {
    const languageOf = (markdown: string) =>
      JSDOM.fragment(renderPublicHtml(markdown)).querySelector("pre")?.getAttribute("data-language")
    expect(languageOf("```bash\ncurl https://x.test\n```")).toBe("cURL")
    expect(languageOf("```sh\nnpm install\n```")).toBe("Shell")
    expect(languageOf("```py\nprint(1)\n```")).toBe("Python")
    expect(languageOf("```json\n{}\n```")).toBe("JSON")
    expect(languageOf('<pre><code class="hljs language-ts">let a = 1</code></pre>')).toBe("TypeScript")
    expect(languageOf("```\nplain\n```")).toBeNull()
  })

  it("removes trailing blank code rows while preserving interior spacing", () => {
    const out = renderPublicHtml(
      '<pre><code class="language-bash">first\n\nsecond\n\n\n</code></pre>',
    )
    const lines = Array.from(
      JSDOM.fragment(out).querySelectorAll<HTMLElement>(".line"),
    ).map((line) => line.textContent)

    expect(lines).toEqual(["first", "", "second"])
  })

  it("highlights stored <pre><code> blocks and keeps script-shaped code inert", () => {
    // Production code blocks arrive as HTML (Tiptap). The highlighter runs on the
    // parsed tree; the code text is rendered as escaped text, never a live tag.
    const out = renderPublicHtml(
      '<pre><code class="language-javascript">alert(1)</code></pre>',
    )
    expect(out).toContain('class="shiki')
    expect(out).not.toContain("<script")
  })

  it("rewrites S3 media srcs to the public endpoint, keeps the <img>, strips onerror", () => {
    const out = renderPublicHtml('<p><img src="/api/media/x1" alt="d"></p>')
    // src is rewritten to the anonymous, portal-scope-gated public endpoint.
    expect(out).toContain("/api/public/media/x1")
    expect(out).not.toContain('src="/api/media/x1"')
    // The <img> itself survives sanitize (relative src is allowed).
    const img = JSDOM.fragment(out).querySelector("img")
    expect(img).not.toBeNull()
    expect(img?.getAttribute("src")).toBe("/api/public/media/x1")
    expect(img?.getAttribute("alt")).toBe("d")
  })

  it("strips onerror from a rewritten media <img> (no on* survives)", () => {
    const out = renderPublicHtml(
      '<img src="/api/media/x2" alt="d" onerror="alert(1)">',
    )
    expect(out).toContain("/api/public/media/x2")
    expect(out.toLowerCase()).not.toContain("onerror")
    expect(out.toLowerCase()).not.toContain("alert(1)")
  })

  it("rewrites and preserves playable S3-backed videos", () => {
    const out = renderPublicHtml(
      '<video src="/api/media/v1" title="Demo" controls playsinline preload="metadata" onerror="alert(1)"></video>',
    )
    const video = JSDOM.fragment(out).querySelector("video")
    expect(video?.getAttribute("src")).toBe("/api/public/media/v1")
    expect(video?.hasAttribute("controls")).toBe(true)
    expect(video?.hasAttribute("playsinline")).toBe(true)
    expect(video?.getAttribute("preload")).toBe("metadata")
    expect(out.toLowerCase()).not.toContain("onerror")
  })

  it("drops style attributes carrying CSS-injection tokens", () => {
    const out = renderPublicHtml(
      '<p style="color:red">ok</p><div style="background:url(javascript:alert(1))">x</div>',
    )
    expect(out).toContain('style="color:red"')
    expect(out.toLowerCase()).not.toContain("javascript:")
    expect(out.toLowerCase()).not.toContain("url(")
  })
})

describe("public document tabs", () => {
  it("renders tab panels with rich content through the public sanitizer", () => {
    const html = renderPublicHtml('<Tabs>\n<Tab title="Webhooks">\n**Events**\n</Tab>\n<Tab title="Customers">\n[Guide](https://example.com)\n</Tab>\n</Tabs>')
    const doc = new JSDOM(html).window.document
    expect(doc.querySelectorAll('[data-document-tab]')).toHaveLength(2)
    expect(doc.querySelector('strong')?.textContent).toBe('Events')
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
  })
})

describe("public document cards", () => {
  it("rebuilds cards that the editor saved as a flattened paragraph", () => {
    const html = renderPublicHtml('<h2>Explore</h2><p>{% cards %} {% card title="Webhooks" href="/p/x/doc/webhooks_overview" %} Receive events. {% endcard %} {% endcards %}</p>')
    const doc = new JSDOM(html).window.document
    expect(doc.querySelectorAll('[data-document-card]')).toHaveLength(1)
    expect(doc.querySelector('[data-card-title] a')?.getAttribute('href')).toBe('/p/x/doc/webhooks_overview')
    expect(doc.body.textContent).not.toContain('{%')
  })
})
