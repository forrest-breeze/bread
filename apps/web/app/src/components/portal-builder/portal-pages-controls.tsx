"use client"

import { useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  FileText,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { setPages } from "@/lib/portal/builder-ops"
import {
  portalPagePresentation,
  type PortalLayout,
  type PortalPage,
  type PortalPagePresentation,
} from "@/lib/portal/schema"
import type { PortalScopeEntry } from "@/lib/public-kb"
import { cn } from "@/lib/utils"

interface PortalPagesControlsProps {
  layout: PortalLayout
  activePageSlug: string | null
  onLayoutChange: (layout: PortalLayout) => void
  /** Keeps the external page switcher valid after a rename or removal. */
  onActivePageChange: (pageSlug: string | null) => void
}

interface PageEditorState {
  pageId: string | null
  title: string
  slug: string
  /** Preserved here, but edited only from the Included docs panel. */
  scope: PortalScopeEntry[] | null
  presentation: PortalPagePresentation
  slugEdited: boolean
}

const PAGE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/
const MAX_PORTAL_PAGES = 8

// Single source for the layout picker and the saved-page summary line, so a new
// presentation only has to be described once.
const PAGE_PRESENTATION_OPTIONS: ReadonlyArray<{
  value: PortalPagePresentation
  label: string
}> = [
  { value: "landing", label: "Documents" },
  { value: "api_reference", label: "API reference" },
  { value: "changelog", label: "Changelog" },
]

// Miniature wireframes stand in for prose descriptions: the picker reads as a
// shape, which is what the layout actually changes.
function PresentationSkeleton({
  presentation,
}: {
  presentation: PortalPagePresentation
}): React.ReactElement {
  const frame =
    "h-9 w-14 shrink-0 rounded-[3px] border border-border bg-background p-1"
  if (presentation === "api_reference") {
    return (
      <div className={cn(frame, "flex gap-1")} aria-hidden="true">
        <div className="flex w-2 flex-col gap-[3px]">
          <div className="h-[2px] rounded-full bg-foreground/25" />
          <div className="h-[2px] rounded-full bg-foreground/25" />
          <div className="h-[2px] rounded-full bg-foreground/25" />
        </div>
        <div className="flex flex-1 flex-col gap-[3px]">
          <div className="h-[3px] w-3/4 rounded-full bg-foreground/50" />
          <div className="flex-1 rounded-[2px] bg-foreground/15" />
        </div>
        <div className="flex w-1.5 flex-col gap-[3px]">
          <div className="h-[2px] rounded-full bg-foreground/25" />
          <div className="h-[2px] rounded-full bg-foreground/25" />
        </div>
      </div>
    )
  }
  if (presentation === "changelog") {
    return (
      <div
        className={cn(frame, "flex flex-col justify-between")}
        aria-hidden="true"
      >
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-1">
            <div className="size-1 shrink-0 rounded-full bg-foreground/50" />
            <div className="h-[3px] flex-1 rounded-full bg-foreground/20" />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className={cn(frame, "flex flex-col gap-1")} aria-hidden="true">
      <div className="h-2 rounded-[2px] bg-foreground/40" />
      <div className="h-[2px] rounded-full bg-foreground/20" />
      <div className="h-[2px] rounded-full bg-foreground/20" />
      <div className="h-[2px] w-3/4 rounded-full bg-foreground/20" />
    </div>
  )
}

function presentationLabel(presentation: PortalPagePresentation): string {
  return (
    PAGE_PRESENTATION_OPTIONS.find((option) => option.value === presentation)
      ?.label ?? "Documents"
  )
}

function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "")
}

function pageEditorState(page: PortalPage): PageEditorState {
  return {
    pageId: page.id,
    title: page.title,
    slug: page.slug,
    scope: page.scope ?? null,
    presentation: portalPagePresentation(page),
    slugEdited: true,
  }
}

function unusedPageId(pages: PortalPage[], slug: string): string {
  const base = `page-${slug}`
  const taken = new Set(pages.map((page) => page.id))
  if (!taken.has(base)) return base
  let suffix = 2
  while (taken.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

export function PortalPagesControls({
  layout,
  activePageSlug,
  onLayoutChange,
  onActivePageChange,
}: PortalPagesControlsProps): React.ReactElement {
  const pages = layout.pages ?? []
  const [editor, setEditor] = useState<PageEditorState | null>(null)

  const slugTaken =
    editor !== null &&
    pages.some((page) => page.id !== editor.pageId && page.slug === editor.slug)
  const editorValid =
    editor !== null &&
    editor.title.trim().length > 0 &&
    PAGE_SLUG_RE.test(editor.slug) &&
    !slugTaken

  function beginCreate(): void {
    setEditor({
      pageId: null,
      title: "",
      slug: "",
      // Pages are fail-closed until their content is assigned from Included docs.
      scope: [],
      presentation: "landing",
      slugEdited: false,
    })
  }

  function beginEdit(page: PortalPage): void {
    setEditor(pageEditorState(page))
  }

  function saveEditor(): void {
    if (!editor || !editorValid) return
    const page: PortalPage = {
      id: editor.pageId ?? unusedPageId(pages, editor.slug),
      title: editor.title.trim(),
      slug: editor.slug,
      scope: editor.scope,
      presentation: editor.presentation,
    }
    const next = editor.pageId
      ? pages.map((candidate) =>
          candidate.id === editor.pageId ? page : candidate,
        )
      : [...pages, page]
    onLayoutChange(setPages(layout, next))
    const previous = editor.pageId
      ? pages.find((candidate) => candidate.id === editor.pageId)
      : null
    if (
      previous &&
      activePageSlug === previous.slug &&
      previous.slug !== page.slug
    ) {
      onActivePageChange(page.slug)
    }
    setEditor(null)
  }

  function removePage(page: PortalPage): void {
    onLayoutChange(
      setPages(
        layout,
        pages.filter((candidate) => candidate.id !== page.id),
      ),
    )
    if (activePageSlug === page.slug) onActivePageChange(null)
    if (editor?.pageId === page.id) setEditor(null)
  }

  function movePage(index: number, offset: -1 | 1): void {
    const target = index + offset
    if (target < 0 || target >= pages.length) return
    const next = [...pages]
    const current = next[index]
    const replacement = next[target]
    if (!current || !replacement) return
    next[index] = replacement
    next[target] = current
    onLayoutChange(setPages(layout, next))
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-muted-foreground">
          Create up to eight pages and choose how each one is presented. Assign
          their content from Included docs.
        </p>
      </div>

      <div className="space-y-2">
        {pages.map((page, index) => {
          const active = page.slug === activePageSlug
          return (
            <div
              key={page.id}
              className={cn(
                "rounded-lg border p-2",
                active ? "border-primary/50 bg-primary/5" : "border-border",
              )}
            >
              <div className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {page.title}
                    </span>
                    {active ? (
                      <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        In preview
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {presentationLabel(portalPagePresentation(page))} · /page/
                    {page.slug}
                  </span>
                </span>
              </div>
              <div className="mt-1 flex justify-end gap-1 border-t border-border/70 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${page.title} up`}
                  disabled={index === 0}
                  onClick={() => movePage(index, -1)}
                >
                  <ChevronUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${page.title} down`}
                  disabled={index === pages.length - 1}
                  onClick={() => movePage(index, 1)}
                >
                  <ChevronDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${page.title}`}
                  onClick={() => beginEdit(page)}
                >
                  <Pencil />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${page.title}`}
                  onClick={() => removePage(page)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          )
        })}
      </div>

      {editor ? (
        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
          <p className="text-xs font-semibold">
            {editor.pageId ? "Edit page" : "New page"}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="portal-page-title">Navigation label</Label>
            <Input
              id="portal-page-title"
              value={editor.title}
              maxLength={60}
              placeholder="API Reference"
              onChange={(event) => {
                const title = event.target.value
                setEditor((current) =>
                  current
                    ? {
                        ...current,
                        title,
                        slug: current.slugEdited
                          ? current.slug
                          : slugFromTitle(title),
                      }
                    : current,
                )
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="portal-page-slug">URL path</Label>
            <div className="flex items-center rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring/40">
              <span className="pl-3 text-xs text-muted-foreground">/page/</span>
              <input
                id="portal-page-slug"
                value={editor.slug}
                maxLength={50}
                className="h-8 min-w-0 flex-1 bg-transparent px-1.5 text-sm outline-none"
                onChange={(event) =>
                  setEditor((current) =>
                    current
                      ? {
                          ...current,
                          slug: event.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9-]/g, ""),
                          slugEdited: true,
                        }
                      : current,
                  )
                }
              />
            </div>
            {slugTaken ? (
              <p className="text-[11px] text-destructive">
                Another page already uses this path.
              </p>
            ) : editor.slug && !PAGE_SLUG_RE.test(editor.slug) ? (
              <p className="text-[11px] text-destructive">
                Use lowercase letters, numbers, and single hyphens.
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Page layout</Label>
            <div className="flex flex-col gap-2">
              {PAGE_PRESENTATION_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={editor.presentation === option.value}
                  onClick={() =>
                    setEditor((current) =>
                      current
                        ? { ...current, presentation: option.value }
                        : current,
                    )
                  }
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors",
                    editor.presentation === option.value
                      ? "border-primary/50 bg-primary/5"
                      : "border-border bg-background hover:bg-muted/60",
                  )}
                >
                  <PresentationSkeleton presentation={option.value} />
                  <span className="text-xs font-semibold">{option.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditor(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!editorValid}
              onClick={saveEditor}
            >
              {editor.pageId ? "Save page" : "Add page"}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={pages.length >= MAX_PORTAL_PAGES}
          onClick={beginCreate}
        >
          <Plus />
          Add page
        </Button>
      )}
    </div>
  )
}
