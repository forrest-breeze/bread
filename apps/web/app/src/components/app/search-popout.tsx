"use client"

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useId,
  useMemo,
} from "react"
import { useRouter } from "next/navigation"
import {
  Search,
  FileText,
  ArrowRight,
  Loader2,
  X,
  Settings as SettingsIcon,
} from "lucide-react"
import posthog from "posthog-js"

import { usePaletteNavigation } from "@/hooks/use-palette-navigation"
import { useWorkspace } from "@/hooks/swr"
import { searchSettingsKeyword } from "@/lib/settings-search"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KnowledgeResult {
  id: string
  title: string
  similarity?: number | null
  content?: string
}

interface SettingsRow {
  id: string
  label: string
  href: string
  description: string
  matchedKeyword?: string
  highlight?: { field: "label" | "description"; span: [number, number] }
  breadcrumb?: string[]
}

interface SearchPopoutProps {
  open: boolean
  onClose: () => void
}

type NavItem =
  | { kind: "setting"; setting: SettingsRow }
  | { kind: "knowledge"; result: KnowledgeResult }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + "..."
}

/**
 * Render `text` with a `<mark>` over the [start, end) span. Returns the bare
 * text when no highlight is provided. Used for both label and description
 * highlight rendering on Settings rows.
 */
function HighlightedText({
  text,
  span,
}: {
  text: string
  span?: [number, number]
}): React.JSX.Element {
  if (!span) return <>{text}</>
  const [start, end] = span
  // Defensive bounds: span should always be valid, but a malformed payload
  // shouldn't crash the row.
  if (start < 0 || end > text.length || start >= end) return <>{text}</>
  return (
    <>
      {text.slice(0, start)}
      <mark className="rounded-sm bg-primary/15 px-0 py-0 text-foreground">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  )
}

// ---------------------------------------------------------------------------
// SearchPopout
// ---------------------------------------------------------------------------

export function SearchPopout({ open, onClose }: SearchPopoutProps): React.JSX.Element | null {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState("")
  const [knowledge, setKnowledge] = useState<KnowledgeResult[]>([])
  const [serverSettings, setServerSettings] = useState<{
    q: string
    matches: SettingsRow[]
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Stable per-instance id used to scope ARIA listbox/option ids. Multiple
  // palettes on the same page (unlikely but cheap to support) won't collide.
  const reactId = useId()
  const listboxId = `palette-listbox-${reactId}`
  const optionId = (i: number): string => `palette-option-${reactId}-${i}`

  // Focus input when opened
  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setQuery("")
      setKnowledge([])
      setServerSettings(null)
      /* eslint-enable react-hooks/set-state-in-effect */
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [open, onClose])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open, onClose])

  // Debounced fetch over /api/search. Returns { knowledge, settings }.
  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    const trimmed = q.trim()
    if (!trimmed) {
      setKnowledge([])
      setServerSettings(null)
      setLoading(false)
      return
    }

    setLoading(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=5`)
        if (!res.ok) {
          setKnowledge([])
          setServerSettings({ q: trimmed, matches: [] })
          return
        }
        const data = (await res.json()) as {
          knowledge?: KnowledgeResult[]
          settings?: SettingsRow[]
        }
        const k = data.knowledge ?? []
        const s = data.settings ?? []
        setKnowledge(k)
        setServerSettings({ q: trimmed, matches: s })
        posthog.capture("search_performed", {
          query: trimmed,
          knowledge_count: k.length,
          setting_count: s.length,
          // Legacy field — preserved so existing dashboards and funnels keep
          // working without a coordinated migration.
          result_count: k.length,
        })
      } catch {
        setKnowledge([])
        setServerSettings({ q: trimmed, matches: [] })
      } finally {
        setLoading(false)
      }
    }, 300)
  }, [])

  const handleChange = (value: string): void => {
    setQuery(value)
    // Invalidate stale server data — the next render falls back to client-
    // side keyword matches until the new fetch returns.
    setServerSettings(null)
    setKnowledge([])
    search(value)
  }

  const navigateToDoc = useCallback(
    (id: string, title?: string): void => {
      posthog.capture("search_result_clicked", {
        kind: "knowledge",
        document_id: id,
        document_title: title,
        query,
      })
      onClose()
      router.push(`/knowledge/${id}`)
    },
    [onClose, query, router],
  )

  const navigateToSetting = useCallback(
    (setting: SettingsRow): void => {
      posthog.capture("search_result_clicked", {
        kind: "setting",
        setting_id: setting.id,
        setting_label: setting.label,
        query,
      })
      onClose()
      router.push(setting.href)
    },
    [onClose, query, router],
  )

  // Client-side keyword settings — synchronous, runs on every keystroke.
  // Used as the visible settings list until the server fetch resolves.
  const clientSettings = useMemo<SettingsRow[]>(() => {
    return searchSettingsKeyword(query).map((m) => ({
      id: m.entry.id,
      label: m.entry.label,
      href: m.entry.href,
      description: m.entry.description,
      matchedKeyword: m.matchedKeyword,
      highlight: m.highlight,
      breadcrumb: m.entry.breadcrumb,
    }))
  }, [query])

  // Display settings: prefer the server response if it's for the current
  // query (more complete — includes semantic matches). Otherwise show the
  // instant client-side keyword matches so the row appears immediately.
  const displaySettings: SettingsRow[] =
    serverSettings && serverSettings.q === query
      ? serverSettings.matches
      : clientSettings

  const hasQuery = query.trim().length > 0
  const hasSettings = displaySettings.length > 0
  const showKnowledge = hasQuery && !loading && knowledge.length > 0
  const showEmpty =
    hasQuery && !loading && knowledge.length === 0 && !hasSettings

  // Flat, ordered list of keyboard-navigable items. Section headers are not
  // included — they're decorative. Settings always appear before knowledge.
  const navItems = useMemo<NavItem[]>(() => {
    const items: NavItem[] = []
    for (const s of displaySettings) {
      items.push({ kind: "setting", setting: s })
    }
    if (showKnowledge) {
      for (const r of knowledge) items.push({ kind: "knowledge", result: r })
    }
    return items
  }, [displaySettings, showKnowledge, knowledge])

  const onActivate = useCallback(
    (item: NavItem): void => {
      switch (item.kind) {
        case "setting":
          navigateToSetting(item.setting)
          return
        case "knowledge":
          navigateToDoc(item.result.id, item.result.title)
          return
      }
    },
    [navigateToDoc, navigateToSetting],
  )

  const { activeIndex, setActiveIndex, inputMode, onKeyDown } =
    usePaletteNavigation<NavItem>(navItems, { onActivate })

  // Reset selection when the user types a new query — keeps the cursor at
  // the top so a fresh search doesn't leave the user mid-list.
  useEffect(() => {
    setActiveIndex(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  if (!open) return null

  // ARIA descendant + announcement strings
  const activeOptionId =
    activeIndex >= 0 && activeIndex < navItems.length ? optionId(activeIndex) : undefined

  const totalMatches = displaySettings.length + knowledge.length
  const liveText = loading
    ? ""
    : !hasQuery
      ? ""
      : totalMatches > 0
        ? `${totalMatches} match${totalMatches === 1 ? "" : "es"}`
        : "No matches"

  // Per-row helper: visual ring only renders in keyboard mode.
  const rowClass = (i: number): string =>
    cn(
      "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors",
      i === activeIndex
        ? cn("bg-muted", inputMode === "keyboard" && "ring-1 ring-primary/30")
        : "hover:bg-muted",
    )

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh] backdrop-blur-[2px]">
      <div
        ref={containerRef}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-background shadow-2xl animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-controls={listboxId}
            aria-expanded={navItems.length > 0}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            placeholder="Search knowledge..."
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={onKeyDown}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          {loading && (
            <Loader2
              className="size-4 shrink-0 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
          {hasQuery && !loading && (
            <button
              onClick={() => handleChange("")}
              className="rounded-md p-0.5 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear search"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
          <kbd className="hidden sm:inline-flex h-5 items-center rounded border border-border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>

        {/* Results area */}
        <div className="max-h-[60vh] overflow-y-auto" role="listbox" id={listboxId}>
          {/* Settings — appear instantly via the keyword path on every
              keystroke; replaced by the server hybrid response after the
              fetch resolves. */}
          {hasQuery && hasSettings && (
            <div className="p-2">
              <p
                className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                aria-hidden="true"
              >
                Settings
              </p>
              {navItems.map((item, i) => {
                if (item.kind !== "setting") return null
                const s = item.setting
                const labelHighlight =
                  s.highlight?.field === "label" ? s.highlight.span : undefined
                const descHighlight =
                  s.highlight?.field === "description" ? s.highlight.span : undefined
                return (
                  <button
                    key={s.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === activeIndex}
                    onClick={() => onActivate(item)}
                    onMouseEnter={() => {
                      if (inputMode === "mouse") setActiveIndex(i)
                    }}
                    className={cn("group items-start", rowClass(i))}
                  >
                    <SettingsIcon
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        <HighlightedText text={s.label} span={labelHighlight} />
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        <HighlightedText text={s.description} span={descHighlight} />
                      </p>
                      {s.breadcrumb && (
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
                          {s.breadcrumb.join(" › ")}
                        </p>
                      )}
                    </div>
                    <ArrowRight
                      className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
                      aria-hidden="true"
                    />
                  </button>
                )
              })}
            </div>
          )}

          {/* Knowledge results */}
          {showKnowledge && (
            <div className="p-2">
              <p
                className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                aria-hidden="true"
              >
                Knowledge
              </p>
              {navItems.map((item, i) => {
                if (item.kind !== "knowledge") return null
                const r = item.result
                const score =
                  typeof r.similarity === "number"
                    ? `${Math.round(r.similarity * 100)}%`
                    : null
                return (
                  <button
                    key={r.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === activeIndex}
                    onClick={() => onActivate(item)}
                    onMouseEnter={() => {
                      if (inputMode === "mouse") setActiveIndex(i)
                    }}
                    className={cn("group items-start", rowClass(i))}
                  >
                    <FileText
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.title}</p>
                      {r.content && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {truncate(r.content, 100)}
                        </p>
                      )}
                    </div>
                    {score && (
                      <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">
                        {score}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {/* No results — shown only when both settings and knowledge are empty */}
          {showEmpty && (
            <div className="px-4 py-8 text-center">
              <FileText className="mx-auto size-8 text-muted-foreground/20" aria-hidden="true" />
              <p className="mt-2 text-sm text-muted-foreground">No matches.</p>
            </div>
          )}
        </div>

        {/* Polite live region for screen-reader result-count announcements */}
        {hasQuery && liveText && (
          <div role="status" aria-live="polite" className="sr-only">
            {liveText}
          </div>
        )}
      </div>
    </div>
  )
}
