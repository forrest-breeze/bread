import type { CrawledPage } from "@/lib/import/website-crawl"

// ---------------------------------------------------------------------------
// Website import, without AI.
//
// The Breeze internal build sends no content to any model provider, so crawled
// pages are not rewritten by an LLM. Each readable page becomes one document,
// verbatim, under a single "Website" section. The sanitizers below still drop
// marketing claims and empty headings from the page text.
// ---------------------------------------------------------------------------

const MAX_DOCS = 12
const SUMMARY_CHARS = 200

export interface WebsiteSynthesisDocument {
  title: string
  category: string
  content: string
  summary: string
  sourceUrls: string[]
}

const UNSAFE_SECTION_RE = /^(?:deployment(?:\s*&.*)?|(?:typical\s+)?implementation timeline|(?:typical\s+)?deployment timeline|partner certification program|customer (?:case studies|stories|results)|proven results|key metrics|trusted partners|example scenario)$/i
const UNSAFE_MARKETING_LINE_RE = /(?:\b\d+(?:\.\d+)?%|\b\d+x\b|\buptime\b|\bzero unplanned\b|\b(?:\d+\s*(?:-|–|to)\s*)?\d*\s*(?:weeks?|months?)\b|\bwithin a quarter\b|customer testimonials?|central bank rates?|\bAllianz\b|\bHelvetia\b|\bAmtrust\b)/i

function normalizedHeading(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

export function sanitizeSynthesizedContent(title: string, content: string): string {
  const output: string[] = []
  let skipSection = false
  const normalizedTitle = normalizedHeading(title)

  for (const line of content.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const headingText = heading[2]!.replace(/[*_`]/g, "").trim()
      skipSection = UNSAFE_SECTION_RE.test(headingText)
      if (skipSection) continue
      if (output.length === 0 && normalizedHeading(headingText) === normalizedTitle) {
        continue
      }
    }
    if (skipSection) continue
    if (/^\s*_?sources?\s*:/i.test(line)) continue
    if (UNSAFE_MARKETING_LINE_RE.test(line)) continue
    output.push(line)
  }

  const filtered = output.join("\n").replace(/\n{3,}/g, "\n\n").trim().split("\n")
  const withoutEmptyHeadings = filtered.filter((line, index, lines) => {
    if (!/^#{1,6}\s+/.test(line)) return true
    let next = index + 1
    while (next < lines.length && lines[next]!.trim() === "") next += 1
    return next < lines.length && !/^#{1,6}\s+/.test(lines[next]!)
  })

  return withoutEmptyHeadings.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

export function isUnsafeSynthesizedTitle(title: string): boolean {
  return UNSAFE_SECTION_RE.test(title.trim())
}

export function sanitizeSynthesizedTitle(value: string): string {
  return value
    .trim()
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function crawledPagesToDocuments(input: {
  pages: CrawledPage[]
}): WebsiteSynthesisDocument[] {
  const docs: WebsiteSynthesisDocument[] = []
  const seenTitles = new Set<string>()
  for (const page of input.pages) {
    if (docs.length >= MAX_DOCS) break
    let title = sanitizeSynthesizedTitle(page.title)
    if (!title) {
      try {
        title = new URL(page.url).pathname.replace(/^\/|\/$/g, "") || "Home"
      } catch {
        continue
      }
    }
    if (isUnsafeSynthesizedTitle(title) || seenTitles.has(title.toLowerCase())) continue
    const content = sanitizeSynthesizedContent(title, page.text)
    if (!content) continue
    seenTitles.add(title.toLowerCase())
    const flat = content.replace(/^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim()
    docs.push({
      title,
      category: "Website",
      content,
      summary: flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat,
      sourceUrls: [page.url],
    })
  }
  return docs
}
