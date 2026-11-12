import { JSDOM } from "jsdom"
import type { FooterColumn, FooterSocial, FooterSocialPlatform } from "@/lib/portal/schema"

// ---------------------------------------------------------------------------
// Footer scraper — turn a customer's marketing-site footer into a portal
// FooterBlock's columns + social links, so the builder's "Import from website"
// flow can seed a branded footer instead of hand-entering every link.
//
// Heuristic, not a parser for one specific site: walk the <footer> in document
// order, treat heading-ish elements as column starts, and bucket the anchors
// that follow under the current heading. Social-profile links (matched by host)
// are pulled out into their own row. Everything is best-effort; a site whose
// footer doesn't fit the pattern just yields fewer columns.
// ---------------------------------------------------------------------------

const MAX_COLUMNS = 5
const MAX_LINKS_PER_COLUMN = 12
const MAX_SOCIAL = 8
const MAX_LABEL = 60
const MAX_HEADING = 60

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "DT", "STRONG", "B"])

// host substring → platform. First match wins; checked against the link's host.
const SOCIAL_HOSTS: ReadonlyArray<[string, FooterSocialPlatform]> = [
  ["twitter.com", "x"],
  ["x.com", "x"],
  ["linkedin.com", "linkedin"],
  ["github.com", "github"],
  ["youtube.com", "youtube"],
  ["youtu.be", "youtube"],
  ["instagram.com", "instagram"],
]

export interface ScrapedFooter {
  columns: FooterColumn[]
  social: FooterSocial[]
  note?: string
}

function clean(text: string | null | undefined, max: number): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max)
}

function absoluteHttpUrl(rawHref: string, pageUrl: string): string | null {
  try {
    const url = new URL(rawHref, pageUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.toString()
  } catch {
    return null
  }
}

function socialPlatformFor(href: string): FooterSocialPlatform | null {
  let host: string
  try {
    host = new URL(href).host.toLowerCase()
  } catch {
    return null
  }
  for (const [needle, platform] of SOCIAL_HOSTS) {
    if (host === needle || host.endsWith(`.${needle}`) || host.includes(needle)) {
      return platform
    }
  }
  return null
}

function pickFooterElement(doc: Document): Element | null {
  const candidates = [
    ...Array.from(doc.querySelectorAll("footer")),
    ...Array.from(doc.querySelectorAll("[role='contentinfo']")),
  ]
  if (candidates.length === 0) return null
  // Prefer the footer with the most links — marketing sites sometimes have a
  // tiny secondary <footer>; the link-dense one is the real sitemap footer.
  return candidates.reduce((best, el) =>
    el.querySelectorAll("a").length > best.querySelectorAll("a").length ? el : best,
  )
}

/**
 * Parse a page's HTML and extract a portal footer (columns + social) from its
 * `<footer>`. `pageUrl` is the URL the HTML was fetched from — used to resolve
 * relative hrefs to absolute http(s) URLs (so they pass the portal href gate).
 */
export function scrapeFooterFromHtml(html: string, pageUrl: string): ScrapedFooter {
  const dom = new JSDOM(html)
  const doc = dom.window.document
  const footer = pickFooterElement(doc)
  if (!footer) return { columns: [], social: [] }

  const social: FooterSocial[] = []
  const seenSocial = new Set<FooterSocialPlatform>()
  const columns: Array<{ heading: string; links: FooterColumn["links"] }> = []
  let current: { heading: string; links: FooterColumn["links"] } | null = null
  const seenInColumn = new Set<string>()

  // Walk elements in document order. Headings open a new column; anchors land in
  // the open column (deduped) unless they're social links.
  const walker = doc.createTreeWalker(footer, dom.window.NodeFilter.SHOW_ELEMENT)
  let node = walker.currentNode === footer ? walker.nextNode() : walker.currentNode
  while (node) {
    const el = node as Element
    const tag = el.tagName

    if (HEADING_TAGS.has(tag)) {
      const heading = clean(el.textContent, MAX_HEADING)
      // Skip a heading that itself wraps a link (it's a nav item, not a column
      // title) or is empty.
      if (heading && !el.querySelector("a")) {
        current = { heading, links: [] }
        columns.push(current)
        seenInColumn.clear()
      }
    } else if (tag === "A") {
      const anchor = el as HTMLAnchorElement
      const rawHref = anchor.getAttribute("href")
      const href = rawHref ? absoluteHttpUrl(rawHref, pageUrl) : null
      if (href) {
        const platform = socialPlatformFor(href)
        if (platform) {
          if (!seenSocial.has(platform) && social.length < MAX_SOCIAL) {
            seenSocial.add(platform)
            social.push({ platform, href })
          }
        } else {
          const label = clean(anchor.textContent, MAX_LABEL)
          // License disclosures are body copy, not footer navigation.
          if (label && !/\bNMLS\s*(?:ID|#|\d)/i.test(label) && current && current.links.length < MAX_LINKS_PER_COLUMN) {
            const key = `${label}|${href}`
            if (!seenInColumn.has(key)) {
              seenInColumn.add(key)
              current.links.push({ label, href })
            }
          }
        }
      }
    }
    node = walker.nextNode()
  }

  // Use the smallest copyright container so adjacent navigation and legal
  // disclosures aren't flattened into the note. Keep inline company names.
  const copyrightPattern = /©|\(c\)/i
  const copyrightElement = [footer, ...Array.from(footer.querySelectorAll("*"))]
    .find((el) => copyrightPattern.test(el.textContent ?? "") &&
      !Array.from(el.children).some((child) => copyrightPattern.test(child.textContent ?? "")))
  const copyrightText = clean(copyrightElement?.textContent, 1000)
  const noteMatch = copyrightText.match(/(?:©|\(c\)).*/i)
  const note = noteMatch
    ? clean(noteMatch[0]
        .split(/\bThe\s+[^.]*registered trademark\b|\b[^.]*\bNMLS\s*(?:ID|#)/i)[0]
        .replace(/[\s.|]+$/, ""), 200)
    : undefined

  const usableColumns: FooterColumn[] = columns
    .filter((col) => col.links.length > 0)
    .slice(0, MAX_COLUMNS)
    .map((col) => ({ heading: col.heading, links: col.links }))

  return { columns: usableColumns, social, ...(note ? { note } : {}) }
}
