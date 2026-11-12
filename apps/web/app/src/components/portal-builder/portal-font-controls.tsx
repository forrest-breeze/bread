"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  portalFontFamilySchema,
  portalFontSourceSchema,
  type PortalFonts,
  type PortalTheme,
} from "@/lib/portal/schema"

// ---------------------------------------------------------------------------
// Heading / body font pickers.
//
// Both dropdowns share one list: the Bread default (Rethink Sans), popular
// Google Fonts, and any custom fonts the workspace has added. "Add custom
// font…" adds a family to that shared list — a Google Fonts name, or a
// self-hosted licensed file — and applies it to the dropdown it came from.
// Custom fonts live in `theme.fonts.custom`; picking one for a slot copies its
// file into `headingSource` / `bodySource`, which is what the renderer reads.
// ---------------------------------------------------------------------------

type FontSlot = "heading" | "body"

// Select-only sentinels; neither is ever stored.
const DEFAULT_FONT = "__default__"
const ADD_FONT = "__add__"

// The legacy `font: "serif"` preset is Crimson Text for both slots.
const SERIF_FAMILY = "Crimson Text"

// Popular Google Fonts offered by default; custom fonts extend the list.
const FONT_SUGGESTIONS: readonly string[] = [
  "Crimson Text",
  "Inter",
  "Geist",
  "DM Sans",
  "Manrope",
  "Plus Jakarta Sans",
  "IBM Plex Sans",
  "Source Sans 3",
  "Open Sans",
  "Roboto",
  "Lato",
  "Poppins",
  "Montserrat",
  "Work Sans",
  "Nunito Sans",
  "Space Grotesk",
  "Outfit",
  "Lora",
  "Merriweather",
  "Playfair Display",
  "Fraunces",
]

const SOURCE_KEY = { heading: "headingSource", body: "bodySource" } as const

function slotFamily(theme: PortalTheme, slot: FontSlot): string | undefined {
  return theme.fonts?.[slot] ?? (theme.font === "serif" ? SERIF_FAMILY : undefined)
}

/** Drop empty keys; undefined when nothing is left. */
function compactFonts(fonts: PortalFonts): PortalFonts | undefined {
  const entries = Object.entries(fonts).filter(
    ([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
  )
  return entries.length ? (Object.fromEntries(entries) as PortalFonts) : undefined
}

export function PortalFontControls({
  theme,
  onChange,
}: {
  theme: PortalTheme
  onChange: (patch: Partial<PortalTheme>) => void
}): React.ReactElement {
  const [addingFor, setAddingFor] = useState<FontSlot | null>(null)
  const custom = theme.fonts?.custom ?? []

  const families: string[] = []
  for (const family of [
    ...FONT_SUGGESTIONS,
    ...custom.map((font) => font.family),
    // A family saved before it was in the list (typed by hand) still shows.
    slotFamily(theme, "heading"),
    slotFamily(theme, "body"),
  ]) {
    if (family && !families.includes(family)) families.push(family)
  }
  const customFamilies = new Set(custom.map((font) => font.family))

  // Writes the full fonts object. The legacy serif preset is folded into
  // explicit families first so changing one slot doesn't change the other.
  function writeFonts(next: (fonts: PortalFonts) => PortalFonts): void {
    const base: PortalFonts = {
      heading: slotFamily(theme, "heading"),
      body: slotFamily(theme, "body"),
      ...theme.fonts,
    }
    if (theme.font === "serif") {
      base.heading ??= SERIF_FAMILY
      base.body ??= SERIF_FAMILY
    }
    onChange({ font: "sans", fonts: compactFonts(next(base)) })
  }

  function selectFamily(slot: FontSlot, family: string | undefined, fonts = custom): void {
    const source = fonts.find((font) => font.family === family)?.source
    writeFonts((current) => ({
      ...current,
      custom: fonts,
      [slot]: family,
      [SOURCE_KEY[slot]]: source,
    }))
  }

  function renderSelect(slot: FontSlot, label: string): React.ReactElement {
    const value = slotFamily(theme, slot) ?? DEFAULT_FONT
    const items = [
      { value: DEFAULT_FONT, label: "Rethink Sans (default)" },
      ...families.map((family) => ({
        value: family,
        label: customFamilies.has(family) ? `${family} (custom)` : family,
      })),
      { value: ADD_FONT, label: "Add custom font…" },
    ]
    return (
      <div className="min-w-0 space-y-1.5">
        <Label>{label}</Label>
        <Select
          items={items}
          value={value}
          onValueChange={(next) => {
            if (next === ADD_FONT) {
              setAddingFor(slot)
              return
            }
            selectFamily(slot, next === DEFAULT_FONT ? undefined : (next as string))
          }}
        >
          <SelectTrigger aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72 overflow-y-auto">
            {items.map((item) => (
              <SelectItem
                key={item.value}
                value={item.value}
                className={item.value === ADD_FONT ? "mt-1 border-t border-border" : undefined}
              >
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {renderSelect("heading", "Heading font")}
        {renderSelect("body", "Body font")}
      </div>
      {addingFor ? (
        <AddCustomFontForm
          slot={addingFor}
          existing={families}
          onCancel={() => setAddingFor(null)}
          onAdd={(font) => {
            const nextCustom = [
              ...custom.filter((entry) => entry.family !== font.family),
              font,
            ]
            selectFamily(addingFor, font.family, nextCustom)
            setAddingFor(null)
          }}
        />
      ) : null}
    </div>
  )
}

function AddCustomFontForm({
  slot,
  existing,
  onCancel,
  onAdd,
}: {
  slot: FontSlot
  existing: string[]
  onCancel: () => void
  onAdd: (font: { family: string; source?: string }) => void
}): React.ReactElement {
  const [family, setFamily] = useState("")
  const [source, setSource] = useState("")
  const [error, setError] = useState<string | null>(null)

  function submit(): void {
    const parsedFamily = portalFontFamilySchema.safeParse(family)
    if (!parsedFamily.success) {
      setError("Use letters, numbers and spaces only, e.g. “Playfair Display”.")
      return
    }
    const trimmedSource = source.trim()
    if (trimmedSource && !portalFontSourceSchema.safeParse(trimmedSource).success) {
      setError("The file must be an https URL ending in .woff2, .woff, .ttf or .otf.")
      return
    }
    const name = parsedFamily.data
    if (!trimmedSource && existing.includes(name)) {
      setError(`${name} is already in the list.`)
      return
    }
    onAdd({ family: name, ...(trimmedSource ? { source: trimmedSource } : {}) })
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <p className="text-xs font-medium text-foreground">
        Add a custom {slot === "heading" ? "heading" : "body"} font
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="portal-custom-font-family">Font name</Label>
        <Input
          id="portal-custom-font-family"
          autoFocus
          value={family}
          placeholder="Playfair Display"
          onChange={(event) => {
            setFamily(event.target.value)
            setError(null)
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="portal-custom-font-source">Font file (optional)</Label>
        <Input
          id="portal-custom-font-source"
          value={source}
          placeholder="https://…/font.woff2"
          onChange={(event) => {
            setSource(event.target.value)
            setError(null)
          }}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Leave empty to load the font from Google Fonts. Add a file to host a
          licensed brand font yourself.
        </p>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={submit}>
          <Plus className="size-3.5" />
          Add font
        </Button>
      </div>
    </div>
  )
}
