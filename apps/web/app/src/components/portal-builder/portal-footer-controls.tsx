"use client"

import { useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
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
import { setFooter } from "@/lib/portal/builder-ops"
import {
  FOOTER_SOCIAL_PLATFORMS,
  type FooterColumn,
  type FooterSocial,
  type FooterSocialPlatform,
  type PortalLayout,
} from "@/lib/portal/schema"
import type { PortalChromeScope } from "@/lib/workspace-settings"

// ---------------------------------------------------------------------------
// Footer editor — edits the rich multi-column footer (columns + social + note)
// via the pure `setFooter` builder-op, plus an "Import from website" flow that
// scrapes a customer's marketing-site footer to seed the columns.
//
// Editing is local-first: the working arrays live in component state so a row
// can be half-typed without tripping schema validation. Each change commits the
// CLEANED arrays (complete rows only) through setFooter, so the persisted draft
// is always valid and incomplete rows simply aren't saved yet.
// ---------------------------------------------------------------------------

interface PortalFooterControlsProps {
  layout: PortalLayout
  onLayoutChange: (layout: PortalLayout) => void
  onSharedLayoutChange: (layout: PortalLayout) => void
  chromeScope: PortalChromeScope
  className?: string
}

const SOCIAL_LABELS: Record<FooterSocialPlatform, string> = {
  x: "X",
  linkedin: "LinkedIn",
  github: "GitHub",
  youtube: "YouTube",
  instagram: "Instagram",
}

type WorkingColumn = {
  heading: string
  links: Array<{ label: string; href: string }>
}
type WorkingSocial = { platform: FooterSocialPlatform; href: string }

function cleanColumns(columns: WorkingColumn[]): FooterColumn[] {
  return columns
    .map((col) => ({
      heading: col.heading.trim(),
      links: col.links
        .map((l) => ({ label: l.label.trim(), href: l.href.trim() }))
        .filter((l) => l.label.length > 0 && l.href.length > 0)
        .slice(0, 12),
    }))
    .filter((col) => col.heading.length > 0 && col.links.length > 0)
    .slice(0, 5)
}

function cleanSocial(social: WorkingSocial[]): FooterSocial[] {
  return social
    .map((s) => ({ platform: s.platform, href: s.href.trim() }))
    .filter((s) => s.href.length > 0)
    .slice(0, 8)
}

export function PortalFooterControls({
  layout,
  onLayoutChange,
  onSharedLayoutChange,
  chromeScope,
  className,
}: PortalFooterControlsProps): React.ReactElement {
  const [columns, setColumns] = useState<WorkingColumn[]>(
    () =>
      layout.footer?.columns?.map((c) => ({
        heading: c.heading,
        links: [...c.links],
      })) ?? [],
  )
  const [social, setSocial] = useState<WorkingSocial[]>(
    () => layout.footer?.social?.map((s) => ({ ...s })) ?? [],
  )
  const [note, setNote] = useState<string>(layout.footer?.note ?? "")
  const [error, setError] = useState<string | null>(null)
  const usesWorkspaceChrome = chromeScope === "workspace"
  // Shared workspace chrome routes edits through the shared-layout path so the
  // builder saves them to the workspace footer (every project), not just this
  // project's draft.
  const commitLayout = usesWorkspaceChrome ? onSharedLayoutChange : onLayoutChange

  // Commit a candidate state to the layout. Cleans incomplete rows first so a
  // half-typed link never fails validation; a genuine schema rejection (e.g. an
  // unsafe href) surfaces inline without corrupting the draft.
  function commit(next: {
    columns: WorkingColumn[]
    social: WorkingSocial[]
    note: string
  }): void {
    try {
      setError(null)
      const trimmedNote = next.note.trim()
      commitLayout(
        setFooter(layout, {
          columns: cleanColumns(next.columns),
          social: cleanSocial(next.social),
          note: trimmedNote.length > 0 ? trimmedNote : undefined,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed")
    }
  }

  function updateColumns(next: WorkingColumn[]): void {
    setColumns(next)
    commit({ columns: next, social, note })
  }
  function updateSocial(next: WorkingSocial[]): void {
    setSocial(next)
    commit({ columns, social: next, note })
  }
  function updateNote(next: string): void {
    setNote(next)
    commit({ columns, social, note: next })
  }

  const availablePlatforms = FOOTER_SOCIAL_PLATFORMS

  return (
    <div className={cn("flex flex-col gap-6", className)}>
      {usesWorkspaceChrome ? (
        <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
          Editing this shared workspace footer updates every portal project.
        </p>
      ) : null}
      {/* Columns */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Link columns</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={columns.length >= 5}
            onClick={() =>
              updateColumns([...columns, { heading: "", links: [] }])
            }
          >
            <Plus className="size-3.5" />
            Column
          </Button>
        </div>
        {columns.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No columns yet. Add one, or import from your website.
          </p>
        ) : null}
        {columns.map((col, ci) => (
          <div
            key={ci}
            className="space-y-2 rounded-lg border border-border p-3"
          >
            <div className="flex items-center gap-2">
              <Input
                aria-label={`Column ${ci + 1} heading`}
                value={col.heading}
                placeholder="Heading (e.g. Resources)"
                onChange={(e) =>
                  updateColumns(
                    columns.map((c, i) =>
                      i === ci ? { ...c, heading: e.target.value } : c,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove column ${ci + 1}`}
                onClick={() =>
                  updateColumns(columns.filter((_, i) => i !== ci))
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="space-y-2 pl-1">
              {col.links.map((link, li) => (
                <div key={li} className="flex items-start gap-1.5">
                  {/* Label + URL stack as a joined pair so each gets the full
                      panel width — side-by-side they truncate in the narrow
                      builder sidebar. */}
                  <div className="min-w-0 flex-1">
                    <Input
                      aria-label={`Link ${li + 1} label`}
                      value={link.label}
                      placeholder="Label"
                      className="relative rounded-b-none focus-visible:z-10"
                      onChange={(e) =>
                        updateColumns(
                          columns.map((c, i) =>
                            i === ci
                              ? {
                                  ...c,
                                  links: c.links.map((l, j) =>
                                    j === li
                                      ? { ...l, label: e.target.value }
                                      : l,
                                  ),
                                }
                              : c,
                          ),
                        )
                      }
                    />
                    <Input
                      aria-label={`Link ${li + 1} URL`}
                      value={link.href}
                      placeholder="https://… or /path"
                      className="relative -mt-px rounded-t-none focus-visible:z-10"
                      onChange={(e) =>
                        updateColumns(
                          columns.map((c, i) =>
                            i === ci
                              ? {
                                  ...c,
                                  links: c.links.map((l, j) =>
                                    j === li
                                      ? { ...l, href: e.target.value }
                                      : l,
                                  ),
                                }
                              : c,
                          ),
                        )
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove link ${li + 1}`}
                    onClick={() =>
                      updateColumns(
                        columns.map((c, i) =>
                          i === ci
                            ? {
                                ...c,
                                links: c.links.filter((_, j) => j !== li),
                              }
                            : c,
                        ),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={col.links.length >= 12}
                onClick={() =>
                  updateColumns(
                    columns.map((c, i) =>
                      i === ci
                        ? {
                            ...c,
                            links: [...c.links, { label: "", href: "" }],
                          }
                        : c,
                    ),
                  )
                }
              >
                <Plus className="size-3.5" />
                Link
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Social */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Social links</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={social.length >= 8}
            onClick={() =>
              updateSocial([...social, { platform: "x", href: "" }])
            }
          >
            <Plus className="size-3.5" />
            Social
          </Button>
        </div>
        {social.map((s, si) => (
          <div key={si} className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <Select
                value={s.platform}
                onValueChange={(value) =>
                  updateSocial(
                    social.map((row, i) =>
                      i === si
                        ? { ...row, platform: value as FooterSocialPlatform }
                        : row,
                    ),
                  )
                }
              >
                <SelectTrigger
                  aria-label={`Social ${si + 1} platform`}
                  className="relative w-full rounded-b-none focus:z-10"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availablePlatforms.map((p) => (
                    <SelectItem key={p} value={p}>
                      {SOCIAL_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                aria-label={`Social ${si + 1} URL`}
                value={s.href}
                placeholder="https://…"
                className="relative -mt-px rounded-t-none focus-visible:z-10"
                onChange={(e) =>
                  updateSocial(
                    social.map((row, i) =>
                      i === si ? { ...row, href: e.target.value } : row,
                    ),
                  )
                }
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove social ${si + 1}`}
              onClick={() =>
                updateSocial(social.filter((_, i) => i !== si))
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      {/* Note */}
      <div className="space-y-1.5">
        <Label htmlFor="footer-note">Footer note</Label>
        <Input
          id="footer-note"
          value={note}
          placeholder="© 2026 Your Company"
          onChange={(e) => updateNote(e.target.value)}
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
