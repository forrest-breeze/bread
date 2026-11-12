// Shared HTML sanitization logic operating on a parsed DOM tree. Both the
// client renderer (DOMParser, render-document-html.ts) and the public
// server renderer (jsdom, public-kb-render.ts) pass their parsed <body> here so
// the security-critical denylist lives in exactly one place and cannot drift.
//
// Denylist approach: stored content is authored HTML (Tiptap / ingestion), so
// we keep the element set broad but strip script-bearing tags, event handlers,
// and any URL-bearing attribute pointing at an unsafe scheme.

const BLOCKED_TAGS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  // Raw SVG / MathML / <template> can carry script or namespaced URL vectors and
  // are never part of legitimate document content (math is stored as
  // data-latex spans rendered client-side by KaTeX, not raw <math>/<svg>).
  "svg",
  "math",
  "template",
  "noscript",
  "frame",
  "frameset",
].join(",")

function isSafeUrl(value: string): boolean {
  const normalized = value.trim()
  if (!normalized) return true
  return (
    normalized.startsWith("#") ||
    normalized.startsWith("/") ||
    /^(https?:|mailto:|tel:)/i.test(normalized)
  )
}

/** True for any attribute that resolves a URL (incl. namespaced + form*). */
function isUrlAttribute(name: string): boolean {
  return (
    name === "href" ||
    name === "src" ||
    name === "formaction" ||
    name === "data-card-href" ||
    name.endsWith(":href") ||
    name.endsWith(":src")
  )
}

// The `style` attribute is allowed (the server renderer's Shiki highlighter
// emits inline `color` / `--shiki-*` custom properties for syntax colors), but
// it is a known CSS-injection surface. Drop the whole attribute if it contains a
// scheme/loader token — `url(` (can fetch or carry `javascript:`), `expression(`
// (legacy IE), `@import`, or a `behavior:`/`-moz-binding:` script binding.
// Shiki's output (plain `color:#hex` + custom props) never hits these, so this
// is a strict tightening with no effect on legitimate highlight or editor markup.
const UNSAFE_STYLE = /url\(|expression\(|@import|behavior\s*:|-moz-binding|javascript:/i

/**
 * Sanitize a parsed document body in place and return its innerHTML. Strips
 * blocked tags, all `on*` event handlers, `srcdoc`, URL attributes
 * (`href`/`src`/`formaction`/namespaced) that point at unsafe schemes (anything
 * other than `#`, `/`, `http(s):`, `mailto:`, `tel:` — so `javascript:` and
 * `data:` are removed), and `style` attributes carrying CSS-injection tokens.
 * The element set keeps `<pre>/<code>/<span>` with `class`/`style` so
 * server-side Shiki syntax highlighting (public-kb-render.ts) survives intact.
 */
export function sanitizeElementTree(body: Element): string {
  for (const element of Array.from(body.querySelectorAll(BLOCKED_TAGS))) {
    element.remove()
  }

  for (const element of Array.from(body.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith("on") || name === "srcdoc") {
        element.removeAttribute(attribute.name)
        continue
      }
      if (isUrlAttribute(name) && !isSafeUrl(attribute.value)) {
        element.removeAttribute(attribute.name)
        continue
      }
      if (name === "style" && UNSAFE_STYLE.test(attribute.value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }

  return body.innerHTML || "<p>No content.</p>"
}
