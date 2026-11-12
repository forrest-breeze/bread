import { renderDocumentTabs } from "@/lib/document-tabs"
import MarkdownIt from "markdown-it"
import { looksLikeHtml } from "@/lib/html-detection"
import { sanitizeElementTree } from "@/lib/sanitize-dom"
import { hasDirectiveText, repairDirectiveParagraphs } from "@/lib/repair-document-directives"

// Shared, dependency-free rendering for stored document bodies. Documents are
// persisted as sanitized HTML (with a Markdown fallback for plain-text/legacy
// content). Both the editor's read-only preview (`RichContentPreview`) and the
// knowledge-base reading portal (`KbProse`) render through this single helper
// so sanitization stays in one place (the denylist itself lives in
// sanitize-dom.ts, shared with the public server renderer).

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
})

function sanitizeHtml(value: string): string {
  // DOMParser is browser-only. On the server (SSR / route handlers) fall back
  // to rendering the raw value through Markdown, which never emits scripts.
  if (typeof DOMParser === "undefined") {
    return markdown.render(value)
  }

  const parsed = new DOMParser().parseFromString(value, "text/html")
  if (hasDirectiveText(value)) repairDirectiveParagraphs(parsed.body, (source) => markdown.render(source))
  return sanitizeElementTree(parsed.body)
}

/**
 * Render a stored document body to sanitized HTML ready for
 * `dangerouslySetInnerHTML`. HTML input is sanitized (scripts/handlers/unsafe
 * URLs stripped); plain text is treated as Markdown. Empty input yields a
 * neutral placeholder.
 */
export function renderDocumentHtml(value: string): string {
  if (!value.trim()) {
    return "<p>No content.</p>"
  }

  if (looksLikeHtml(value)) {
    return sanitizeHtml(value)
  }

  return renderDocumentTabs(value, (source) => markdown.render(source))
}
