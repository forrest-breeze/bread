import JSZip from "jszip"
import { looksLikeHtml } from "@/lib/html-detection"

export interface DocumentExportPage {
  name: string
  html: string
}

export interface DocumentExportInput {
  title: string
  pages: DocumentExportPage[]
  updatedAt?: string
}

export type DocumentExportFormat = "markdown" | "html" | "pdf" | "docx"

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

const BLOCKED_HTML_SELECTORS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
]
const INLINE_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "code",
  "del",
  "em",
  "i",
  "img",
  "input",
  "kbd",
  "mark",
  "s",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
])
const BLOCK_TAGS = new Set([
  "blockquote",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "ul",
])

function normalizeTitle(title: string): string {
  return title.trim() || "Untitled"
}

export function makeSafeExportFilename(title: string, extension: string): string {
  const base = normalizeTitle(title)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)

  return `${base || "untitled"}.${extension.replace(/^\./, "")}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([*_`[\]<>])/g, "\\$1")
}

function escapeMarkdownUrl(value: string): string {
  return value.replace(/\)/g, "%29").replace(/\s/g, "%20")
}

function normalizeBlankLines(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Parses an HTML string into a `<template>` whose content can be walked. The
 * browser path uses the ambient `document`; server callers inject a DOM (see
 * lib/portal/portal-doc-markdown.ts, which parses with jsdom).
 */
export type HtmlTemplateParser = (html: string) => HTMLTemplateElement | null

function getTemplate(
  html: string,
  parseTemplate?: HtmlTemplateParser,
): HTMLTemplateElement | null {
  if (parseTemplate) return parseTemplate(html)
  if (typeof document === "undefined") return null
  const template = document.createElement("template")
  template.innerHTML = html
  return template
}

function isSafeUrl(value: string): boolean {
  const normalized = value.trim()
  if (!normalized) return true
  return (
    normalized.startsWith("#") ||
    normalized.startsWith("/") ||
    /^(https?:|mailto:|tel:)/i.test(normalized)
  )
}

function sanitizeHtmlForExport(html: string): string {
  const template = getTemplate(html)
  if (!template) return html

  for (const element of template.content.querySelectorAll(
    '[data-type="mermaid-diagram"]',
  )) {
    const source = getMermaidSource(element)
    const replacement = document.createElement("pre")
    replacement.className = "mermaid-source"
    const code = document.createElement("code")
    code.className = "language-mermaid"
    code.textContent = source
    replacement.appendChild(code)
    element.replaceWith(replacement)
  }

  for (const element of template.content.querySelectorAll(
    '[data-type="math-block"]',
  )) {
    const latex = getLatex(element)
    const replacement = document.createElement("div")
    replacement.className = "math-block"
    replacement.textContent = latex ? `$$\n${latex}\n$$` : ""
    element.replaceWith(replacement)
  }

  for (const element of template.content.querySelectorAll(
    '[data-type="math-inline"]',
  )) {
    const latex = getLatex(element)
    const replacement = document.createElement("span")
    replacement.className = "math-inline"
    replacement.textContent = latex ? `$${latex}$` : ""
    element.replaceWith(replacement)
  }

  for (const element of template.content.querySelectorAll(
    BLOCKED_HTML_SELECTORS.join(","),
  )) {
    element.remove()
  }

  for (const element of template.content.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith("on") || name === "srcdoc") {
        element.removeAttribute(attribute.name)
        continue
      }
      if ((name === "href" || name === "src") && !isSafeUrl(attribute.value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }

  return template.innerHTML
}

function elementTag(node: Element): string {
  return node.tagName.toLowerCase()
}

function textContent(node: Node): string {
  return node.textContent ?? ""
}

function getLatex(element: Element): string {
  return element.getAttribute("data-latex")?.trim() ?? ""
}

function getMermaidSource(element: Element): string {
  return (
    element.getAttribute("data-source") ??
    element.querySelector("[data-mermaid-fallback]")?.textContent ??
    ""
  ).trim()
}

function inlineChildren(element: Element): string {
  return Array.from(element.childNodes).map(nodeToInlineMarkdown).join("")
}

function hasBlockChild(element: Element): boolean {
  return Array.from(element.children).some((child) => BLOCK_TAGS.has(elementTag(child)))
}

function blockChildren(element: Element, depth = 0): string {
  return normalizeBlankLines(
    Array.from(element.childNodes)
      .map((node) => nodeToBlockMarkdown(node, depth))
      .filter((part) => part.trim().length > 0)
      .join("\n\n"),
  )
}

function nodeToInlineMarkdown(node: Node): string {
  if (node.nodeType === 3) {
    return escapeMarkdownText(textContent(node).replace(/\s+/g, " "))
  }
  if (node.nodeType !== 1) return ""

  const element = node as Element
  const tag = elementTag(element)

  if (element.getAttribute("data-type") === "math-inline") {
    return getLatex(element) ? `$${getLatex(element)}$` : ""
  }

  switch (tag) {
    case "br":
      return "  \n"
    case "strong":
    case "b": {
      const content = inlineChildren(element).trim()
      return content ? `**${content}**` : ""
    }
    case "em":
    case "i": {
      const content = inlineChildren(element).trim()
      return content ? `*${content}*` : ""
    }
    case "s":
    case "del":
    case "strike": {
      const content = inlineChildren(element).trim()
      return content ? `~~${content}~~` : ""
    }
    case "code": {
      const content = textContent(element).replace(/`/g, "\\`")
      return content ? `\`${content}\`` : ""
    }
    case "a": {
      const content = inlineChildren(element).trim() || textContent(element).trim()
      const href = element.getAttribute("href") ?? ""
      if (!content) return ""
      return href && isSafeUrl(href)
        ? `[${content}](${escapeMarkdownUrl(href)})`
        : content
    }
    case "img": {
      const src = element.getAttribute("src") ?? ""
      if (!src || !isSafeUrl(src)) return ""
      const alt = escapeMarkdownText(element.getAttribute("alt") ?? "")
      return `![${alt}](${escapeMarkdownUrl(src)})`
    }
    case "input":
      return ""
    default:
      return inlineChildren(element)
  }
}

function codeFenceFor(value: string): string {
  const longestTickRun = value.match(/`+/g)?.reduce((longest, run) => {
    return Math.max(longest, run.length)
  }, 0) ?? 0

  return "`".repeat(Math.max(3, longestTickRun + 1))
}

function blockquoteMarkdown(element: Element, depth: number): string {
  const content = blockChildren(element, depth).trim()
  if (!content) return ""
  return content
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}

function tableMarkdown(element: Element): string {
  const rows = Array.from(element.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        escapeMarkdownText(textContent(cell).replace(/\s+/g, " ").trim()).replace(
          /\|/g,
          "\\|",
        ),
      ),
    )
    .filter((row) => row.length > 0)

  if (rows.length === 0) return ""

  const width = Math.max(...rows.map((row) => row.length))
  const normalizedRows = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ""),
  ])
  const separator = Array.from({ length: width }, () => "---")
  const [header, ...body] = normalizedRows

  return [header, separator, ...body]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n")
}

function listMarkdown(element: Element, ordered: boolean, depth: number): string {
  return Array.from(element.children)
    .filter((child) => elementTag(child) === "li")
    .map((item, index) => listItemMarkdown(item, ordered, index, depth))
    .filter(Boolean)
    .join("\n")
}

function listItemMarkdown(
  item: Element,
  ordered: boolean,
  index: number,
  depth: number,
): string {
  const nestedLists: Element[] = []
  const contentNodes: Node[] = []

  for (const child of Array.from(item.childNodes)) {
    if (
      child.nodeType === 1 &&
      ["ul", "ol"].includes(elementTag(child as Element))
    ) {
      nestedLists.push(child as Element)
    } else {
      contentNodes.push(child)
    }
  }

  const content = normalizeBlankLines(
    contentNodes
      .map((node) => nodeToBlockMarkdown(node, depth))
      .filter((part) => part.trim().length > 0)
      .join("\n\n"),
  )

  const checked = item.getAttribute("data-checked")
  const marker =
    checked === "true"
      ? "- [x] "
      : checked === "false"
        ? "- [ ] "
        : ordered
          ? `${index + 1}. `
          : "- "
  const indent = "  ".repeat(depth)
  const continuationIndent = " ".repeat(marker.length)
  const lines = content ? content.split("\n") : [""]
  const firstLine = `${indent}${marker}${lines[0] ?? ""}`
  const restLines = lines
    .slice(1)
    .map((line) => `${indent}${continuationIndent}${line}`)
  const nested = nestedLists
    .map((list) => listMarkdown(list, elementTag(list) === "ol", depth + 1))
    .filter(Boolean)

  return [firstLine, ...restLines, ...nested].join("\n")
}

function nodeToBlockMarkdown(node: Node, depth = 0): string {
  if (node.nodeType === 3) {
    return escapeMarkdownText(textContent(node).replace(/\s+/g, " ")).trim()
  }
  if (node.nodeType !== 1) return ""

  const element = node as Element
  const tag = elementTag(element)
  const dataType = element.getAttribute("data-type")

  if (element.hasAttribute("data-document-tabs")) {
    return `{% tabs %}\n\n${blockChildren(element, depth)}\n\n{% endtabs %}`
  }
  if (element.hasAttribute("data-document-tab")) {
    const title = JSON.stringify(element.getAttribute("data-document-tab") || "Section")
    return `{% tab title=${title} %}\n\n${blockChildren(element, depth)}\n\n{% endtab %}`
  }
  if (element.hasAttribute("data-tab-label")) return ""
  if (element.hasAttribute("data-document-cards")) {
    return `{% cards %}\n\n${blockChildren(element, depth)}\n\n{% endcards %}`
  }
  if (element.hasAttribute("data-document-card")) {
    const title = JSON.stringify(element.getAttribute("data-document-card") || "Card")
    const href = element.getAttribute("data-card-href")
    const hrefAttribute = href ? ` href=${JSON.stringify(href)}` : ""
    const icon = element.getAttribute("data-card-icon")
    const iconAttribute = icon ? ` icon=${JSON.stringify(icon)}` : ""
    return `{% card title=${title}${hrefAttribute}${iconAttribute} %}\n\n${blockChildren(element, depth)}\n\n{% endcard %}`
  }
  if (element.hasAttribute("data-card-title") || element.hasAttribute("data-card-glyph")) return ""
  if (element.hasAttribute("data-card-body")) return blockChildren(element, depth)

  if (dataType === "math-block") {
    const latex = getLatex(element)
    return latex ? `$$\n${latex}\n$$` : ""
  }
  if (dataType === "mermaid-diagram") {
    const source = getMermaidSource(element)
    if (!source) return ""
    const fence = codeFenceFor(source)
    return `${fence}mermaid\n${source}\n${fence}`
  }
  if (dataType === "page-break") {
    const pageName = element.getAttribute("data-name")?.trim()
    return pageName ? `## ${escapeMarkdownText(pageName)}` : ""
  }

  if (INLINE_TAGS.has(tag)) {
    return nodeToInlineMarkdown(element).trim()
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1))
    const content = inlineChildren(element).trim()
    return content ? `${"#".repeat(level)} ${content}` : ""
  }

  switch (tag) {
    case "p":
      return inlineChildren(element).trim()
    case "pre": {
      const content = textContent(element).replace(/\n+$/g, "")
      const language =
        element.querySelector("code")?.className.match(/language-([^\s]+)/)?.[1] ??
        ""
      const fence = codeFenceFor(content)
      return `${fence}${language}\n${content}\n${fence}`
    }
    case "blockquote":
      return blockquoteMarkdown(element, depth)
    case "ul":
      return listMarkdown(element, false, depth)
    case "ol":
      return listMarkdown(element, true, depth)
    case "li":
      return listItemMarkdown(element, false, 0, depth)
    case "hr":
      return "---"
    case "table":
      return tableMarkdown(element)
    case "br":
      return ""
    default: {
      if (!hasBlockChild(element)) {
        return inlineChildren(element).trim()
      }
      const children = blockChildren(element, depth)
      return children || inlineChildren(element).trim()
    }
  }
}

export function documentHtmlToMarkdown(
  html: string,
  parseTemplate?: HtmlTemplateParser,
): string {
  if (!html.trim()) return ""
  if (!looksLikeHtml(html)) return html.trim()

  const template = getTemplate(html, parseTemplate)
  if (!template) return html.trim()

  return normalizeBlankLines(
    Array.from(template.content.childNodes)
      .map((node) => nodeToBlockMarkdown(node))
      .filter((part) => part.trim().length > 0)
      .join("\n\n"),
  )
}

export function buildMarkdownExport(input: DocumentExportInput): string {
  const title = normalizeTitle(input.title)
  const pages =
    input.pages.length > 0
      ? input.pages
      : [{ name: "", html: "" } satisfies DocumentExportPage]

  const sections = [`# ${escapeMarkdownText(title)}`]
  pages.forEach((page, index) => {
    const pageName = page.name.trim()
    if (pageName) {
      sections.push(`## ${escapeMarkdownText(pageName)}`)
    } else if (pages.length > 1 && index > 0) {
      sections.push("---")
    }

    const content = documentHtmlToMarkdown(page.html)
    if (content) sections.push(content)
  })

  return `${normalizeBlankLines(sections.join("\n\n"))}\n`
}

export function buildHtmlExport(input: DocumentExportInput): string {
  const title = normalizeTitle(input.title)
  const updatedAt = input.updatedAt
    ? `<p class="bread-meta">Exported from Bread. Last updated ${escapeHtml(
        new Date(input.updatedAt).toLocaleString(),
      )}.</p>`
    : `<p class="bread-meta">Exported from Bread.</p>`
  const pages =
    input.pages.length > 0
      ? input.pages
      : [{ name: "", html: "" } satisfies DocumentExportPage]
  const pageSections = pages
    .map((page, index) => {
      const pageHeading = page.name.trim()
        ? `<h2>${escapeHtml(page.name.trim())}</h2>`
        : ""
      return `<section class="bread-page" data-page="${index + 1}">${pageHeading}${sanitizeHtmlForExport(page.html)}</section>`
    })
    .join("\n")

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { margin: 0.7in; }
    body { margin: 0; color: #111827; background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; }
    main { max-width: 760px; margin: 0 auto; padding: 48px 24px 72px; }
    h1, h2, h3 { line-height: 1.2; }
    h1 { margin: 0 0 8px; font-size: 2.25rem; }
    h2 { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #e5e7eb; }
    pre { overflow-x: auto; padding: 12px 14px; border-radius: 8px; background: #f3f4f6; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid #d1d5db; color: #4b5563; }
    img { max-width: 100%; height: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 6px 8px; border: 1px solid #d1d5db; text-align: left; }
    .math-block { margin: 1rem 0; overflow-x: auto; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .math-inline { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .mermaid-source { white-space: pre-wrap; }
    .bread-meta { margin: 0 0 32px; color: #6b7280; font-size: 0.875rem; }
    .bread-page + .bread-page { margin-top: 32px; }
    @media print {
      body { color: #111827; background: #ffffff; }
      main { max-width: none; padding: 0; }
      h2 { break-after: avoid; }
      pre, blockquote, table { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    ${updatedAt}
    ${pageSections || "<p>No content.</p>"}
  </main>
</body>
</html>
`
}

export function buildClipboardHtml(input: DocumentExportInput): string {
  const title = normalizeTitle(input.title)
  const pages =
    input.pages.length > 0
      ? input.pages
      : [{ name: "", html: "" } satisfies DocumentExportPage]
  const pageSections = pages
    .map((page) => {
      const pageHeading = page.name.trim()
        ? `<h2>${escapeHtml(page.name.trim())}</h2>`
        : ""
      return `<section>${pageHeading}${sanitizeHtmlForExport(page.html)}</section>`
    })
    .join("")

  return `<article><h1>${escapeHtml(title)}</h1>${pageSections}</article>`
}

interface DocxRunStyle {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  color?: string
  underline?: boolean
}

function docxRunProperties(style: DocxRunStyle = {}): string {
  const parts: string[] = []
  if (style.bold) parts.push("<w:b/>")
  if (style.italic) parts.push("<w:i/>")
  if (style.strike) parts.push("<w:strike/>")
  if (style.underline) parts.push('<w:u w:val="single"/>')
  if (style.color) parts.push(`<w:color w:val="${escapeXml(style.color)}"/>`)
  if (style.code) {
    parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
  }

  return parts.length > 0 ? `<w:rPr>${parts.join("")}</w:rPr>` : ""
}

function docxRun(text: string, style: DocxRunStyle = {}): string {
  if (!text) return ""
  return `<w:r>${docxRunProperties(style)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
}

function docxBreakRun(style: DocxRunStyle = {}): string {
  return `<w:r>${docxRunProperties(style)}<w:br/></w:r>`
}

function docxParagraph(
  runs: string[],
  styleId?: string,
  paragraphProperties = "",
): string {
  const properties = [
    styleId ? `<w:pStyle w:val="${escapeXml(styleId)}"/>` : "",
    paragraphProperties,
  ].join("")

  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${runs.join("")}</w:p>`
}

function mergeRunStyle(
  base: DocxRunStyle,
  next: DocxRunStyle,
): DocxRunStyle {
  return { ...base, ...next }
}

function inlineNodesToDocxRuns(
  nodes: Node[],
  style: DocxRunStyle = {},
): string[] {
  return nodes.flatMap((node) => nodeToDocxRuns(node, style))
}

function elementInlineDocxRuns(
  element: Element,
  style: DocxRunStyle = {},
): string[] {
  return inlineNodesToDocxRuns(Array.from(element.childNodes), style)
}

function nodeToDocxRuns(node: Node, style: DocxRunStyle = {}): string[] {
  if (node.nodeType === 3) {
    const text = textContent(node).replace(/\s+/g, " ")
    return text ? [docxRun(text, style)] : []
  }
  if (node.nodeType !== 1) return []

  const element = node as Element
  const tag = elementTag(element)
  const dataType = element.getAttribute("data-type")

  if (dataType === "math-inline") {
    const latex = getLatex(element)
    return latex ? [docxRun(`$${latex}$`, mergeRunStyle(style, { code: true }))] : []
  }

  switch (tag) {
    case "br":
      return [docxBreakRun(style)]
    case "strong":
    case "b":
      return elementInlineDocxRuns(element, mergeRunStyle(style, { bold: true }))
    case "em":
    case "i":
      return elementInlineDocxRuns(element, mergeRunStyle(style, { italic: true }))
    case "s":
    case "del":
    case "strike":
      return elementInlineDocxRuns(element, mergeRunStyle(style, { strike: true }))
    case "code":
      return [docxRun(textContent(element), mergeRunStyle(style, { code: true }))]
    case "a": {
      const href = element.getAttribute("href") ?? ""
      const linkStyle = href && isSafeUrl(href)
        ? mergeRunStyle(style, { color: "0563C1", underline: true })
        : style
      const runs = elementInlineDocxRuns(element, linkStyle)
      if (href && isSafeUrl(href)) {
        runs.push(docxRun(` (${href})`, linkStyle))
      }
      return runs
    }
    case "img": {
      const alt = element.getAttribute("alt")?.trim()
      return alt ? [docxRun(`[Image: ${alt}]`, style)] : [docxRun("[Image]", style)]
    }
    case "input":
      return []
    default:
      return elementInlineDocxRuns(element, style)
  }
}

function textDocxParagraph(
  text: string,
  styleId?: string,
  runStyle: DocxRunStyle = {},
  paragraphProperties = "",
): string {
  return docxParagraph([docxRun(text, runStyle)], styleId, paragraphProperties)
}

function docxBlocksFromHtml(html: string): string[] {
  if (!html.trim()) return []
  if (!looksLikeHtml(html)) return [textDocxParagraph(html.trim())]

  const template = getTemplate(html)
  if (!template) return [textDocxParagraph(html.trim())]

  return Array.from(template.content.childNodes).flatMap((node) =>
    nodeToDocxBlocks(node),
  )
}

function docxBlocksFromChildren(element: Element, depth = 0): string[] {
  return Array.from(element.childNodes).flatMap((node) =>
    nodeToDocxBlocks(node, depth),
  )
}

function listItemDocxBlocks(
  item: Element,
  ordered: boolean,
  index: number,
  depth: number,
): string[] {
  const nestedLists: Element[] = []
  const contentNodes: Node[] = []

  for (const child of Array.from(item.childNodes)) {
    if (
      child.nodeType === 1 &&
      ["ul", "ol"].includes(elementTag(child as Element))
    ) {
      nestedLists.push(child as Element)
    } else {
      contentNodes.push(child)
    }
  }

  const checked = item.getAttribute("data-checked")
  const prefix =
    checked === "true"
      ? "[x] "
      : checked === "false"
        ? "[ ] "
        : ordered
          ? `${index + 1}. `
          : "- "
  const runs = [
    docxRun(prefix),
    ...inlineNodesToDocxRuns(contentNodes).filter((run) => run.length > 0),
  ]
  const leftIndent = 360 * depth
  const blocks = [
    docxParagraph(
      runs,
      undefined,
      leftIndent > 0 ? `<w:ind w:left="${leftIndent}"/>` : "",
    ),
  ]

  for (const nested of nestedLists) {
    blocks.push(...listDocxBlocks(nested, elementTag(nested) === "ol", depth + 1))
  }

  return blocks
}

function listDocxBlocks(
  element: Element,
  ordered: boolean,
  depth: number,
): string[] {
  return Array.from(element.children)
    .filter((child) => elementTag(child) === "li")
    .flatMap((item, index) => listItemDocxBlocks(item, ordered, index, depth))
}

function tableDocxBlock(element: Element): string {
  const rows = Array.from(element.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        docxParagraph(elementInlineDocxRuns(cell)),
      ),
    )
    .filter((row) => row.length > 0)

  if (rows.length === 0) return ""

  const border =
    '<w:top w:val="single" w:sz="4" w:color="D1D5DB"/>' +
    '<w:left w:val="single" w:sz="4" w:color="D1D5DB"/>' +
    '<w:bottom w:val="single" w:sz="4" w:color="D1D5DB"/>' +
    '<w:right w:val="single" w:sz="4" w:color="D1D5DB"/>' +
    '<w:insideH w:val="single" w:sz="4" w:color="D1D5DB"/>' +
    '<w:insideV w:val="single" w:sz="4" w:color="D1D5DB"/>'

  const rowXml = rows
    .map((row) => {
      const cells = row
        .map(
          (cell) =>
            `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${cell}</w:tc>`,
        )
        .join("")
      return `<w:tr>${cells}</w:tr>`
    })
    .join("")

  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>${rowXml}</w:tbl>`
}

function preDocxBlocks(element: Element): string[] {
  const lines = textContent(element).replace(/\n+$/g, "").split("\n")
  return lines.map((line) => textDocxParagraph(line || " ", "Code", { code: true }))
}

function nodeToDocxBlocks(node: Node, depth = 0): string[] {
  if (node.nodeType === 3) {
    const text = textContent(node).replace(/\s+/g, " ").trim()
    return text ? [textDocxParagraph(text)] : []
  }
  if (node.nodeType !== 1) return []

  const element = node as Element
  const tag = elementTag(element)
  const dataType = element.getAttribute("data-type")

  if (dataType === "math-block") {
    const latex = getLatex(element)
    return latex ? [textDocxParagraph(`$$ ${latex} $$`, "Code", { code: true })] : []
  }
  if (dataType === "mermaid-diagram") {
    const source = getMermaidSource(element)
    if (!source) return []
    return source
      .split("\n")
      .map((line) => textDocxParagraph(line || " ", "Code", { code: true }))
  }
  if (dataType === "page-break") return []

  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(Number(tag.slice(1)), 3)
    return [docxParagraph(elementInlineDocxRuns(element), `Heading${level}`)]
  }

  switch (tag) {
    case "p":
      return [docxParagraph(elementInlineDocxRuns(element))]
    case "pre":
      return preDocxBlocks(element)
    case "blockquote":
      return [
        docxParagraph(
          elementInlineDocxRuns(element, { italic: true }),
          undefined,
          '<w:ind w:left="720"/>',
        ),
      ]
    case "ul":
      return listDocxBlocks(element, false, depth)
    case "ol":
      return listDocxBlocks(element, true, depth)
    case "li":
      return listItemDocxBlocks(element, false, 0, depth)
    case "hr":
      return [textDocxParagraph("---")]
    case "table": {
      const table = tableDocxBlock(element)
      return table ? [table] : []
    }
    default:
      if (!hasBlockChild(element)) {
        return [docxParagraph(elementInlineDocxRuns(element))]
      }
      return docxBlocksFromChildren(element, depth)
  }
}

function docxDocumentXml(input: DocumentExportInput): string {
  const title = normalizeTitle(input.title)
  const pages =
    input.pages.length > 0
      ? input.pages
      : [{ name: "", html: "" } satisfies DocumentExportPage]
  const bodyBlocks = [
    docxParagraph([docxRun(title)], "Heading1"),
    ...pages.flatMap((page, index) => {
      const blocks: string[] = []
      if (page.name.trim()) {
        blocks.push(docxParagraph([docxRun(page.name.trim())], "Heading2"))
      } else if (pages.length > 1 && index > 0) {
        blocks.push(textDocxParagraph("---"))
      }
      blocks.push(...docxBlocksFromHtml(page.html))
      return blocks
    }),
  ]

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyBlocks.join("\n")}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1008" w:right="1008" w:bottom="1008" w:left="1008" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`
}

function docxStylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>`
}

function docxContentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`
}

function docxRootRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`
}

function docxDocumentRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
}

function docxCorePropertiesXml(input: DocumentExportInput): string {
  const title = normalizeTitle(input.title)
  const now = new Date().toISOString()

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>Bread</dc:creator>
  <cp:lastModifiedBy>Bread</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`
}

function docxAppPropertiesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Bread</Application>
</Properties>`
}

export async function buildDocxExport(
  input: DocumentExportInput,
): Promise<Blob> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", docxContentTypesXml())
  zip.file("_rels/.rels", docxRootRelationshipsXml())
  zip.file("word/document.xml", docxDocumentXml(input))
  zip.file("word/styles.xml", docxStylesXml())
  zip.file("word/_rels/document.xml.rels", docxDocumentRelationshipsXml())
  zip.file("docProps/core.xml", docxCorePropertiesXml(input))
  zip.file("docProps/app.xml", docxAppPropertiesXml())

  // Emit the Blob directly from JSZip (with the right MIME) rather than wrapping
  // a Uint8Array — avoids the generic-Uint8Array/BlobPart mismatch under TS 5.7+.
  return zip.generateAsync({ type: "blob", mimeType: DOCX_MIME })
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")

  anchor.href = url
  anchor.download = filename
  anchor.rel = "noopener"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function downloadBlobFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")

  anchor.href = url
  anchor.download = filename
  anchor.rel = "noopener"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function printHtmlAsPdf(filename: string, html: string): void {
  const printWindow = window.open("", "_blank")
  if (!printWindow) {
    throw new Error("Unable to open print window")
  }

  printWindow.opener = null
  printWindow.document.open()
  printWindow.document.write(html)
  printWindow.document.close()
  printWindow.document.title = filename
  printWindow.focus()
  printWindow.setTimeout(() => printWindow.print(), 250)
}

export async function copyDocumentToClipboard(
  input: DocumentExportInput,
): Promise<void> {
  const markdown = buildMarkdownExport(input)
  const html = buildClipboardHtml(input)

  if (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  ) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([markdown], { type: "text/plain" }),
      }),
    ])
    return
  }

  await navigator.clipboard.writeText(markdown)
}
