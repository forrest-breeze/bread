import { documentHtmlToMarkdown } from "@/lib/document-export"
import { renderDocumentTabs } from "@/lib/document-tabs"

// Tab/card directives pasted into the rich-text editor are parsed by
// tiptap-markdown, which doesn't know them: the whole block collapses into
// plain paragraphs like `<p>{% cards %} {% card title="…" %} Body {% endcard %} …</p>`.
// This rebuilds those runs of top-level blocks into real tab/card groups so
// already-saved documents render correctly (and are re-saved properly once
// opened in the editor).

const GROUP_TOKEN = /{%\s*(end)?(?:tabs|cards)\s*%}/g
const ANY_TOKEN = /{%[^%]*%}/g

/** Cheap pre-check before parsing: does stored HTML contain directive text? */
export function hasDirectiveText(html: string): boolean {
  return /{%\s*(?:tabs|cards)\s*%}/.test(html)
}

function balance(text: string): { opened: boolean; depth: number } {
  let depth = 0
  let opened = false
  for (const match of text.matchAll(GROUP_TOKEN)) {
    if (match[1]) depth--
    else { depth++; opened = true }
  }
  return { opened, depth }
}

/** Put every directive on its own line and undo Markdown escaping inside it. */
function restoreDirectiveLines(markdown: string): string {
  return markdown
    .replace(ANY_TOKEN, (token) => token.replace(/\\([\\*_`[\]<>])/g, "$1"))
    .replace(/[ \t]*({%[^%]*%})[ \t]*/g, "\n$1\n")
}

/**
 * Rebuild directive text found in top-level blocks of `root` (a parsed body)
 * into rendered tab/card groups, in place. Code blocks are never touched and
 * unbalanced or malformed runs are left as they are.
 */
export function repairDirectiveParagraphs(root: Element, render: (markdown: string) => string): void {
  const doc = root.ownerDocument
  const parseTemplate = (html: string) => {
    const template = doc.createElement("template")
    template.innerHTML = html
    return template
  }
  const children = Array.from(root.children)
  for (let i = 0; i < children.length; i++) {
    const first = children[i]
    if (first.tagName === "PRE" || !balance(first.textContent ?? "").opened) continue
    const run: Element[] = []
    let depth = 0
    for (let j = i; j < children.length; j++) {
      const child = children[j]
      if (child.tagName === "PRE" && depth > 0) { run.push(child); continue }
      run.push(child)
      depth += balance(child.textContent ?? "").depth
      if (depth <= 0) break
    }
    if (depth !== 0) continue
    const markdown = restoreDirectiveLines(documentHtmlToMarkdown(run.map((el) => el.outerHTML).join(""), parseTemplate))
    const html = renderDocumentTabs(markdown, render)
    if (!/data-document-(?:tabs|cards)=/.test(html)) continue
    const replacement = parseTemplate(html)
    first.before(replacement.content)
    run.forEach((el) => el.remove())
    i += run.length - 1
  }
}
