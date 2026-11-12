"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Node, mergeAttributes, InputRule } from "@tiptap/core"
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react"
import type { NodeViewProps } from "@tiptap/react"
import { cn } from "@/lib/utils"

// ── KaTeX loader ────────────────────────────────────────────────────
// KaTeX is ~75 KB gzipped and most documents contain no math, so it is loaded
// on demand: only when a math node view mounts or a rendered body contains
// math. Kept out of the editor / portal chunks.

type Katex = (typeof import("katex"))["default"]

let katexModule: Katex | null = null
let katexPromise: Promise<Katex> | null = null

function loadKatex(): Promise<Katex> {
  katexPromise ??= import("katex").then(
    (mod) => (katexModule = mod.default),
    (err: unknown) => {
      katexPromise = null // allow a retry on the next render
      throw err
    },
  )
  return katexPromise
}

function useKatex(): Katex | null {
  const [katex, setKatex] = useState<Katex | null>(katexModule)
  useEffect(() => {
    if (katex) return
    let alive = true
    loadKatex()
      .then((mod) => {
        if (alive) setKatex(mod)
      })
      .catch((err: unknown) => console.warn("[math] failed to load KaTeX", err))
    return () => {
      alive = false
    }
  }, [katex])
  return katex
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ── KaTeX render helper ─────────────────────────────────────────────

function renderLatex(
  katex: Katex | null,
  latex: string,
  displayMode: boolean,
): { html: string; error: boolean } {
  if (!latex.trim()) return { html: "", error: false }
  // Until KaTeX arrives, keep the source in place (hidden for the first
  // 200ms, see .delayed-reveal) so a quick load never flashes raw LaTeX.
  if (!katex) {
    return {
      html: `<span class="delayed-reveal">${escapeHtml(latex)}</span>`,
      error: false,
    }
  }
  try {
    return {
      html: katex.renderToString(latex, { throwOnError: false, displayMode }),
      error: false,
    }
  } catch {
    return { html: latex, error: true }
  }
}

// ── Math Block Node View ────────────────────────────────────────────

function MathBlockView({
  node,
  updateAttributes,
  selected,
}: NodeViewProps): React.ReactElement {
  const [editing, setEditing] = useState(!(node.attrs.latex as string))
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const latex = (node.attrs.latex as string) || ""

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
    }
  }, [editing])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "0px"
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [latex, editing])

  const handleBlur = useCallback((): void => {
    setEditing(false)
  }, [])

  const katex = useKatex()
  const { html: rendered, error: hasError } = renderLatex(katex, latex, true)

  if (editing || selected) {
    return (
      <NodeViewWrapper className="math-node math-block-wrapper">
        <div className="math-block-editor">
          <div className="math-block-label">LaTeX</div>
          <textarea
            ref={textareaRef}
            value={latex}
            onChange={(e) => updateAttributes({ latex: e.target.value })}
            onBlur={handleBlur}
            placeholder="E = mc^2"
            className="math-block-input"
            rows={1}
          />
          {latex.trim() && (
            <div
              className={cn("math-block-preview", hasError && "math-error")}
              dangerouslySetInnerHTML={{ __html: rendered }}
            />
          )}
        </div>
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper className="math-node math-block-wrapper">
      <div
        className={cn("math-block-render", hasError && "math-error")}
        onClick={() => setEditing(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") setEditing(true)
        }}
        dangerouslySetInnerHTML={{
          __html:
            rendered ||
            '<span class="math-empty">Click to add equation</span>',
        }}
      />
    </NodeViewWrapper>
  )
}

// ── Math Inline Node View ───────────────────────────────────────────

function MathInlineView({
  node,
  updateAttributes,
  selected,
}: NodeViewProps): React.ReactElement {
  const [editing, setEditing] = useState(!(node.attrs.latex as string))
  const inputRef = useRef<HTMLInputElement>(null)
  const latex = (node.attrs.latex as string) || ""

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault()
        setEditing(false)
      }
    },
    [],
  )

  const katex = useKatex()
  const { html: rendered } = renderLatex(katex, latex, false)

  if (editing || selected) {
    return (
      <NodeViewWrapper as="span" className="math-node math-inline-wrapper">
        <input
          ref={inputRef}
          type="text"
          value={latex}
          onChange={(e) => updateAttributes({ latex: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={handleKeyDown}
          placeholder="x^2"
          className="math-inline-input"
          size={Math.max(latex.length + 2, 4)}
        />
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper as="span" className="math-node math-inline-wrapper">
      <span
        className="math-inline-render"
        onClick={() => setEditing(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") setEditing(true)
        }}
        dangerouslySetInnerHTML={{
          __html: rendered || '<span class="math-empty">$</span>',
        }}
      />
    </NodeViewWrapper>
  )
}

// ── MathBlock Extension ─────────────────────────────────────────────

export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-latex") || "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-latex": attributes.latex as string,
        }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="math-block"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "math-block" }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathBlockView)
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^\$\$\s$/,
        handler: ({ state, range }) => {
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex: "" }),
          )
        },
      }),
    ]
  },
})

// ── MathInline Extension ────────────────────────────────────────────

export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-latex") || "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-latex": attributes.latex as string,
        }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="math-inline"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-type": "math-inline" }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView)
  },

  addInputRules() {
    return [
      new InputRule({
        find: /\$([^$]+)\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex }),
          )
        },
      }),
    ]
  },
})

// ── DOM math renderer (for preview / read-only contexts) ────────────

export async function renderMathInElement(container: HTMLElement): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>(
    '[data-type="math-block"]',
  )
  const inlines = container.querySelectorAll<HTMLElement>(
    '[data-type="math-inline"]',
  )
  // Skip the KaTeX download entirely for bodies without math.
  if (blocks.length === 0 && inlines.length === 0) return

  let katex: Katex
  try {
    katex = await loadKatex()
  } catch (err) {
    console.warn("[math] failed to load KaTeX", err)
    return
  }

  for (const el of blocks) {
    const latex = el.getAttribute("data-latex") || ""
    if (!latex.trim() || !el.isConnected) continue
    try {
      katex.render(latex, el, { throwOnError: false, displayMode: true })
    } catch {
      el.textContent = latex
    }
  }

  for (const el of inlines) {
    const latex = el.getAttribute("data-latex") || ""
    if (!latex.trim() || !el.isConnected) continue
    try {
      katex.render(latex, el, { throwOnError: false, displayMode: false })
    } catch {
      el.textContent = latex
    }
  }
}
