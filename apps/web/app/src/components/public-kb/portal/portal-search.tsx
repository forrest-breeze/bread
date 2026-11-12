"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useRouter } from "next/navigation"
import { ArrowRight, Loader2, Search, X } from "lucide-react"
import { PORTAL_GLYPHS } from "@/components/icons/portal-glyphs"

// Brand glyphs for the content marks (empty state, Ask-AI action); the
// magnifier/arrow/close remain generic UI affordances.
const DocGlyph = PORTAL_GLYPHS["file-text"]!
const SparkGlyph = PORTAL_GLYPHS["sparkles"]!
import { Skeleton } from "@/components/ui/skeleton"
import { SourceLogo } from "@/components/ui/source-logo"
import { cn } from "@/lib/utils"
import { trackPortalEvent } from "@/lib/portal/track-client"
import type { PublicSearchHit } from "@/lib/public-kb"
import { publicPortalApiPath, publicPortalHref } from "@/lib/portal/public-base-path"

// Shared in-portal search surface. Clicking a rendered search bar opens an
// anchored dropdown; the header instance also owns the global command-palette
// shortcut, which opens the same logic as a full-screen modal.
//
// All querying happens inside the popout via /api/public/search and links
// straight to docs. "Ask AI" is an explicit secondary action that hands off to
// the server-rendered cited-answer view (/p/[slug]?q=&ask=1). The underlying
// retrieval is visibility-scoped server-side, so this client never sees docs
// outside the portal's scope.

interface PortalSearchProps {
  slug: string
  hrefBase?: string
  placeholder: string
  askAiEnabled: boolean
  variant?: "header" | "block" | "help"
  globalShortcut?: boolean
  /**
   * Replaces router navigation for results (the builder's preview frame maps
   * portal URLs onto its own views instead of leaving for the public portal).
   */
  onNavigate?: (href: string) => void
}

type PortalSearchMode = "dropdown" | "modal"

// Stock placeholders that promise an AI answer. When the assistant is off we
// swap these for a plain search prompt at render time; the stored value is left
// alone so re-enabling the assistant restores it. Custom copy is never touched.
const AI_DEFAULT_PLACEHOLDERS = new Set([
  "Search or ask AI",
  "Ask, search, or explain…",
  "Ask, search, or explain...",
])
const PLAIN_SEARCH_PLACEHOLDER = "Search"

export function resolveSearchPlaceholder(placeholder: string, askAiEnabled: boolean): string {
  if (askAiEnabled) return placeholder
  return AI_DEFAULT_PLACEHOLDERS.has(placeholder.trim()) ? PLAIN_SEARCH_PLACEHOLDER : placeholder
}

export function PortalSearch({
  slug,
  hrefBase,
  placeholder: rawPlaceholder,
  askAiEnabled,
  variant = "header",
  globalShortcut,
  onNavigate,
}: PortalSearchProps): React.ReactElement {
  const placeholder = resolveSearchPlaceholder(rawPlaceholder, askAiEnabled)
  const [mode, setMode] = useState<PortalSearchMode | null>(null)
  const [modalTarget, setModalTarget] = useState<HTMLElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const shouldUseGlobalShortcut = globalShortcut ?? variant === "header"
  const publicBase = hrefBase ?? `/p/${slug}`

  // ⌘K / Ctrl+K opens the full command palette from anywhere on the portal.
  useEffect(() => {
    if (!shouldUseGlobalShortcut) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setModalTarget(
          rootRef.current?.closest<HTMLElement>("[data-portal-root]") ?? document.body,
        )
        setMode("modal")
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [shouldUseGlobalShortcut])

  const popout = mode ? (
    <PortalSearchPopout
      mode={mode}
      slug={slug}
      hrefBase={publicBase}
      placeholder={placeholder}
      askAiEnabled={askAiEnabled}
      onNavigate={onNavigate}
      onClose={() => setMode(null)}
    />
  ) : null

  const isHeader = variant === "header"
  const isHelp = variant === "help"
  const openSearch = (): void => {
    const useModal =
      isHeader && window.matchMedia("(max-width: 1279px)").matches
    if (useModal) {
      setModalTarget(
        rootRef.current?.closest<HTMLElement>("[data-portal-root]") ?? document.body,
      )
    }
    setMode(useModal ? "modal" : "dropdown")
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative",
        // Header: a bar on mobile (filling the row's middle) and xl+, an icon between.
        isHeader ? "flex w-full items-center gap-2 md:w-auto xl:w-full" : "w-full",
        isHelp && "mx-auto max-w-xl",
      )}
    >
      <button
        type="button"
        onClick={openSearch}
        aria-label="Search the knowledge base"
        aria-expanded={mode !== null}
        aria-haspopup="dialog"
        className={cn(
          "flex min-w-0 items-center border border-border bg-card text-left text-muted-foreground transition-colors hover:border-ring hover:bg-background",
          isHeader
            ? "h-9 w-full justify-start gap-2 rounded-xl px-3 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.02)] md:size-9 md:justify-center md:gap-0 md:p-0 xl:h-auto xl:w-full xl:justify-start xl:gap-2.5 xl:px-3.5 xl:py-2"
            : isHelp
              ? "w-full gap-3 rounded-2xl px-5 py-4 text-base shadow-[0_18px_40px_-28px_rgba(15,23,42,0.45)]"
              : "w-full gap-3 rounded-xl px-5 py-4 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.02)]",
        )}
      >
        <Search
          className={cn(
            "shrink-0",
            isHelp ? "size-5 text-[var(--portal-accent)]" : "size-4 text-muted-foreground/60",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate placeholder:text-muted-foreground/70",
            isHeader && "md:hidden xl:block",
          )}
        >
          {placeholder}
        </span>
        {isHeader ? (
          <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground/60 2xl:flex">
            <kbd className="grid size-7 place-items-center rounded-lg border border-border bg-background">
              ⌘
            </kbd>
            <kbd className="grid size-7 place-items-center rounded-lg border border-border bg-background">
              K
            </kbd>
          </span>
        ) : (
          <span className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors">
            <ArrowRight className="size-4" />
          </span>
        )}
      </button>
      {/* Header "Ask AI" trigger removed for now — the standalone Ask AI flow
          isn't built yet. The in-popout Ask AI hand-off below still routes to
          /p/[slug]?q= for when it lands. Re-add this button to restore it. */}

      {mode === "modal" && typeof document !== "undefined"
        ? createPortal(popout, modalTarget ?? document.body)
        : popout}
    </div>
  )
}

function PortalSearchPopout({
  mode,
  slug,
  hrefBase,
  placeholder,
  askAiEnabled,
  onNavigate,
  onClose,
}: {
  mode: PortalSearchMode
  slug: string
  hrefBase: string
  placeholder: string
  askAiEnabled: boolean
  onNavigate?: (href: string) => void
  onClose: () => void
}): React.ReactElement {
  const appRouter = useRouter()
  const router = useMemo(
    () => (onNavigate ? { push: onNavigate } : appRouter),
    [appRouter, onNavigate],
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<PublicSearchHit[]>([])
  const [loading, setLoading] = useState(false)
  // Active row index across the flat list: [...hits, ask-ai].
  const [activeIndex, setActiveIndex] = useState(0)

  const trimmed = query.trim()
  const hasQuery = trimmed.length >= 2
  const askIndex = hasQuery && askAiEnabled ? hits.length : -1
  const rowCount = hits.length + (hasQuery && askAiEnabled ? 1 : 0)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  // Close on Escape / outside click.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose()
    }
    const onClick = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("mousedown", onClick)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("mousedown", onClick)
    }
  }, [onClose])

  const runSearch = useCallback(
    (q: string): void => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      const t = q.trim()
      if (t.length < 2) {
        setHits([])
        setLoading(false)
        return
      }
      setLoading(true)
      debounceRef.current = setTimeout(async () => {
        try {
          const res = await fetch(
            `${publicPortalApiPath("search")}?portal=${encodeURIComponent(slug)}&q=${encodeURIComponent(t)}`,
          )
          if (!res.ok) {
            setHits([])
            return
          }
          const data = (await res.json()) as { hits?: PublicSearchHit[] }
          setHits(data.hits ?? [])
        } catch {
          setHits([])
        } finally {
          setLoading(false)
        }
      }, 250)
    },
    [slug],
  )

  const handleChange = (value: string): void => {
    setQuery(value)
    setActiveIndex(0)
    setHits([])
    runSearch(value)
  }

  const goToDoc = useCallback(
    (hit: PublicSearchHit): void => {
      // Log the committed palette search so it pairs with the search_click the
      // doc page records via ?ref=search — keeps CTR coherent (the as-you-type
      // /api/public/search calls are intentionally not logged).
      trackPortalEvent({ portal: slug, type: "search", query: trimmed, resultCount: hits.length })
      onClose()
      // ?ref=search lets the doc page record a search_click for CTR.
      router.push(publicPortalHref(hrefBase, `/doc/${hit.slug}?ref=search`))
    },
    [hrefBase, onClose, router, slug, trimmed, hits.length],
  )

  const askAi = useCallback((): void => {
    if (!hasQuery) return
    onClose()
    router.push(
      publicPortalHref(hrefBase, `?q=${encodeURIComponent(trimmed)}&ask=1`),
    )
  }, [hasQuery, hrefBase, onClose, router, trimmed])

  const activate = useCallback(
    (i: number): void => {
      if (i === askIndex) {
        askAi()
        return
      }
      const hit = hits[i]
      if (hit) goToDoc(hit)
    },
    [askIndex, askAi, goToDoc, hits],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (rowCount === 0) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % rowCount)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + rowCount) % rowCount)
    } else if (e.key === "Enter") {
      e.preventDefault()
      activate(activeIndex)
    }
  }

  const showEmpty = hasQuery && !loading && hits.length === 0

  const rowClass = (i: number): string =>
    cn(
      "flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors",
      i === activeIndex ? "bg-muted" : "hover:bg-muted",
    )

  const isModal = mode === "modal"

  return (
    <div
      className={cn(
        isModal
          ? "fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[15vh] backdrop-blur-[2px] sm:px-6"
          : "absolute left-0 right-0 top-0 z-50",
      )}
    >
      <div
        ref={containerRef}
        role={isModal ? "dialog" : "region"}
        aria-modal={isModal ? true : undefined}
        aria-label="Search the knowledge base"
        className={cn(
          "w-full overflow-hidden rounded-xl border border-border bg-background",
          isModal ? "max-w-lg shadow-2xl" : "shadow-xl",
        )}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label="Search the knowledge base"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          {loading && (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
          {query.length > 0 && !loading && (
            <button
              type="button"
              onClick={() => handleChange("")}
              aria-label="Clear search"
              className="rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
          <kbd className="hidden h-5 items-center rounded border border-border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {!hasQuery && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {askAiEnabled
                ? "Search the knowledge base, or ask a question."
                : "Search the knowledge base."}
            </p>
          )}

          {hasQuery && (
            <div className="p-2" aria-busy={loading}>
              <p className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Knowledge
              </p>
              {loading &&
                hits.length === 0 &&
                [0, 1, 2].map((n) => (
                  <div key={n} className="flex items-start gap-3 px-2 py-2">
                    <Skeleton className="mt-0.5 size-4 shrink-0 rounded" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Skeleton className={cn("h-3.5", n === 1 ? "w-1/2" : "w-2/3")} />
                      <Skeleton className={cn("h-3", n === 2 ? "w-3/5" : "w-5/6")} />
                    </div>
                  </div>
                ))}
              {showEmpty && (
                <div className="px-4 py-6 text-center">
                  <DocGlyph className="mx-auto size-8 text-muted-foreground/20" aria-hidden="true" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    No documents match “{trimmed}”.
                  </p>
                </div>
              )}
              {hits.map((hit, i) => (
                <button
                  key={hit.id}
                  type="button"
                  onClick={() => goToDoc(hit)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={rowClass(i)}
                >
                  <SourceLogo
                    source={hit.source}
                    size={16}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {hit.title || "Untitled"}
                    </span>
                    {hit.snippet && (
                      <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                        {hit.snippet}
                      </span>
                    )}
                  </span>
                  <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}

          {/* Ask AI hand-off */}
          {hasQuery && askAiEnabled && (
            <div className="border-t border-border p-2">
              <button
                type="button"
                onClick={askAi}
                onMouseEnter={() => setActiveIndex(askIndex)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                  activeIndex === askIndex ? "bg-primary/10" : "hover:bg-primary/5",
                )}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10">
                  <SparkGlyph className="size-3.5 text-primary" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-primary">Ask AI</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    “{trimmed}”
                  </span>
                </span>
                <ArrowRight className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
