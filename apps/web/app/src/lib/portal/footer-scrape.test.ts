import { describe, expect, it } from "vitest"
import { scrapeFooterFromHtml } from "./footer-scrape"

const PAGE_URL = "https://acme.example.com/"

describe("scrapeFooterFromHtml", () => {
  it("extracts heading-grouped columns with absolute hrefs", () => {
    const html = `
      <body>
        <main>ignored <a href="/not-footer">nope</a></main>
        <footer>
          <h3>Resources</h3>
          <ul>
            <li><a href="/docs">Docs</a></li>
            <li><a href="https://acme.example.com/blog">Blog</a></li>
          </ul>
          <h3>Company</h3>
          <ul>
            <li><a href="/careers">Careers</a></li>
          </ul>
        </footer>
      </body>`
    const out = scrapeFooterFromHtml(html, PAGE_URL)
    expect(out.columns).toEqual([
      {
        heading: "Resources",
        links: [
          { label: "Docs", href: "https://acme.example.com/docs" },
          { label: "Blog", href: "https://acme.example.com/blog" },
        ],
      },
      { heading: "Company", links: [{ label: "Careers", href: "https://acme.example.com/careers" }] },
    ])
  })

  it("pulls social links out of the columns and dedupes by platform", () => {
    const html = `
      <footer>
        <h4>Follow</h4>
        <a href="https://twitter.com/acme">Twitter</a>
        <a href="https://x.com/acme">X</a>
        <a href="https://github.com/acme">GitHub</a>
        <a href="https://www.linkedin.com/company/acme">LinkedIn</a>
      </footer>`
    const out = scrapeFooterFromHtml(html, PAGE_URL)
    // Social links are not counted as column links.
    expect(out.columns).toEqual([])
    expect(out.social).toEqual([
      { platform: "x", href: "https://twitter.com/acme" },
      { platform: "github", href: "https://github.com/acme" },
      { platform: "linkedin", href: "https://www.linkedin.com/company/acme" },
    ])
  })

  it("drops non-http(s) hrefs and skips heading links", () => {
    const html = `
      <footer>
        <h3><a href="/home">Home</a></h3>
        <h3>Legal</h3>
        <a href="mailto:hi@acme.com">Email</a>
        <a href="/terms">Terms</a>
      </footer>`
    const out = scrapeFooterFromHtml(html, PAGE_URL)
    // The "Home" heading wraps a link → not treated as a column title.
    expect(out.columns).toEqual([
      { heading: "Legal", links: [{ label: "Terms", href: "https://acme.example.com/terms" }] },
    ])
  })

  it("returns empty result when there is no footer", () => {
    const out = scrapeFooterFromHtml("<body><main>hi</main></body>", PAGE_URL)
    expect(out).toEqual({ columns: [], social: [] })
  })

  it("keeps Breeze disclosures out of the copyright note and legal navigation", () => {
    const out = scrapeFooterFromHtml(`<footer>
      <h3>Legal</h3>
      <a href="/privacy">Privacy Policy</a>
      <a href="https://nmlsconsumeraccess.org/">NMLS ID 2669644</a>
      <p>© 2026 Breeze Labs. The Breeze "B" is a registered trademark.
        Breeze Labs Payments Inc. NMLS ID 2669644.</p>
    </footer>`, PAGE_URL)
    expect(out.note).toBe("© 2026 Breeze Labs")
    expect(out.columns).toEqual([{
      heading: "Legal",
      links: [{ label: "Privacy Policy", href: "https://acme.example.com/privacy" }],
    }])
  })

  it("extracts copyright beyond the first 400 characters without adjacent disclosures", () => {
    const out = scrapeFooterFromHtml(`<footer>
      <p>${"Navigation ".repeat(50)}</p>
      <p>© 2026 <span>Acme Inc.</span></p>
      <p>Other legal disclosures.</p>
    </footer>`, PAGE_URL)
    expect(out.note).toBe("© 2026 Acme Inc")
  })
})
