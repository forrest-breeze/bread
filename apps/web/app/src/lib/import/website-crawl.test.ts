import { describe, expect, it } from "vitest"
import {
  extractBrandLogo,
  extractBrandAccentColor,
  extractReadable,
  parseRobotsDisallow,
} from "@/lib/import/website-crawl"

describe("parseRobotsDisallow", () => {
  it("collects Disallow rules under the wildcard agent", () => {
    const robots = [
      "User-agent: *",
      "Disallow: /admin",
      "Disallow: /private",
      "Allow: /",
    ].join("\n")
    expect(parseRobotsDisallow(robots)).toEqual(["/admin", "/private"])
  })

  it("ignores rules scoped to other user-agents", () => {
    const robots = [
      "User-agent: Googlebot",
      "Disallow: /nogoogle",
      "",
      "User-agent: *",
      "Disallow: /shared",
    ].join("\n")
    expect(parseRobotsDisallow(robots)).toEqual(["/shared"])
  })

  it("represents a full-site block as a single slash", () => {
    expect(parseRobotsDisallow("User-agent: *\nDisallow: /")).toEqual(["/"])
  })

  it("strips comments and blank lines", () => {
    const robots = "# comment\nUser-agent: *\nDisallow: /x # inline"
    expect(parseRobotsDisallow(robots)).toEqual(["/x"])
  })
})

describe("extractReadable", () => {
  it("strips chrome and returns title + body text", () => {
    const html = `
      <html><head><title>Fallback Title</title></head>
      <body>
        <nav>Home About Pricing</nav>
        <header>logo</header>
        <main>
          <h1>Getting Started</h1>
          <p>Connect the MCP server and authorize access.</p>
          <script>console.log('noise')</script>
        </main>
        <footer>© 2026</footer>
      </body></html>`
    const { title, text } = extractReadable(html)
    expect(title).toBe("Getting Started")
    expect(text).toContain("Connect the MCP server")
    expect(text).not.toContain("noise")
    expect(text).not.toContain("Pricing")
    expect(text).not.toContain("2026")
  })

  it("falls back to <title> when there is no h1", () => {
    const html = "<html><head><title>Docs Home</title></head><body><p>Body copy here.</p></body></html>"
    const { title } = extractReadable(html)
    expect(title).toBe("Docs Home")
  })
})

describe("extractBrandLogo", () => {
  it("prefers a first-party touch icon and resolves relative URLs", () => {
    const html = `
      <link rel="icon" href="/favicon.ico">
      <link rel="apple-touch-icon" href="/assets/touch.png">
      <header><img src="/assets/wide-logo.svg"></header>`
    expect(extractBrandLogo(html, "https://acme.example/product")).toBe(
      "https://acme.example/assets/touch.png",
    )
  })

  it("accepts a CDN-hosted icon declared by the site", () => {
    expect(
      extractBrandLogo(
        '<link rel="icon" href="https://cdn.example/icon.png">',
        "https://acme.example",
      ),
    ).toBe("https://cdn.example/icon.png")
  })

  it("rejects insecure logo URLs", () => {
    expect(
      extractBrandLogo('<link rel="icon" href="http://acme.example/icon.png">', "https://acme.example"),
    ).toBeNull()
  })
})

describe("extractBrandAccentColor", () => {
  it("selects a repeated saturated brand color over neutral page colors", () => {
    const html = `
      <style>
        body { color: #222222; background: #ffffff; }
        .button, .link, .badge { color: #ff6918; border-color: #ff6918; }
      </style>`
    expect(extractBrandAccentColor(html)).toBe("#ff6918")
  })

  it("returns null for grayscale-only pages", () => {
    expect(extractBrandAccentColor("<style>body{color:#111;background:#fff}</style>")).toBeNull()
  })
})
