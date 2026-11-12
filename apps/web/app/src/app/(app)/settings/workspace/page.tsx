"use client"

import { useState, useEffect, useRef, useId } from "react"
import {
  Loader2,
  Upload,
  ImageIcon,
  X,
} from "lucide-react"
import { RemoteIcon } from "@/components/ui/remote-icon"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
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
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { WorkspaceMembersCard } from "@/components/settings/workspace-members-card"
import { WorkspaceIdentifierField } from "@/components/settings/workspace-identifier-field"
import {
  getAllowedDomains,
  getIngestionApprovalMode,
} from "@/lib/workspace-settings"
import { createClient } from "@/lib/supabase/client"
import { useWorkspace, useWorkspaces } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { type IngestionApprovalMode, type WorkspaceRole } from "@bread/core"

export default function WorkspacePage() {
  const hasHydrated = useHasHydrated()
  const { data: workspace, isLoading: loading, mutate } = useWorkspace()
  const hasData = !!workspace
  const { mutate: mutateWorkspaces } = useWorkspaces()

  const instanceId = useId()
  const workspaceId = workspace?.id

  // Real-time subscription for workspace settings (icon, name, settings).
  // Member changes are subscribed to inside <WorkspaceMembersCard />.
  useEffect(() => {
    if (!workspaceId) return

    const supabase = createClient()
    const channelName = `settings-workspace-${workspaceId}-${instanceId}`
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspaces",
          filter: `id=eq.${workspaceId}`,
        },
        () => {
          void mutate()
          void mutateWorkspaces()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [workspaceId, instanceId, mutate, mutateWorkspaces])

  const [saving, setSaving] = useState(false)
  const [name, setName] = useState<string | null>(null)
  const [ingestionApprovalMode, setIngestionApprovalMode] = useState<IngestionApprovalMode | null>(null)
  const [allowedDomains, setAllowedDomains] = useState<string[] | null>(null)
  const [domainInput, setDomainInput] = useState("")
  const [domainError, setDomainError] = useState<string | null>(null)
  const [pendingIcon, setPendingIcon] = useState<File | "remove" | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const displayName = name ?? workspace?.name ?? ""
  const currentIngestionApprovalMode = getIngestionApprovalMode(workspace?.settings)
  const displayIngestionApprovalMode =
    ingestionApprovalMode ?? currentIngestionApprovalMode
  const currentAllowedDomains = getAllowedDomains(workspace?.settings)
  const displayAllowedDomains = allowedDomains ?? currentAllowedDomains
  const currentUserRole = (workspace?.user_role as WorkspaceRole) || "viewer"
  const isAdmin = currentUserRole === "admin" || currentUserRole === "owner"
  const hasChanges =
    name !== null ||
    pendingIcon !== null ||
    ingestionApprovalMode !== null ||
    allowedDomains !== null

  const displayIconUrl =
    pendingIcon === "remove"
      ? null
      : previewUrl ?? workspace?.icon_url ?? null

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPendingIcon(file)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(URL.createObjectURL(file))
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const handleRemoveIcon = () => {
    setPendingIcon("remove")
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
  }

  const handleCancel = () => {
    setPendingIcon(null)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl(null)
    setName(null)
    setIngestionApprovalMode(null)
    setAllowedDomains(null)
    setDomainInput("")
    setDomainError(null)
  }

  const DOMAIN_REGEX = /^[a-z0-9.-]+\.[a-z]{2,}$/

  const handleAddDomain = () => {
    const candidate = domainInput.trim().toLowerCase()
    if (!candidate) return
    if (!DOMAIN_REGEX.test(candidate)) {
      setDomainError("Enter a valid domain like example.com")
      return
    }
    const base = displayAllowedDomains
    if (base.includes(candidate)) {
      setDomainError("Domain is already in the list")
      return
    }
    setAllowedDomains([...base, candidate])
    setDomainInput("")
    setDomainError(null)
  }

  const handleRemoveDomain = (domain: string) => {
    const base = displayAllowedDomains
    setAllowedDomains(base.filter((d) => d !== domain))
    setDomainError(null)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      if (pendingIcon === "remove") {
        await fetch("/api/workspace/icon", { method: "DELETE" })
      } else if (pendingIcon instanceof File) {
        const formData = new FormData()
        formData.append("file", pendingIcon)
        const iconRes = await fetch("/api/workspace/icon", {
          method: "POST",
          body: formData,
        })
        if (!iconRes.ok) {
          const data = await iconRes.json()
          console.error("Upload failed:", data.error)
        }
      }

      const settingsPatch: Record<string, unknown> = {}
      if (ingestionApprovalMode !== null) {
        settingsPatch.ingestion_approval_mode = displayIngestionApprovalMode
      }
      if (allowedDomains !== null) {
        settingsPatch.allowed_domains = displayAllowedDomains
      }

      const res = await fetch("/api/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: displayName,
          ...(Object.keys(settingsPatch).length > 0
            ? { settings: settingsPatch }
            : {}),
        }),
      })

      if (res.ok) {
        const data = await res.json()
        mutate(data, false)
        const iconChanged = pendingIcon !== null
        setPendingIcon(null)
        setName(null)
        setIngestionApprovalMode(null)
        setAllowedDomains(null)
        setDomainInput("")
        setDomainError(null)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        setPreviewUrl(null)
        window.dispatchEvent(new Event("workspace-updated"))
        // When the icon changed, also revalidate the workspace list so the
        // sidebar dropdown picks up the new icon_url immediately.
        if (iconChanged) {
          mutateWorkspaces()
        }
      }
    } catch (err) {
      console.error("Failed to save workspace:", err)
    } finally {
      setSaving(false)
    }
  }

  if (!hasHydrated || (loading && !hasData)) {
    return (
      <div className="space-y-6 p-6 lg:p-8">
        <div className="space-y-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-4 w-56" />
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-9 w-full" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="space-y-2">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-8 w-28" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div>
        <h1 className="text-xl font-semibold">Workspace</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure your workspace settings
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>
            Workspace identity and branding
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-4">
            {displayIconUrl ? (
              <RemoteIcon
                src={displayIconUrl}
                alt="Workspace icon"
                size={64}
                className="rounded-lg object-cover"
              />
            ) : (
              <div className="flex size-16 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <ImageIcon className="size-6" />
              </div>
            )}
            <div className="space-y-1">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={handleFileSelect}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!isAdmin}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="mr-2 size-3.5" />
                  {displayIconUrl ? "Change icon" : "Upload icon"}
                </Button>
                {displayIconUrl && pendingIcon !== "remove" && (
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!isAdmin}
                        >
                          Remove
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove workspace icon?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will remove the workspace icon. You can upload a new one at any time.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleRemoveIcon}>
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                PNG, JPEG, WebP, or SVG. Max 2MB.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="workspace-name">Workspace Name</Label>
            <Input
              id="workspace-name"
              value={displayName}
              onChange={(e) => setName(e.target.value)}
              disabled={!isAdmin}
            />
          </div>

          <WorkspaceIdentifierField />

        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ingestion Review</CardTitle>
          <CardDescription>
            Control whether imported knowledge is auto-applied or always marked for review.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ingestion-approval-mode">Approval Mode</Label>
            <Select
              value={displayIngestionApprovalMode}
              onValueChange={(value) => setIngestionApprovalMode(value as IngestionApprovalMode)}
              disabled={!isAdmin}
            >
              <SelectTrigger id="ingestion-approval-mode">
                <SelectValue>
                  {displayIngestionApprovalMode === "always_review"
                    ? "Always review changes"
                    : "Smart review"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="smart">Smart review</SelectItem>
                <SelectItem value="always_review">Always review changes</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Smart review auto-applies high-confidence ingests and routes uncertain ones to review. Always review changes marks all imported new or updated knowledge as Under Review.
            </p>
          </div>

        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Allowed Domains</CardTitle>
          <CardDescription>
            Users with an email at these domains can find and join this workspace from the Join Workspace dialog. They won&apos;t be auto-added.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="allowed-domain-input">Domains</Label>
            {displayAllowedDomains.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {displayAllowedDomains.map((domain) => (
                  <Badge
                    key={domain}
                    variant="secondary"
                    className="flex items-center gap-1.5 pr-1 text-xs font-normal"
                  >
                    <span>{domain}</span>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => handleRemoveDomain(domain)}
                        className="rounded-full p-0.5 transition-colors hover:bg-muted-foreground/20"
                        aria-label={`Remove ${domain}`}
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No domains configured yet.
              </p>
            )}

            {isAdmin && (
              <div className="flex items-center gap-2 pt-2">
                <Input
                  id="allowed-domain-input"
                  placeholder="example.com"
                  value={domainInput}
                  onChange={(e) => {
                    setDomainInput(e.target.value)
                    setDomainError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      handleAddDomain()
                    }
                  }}
                  className="max-w-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddDomain}
                  disabled={!domainInput.trim()}
                >
                  Add
                </Button>
              </div>
            )}
            {domainError && (
              <p className="text-xs text-destructive">{domainError}</p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Only the domain part (e.g. <span className="font-mono">acme.com</span>). Separate entries by adding them one at a time.
            </p>
          </div>

        </CardContent>
      </Card>

      <WorkspaceMembersCard limit={5} />

      {isAdmin && hasChanges && (
        <div className="sticky bottom-4 z-10 flex items-center gap-2 rounded-lg border bg-background/95 px-4 py-3 shadow-sm backdrop-blur">
          <p className="mr-auto text-xs text-muted-foreground">
            You have unsaved workspace changes.
          </p>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
