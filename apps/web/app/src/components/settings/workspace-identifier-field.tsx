"use client"

import { useEffect, useState } from "react"
import { AlertCircle, AlertTriangle, Check, CheckCircle2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWorkspace } from "@/hooks/swr"
import {
  checkSlugAvailability,
  updateWorkspaceSlug,
} from "@/lib/api/workspace"
import { handleErrorMessage, validateHandle } from "@/lib/public-kb-handle"
import type { WorkspaceRole } from "@breezify/core"

// ---------------------------------------------------------------------------
// Editable workspace identifier (the `slug` column).
//
// The slug is the human-readable, globally-unique identifier that keys the
// workspace's public portal URL (`/p/<slug>`). It is always present (NOT NULL)
// and required — it cannot be cleared, only changed to another available value.
//
// Renaming the slug is allowed, but it breaks any existing `/p/<old-slug>` link
// (and any subdomain pointing at it). The inline warning makes that explicit
// before the user saves, matching how GitHub org / Slack workspace renames work.
// ---------------------------------------------------------------------------

export function WorkspaceIdentifierField(): React.ReactElement | null {
  const { data: workspace, mutate } = useWorkspace()

  const savedSlug = workspace?.slug ?? ""
  const [lastSavedSlug, setLastSavedSlug] = useState(savedSlug)
  const [input, setInput] = useState(savedSlug)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [availResult, setAvailResult] = useState<{
    slug: string
    available: boolean
    message: string
  } | null>(null)

  // Sync local input when the persisted slug changes underneath us (e.g.
  // realtime update or workspace switch) — render-phase sync, not an effect.
  if (savedSlug !== lastSavedSlug) {
    setLastSavedSlug(savedSlug)
    setInput(savedSlug)
    setError(null)
    setStatus(null)
    setAvailResult(null)
  }

  const validation = validateHandle(input)
  const trimmed = input.trim()
  const normalized = validation.handle
  // The current slug is grandfathered: re-displaying it is never an error or a
  // pending change, even if it predates a reserved-word it would now fail (e.g.
  // an existing "breezify" slug). Only a value the user actually changed to is
  // validated. The slug is required, so an empty field is an error, not "clear".
  const unchanged = trimmed.toLowerCase() === savedSlug.toLowerCase()
  const dirty = !unchanged
  const formatError = unchanged
    ? null
    : trimmed.length === 0
      ? "Workspace identifier is required."
      : validation.error
        ? handleErrorMessage(validation.error)
        : null
  const needsCheck = dirty && Boolean(normalized)

  useEffect(() => {
    if (!needsCheck || !normalized) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void checkSlugAvailability(normalized, controller.signal).then((res) => {
        if (controller.signal.aborted) return
        setAvailResult({
          slug: normalized,
          available: res.available,
          message: res.available ? "Available" : res.error ?? "Unavailable",
        })
      })
    }, 400)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [needsCheck, normalized])

  if (!workspace) return null

  const role = (workspace.user_role as WorkspaceRole | undefined) ?? "viewer"
  const isAdmin = role === "admin" || role === "owner"

  const matched =
    availResult !== null && availResult.slug === normalized ? availResult : null
  const checking = needsCheck && matched === null
  const available = matched ? matched.available : null
  const availMessage = matched ? matched.message : null
  const canSave =
    isAdmin && !saving && dirty && !formatError && available === true

  const onSave = async (): Promise<void> => {
    if (formatError || !normalized) {
      setError(formatError)
      return
    }
    setSaving(true)
    setError(null)
    setStatus(null)
    const result = await updateWorkspaceSlug(normalized)
    setSaving(false)
    if (!result.ok) {
      setError(result.error ?? "Couldn't save the identifier.")
      return
    }
    if (result.workspace) {
      void mutate({ ...workspace, ...result.workspace }, false)
      window.dispatchEvent(new Event("workspace-updated"))
    }
    setStatus("Identifier saved.")
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="workspace-identifier">Workspace Identifier</Label>
      <div className="flex max-w-md items-stretch gap-2">
        <Input
          id="workspace-identifier"
          value={input}
          placeholder="acme"
          maxLength={63}
          disabled={!isAdmin || saving}
          className="font-mono lowercase"
          onChange={(e) => {
            setInput(e.target.value)
            setError(null)
            setStatus(null)
          }}
        />
        {isAdmin ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canSave}
            onClick={() => void onSave()}
          >
            {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Save
          </Button>
        ) : null}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Keys your portal URL:{" "}
        <span className="font-mono">/p/{normalized || savedSlug || "your-id"}</span>
      </p>

      {dirty && !formatError && isAdmin ? (
        <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="size-3 shrink-0" />
          Changing this breaks existing links to /p/{savedSlug}.
        </p>
      ) : null}

      {formatError && (trimmed.length > 0 || dirty) ? (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="size-3 shrink-0" />
          {formatError}
        </p>
      ) : checking ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 shrink-0 animate-spin" />
          Checking availability...
        </p>
      ) : available === true ? (
        <p className="flex items-center gap-1 text-xs text-primary">
          <Check className="size-3 shrink-0" />
          {availMessage}
        </p>
      ) : available === false ? (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="size-3 shrink-0" />
          {availMessage}
        </p>
      ) : status ? (
        <p className="flex items-center gap-1 text-xs text-primary">
          <CheckCircle2 className="size-3 shrink-0" />
          {status}
        </p>
      ) : error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
