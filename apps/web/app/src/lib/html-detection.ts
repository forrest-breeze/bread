const HTML_TAG_NAMES = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "map",
  "mark",
  "math",
  "menu",
  "meter",
  "nav",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "picture",
  "pre",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "search",
  "script",
  "section",
  "select",
  "slot",
  "small",
  "source",
  "span",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "svg",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "track",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
] as const

const HTML_TAG_PATTERN = new RegExp(
  String.raw`</?(?:${HTML_TAG_NAMES.join("|")})(?=[\s>/])[^>]*>`,
  "i",
)

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/
const INLINE_CODE = /(`+)[^`\n]*\1/g

/**
 * Drops fenced blocks and inline code spans so a Markdown document that merely
 * *mentions* a tag (`<script>` in a snippet, `<div>` in a code span) is not
 * mistaken for authored HTML. Misclassifying Markdown is destructive: callers
 * hand it to the DOM-based HTML→Markdown walker, which flattens the whole file
 * into one escaped text run.
 */
function withoutCode(value: string): string {
  const kept: string[] = []
  let fence: string | null = null

  for (const line of value.split("\n")) {
    const marker = FENCE_OPEN.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    kept.push(line.replace(INLINE_CODE, " "))
  }

  return kept.join("\n")
}

export function looksLikeHtml(value: string): boolean {
  if (!HTML_TAG_PATTERN.test(value)) return false
  return HTML_TAG_PATTERN.test(withoutCode(value))
}
