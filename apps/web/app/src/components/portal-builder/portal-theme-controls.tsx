"use client"

import { useRef, useState } from "react"
import {
  ImageIcon,
  Loader2,
  Moon,
  Sun,
  Trash2,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { uploadPortalLogo } from "@/lib/api/portal"
import { PortalFontControls } from "@/components/portal-builder/portal-font-controls"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  setFooterPoweredBy,
  setTheme,
} from "@/lib/portal/builder-ops"
import {
  PORTAL_BACKGROUND_DECORATIONS,
  PORTAL_BANNER_TONES,
  type PortalBackground,
  type PortalBanner,
  type PortalLayout,
  type PortalTheme,
} from "@/lib/portal/schema"

// ---------------------------------------------------------------------------
// Theme panel — edits the layout's PortalTheme (branding + appearance) via the
// pure `setTheme` builder-op. Each change re-validates through the op; a schema
// rejection surfaces inline rather than corrupting the buffer.
// ---------------------------------------------------------------------------

interface PortalThemeControlsProps {
  layout: PortalLayout
  onLayoutChange: (layout: PortalLayout) => void
  /** The workspace's logo, shown as the default when the project sets none. */
  workspaceLogoUrl?: string
  /** Enterprise entitlement for removing the Bread footer credit. */
  canRemoveBreadBranding?: boolean
  className?: string
}

type ImageSlot = "light" | "dark" | "favicon"

function DeferredTextField({
  id,
  value,
  maxLength,
  placeholder,
  onEdit,
  onCommit,
}: {
  id: string
  value: string
  maxLength: number
  placeholder?: string
  onEdit: () => void
  onCommit: (value: string) => void
}): React.ReactElement {
  const [draft, setDraft] = useState(value)

  return (
    <Input
      id={id}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      className="h-11"
      onChange={(event) => {
        setDraft(event.target.value)
        onEdit()
      }}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function LogoUploadCard({
  slot,
  label,
  imageUrl,
  hasCustomImage,
  circular,
  uploading,
  dragActive,
  inputRef,
  onDragActiveChange,
  onFile,
  onRemove,
}: {
  slot: "light" | "dark"
  label: string
  imageUrl?: string
  hasCustomImage: boolean
  circular: boolean
  uploading: boolean
  dragActive: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  onDragActiveChange: (active: boolean) => void
  onFile: (file: File) => void
  onRemove: () => void
}): React.ReactElement {
  const ModeIcon = slot === "light" ? Sun : Moon
  const isDark = slot === "dark"

  function openPicker(): void {
    if (!uploading) inputRef.current?.click()
  }

  return (
    <div className="min-w-0 space-y-2">
      <div
        role="button"
        tabIndex={0}
        aria-label={`${label} logo. Click to upload.`}
        aria-busy={uploading}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            openPicker()
          }
        }}
        onDragOver={(event) => {
          event.preventDefault()
          onDragActiveChange(true)
        }}
        onDragLeave={() => onDragActiveChange(false)}
        onDrop={(event) => {
          event.preventDefault()
          onDragActiveChange(false)
          const file = event.dataTransfer.files?.[0]
          if (file) onFile(file)
        }}
        className={cn(
          "group relative flex min-h-28 cursor-pointer items-center justify-center overflow-hidden rounded-xl border p-3 text-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          isDark
            ? "border-zinc-600 bg-[#252525] text-zinc-100"
            : "border-border bg-muted/70 text-foreground",
          dragActive && "border-primary ring-2 ring-primary/20",
        )}
      >
        {uploading ? (
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        ) : imageUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt=""
              className={cn(
                "max-h-20 max-w-[78%] object-contain",
                // Inset inside the circle so the logo's corners aren't clipped.
                circular && "aspect-square rounded-full bg-muted p-[15%]",
              )}
            />
            {hasCustomImage ? (
              <button
                type="button"
                className="absolute left-1/2 top-1/2 flex h-9 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-xl border border-border bg-background/95 px-3 text-xs font-medium text-foreground opacity-0 shadow-sm transition-opacity pointer-events-none hover:bg-background focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove()
                }}
              >
                <Trash2 className="size-3.5 text-destructive" />
                Remove
              </button>
            ) : null}
          </>
        ) : (
          <div className="space-y-2">
            <ImageIcon
              className={cn(
                "mx-auto size-7",
                isDark ? "text-zinc-500" : "text-muted-foreground",
              )}
            />
            <p className="text-xs leading-relaxed">
              Drop an image or{" "}
              <span className="font-medium text-violet-500">click to browse</span>
            </p>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ModeIcon className="size-4" />
        <span>{label}</span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        aria-label={`${label} logo upload`}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
          event.target.value = ""
        }}
      />
    </div>
  )
}

// ----- colors ---------------------------------------------------------------

const HEX_RE = /^#[0-9a-fA-F]{6}$/

const DECORATION_LABELS: Record<(typeof PORTAL_BACKGROUND_DECORATIONS)[number], string> = {
  none: "None",
  gradient: "Accent glow",
  grid: "Grid",
}

const BANNER_TONE_LABELS: Record<(typeof PORTAL_BANNER_TONES)[number], string> = {
  brand: "Accent color",
  info: "Info",
  warning: "Warning",
  critical: "Critical",
}

/** Drop empty keys; undefined when nothing is left. */
function compact<T extends Record<string, unknown>>(value: T): T | undefined {
  const entries = Object.entries(value).filter(
    ([, v]) => v !== undefined && v !== "",
  )
  return entries.length ? (Object.fromEntries(entries) as T) : undefined
}

/**
 * Hex color picker + text field. Typing commits only complete hex values, so a
 * half-typed color never fails validation; `optional` adds a clear button.
 */
function ColorField({
  id,
  label,
  value,
  fallback,
  optional = false,
  onChange,
}: {
  id: string
  label: string
  value: string | undefined
  /** Swatch shown while unset. */
  fallback: string
  optional?: boolean
  onChange: (value: string | undefined) => void
}): React.ReactElement {
  const [draft, setDraft] = useState(value ?? "")
  const [synced, setSynced] = useState(value)
  if (value !== synced) {
    setSynced(value)
    setDraft(value ?? "")
  }
  const swatch = value && HEX_RE.test(value) ? value : fallback

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={swatch}
          onChange={(event) => onChange(event.target.value)}
          className="size-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
        />
        <Input
          id={id}
          value={draft}
          placeholder={optional ? "Default" : fallback}
          onChange={(event) => {
            const next = event.target.value.trim()
            setDraft(next)
            if (HEX_RE.test(next)) onChange(next)
          }}
          onBlur={() => {
            if (optional && draft === "") onChange(undefined)
            else if (!HEX_RE.test(draft)) setDraft(value ?? "")
          }}
          className="flex-1"
        />
        {optional && value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Reset ${label.toLowerCase()}`}
            onClick={() => onChange(undefined)}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** Google Fonts family field with suggestions; commits on blur / Enter. */
function SwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): React.ReactElement {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  )
}

function BannerFields({
  banner,
  onChange,
}: {
  banner: PortalBanner
  onChange: (banner: PortalBanner) => void
}): React.ReactElement {
  const [text, setText] = useState(banner.text)
  const [linkLabel, setLinkLabel] = useState(banner.linkLabel ?? "")
  const [linkHref, setLinkHref] = useState(banner.linkHref ?? "")
  const commit = (next: Partial<PortalBanner>) => {
    const merged = { ...banner, ...next }
    onChange({
      text: merged.text.trim() || banner.text,
      tone: merged.tone,
      dismissible: merged.dismissible,
      ...(merged.linkLabel?.trim() && merged.linkHref?.trim()
        ? { linkLabel: merged.linkLabel.trim(), linkHref: merged.linkHref.trim() }
        : {}),
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="portal-banner-text">Message</Label>
        <Input
          id="portal-banner-text"
          value={text}
          maxLength={240}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => commit({ text })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="portal-banner-link-label">Link text</Label>
          <Input
            id="portal-banner-link-label"
            value={linkLabel}
            maxLength={40}
            placeholder="Learn more"
            onChange={(event) => setLinkLabel(event.target.value)}
            onBlur={() => commit({ linkLabel, linkHref })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="portal-banner-link-href">Link URL</Label>
          <Input
            id="portal-banner-link-href"
            value={linkHref}
            placeholder="https://"
            onChange={(event) => setLinkHref(event.target.value)}
            onBlur={() => commit({ linkLabel, linkHref })}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Style</Label>
        <Select
          value={banner.tone ?? "brand"}
          onValueChange={(value) => commit({ tone: value as PortalBanner["tone"] })}
        >
          <SelectTrigger aria-label="Banner style">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PORTAL_BANNER_TONES.map((tone) => (
              <SelectItem key={tone} value={tone}>
                {BANNER_TONE_LABELS[tone]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <SwitchRow
        id="portal-banner-dismissible"
        label="Dismissible"
        description="Let visitors close the banner."
        checked={banner.dismissible === true}
        onCheckedChange={(checked) => commit({ dismissible: checked })}
      />
    </div>
  )
}

export function PortalThemeControls({
  layout,
  onLayoutChange,
  workspaceLogoUrl,
  canRemoveBreadBranding = false,
  className,
}: PortalThemeControlsProps): React.ReactElement {
  const [error, setError] = useState<string | null>(null)
  const [uploadingSlot, setUploadingSlot] = useState<ImageSlot | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragActiveSlot, setDragActiveSlot] = useState<ImageSlot | null>(null)
  const lightLogoInputRef = useRef<HTMLInputElement>(null)
  const darkLogoInputRef = useRef<HTMLInputElement>(null)
  const faviconInputRef = useRef<HTMLInputElement>(null)
  const { theme } = layout
  const logoText = theme.logoText ?? theme.brandName
  const faviconPreviewUrl =
    theme.faviconUrl || workspaceLogoUrl || theme.logoUrl || undefined

  function patch(themePatch: Partial<PortalTheme>): void {
    try {
      setError(null)
      onLayoutChange(setTheme(layout, themePatch))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed")
    }
  }

  function commitLogoText(nextLogoText: string): void {
    if (nextLogoText === logoText) {
      setError(null)
      return
    }
    // Keep the portal's required internal name aligned when visible text is
    // entered, while allowing an empty logoText to hide header copy.
    patch({
      logoText: nextLogoText,
      ...(nextLogoText.trim() ? { brandName: nextLogoText } : {}),
    })
  }

  function commitLogoLink(logoLink: string): void {
    const normalized = logoLink.trim()
    if (normalized === (theme.logoLink ?? "")) {
      setError(null)
      return
    }
    patch({ logoLink: normalized })
  }

  async function handleImageFile(slot: ImageSlot, file: File): Promise<void> {
    setUploadError(null)
    setUploadingSlot(slot)
    try {
      const url = await uploadPortalLogo(file)
      if (slot === "light") patch({ logoUrl: url })
      if (slot === "dark") patch({ darkLogoUrl: url })
      if (slot === "favicon") patch({ faviconUrl: url })
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploadingSlot(null)
    }
  }

  // A color <input> needs a valid 7-char hex; fall back so a partially-typed or
  // named color in the text field doesn't crash the swatch.
  const swatchValue = /^#[0-9a-fA-F]{6}$/.test(theme.accentColor)
    ? theme.accentColor
    : "#2f5520"
  const showPoweredBy = layout.footer?.showPoweredBy !== false

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      <section className="space-y-5">
        <div className="space-y-1">
          <Label className="text-sm font-medium">Logo</Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The image that appears in the header of the portal.
            Recommended size: 512×512 pixels.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <LogoUploadCard
            slot="light"
            label="Light mode"
            imageUrl={theme.logoUrl || workspaceLogoUrl}
            hasCustomImage={Boolean(theme.logoUrl)}
            circular={theme.circularLogo === true}
            uploading={uploadingSlot === "light"}
            dragActive={dragActiveSlot === "light"}
            inputRef={lightLogoInputRef}
            onDragActiveChange={(active) =>
              setDragActiveSlot(active ? "light" : null)
            }
            onFile={(file) => void handleImageFile("light", file)}
            onRemove={() => patch({ logoUrl: "" })}
          />
          <LogoUploadCard
            slot="dark"
            label="Dark mode"
            imageUrl={theme.darkLogoUrl}
            hasCustomImage={Boolean(theme.darkLogoUrl)}
            circular={theme.circularLogo === true}
            uploading={uploadingSlot === "dark"}
            dragActive={dragActiveSlot === "dark"}
            inputRef={darkLogoInputRef}
            onDragActiveChange={(active) =>
              setDragActiveSlot(active ? "dark" : null)
            }
            onFile={(file) => void handleImageFile("dark", file)}
            onRemove={() => patch({ darkLogoUrl: "" })}
          />
        </div>

        <div className="flex items-center gap-3">
          <Switch
            id="portal-circular-logo"
            checked={theme.circularLogo === true}
            onCheckedChange={(checked) => patch({ circularLogo: checked })}
            aria-label="Circular Logo"
          />
          <Label htmlFor="portal-circular-logo" className="text-sm font-medium">
            Circular Logo
          </Label>
        </div>

        <div className="space-y-1.5">
          <Label>Logo size</Label>
          <Select
            value={theme.logoSize ?? "md"}
            onValueChange={(value) =>
              patch({ logoSize: value === "md" ? undefined : (value as PortalTheme["logoSize"]) })
            }
          >
            <SelectTrigger aria-label="Logo size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sm">Small</SelectItem>
              <SelectItem value="md">Medium</SelectItem>
              <SelectItem value="lg">Large</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="portal-logo-text">Logo Text</Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The text that appears next to your logo. Leave empty to hide.
          </p>
          <DeferredTextField
            key={logoText}
            id="portal-logo-text"
            value={logoText}
            maxLength={80}
            onEdit={() => setError(null)}
            onCommit={commitLogoText}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="portal-logo-link">Logo Link</Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The URL your logo redirects to when clicked. Leave empty to link to
            the portal home page.
          </p>
          <DeferredTextField
            key={theme.logoLink ?? ""}
            id="portal-logo-link"
            value={theme.logoLink ?? ""}
            maxLength={2048}
            placeholder="Leave empty for home"
            onEdit={() => setError(null)}
            onCommit={commitLogoLink}
          />
        </div>

        <div className="space-y-1.5">
          <Label>Favicon</Label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The image that appears in the browser tab. Leave empty to use the
            workspace logo. Recommended size: 16×16 pixels.
          </p>
          <div
            role="button"
            tabIndex={0}
            aria-label="Favicon. Click to upload."
            aria-busy={uploadingSlot === "favicon"}
            onClick={() => {
              if (uploadingSlot !== "favicon") faviconInputRef.current?.click()
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                faviconInputRef.current?.click()
              }
            }}
            onDragOver={(event) => {
              event.preventDefault()
              setDragActiveSlot("favicon")
            }}
            onDragLeave={() => setDragActiveSlot(null)}
            onDrop={(event) => {
              event.preventDefault()
              setDragActiveSlot(null)
              const file = event.dataTransfer.files?.[0]
              if (file) void handleImageFile("favicon", file)
            }}
            className={cn(
              "group relative flex min-h-36 cursor-pointer items-center justify-center rounded-xl border border-dashed border-input p-5 text-center transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              dragActiveSlot === "favicon" &&
                "border-primary bg-muted/40 ring-2 ring-primary/20",
            )}
          >
            {uploadingSlot === "favicon" ? (
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            ) : faviconPreviewUrl ? (
              <>
                <span
                  className={cn(
                    "block size-16 overflow-hidden bg-muted",
                    theme.faviconShape === "circle"
                      ? "rounded-full"
                      : "rounded-xl",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={faviconPreviewUrl}
                    alt=""
                    className={cn(
                      "size-full object-contain",
                      theme.faviconShape === "circle" ? "p-[15%]" : "p-[6%]",
                    )}
                  />
                </span>
                {theme.faviconUrl ? (
                  <button
                    type="button"
                    className="absolute left-1/2 top-1/2 flex h-9 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-xl border border-border bg-background/95 px-3 text-xs font-medium opacity-0 shadow-sm transition-opacity pointer-events-none hover:bg-background focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation()
                      patch({ faviconUrl: "" })
                    }}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                    Remove
                  </button>
                ) : null}
              </>
            ) : (
              <div className="space-y-2">
                <ImageIcon className="mx-auto size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Drop an image or{" "}
                  <span className="font-medium text-violet-500">
                    click to browse
                  </span>
                </p>
                <p className="text-xs text-muted-foreground/80">
                  Supports PNG, JPG, SVG
                </p>
              </div>
            )}
          </div>
          <input
            ref={faviconInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            aria-label="Favicon upload"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleImageFile("favicon", file)
              event.target.value = ""
            }}
          />
          <div className="flex items-center gap-3 pt-1">
            <Switch
              id="portal-circular-favicon"
              checked={theme.faviconShape === "circle"}
              onCheckedChange={(checked) =>
                patch({ faviconShape: checked ? "circle" : "rounded" })
              }
              aria-label="Circular Favicon"
            />
            <div className="space-y-0.5">
              <Label
                htmlFor="portal-circular-favicon"
                className="text-sm font-medium"
              >
                Circular Favicon
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Off uses rounded corners.
              </p>
            </div>
          </div>
        </div>

        {uploadError ? (
          <p className="text-xs text-destructive">{uploadError}</p>
        ) : null}
      </section>

      <section className="space-y-4 border-t border-border pt-5">
        <p className="text-sm font-semibold text-foreground">Theme</p>

        <div className="space-y-1.5">
          <Label htmlFor="portal-tagline">Tagline</Label>
          <Input
            id="portal-tagline"
            value={theme.tagline}
            placeholder="A short description of your knowledge base"
            onChange={(event) => patch({ tagline: event.target.value })}
          />
        </div>

        <ColorField
          id="portal-accent"
          label="Accent color"
          value={HEX_RE.test(theme.accentColor) ? theme.accentColor : undefined}
          fallback={swatchValue}
          onChange={(value) => value && patch({ accentColor: value })}
        />
        <ColorField
          id="portal-accent-dark"
          label="Dark mode accent"
          value={theme.accentColorDark}
          fallback={swatchValue}
          optional
          onChange={(value) => patch({ accentColorDark: value })}
        />
        <div className="grid grid-cols-2 gap-3">
          <ColorField
            id="portal-bg-light"
            label="Background (light)"
            value={theme.background?.light}
            fallback="#ffffff"
            optional
            onChange={(value) =>
              patch({ background: compact<PortalBackground>({ ...theme.background, light: value }) })
            }
          />
          <ColorField
            id="portal-bg-dark"
            label="Background (dark)"
            value={theme.background?.dark}
            fallback="#0a0a0a"
            optional
            onChange={(value) =>
              patch({ background: compact<PortalBackground>({ ...theme.background, dark: value }) })
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label>Background decoration</Label>
          <Select
            value={theme.background?.decoration ?? "none"}
            onValueChange={(value) =>
              patch({
                background: compact<PortalBackground>({
                  ...theme.background,
                  decoration:
                    value === "none" ? undefined : (value as PortalBackground["decoration"]),
                }),
              })
            }
          >
            <SelectTrigger aria-label="Background decoration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PORTAL_BACKGROUND_DECORATIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {DECORATION_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <PortalFontControls theme={theme} onChange={patch} />

        <div className="space-y-1.5">
          <Label>Code blocks</Label>
          <Select
            value={theme.codeBlocks ?? "dark"}
            onValueChange={(value) =>
              patch({ codeBlocks: value === "system" ? "system" : undefined })
            }
          >
            <SelectTrigger aria-label="Code blocks">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">Always dark</SelectItem>
              <SelectItem value="system">Match light/dark mode</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <SwitchRow
          id="portal-last-updated"
          label="Show last updated date"
          description="Display when each document was last updated."
          checked={theme.showLastUpdated !== false}
          onCheckedChange={(checked) => patch({ showLastUpdated: checked ? undefined : false })}
        />
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-muted/30 p-3">
        <SwitchRow
          id="portal-banner"
          label="Announcement banner"
          description="A bar above the header for launches, incidents, or notices."
          checked={Boolean(theme.banner)}
          onCheckedChange={(checked) =>
            patch({
              banner: checked
                ? { text: "We just shipped something new.", tone: "brand", dismissible: true }
                : undefined,
            })
          }
        />
        {theme.banner ? (
          <BannerFields
            banner={theme.banner}
            onChange={(banner) => patch({ banner })}
          />
        ) : null}
      </section>

      {canRemoveBreadBranding ? (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="portal-powered-by">Show Powered by Bread</Label>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Controls the Bread credit in the public portal footer.
            </p>
          </div>
          <Switch
            id="portal-powered-by"
            checked={showPoweredBy}
            onCheckedChange={(checked) => {
              try {
                setError(null)
                onLayoutChange(setFooterPoweredBy(layout, checked))
              } catch (err) {
                setError(err instanceof Error ? err.message : "Operation failed")
              }
            }}
            aria-label="Show Powered by Bread"
          />
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
