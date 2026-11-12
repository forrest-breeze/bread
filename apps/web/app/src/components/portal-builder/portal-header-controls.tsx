"use client"

import { useState, type DragEvent } from "react"
import { ArrowLeft, ArrowRight, GripVertical, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { setHeader, setTheme } from "@/lib/portal/builder-ops"
import {
  DEFAULT_PORTAL_HEADER_ITEM_ORDER,
  type NavLink,
  type PortalHeaderItem,
  type PortalLayout,
  type PortalTheme,
} from "@/lib/portal/schema"
import type { PortalChromeScope } from "@/lib/workspace-settings"
import { cn } from "@/lib/utils"

interface PortalHeaderControlsProps {
  layout: PortalLayout
  onLayoutChange: (layout: PortalLayout) => void
  onSharedLayoutChange: (layout: PortalLayout) => void
  chromeScope: PortalChromeScope
}

const HEADER_ITEM_LABELS: Record<PortalHeaderItem, string> = {
  links: "Header links",
  cta: "Action button",
  language: "Language selector",
}

function HeaderLinkFields({
  link,
  idPrefix,
  onCommit,
  onRemove,
}: {
  link: NavLink
  idPrefix: string
  onCommit: (link: NavLink) => void
  onRemove?: () => void
}): React.ReactElement {
  const [label, setLabel] = useState(link.label)
  const [href, setHref] = useState(link.href)

  const commit = (): void => {
    if (label === link.label && href === link.href) return
    onCommit({ label, href })
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <Label htmlFor={`${idPrefix}-label`} className="flex-1 text-xs text-muted-foreground">
          Label
        </Label>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove header link"
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <Input
        id={`${idPrefix}-label`}
        value={label}
        maxLength={60}
        placeholder="Link label"
        onChange={(event) => setLabel(event.target.value)}
        onBlur={commit}
      />
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-url`} className="text-xs text-muted-foreground">
          URL
        </Label>
        <Input
          id={`${idPrefix}-url`}
          type="url"
          value={href}
          maxLength={2048}
          placeholder="https://example.com"
          onChange={(event) => setHref(event.target.value)}
          onBlur={commit}
        />
      </div>
    </div>
  )
}

export function PortalHeaderControls({
  layout,
  onLayoutChange,
  onSharedLayoutChange,
  chromeScope,
}: PortalHeaderControlsProps): React.ReactElement {
  const [error, setError] = useState<string | null>(null)
  const [draggedItem, setDraggedItem] = useState<PortalHeaderItem | null>(null)
  const [dropTargetItem, setDropTargetItem] = useState<PortalHeaderItem | null>(null)
  const { theme, header } = layout
  const usesWorkspaceChrome = chromeScope === "workspace"
  const commitLayout = usesWorkspaceChrome ? onSharedLayoutChange : onLayoutChange

  const patchTheme = (patch: Partial<PortalTheme>): void => {
    try {
      setError(null)
      commitLayout(setTheme(layout, patch))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed")
    }
  }

  const patchHeader = (
    patch: Partial<Pick<typeof header, "search" | "itemOrder">>,
  ): void => {
    try {
      setError(null)
      commitLayout(setHeader(layout, patch))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed")
    }
  }

  const patchSearch = (patch: Partial<typeof header.search>): void => {
    patchHeader({ search: { ...header.search, ...patch } })
  }

  const itemOrder = header.itemOrder ?? DEFAULT_PORTAL_HEADER_ITEM_ORDER

  const moveHeaderItem = (item: PortalHeaderItem, offset: -1 | 1): void => {
    const from = itemOrder.indexOf(item)
    const to = from + offset
    if (from < 0 || to < 0 || to >= itemOrder.length) return
    const nextOrder = [...itemOrder]
    ;[nextOrder[from], nextOrder[to]] = [nextOrder[to], nextOrder[from]]
    patchHeader({ itemOrder: nextOrder })
  }

  const reorderHeaderItem = (
    item: PortalHeaderItem,
    targetItem: PortalHeaderItem,
  ): void => {
    const from = itemOrder.indexOf(item)
    const to = itemOrder.indexOf(targetItem)
    if (from < 0 || to < 0 || from === to) return

    const nextOrder = [...itemOrder]
    nextOrder.splice(from, 1)
    nextOrder.splice(to, 0, item)
    patchHeader({ itemOrder: nextOrder })
  }

  const startDraggingHeaderItem = (
    event: DragEvent<HTMLButtonElement>,
    item: PortalHeaderItem,
  ): void => {
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", item)
    setDraggedItem(item)
  }

  const stopDraggingHeaderItem = (): void => {
    setDraggedItem(null)
    setDropTargetItem(null)
  }

  return (
    <div className="flex flex-col gap-5">
      {usesWorkspaceChrome ? (
        <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
          Editing this shared workspace header updates every portal project.
        </p>
      ) : null}

      <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="portal-header-search">Header search</Label>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Show search in the center of the portal header.
          </p>
        </div>
        <Switch
          id="portal-header-search"
          checked={header.search.enabled}
          onCheckedChange={(enabled) => patchSearch({ enabled })}
        />
      </div>

      {header.search.enabled ? (
        <div className="space-y-1.5">
          <Label htmlFor="portal-header-search-placeholder">Search placeholder</Label>
          <Input
            id="portal-header-search-placeholder"
            value={header.search.placeholder}
            maxLength={120}
            onChange={(event) => patchSearch({ placeholder: event.target.value })}
          />
        </div>
      ) : null}

      <div className="space-y-3 border-t border-border pt-5">
        <div>
          <Label>Header item order</Label>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Items are listed in their left-to-right order. Drag the cards to move
            links, the action button, and the language selector when it is on the
            far right. Choose the selector&apos;s header region under Languages.
            The arrows remain available for keyboard-friendly reordering.
          </p>
        </div>
        <div className="space-y-2" aria-label="Header item order">
          {itemOrder.map((item, index) => (
            <div
              key={item}
              data-testid={`header-order-${item}`}
              className={cn(
                "flex items-center gap-2 rounded-lg border border-border bg-muted/20 p-2 transition-colors",
                draggedItem === item && "opacity-50",
                draggedItem !== item &&
                  dropTargetItem === item &&
                  "border-primary bg-primary/5",
              )}
              onDragOver={(event) => {
                if (!draggedItem || draggedItem === item) return
                event.preventDefault()
                event.dataTransfer.dropEffect = "move"
                setDropTargetItem(item)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (draggedItem) reorderHeaderItem(draggedItem, item)
                stopDraggingHeaderItem()
              }}
            >
              <button
                type="button"
                draggable
                aria-label={`Drag ${HEADER_ITEM_LABELS[item]}`}
                title={`Drag ${HEADER_ITEM_LABELS[item]} to reorder`}
                className="flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onDragStart={(event) => startDraggingHeaderItem(event, item)}
                onDragEnd={stopDraggingHeaderItem}
              >
                <GripVertical className="size-4" />
              </button>
              <span className="min-w-0 flex-1 px-1 text-sm font-medium">
                {HEADER_ITEM_LABELS[item]}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={index === 0}
                aria-label={`Move ${HEADER_ITEM_LABELS[item]} left`}
                onClick={() => moveHeaderItem(item, -1)}
              >
                <ArrowLeft className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={index === itemOrder.length - 1}
                aria-label={`Move ${HEADER_ITEM_LABELS[item]} right`}
                onClick={() => moveHeaderItem(item, 1)}
              >
                <ArrowRight className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <Label>Header links</Label>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            Add up to eight links to your website, pricing, contact page, or other resources.
          </p>
        </div>
        {theme.navLinks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
            No header links yet.
          </p>
        ) : null}
        {theme.navLinks.map((link, index) => (
          <HeaderLinkFields
            key={`${index}:${link.href}`}
            link={link}
            idPrefix={`portal-header-link-${index}`}
            onCommit={(nextLink) => {
              const navLinks = theme.navLinks.map((candidate, candidateIndex) =>
                candidateIndex === index ? nextLink : candidate,
              )
              patchTheme({ navLinks })
            }}
            onRemove={() =>
              patchTheme({
                navLinks: theme.navLinks.filter((_, candidateIndex) => candidateIndex !== index),
              })
            }
          />
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={theme.navLinks.length >= 8}
          onClick={() =>
            patchTheme({
              navLinks: [
                ...theme.navLinks,
                { label: "Website", href: "https://example.com" },
              ],
            })
          }
        >
          <Plus className="size-3.5" />
          Add link
        </Button>
      </div>

      <div className="space-y-3 border-t border-border pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="portal-header-cta">Header button</Label>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              A prominent action such as Contact us or Visit website.
            </p>
          </div>
          <Switch
            id="portal-header-cta"
            checked={theme.cta !== null}
            onCheckedChange={(checked) =>
              patchTheme({
                cta: checked
                  ? theme.cta ?? { label: "Contact us", href: "https://example.com/contact" }
                  : null,
              })
            }
          />
        </div>
        {theme.cta ? (
          <HeaderLinkFields
            key={`cta:${theme.cta.href}`}
            link={theme.cta}
            idPrefix="portal-header-cta"
            onCommit={(cta) => patchTheme({ cta })}
          />
        ) : null}
      </div>

      {error ? (
        <p className={cn("text-sm text-destructive")}>{error}</p>
      ) : null}
    </div>
  )
}
