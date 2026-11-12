"use client"

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useRouter } from "next/navigation"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import {
  Search,
  FileText,
  ArrowRight,
  Loader2,
  Settings as SettingsIcon,
} from "lucide-react"
import posthog from "posthog-js"

import { cn } from "@/lib/utils"
import { useCommandPalette } from "@/hooks/use-command-palette"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { usePaletteNavigation } from "@/hooks/use-palette-navigation"
import { searchSettingsKeyword } from "@/lib/settings-search"
import type { CommandPaletteCommand } from "@/hooks/use-command-palette"

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

type Item =
  | { kind: "command"; command: CommandPaletteCommand }
  | { kind: "setting"; setting: SettingsRow }
  | { kind: "knowledge"; result: KnowledgeResult }

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const GROUP_LABELS: Record<NonNullable<CommandPaletteCommand["group"]>, string> =
  {
    navigate: "Navigation",
    create: "Create",
    workspace: "Workspace",
    settings: "Settings",
  }

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + "..."
}

function HighlightedText({
  text,
  span,
}: {
  text: string
  span?: [number, number]
}): React.JSX.Element {
  if (!span) return <>{text}</>
  const [start, end] = span
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

function matchesQuery(command: CommandPaletteCommand, query: string): boolean {
  if (!query) return true
  const lower = query.toLowerCase()
  if (command.title.toLowerCase().includes(lower)) return true
  if (command.description?.toLowerCase().includes(lower)) return true
  if (command.keywords?.some((kw) => kw.toLowerCase().includes(lower)))
    return true
  return false
}

// ---------------------------------------------------------------------------
// Main CommandPalette component
// ---------------------------------------------------------------------------

export function CommandPalette(): React.JSX.Element {
  const { isOpen, close, commands } = useCommandPalette()
  const router = useRouter()
  const [query, setQuery] = useState("")
  const debouncedQuery = useDebouncedValue(query, 80)
  const inputRef = useRef<HTMLInputElement>(null)

  // Async server-side hybrid search state (knowledge + settings)
  const [knowledge, setKnowledge] = useState<KnowledgeResult[]>([])
  const [serverSettings, setServerSettings] = useState<{
    q: string
    matches: SettingsRow[]
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const fetchAbortRef = useRef<AbortController | null>(null)

  // Fire the /api/search request when the debounced query changes. Inlined
  // (rather than inside a `useCallback` like the legacy popout) because the
  // debounce is already handled by `useDebouncedValue`.
  useEffect(() => {
    const trimmed = debouncedQuery.trim()
    fetchAbortRef.current?.abort()
    if (!trimmed) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setKnowledge([])
      setServerSettings(null)
      setLoading(false)
      /* eslint-enable react-hooks/set-state-in-effect */
      return
    }
    const controller = new AbortController()
    fetchAbortRef.current = controller
    setLoading(true)
    fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=5`, {
      signal: controller.signal,
    })
      .then(async (res) => {
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
          result_count: k.length,
        })
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        setKnowledge([])
        setServerSettings({ q: trimmed, matches: [] })
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [debouncedQuery])

  // Instant client-side settings keyword matches — visible until the server
  // hybrid response resolves.
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

  const displaySettings: SettingsRow[] =
    serverSettings && serverSettings.q === query
      ? serverSettings.matches
      : clientSettings

  const hasQuery = query.trim().length > 0

  // Filter + group static commands by their group key
  const filteredCommands = useMemo(
    () => commands.filter((cmd) => matchesQuery(cmd, debouncedQuery)),
    [commands, debouncedQuery],
  )
  const groupedCommands = useMemo(() => {
    const map = new Map<string, CommandPaletteCommand[]>()
    for (const cmd of filteredCommands) {
      const key = cmd.group ?? "other"
      const existing = map.get(key)
      if (existing) existing.push(cmd)
      else map.set(key, [cmd])
    }
    return map
  }, [filteredCommands])

  // Build the single, ordered, keyboard-navigable item list. The render order
  // below must mirror this exactly; usePaletteNavigation indexes into it.
  const items = useMemo<Item[]>(() => {
    if (!hasQuery) {
      // Idle state: registered commands only (the classic palette UX).
      return filteredCommands.map((command) => ({
        kind: "command" as const,
        command,
      }))
    }
    const list: Item[] = []
    for (const s of displaySettings) list.push({ kind: "setting", setting: s })
    if (!loading) {
      for (const r of knowledge) list.push({ kind: "knowledge", result: r })
    }
    for (const c of filteredCommands) list.push({ kind: "command", command: c })
    return list
  }, [
    hasQuery,
    displaySettings,
    knowledge,
    filteredCommands,
    loading,
  ])

  const handleClose = useCallback((): void => {
    setQuery("")
    setKnowledge([])
    setServerSettings(null)
    setLoading(false)
    close()
  }, [close])

  const navigateToDoc = useCallback(
    (id: string, title?: string): void => {
      posthog.capture("search_result_clicked", {
        kind: "knowledge",
        document_id: id,
        document_title: title,
        query,
      })
      handleClose()
      router.push(`/knowledge/${id}`)
    },
    [handleClose, query, router],
  )

  const navigateToSetting = useCallback(
    (setting: SettingsRow): void => {
      posthog.capture("search_result_clicked", {
        kind: "setting",
        setting_id: setting.id,
        setting_label: setting.label,
        query,
      })
      handleClose()
      router.push(setting.href)
    },
    [handleClose, query, router],
  )

  const handleActivate = useCallback(
    (item: Item): void => {
      switch (item.kind) {
        case "command":
          handleClose()
          void item.command.perform()
          return
        case "setting":
          navigateToSetting(item.setting)
          return
        case "knowledge":
          navigateToDoc(item.result.id, item.result.title)
          return
      }
    },
    [handleClose, navigateToSetting, navigateToDoc],
  )

  const activeItems = items

  const { activeIndex, setActiveIndex, inputMode, onKeyDown } =
    usePaletteNavigation<Item>(activeItems, { onActivate: handleActivate })

  // Reset selection when the query changes
  const [prevQuery, setPrevQuery] = useState(query)
  if (prevQuery !== query) {
    setPrevQuery(query)
    setActiveIndex(0)
  }

  useEffect(() => {
    if (!isOpen) return
    const id = setTimeout(() => {
      inputRef.current?.focus()
    }, 50)
    return () => clearTimeout(id)
  }, [isOpen])

  // Stable item-id helper used by ARIA active-descendant + the listbox option ids
  const itemId = (item: Item, index: number): string => {
    switch (item.kind) {
      case "command":
        return `cp-command-${item.command.id}`
      case "setting":
        return `cp-setting-${item.setting.id}-${index}`
      case "knowledge":
        return `cp-knowledge-${item.result.id}`
    }
  }
  const activeOptionId =
    activeIndex >= 0 && activeIndex < activeItems.length
      ? itemId(activeItems[activeIndex], activeIndex)
      : undefined

  const rowClass = (i: number, base?: string): string =>
    cn(
      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
      base,
      i === activeIndex
        ? cn(
            "bg-accent text-accent-foreground",
            inputMode === "keyboard" && "ring-1 ring-primary/30",
          )
        : "hover:bg-accent/50",
    )

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const totalSearchHits = displaySettings.length + knowledge.length
  const liveText =
    !hasQuery || loading
      ? ""
      : totalSearchHits + filteredCommands.length > 0
        ? `${totalSearchHits + filteredCommands.length} match${
            totalSearchHits + filteredCommands.length === 1 ? "" : "es"
          }`
        : "No matches"

  // Index counter shared by the section renderers so `activeIndex` stays in
  // sync with the flat `activeItems` list.
  let flatIndex = 0
  const nextIndex = (): number => flatIndex++

  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) handleClose()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className={cn(
            "fixed left-1/2 top-[15vh] z-50 w-full max-w-[640px] -translate-x-1/2 overflow-hidden",
            "rounded-xl bg-background ring-1 ring-foreground/10 shadow-2xl",
            "outline-none",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          )}
          aria-label="Command palette"
        >
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Search
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={isOpen}
              aria-autocomplete="list"
              aria-controls="command-palette-list"
              aria-activedescendant={activeOptionId}
              placeholder="Search knowledge or run a command..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoComplete="off"
              spellCheck={false}
            />
            {loading && (
              <Loader2
                className="size-4 shrink-0 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            )}
            {query.length > 0 && !loading && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                  <path
                    d="M1 1l12 12M13 1L1 13"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
          </div>

          {/* Results */}
          <div
            id="command-palette-list"
            role="listbox"
            aria-label="Commands and search results"
            className="max-h-[60vh] overflow-y-auto overscroll-contain p-2"
          >
            {/* Settings (only when querying) */}
            {hasQuery && displaySettings.length > 0 && (
              <div className="mb-1">
                <SectionLabel>Settings</SectionLabel>
                {displaySettings.map((s) => {
                  const i = nextIndex()
                  const labelHighlight =
                    s.highlight?.field === "label" ? s.highlight.span : undefined
                  const descHighlight =
                    s.highlight?.field === "description"
                      ? s.highlight.span
                      : undefined
                  const item: Item = { kind: "setting", setting: s }
                  return (
                    <button
                      key={`s-${s.id}-${i}`}
                      id={itemId(item, i)}
                      role="option"
                      aria-selected={i === activeIndex}
                      onClick={() => handleActivate(item)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(rowClass(i, "items-start"), "group")}
                    >
                      <SettingsIcon
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">
                          <HighlightedText text={s.label} span={labelHighlight} />
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          <HighlightedText
                            text={s.description}
                            span={descHighlight}
                          />
                        </p>
                        {s.breadcrumb && (
                          <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
                            {s.breadcrumb.join(" › ")}
                          </p>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Knowledge (only when querying, and only after fetch resolves) */}
            {hasQuery && !loading && knowledge.length > 0 && (
              <div className="mb-1">
                <SectionLabel>Knowledge</SectionLabel>
                {knowledge.map((r) => {
                  const i = nextIndex()
                  const item: Item = { kind: "knowledge", result: r }
                  const score =
                    typeof r.similarity === "number"
                      ? `${Math.round(r.similarity * 100)}%`
                      : null
                  return (
                    <button
                      key={`k-${r.id}`}
                      id={itemId(item, i)}
                      role="option"
                      aria-selected={i === activeIndex}
                      onClick={() => handleActivate(item)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(rowClass(i, "items-start"), "group")}
                    >
                      <FileText
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{r.title}</p>
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

            {/* Commands — rendered grouped, but indices increment in render order */}
            {(hasQuery || filteredCommands.length > 0) &&
              Array.from(groupedCommands.entries()).map(([group, groupCmds]) => (
                <div key={`grp-${group}`} className="mb-1 last:mb-0">
                  <SectionLabel>
                    {GROUP_LABELS[
                      group as NonNullable<CommandPaletteCommand["group"]>
                    ] ?? group}
                  </SectionLabel>
                  {groupCmds.map((cmd) => {
                    const i = nextIndex()
                    const item: Item = { kind: "command", command: cmd }
                    return (
                      <button
                        key={`c-${cmd.id}`}
                        id={itemId(item, i)}
                        role="option"
                        aria-selected={i === activeIndex}
                        // eslint-disable-next-line react-hooks/refs
                        onClick={() => handleActivate(item)}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={rowClass(i)}
                      >
                        {cmd.icon !== undefined && (
                          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                            {cmd.icon}
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{cmd.title}</div>
                          {cmd.description !== undefined && (
                            <div className="truncate text-xs text-muted-foreground">
                              {cmd.description}
                            </div>
                          )}
                        </div>
                        {cmd.shortcut !== undefined && cmd.shortcut.length > 0 && (
                          <span className="ml-auto flex shrink-0 items-center gap-0.5">
                            {cmd.shortcut.map((key, j) => (
                              <kbd
                                key={j}
                                className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                              >
                                {key}
                              </kbd>
                            ))}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}

            {/* Empty state: query with no settings/knowledge/commands hits */}
            {hasQuery &&
              !loading &&
              displaySettings.length === 0 &&
              knowledge.length === 0 &&
              filteredCommands.length === 0 && (
                <div className="px-4 py-8 text-center">
                  <FileText
                    className="mx-auto size-8 text-muted-foreground/20"
                    aria-hidden="true"
                  />
                  <p className="mt-2 text-sm text-muted-foreground">
                    No matches.
                  </p>
                </div>
              )}
          </div>

          {/* Footer hint */}
          <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                ↑
              </kbd>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                ↓
              </kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                ↵
              </kbd>
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                esc
              </kbd>
              close
            </span>
          </div>

          {/* Polite live region for SR result-count */}
          {hasQuery && liveText && (
            <div role="status" aria-live="polite" className="sr-only">
              {liveText}
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  )
}
