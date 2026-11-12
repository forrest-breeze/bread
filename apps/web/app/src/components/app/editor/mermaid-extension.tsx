"use client"

import { InputRule, mergeAttributes, Node } from "@tiptap/core"
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react"
import { AlertCircle, Loader2 } from "lucide-react"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { cn } from "@/lib/utils"
import { mermaidCodeSource } from "@/lib/mermaid-source"

type MermaidApi = typeof import("mermaid")["default"]

let mermaidPromise: Promise<MermaidApi> | null = null
let mermaidRenderId = 0
// mermaid.initialize is global, so renders are serialized to keep each
// diagram's theme from being clobbered by a concurrent render.
let renderQueue: Promise<unknown> = Promise.resolve()

export type MermaidTheme = "neutral" | "dark"

// Rendered SVGs keyed by theme + source. Diagrams are deterministic for a
// given key, so a diagram that has been drawn once this session (in the
// editor, a preview, or another page) reappears synchronously — no blank
// frame, no re-render. Bounded so long sessions can't grow without limit.
const SVG_CACHE_LIMIT = 200
const svgCache = new Map<string, string>()

function svgCacheKey(theme: MermaidTheme | null, source: string): string {
  return `${theme}\u0000${source}`
}

function cacheSvg(key: string, svg: string): void {
  svgCache.delete(key)
  svgCache.set(key, svg)
  if (svgCache.size > SVG_CACHE_LIMIT) {
    const oldest = svgCache.keys().next().value
    if (oldest !== undefined) svgCache.delete(oldest)
  }
}

/**
 * Theme for an element that may not be attached yet (editor node views mount
 * before the editor DOM is inserted): fall back to the document's theme.
 */
function initialMermaidTheme(element?: Element | null): MermaidTheme {
  if (typeof document === "undefined") return "neutral"
  return mermaidThemeFor(
    element?.isConnected ? element : document.documentElement,
  )
}

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => mermaid)
  }
  return mermaidPromise
}

/**
 * Resolves the Mermaid theme from the nearest `.dark` / `.light` ancestor so
 * diagrams follow both the app theme (on <html>) and scoped portal themes.
 */
export function mermaidThemeFor(element: Element | null): MermaidTheme {
  const themed = element?.closest(".dark, .light")
  return themed?.classList.contains("dark") ? "dark" : "neutral"
}

/**
 * Calls `onChange` when the effective Mermaid theme for `element` changes.
 * Watches only the elements that can carry theme classes rather than the
 * whole document subtree.
 */
export function observeMermaidTheme(
  element: Element,
  onChange: (theme: MermaidTheme) => void,
): () => void {
  let current = mermaidThemeFor(element)
  const observer = new MutationObserver(() => {
    const next = mermaidThemeFor(element)
    if (next === current) return
    current = next
    onChange(next)
  })
  for (let node: Element | null = element; node; node = node.parentElement) {
    observer.observe(node, { attributes: true, attributeFilter: ["class"] })
  }
  return () => observer.disconnect()
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unable to render this diagram."
  const firstLine = error.message.split("\n").find((line) => line.trim())
  return firstLine?.trim() || "Unable to render this diagram."
}

function renderMermaidSvg(
  id: string,
  source: string,
  theme: MermaidTheme,
): Promise<string> {
  const key = svgCacheKey(theme, source)
  const cached = svgCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)

  const run = renderQueue.then(async () => {
    const mermaid = await loadMermaid()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme,
      flowchart: {
        htmlLabels: false,
        useMaxWidth: true,
      },
    })
    const { svg } = await mermaid.render(id, source)
    cacheSvg(key, svg)
    return svg
  })
  renderQueue = run.catch(() => undefined)
  return run
}

type RenderResult =
  | { source: string; status: "ready"; svg: string; error: "" }
  | { source: string; status: "error"; svg: ""; error: string }

function MermaidDiagramView({
  node,
  selected,
  updateAttributes,
}: NodeViewProps): React.ReactElement {
  const source = (node.attrs.source as string) || ""
  const [editing, setEditing] = useState(!source.trim())
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  // The first render of an existing diagram runs immediately; only later
  // source edits are debounced (so typing doesn't re-render every keystroke).
  const hasRenderedRef = useRef(false)
  // Start from the document theme (applied before first paint) so the first
  // render already uses the right palette; the effect below refines it for
  // scoped themes and follows later changes.
  const [theme, setTheme] = useState<MermaidTheme | null>(() =>
    initialMermaidTheme(),
  )
  const renderKey = svgCacheKey(theme, source)
  const cachedSvg = svgCache.get(renderKey)
  const renderState =
    !source.trim()
      ? { status: "idle" as const, svg: "", error: "" }
      : renderResult?.source === renderKey
        ? renderResult
        : cachedSvg !== undefined
          ? { status: "ready" as const, svg: cachedSvg, error: "" }
          : { status: "loading" as const, svg: "", error: "" }

  useEffect(() => {
    void loadMermaid().catch(() => undefined)
  }, [])

  useEffect(() => {
    const element = previewRef.current
    if (!element) return
    setTheme(initialMermaidTheme(element))
    return observeMermaidTheme(element, setTheme)
  }, [editing])

  useEffect(() => {
    if (!source.trim() || !theme) return
    // Already drawn this session: rendered synchronously from the cache above.
    if (svgCache.has(renderKey)) return

    let cancelled = false
    const delay = hasRenderedRef.current ? 200 : 0
    hasRenderedRef.current = true
    const timeout = window.setTimeout(() => {
      const diagramId = `mermaid-editor-${++mermaidRenderId}`
      void renderMermaidSvg(diagramId, source, theme)
        .then((svg) => {
          if (!cancelled) {
            setRenderResult({
              source: renderKey,
              status: "ready",
              svg,
              error: "",
            })
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setRenderResult({
              source: renderKey,
              status: "error",
              svg: "",
              error: errorMessage(error),
            })
          }
        })
    }, delay)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [source, theme, renderKey])

  useEffect(() => {
    if (!editing || !textareaRef.current) return
    textareaRef.current.focus()
    const length = textareaRef.current.value.length
    textareaRef.current.setSelectionRange(length, length)
  }, [editing])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = "0px"
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [editing, source])

  const stopEditing = useCallback((): void => {
    setEditing(false)
  }, [])

  const preview = (
    <div
      ref={previewRef}
      className={cn(
        "mermaid-block-preview",
        renderState.status === "error" && "mermaid-error",
      )}
    >
      {renderState.status === "loading" && (
        <span className="mermaid-status mermaid-status-slow">
          <Loader2 className="size-3.5 animate-spin" />
          Rendering diagram…
        </span>
      )}
      {renderState.status === "error" && (
        <span className="mermaid-status">
          <AlertCircle className="size-3.5" />
          {renderState.error}
        </span>
      )}
      {renderState.status === "ready" && (
        <div
          className="mermaid-svg"
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      )}
      {renderState.status === "idle" && (
        <span className="mermaid-empty">
          Add Mermaid syntax to preview the diagram.
        </span>
      )}
    </div>
  )

  if (editing) {
    return (
      <NodeViewWrapper
        className={cn(
          "mermaid-node mermaid-diagram-wrapper",
          selected && "is-selected",
        )}
      >
        <div className="mermaid-block-editor">
          <div className="mermaid-block-label">Mermaid</div>
          <textarea
            ref={textareaRef}
            value={source}
            onChange={(event) =>
              updateAttributes({ source: event.target.value })
            }
            onBlur={stopEditing}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              event.preventDefault()
              event.currentTarget.blur()
            }}
            placeholder={"flowchart TD\n  A[Start] --> B[Finish]"}
            className="mermaid-block-input"
            rows={4}
            aria-label="Mermaid diagram source"
          />
          {preview}
        </div>
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper
      className={cn(
        "mermaid-node mermaid-diagram-wrapper",
        selected && "is-selected",
      )}
    >
      <div
        className="mermaid-block-render"
        onClick={() => setEditing(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            setEditing(true)
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Edit Mermaid diagram"
      >
        {preview}
      </div>
    </NodeViewWrapper>
  )
}

export const MermaidDiagram = Node.create({
  name: "mermaidDiagram",
  group: "block",
  atom: true,
  defining: true,

  addAttributes() {
    return {
      source: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-source") ||
          element.querySelector("[data-mermaid-fallback]")?.textContent ||
          mermaidCodeSource(element) ||
          "",
        renderHTML: (attributes: Record<string, unknown>) => ({
          "data-source": attributes.source as string,
        }),
      },
    }
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="mermaid-diagram"]' },
      {
        tag: "pre",
        priority: 100,
        getAttrs: (element) => mermaidCodeSource(element) === null ? false : {},
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const source = (node.attrs.source as string) || ""
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "mermaid-diagram",
        class: "mermaid-static-render",
      }),
      [
        "pre",
        { "data-mermaid-fallback": "" },
        ["code", { class: "language-mermaid" }, source],
      ],
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidDiagramView)
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^```mermaid\s$/,
        handler: ({ state, range }) => {
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ source: "" }),
          )
        },
      }),
    ]
  },
})

/**
 * Upgrades persisted Mermaid nodes in sanitized read-only HTML. Mermaid's
 * strict security level encodes HTML labels and disables diagram click actions.
 */
export async function renderMermaidInElement(
  container: HTMLElement,
): Promise<void> {
  const diagrams = Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-type="mermaid-diagram"], pre',
    ),
  )

  for (const diagram of diagrams) {
    if (diagram.tagName === "PRE" && diagram.closest('[data-type="mermaid-diagram"]')) continue
    const source =
      diagram.getAttribute("data-source") ||
      diagram.querySelector("[data-mermaid-fallback]")?.textContent ||
      mermaidCodeSource(diagram) ||
      ""
    if (!source.trim()) {
      diagram.setAttribute("data-mermaid-failed", "")
      continue
    }

    const id = `mermaid-static-${++mermaidRenderId}`
    try {
      const svg = await renderMermaidSvg(id, source, mermaidThemeFor(diagram))
      const target = diagram.tagName === "PRE"
        ? diagram.ownerDocument.createElement("div")
        : diagram
      target.innerHTML = svg
      target.classList.add("mermaid-static-render")
      target.setAttribute("data-type", "mermaid-diagram")
      target.setAttribute("data-source", source)
      target.setAttribute("role", "img")
      target.setAttribute("aria-label", "Mermaid diagram")
      if (target !== diagram) diagram.replaceWith(target)
    } catch {
      // The source fallback is hidden while rendering is pending (see
      // index.css); reveal it when the definition is invalid or the renderer
      // cannot load.
      diagram.setAttribute("data-mermaid-failed", "")
    }
  }
}

/**
 * Renders Mermaid diagrams in read-only HTML and re-renders them when the
 * surrounding light/dark theme changes. Returns a cleanup function.
 */
export function mountMermaidInElement(container: HTMLElement): () => void {
  void renderMermaidInElement(container)
  return observeMermaidTheme(container, () => {
    void renderMermaidInElement(container)
  })
}
