import { renderDocumentTabs } from "@/lib/document-tabs"
import "server-only"

import { JSDOM } from "jsdom"
import MarkdownIt from "markdown-it"
import { createHighlighter, type Highlighter } from "shiki"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { sanitizeElementTree } from "@/lib/sanitize-dom"
import { hasDirectiveText, repairDirectiveParagraphs } from "@/lib/repair-document-directives"
import { looksLikeHtml } from "@/lib/html-detection"
import { mermaidCodeSource } from "@/lib/mermaid-source"
import { rewriteMediaForPublic } from "@/lib/storage/media-refs"

// Server-side document-body renderer for the PUBLIC knowledge base. The
// authenticated portal sanitizes with the browser DOMParser (client only);
// public pages are server-rendered for SEO, so we parse with jsdom here and run
// the shared denylist (sanitize-dom.ts) so both paths sanitize identically.
//
// Fenced / <pre><code> blocks are syntax-highlighted at render time with Shiki
// (server-only, no client JS for the highlighting). Shiki emits inline
// `--shiki-light` / `--shiki-dark` CSS variables on its spans; the dual theme is
// switched purely in CSS (portal-docs.css), so there is one HTML payload for
// both color schemes. The Shiki markup (`<pre>/<code>/<span>` + `class`/`style`)
// survives the sanitizer (see sanitize-dom.ts) while scripts/handlers stay
// stripped — sanitization runs AFTER highlighting so nothing Shiki produces is
// trusted blindly.
//
// IMPORTANT: this module is server-only (jsdom + the Shiki engine must never
// reach the client bundle). The output is a sanitized HTML string handed to a
// client island (`PublicProse`) purely for display + KaTeX — it is NOT
// re-sanitized there.

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
})

// Dual theme: one HTML payload, light/dark resolved by CSS variables. Keep these
// in sync with the `.portal-docs-prose .shiki` rules in portal-docs.css.
const LIGHT_THEME = "github-light"
const DARK_THEME = "github-dark"

// Curated language set — common in operational runbooks. Unknown languages fall
// back to `plaintext` (always bundled), so unhighlighted code still renders.
// The bundle is intentionally small to keep highlighter init fast.
const SHIKI_LANGS = [
  "bash",
  "css",
  "diff",
  "dockerfile",
  "go",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "jsonc",
  "markdown",
  "php",
  "python",
  "ruby",
  "rust",
  "sql",
  "toml",
  "tsx",
  "typescript",
  "xml",
  "yaml",
] as const

// Top-level await keeps `renderPublicHtml` synchronous: the highlighter (and its
// grammars) load once at module init, then `codeToHtml` runs synchronously per
// call. The JS regex engine avoids shipping the oniguruma WASM blob.
//
// Guarded: in serverless runtimes (e.g. the Netlify Lambda) Shiki's grammar /
// theme JSON — loaded via dynamic import from `@shikijs/langs` / `@shikijs/themes`
// — may not be traced into the deployed function, making `createHighlighter`
// throw. Because this is a top-level await, an unguarded rejection tears down the
// ENTIRE module and 500s every public portal route (renders fine locally, where
// the assets are on disk). Swallow it: code blocks then render unhighlighted
// while the rest of the document is unaffected. See next.config.mjs
// `outputFileTracingIncludes` for the asset-tracing fix that restores highlighting.
let highlighter: Highlighter | null = null
let loadedLangs = new Set<string>()
try {
  highlighter = await createHighlighter({
    themes: [LIGHT_THEME, DARK_THEME],
    langs: [...SHIKI_LANGS],
    engine: createJavaScriptRegexEngine(),
  })
  loadedLangs = new Set(highlighter.getLoadedLanguages())
} catch {
  highlighter = null
}

// Common fence aliases that Shiki's bundle doesn't register under that name.
const LANG_ALIASES: Record<string, string> = {
  curl: "bash",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  node: "javascript",
  nodejs: "javascript",
  mjs: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  yml: "yaml",
  golang: "go",
  rs: "rust",
}

// Human-readable tag shown on each code block (`data-language`).
const LANG_LABELS: Record<string, string> = {
  bash: "Shell",
  css: "CSS",
  diff: "Diff",
  dockerfile: "Dockerfile",
  go: "Go",
  html: "HTML",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  markdown: "Markdown",
  php: "PHP",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  sql: "SQL",
  toml: "TOML",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
}

function normalizeLang(raw: string | null): string {
  const tokens = (raw ?? "").trim().toLowerCase().split(/\s+/)
  const lang = (tokens.find((token) => /^(language|lang)-/.test(token)) ?? tokens[0] ?? "")
    .replace(/^language-/, "")
    .replace(/^lang-/, "")
  return LANG_ALIASES[lang] ?? lang
}

/** Map a `language-x` class / fence info string to a loaded Shiki lang. */
function resolveLang(raw: string | null): string {
  const lang = normalizeLang(raw)
  if (!lang) return "plaintext"
  return loadedLangs.has(lang) ? lang : "plaintext"
}

/**
 * The tag a reader sees on a code block: "cURL" for curl commands (that is what
 * developers scan API docs for), otherwise the language's display name. Blocks
 * without a declared language stay untagged rather than guessing.
 */
export function codeLanguageLabel(raw: string | null, source: string): string | null {
  const lang = normalizeLang(raw)
  if (!lang || lang === "plaintext" || lang === "text" || lang === "txt") return null
  if (lang === "bash" && /^\s*curl\s/.test(source)) return "cURL"
  return LANG_LABELS[lang] ?? (lang.length <= 12 ? lang.toUpperCase() : null)
}

/**
 * Highlight one snippet into a standalone Shiki `<pre>` (with its language tag),
 * or a plain escaped `<pre><code>` when the highlighter is unavailable. Callers
 * that build code blocks outside Markdown (generated API request samples) use
 * this so their output matches authored blocks exactly.
 */
export function highlightCodeHtml(source: string, lang: string): string {
  const element = buildHighlightedPre(new JSDOM("").window.document, source, lang)
  return element.outerHTML
}

function buildHighlightedPre(document: Document, source: string, rawLang: string | null): HTMLElement {
  const label = codeLanguageLabel(rawLang, source)
  const lang = resolveLang(rawLang)
  let pre: HTMLElement | null = null
  if (highlighter) {
    try {
      const highlighted = highlighter.codeToHtml(source, {
        lang,
        themes: { light: LIGHT_THEME, dark: DARK_THEME },
        defaultColor: false,
      })
      const replacement = JSDOM.fragment(highlighted).querySelector("pre")
      if (replacement) pre = document.importNode(replacement, true) as HTMLElement
    } catch {
      // Fall through to the plain block on any grammar/engine error.
    }
  }
  if (!pre) {
    pre = document.createElement("pre")
    const code = document.createElement("code")
    if (rawLang) code.className = `language-${normalizeLang(rawLang)}`
    code.textContent = source
    pre.append(code)
  }
  if (label) pre.setAttribute("data-language", label)
  return pre
}

/**
 * Replace each `<pre><code>` block with Shiki's highlighted `<pre>`. Operates on
 * the parsed tree before sanitization so the emitted markup is still untrusted
 * and re-cleaned by the denylist. Highlighting failures degrade silently to the
 * original block.
 */
function highlightCodeBlocks(document: Document, body: HTMLElement): void {
  for (const pre of Array.from(body.querySelectorAll("pre"))) {
    if (mermaidCodeSource(pre) !== null) continue
    const code = pre.querySelector("code")
    if (!code) continue
    // Tiptap and Markdown fences commonly leave terminal newlines. Shiki
    // renders each one as a full-height empty row below short snippets.
    const source = (code.textContent ?? "").trimEnd()
    pre.replaceWith(buildHighlightedPre(document, source, code.getAttribute("class")))
  }
}

function sanitizeWithJsdom(html: string): string {
  const dom = new JSDOM(`<!DOCTYPE html><body>${html}</body>`)
  const { document } = dom.window
  if (hasDirectiveText(html)) repairDirectiveParagraphs(document.body, (source) => markdown.render(source))
  highlightCodeBlocks(document, document.body)
  return sanitizeElementTree(document.body)
}

/**
 * Render a stored document body to sanitized HTML for public server rendering.
 * HTML input is sanitized; plain text is treated as Markdown and the result is
 * sanitized too. Fenced code blocks are syntax-highlighted (Shiki) before
 * sanitization. Empty input yields a neutral placeholder.
 */
export function renderPublicHtml(value: string): string {
  if (!value.trim()) return "<p>No content.</p>"
  // Anonymous visitors can't hit the RLS-gated /api/media/<id> endpoint; rewrite
  // those srcs to the public, portal-scope-gated /api/public/media/<id> first.
  const value2 = rewriteMediaForPublic(value)
  const html = looksLikeHtml(value2) ? value2 : renderDocumentTabs(value2, (source) => markdown.render(source))
  return sanitizeWithJsdom(html)
}
