"use client"

import React, { useState } from "react"
import { Loader2, Mail, Copy, Check } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { RelativeTime } from "@/components/app/relative-time"
import { useWorkspace, useTeamMembers } from "@/hooks/swr"
import type { InviteLinkRow } from "@/lib/types"
import { WorkspaceRole, canManageRole } from "@breezify/core"

interface InviteMemberDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InviteMemberDialog({
  open,
  onOpenChange,
}: InviteMemberDialogProps): React.ReactElement {
  const { data: workspace } = useWorkspace()
  const { mutate: mutateTeam } = useTeamMembers()

  const currentUserRole = (workspace?.user_role as WorkspaceRole) || "viewer"
  const isAdmin = currentUserRole === "admin" || currentUserRole === "owner"

  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("viewer")
  const [inviting, setInviting] = useState(false)
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)

  const [inviteLink, setInviteLink] = useState<InviteLinkRow | null>(null)
  const [inviteLinkLoading, setInviteLinkLoading] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  const fetchInviteLink = async (): Promise<InviteLinkRow | null> => {
    setInviteLinkLoading(true)
    try {
      const res = await fetch("/api/workspace/invite")
      if (!res.ok) return null
      const data = await res.json()
      const link = data.invite_link as InviteLinkRow
      setInviteLink(link)
      return link
    } catch (err) {
      console.error("[Breezify] Failed to fetch invite link:", err)
      return null
    } finally {
      setInviteLinkLoading(false)
    }
  }

  const handleOpenChange = (next: boolean): void => {
    onOpenChange(next)
    if (next && isAdmin && !inviteLink) void fetchInviteLink()
    if (!next) {
      setInviteError(null)
      setInviteSuccess(null)
    }
  }

  const handleInvite = async (): Promise<void> => {
    if (!inviteEmail) return
    setInviting(true)
    setInviteError(null)
    setInviteSuccess(null)
    try {
      const res = await fetch("/api/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      })
      const data = await res.json().catch(() => ({}))
      
      if (res.ok) {
        setInviteSuccess(`Invite sent to ${inviteEmail}`)
        setInviteEmail("")
        setInviteRole("viewer")
        void mutateTeam()
        setTimeout(() => {
          onOpenChange(false)
          setInviteSuccess(null)
        }, 1500)
      } else {
        setInviteError(data.error ?? "Failed to send invite")
      }
    } catch (err) {
      console.error("[Breezify] Failed to invite member:", err)
      setInviteError("Failed to send invite")
    } finally {
      setInviting(false)
    }
  }

  const handleCopyInviteLink = async (): Promise<void> => {
    const link = inviteLink ?? (await fetchInviteLink())
    if (!link) return
    const url = `${window.location.origin}/join?code=${link.code}`
    await navigator.clipboard.writeText(url)
    setCopiedLink(true)
    setTimeout(() => setCopiedLink(false), 2000)
  }

  const handleRegenerateLink = async (): Promise<void> => {
    setRegenerating(true)
    try {
      const res = await fetch("/api/workspace/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: inviteLink?.role ?? "viewer" }),
      })
      if (res.ok) {
        const data = await res.json()
        setInviteLink(data.invite_link as InviteLinkRow)
      }
    } catch (err) {
      console.error("[Breezify] Failed to regenerate invite link:", err)
    } finally {
      setRegenerating(false)
    }
  }

  const handleLinkRoleChange = async (nextRole: WorkspaceRole): Promise<void> => {
    if (!inviteLink || nextRole === inviteLink.role) return
    const previous = inviteLink
    setInviteLink({ ...inviteLink, role: nextRole })
    try {
      const res = await fetch("/api/workspace/invite", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      })
      if (!res.ok) {
        setInviteLink(previous)
      } else {
        const data = await res.json()
        setInviteLink(data.invite_link as InviteLinkRow)
      }
    } catch (err) {
      console.error("[Breezify] Failed to update invite link role:", err)
      setInviteLink(previous)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>
            Send an invite via email or share a link to join your workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email address</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="teammate@company.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleInvite()
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role">Email invite role</Label>
            <Select
              value={inviteRole}
              onValueChange={(v) => setInviteRole(v as string)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {canManageRole(currentUserRole, "admin") && (
                  <SelectItem value="admin">Admin</SelectItem>
                )}
                {canManageRole(currentUserRole, "editor") && (
                  <SelectItem value="editor">Editor</SelectItem>
                )}
                {canManageRole(currentUserRole, "viewer") && (
                  <SelectItem value="viewer">Viewer</SelectItem>
                )}
                {canManageRole(currentUserRole, "agent-only") && (
                  <SelectItem value="agent-only">Agent Only</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          {inviteSuccess && (
            <p className="text-sm text-green-600">{inviteSuccess}</p>
          )}
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}
          {isAdmin && (
            <div className="rounded-lg border border-dashed p-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground">
                Or share an invite link
              </p>
              {inviteLinkLoading && !inviteLink ? (
                <div className="flex items-center justify-center py-2">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                </div>
              ) : inviteLink ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={`${window.location.origin}/join?code=${inviteLink.code}`}
                      className="h-8 text-xs font-mono bg-muted/50"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={handleCopyInviteLink}
                    >
                      {copiedLink ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      Joins as
                    </span>
                    <Select
                      value={inviteLink.role}
                      onValueChange={(v) =>
                        void handleLinkRoleChange(v as WorkspaceRole)
                      }
                    >
                      <SelectTrigger className="h-7 w-32 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {canManageRole(currentUserRole, "admin") && (
                          <SelectItem value="admin">Admin</SelectItem>
                        )}
                        {canManageRole(currentUserRole, "editor") && (
                          <SelectItem value="editor">Editor</SelectItem>
                        )}
                        {canManageRole(currentUserRole, "viewer") && (
                          <SelectItem value="viewer">Viewer</SelectItem>
                        )}
                        {canManageRole(currentUserRole, "agent-only") && (
                          <SelectItem value="agent-only">Agent Only</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="secondary"
                        className="text-[10px] font-normal"
                      >
                        {inviteLink.use_count} use
                        {inviteLink.use_count !== 1 ? "s" : ""}
                      </Badge>
                      <RelativeTime
                        isoDate={inviteLink.created_at}
                        prefix="Created"
                        className="text-[10px] text-muted-foreground"
                      />
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] text-muted-foreground"
                            disabled={regenerating}
                          >
                            {regenerating ? (
                              <Loader2 className="mr-1 size-3 animate-spin" />
                            ) : null}
                            Regenerate
                          </Button>
                        }
                      />
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Regenerate invite link?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            This will invalidate the current invite link.
                            Anyone with the old link will no longer be able to
                            join.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={handleRegenerateLink}>
                            Regenerate
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleCopyInviteLink}
                  disabled={inviteLinkLoading}
                >
                  <Copy className="mr-2 size-3.5" />
                  Copy Invite Link
                </Button>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={handleInvite} disabled={inviting || !inviteEmail}>
            {inviting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Mail className="mr-2 size-4" />
                Send Email Invite
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
