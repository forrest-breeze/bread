const BLOCK_TAG_RE = /<\/?(?:address|article|aside|blockquote|br|div|dl|dt|dd|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, token: string) => {
      if (token[0] === "#") {
        const radix = token[1]?.toLowerCase() === "x" ? 16 : 10
        const raw = radix === 16 ? token.slice(2) : token.slice(1)
        const codePoint = Number.parseInt(raw, radix)
        if (Number.isFinite(codePoint)) {
          try {
            return String.fromCodePoint(codePoint)
          } catch {
            return entity
          }
        }
      }

      return HTML_ENTITIES[token.toLowerCase()] ?? entity
    },
  )
}

/**
 * Turns persisted editor HTML (or imported Markdown) into a short, readable
 * plain-text excerpt for document-list surfaces.
 */
export function makeDocumentPreview(content: string, maxLength = 240): string {
  if (!content.trim() || maxLength <= 0) return ""

  const plainText = plainDocumentText(content)

  if (plainText.length <= maxLength) return plainText

  const clipped = plainText.slice(0, Math.max(0, maxLength - 1)).trimEnd()
  const lastSpace = clipped.lastIndexOf(" ")
  const boundary = lastSpace >= Math.floor(maxLength * 0.65) ? lastSpace : clipped.length
  return `${clipped.slice(0, boundary).trimEnd()}…`
}

// Backslash escapes survive Markdown that has round-tripped through an
// HTML→Markdown export (`\*\*Goal:\*\*`). Resolve them before the Markdown
// markers are stripped so the preview reads as prose, not as escape sequences.
const MARKDOWN_ESCAPE_RE = /\\([\\`*_{}[\]()<>#+\-.!|~"'])/g

function plainDocumentText(content: string): string {
  return decodeHtmlEntities(
    content
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(
        /<div\b[^>]*data-type=["']mermaid-diagram["'][^>]*>[\s\S]*?<\/div\s*>/gi,
        " ",
      )
      .replace(/<[^>]+data-type=["'](?:page-break|math-block)["'][^>]*>/gi, " ")
      .replace(BLOCK_TAG_RE, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(MARKDOWN_ESCAPE_RE, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, "")
      .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, "$1"),
  )
    .replace(/\s+/g, " ")
    .trim()
}

export function estimateDocumentReadTimeMinutes(content: string): number {
  const words = plainDocumentText(content).split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.ceil(words / 225))
}
