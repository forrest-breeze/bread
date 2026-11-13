"use client"

import { useMemo, useState } from "react"
import { Folder, Search } from "lucide-react"
import { hasPortalGlyph, PORTAL_GLYPHS } from "@/components/icons/portal-glyphs"
import { LUCIDE_ICON_NAMES } from "@/components/icons/dynamic-lucide-icon"
import {
  isRenderablePortalIconName,
  PortalIcon,
} from "@/components/public-kb/portal/portal-icon"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

// The Breezify brand glyphs lead the catalog (they're what generated portals
// ship with and they render duotone, not stock); the full lucide set is the
// searchable long tail. Both resolve identically on the portal side.
const GLYPH_NAMES = Object.keys(PORTAL_GLYPHS)
const LUCIDE_ONLY_NAMES = LUCIDE_ICON_NAMES.filter(
  (name) => !hasPortalGlyph(name),
)

// Keep each search render bounded: 48 icons = 8 rows of 6, and first-time
// matches each fetch their own chunk.
const MAX_RESULTS = 48

/** "chart-no-axes-combined" → "Chart no axes combined" for hover titles. */
function iconLabel(name: string): string {
  const words = name.replace(/-/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Every query token must appear in the name (hyphens read as spaces). */
function matchesQuery(name: string, tokens: string[]): boolean {
  const haystack = name.replace(/-/g, " ")
  return tokens.every((token) => haystack.includes(token))
}

function IconOption({
  name,
  selected,
  onSelect,
}: {
  name: string
  selected: boolean
  onSelect: (icon: string) => void
}): React.ReactElement {
  return (
    <button
      type="button"
      title={iconLabel(name)}
      aria-label={iconLabel(name)}
      onClick={() => onSelect(name)}
      className={cn(
        "flex size-9 items-center justify-center rounded-md transition-colors hover:bg-muted/50",
        selected && "bg-muted/60 ring-1 ring-foreground/20",
      )}
    >
      <PortalIcon name={name} className="size-4.5" />
    </button>
  )
}

interface FolderIconGridProps {
  /** Current explicit icon; null means automatic (name-based) resolution. */
  value: string | null
  onSelect: (icon: string | null) => void
}

/**
 * Searchable icon catalog + "Automatic" reset shared by every folder-icon
 * surface (header popover, sidebar context menu). No query shows the Breezify
 * glyph set; typing searches the full lucide catalog too. Selection is
 * delegated — the host closes its own popover/menu.
 */
export function FolderIconGrid({
  value,
  onSelect,
}: FolderIconGridProps): React.ReactElement {
  const [query, setQuery] = useState("")

  const results = useMemo(() => {
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return GLYPH_NAMES
    const matches = GLYPH_NAMES.filter((name) => matchesQuery(name, tokens))
    for (const name of LUCIDE_ONLY_NAMES) {
      if (matches.length >= MAX_RESULTS) break
      if (matchesQuery(name, tokens)) matches.push(name)
    }
    return matches.slice(0, MAX_RESULTS)
  }, [query])

  const searching = query.trim().length > 0

  return (
    <>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={query}
          placeholder={`Search ${LUCIDE_ICON_NAMES.length.toLocaleString()} icons…`}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 pl-7 text-xs"
        />
      </div>
      {results.length > 0 ? (
        <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto">
          {results.map((name) => (
            <IconOption
              key={name}
              name={name}
              selected={name === value}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : (
        <div className="px-1 py-4 text-center text-xs text-muted-foreground">
          No icons match &ldquo;{query.trim()}&rdquo;
        </div>
      )}
      {searching && results.length >= MAX_RESULTS && (
        <div className="mt-1 px-1 text-[11px] text-muted-foreground/70">
          Showing the first {MAX_RESULTS} matches — keep typing to narrow.
        </div>
      )}
      {!searching && (
        <div className="mt-1 px-1 text-[11px] text-muted-foreground/70">
          Breezify set — search for the full catalog.
        </div>
      )}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs",
          "text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
          value === null && "bg-muted/40 text-foreground",
        )}
      >
        <Folder className="size-3.5" />
        Automatic (match folder name)
      </button>
    </>
  )
}

interface FolderIconPickerProps {
  /** Current explicit icon; null means automatic (name-based) resolution. */
  value: string | null
  onSelect: (icon: string | null) => void
  /** Render the trigger without opening behavior (read-only roles). */
  disabled?: boolean
  className?: string
}

/**
 * Popover icon catalog for choosing a folder's portal icon. The trigger shows
 * the current icon (or the generic folder mark when automatic); picking
 * "Automatic" clears the explicit icon back to name-based resolution.
 */
export function FolderIconPicker({
  value,
  onSelect,
  disabled,
  className,
}: FolderIconPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false)

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-label={disabled ? "Folder icon" : "Change folder icon"}
      title={disabled ? undefined : "Change folder icon"}
      className={cn(
        "flex size-10 items-center justify-center rounded-md border border-border/60 bg-muted/10",
        "text-foreground transition-colors",
        !disabled && "hover:border-border hover:bg-muted/30",
        className,
      )}
    >
      {value && isRenderablePortalIconName(value) ? (
        <PortalIcon name={value} className="size-5" />
      ) : (
        <Folder className="size-5 text-muted-foreground" />
      )}
    </button>
  )

  if (disabled) return trigger

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-64 p-2">
        <FolderIconGrid
          value={value}
          onSelect={(icon) => {
            setOpen(false)
            onSelect(icon)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
