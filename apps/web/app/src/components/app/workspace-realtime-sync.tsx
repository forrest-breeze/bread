"use client"

import { useEffect, useId } from "react"
import { useSWRConfig } from "swr"
import { createClient } from "@/lib/supabase/client"
import { isGithubHostedDocsPublishStatusKey, useWorkspace } from "@/hooks/swr"
import { wasWorkspaceDocumentSavedRecently } from "@/lib/workspace-publish-events"

/**
 * Workspace-scoped realtime subscription that invalidates SWR keys no
 * other component listens for: per-folder detail/page caches, workspace
 * members, and subscription/billing state. The sub-nav, editor,
 * dashboard, and sidebar each keep their own subscriptions for the keys
 * they own (workspaces, documents lists, conversations, etc.).
 */
export function WorkspaceRealtimeSync(): null {
  const { data: ws } = useWorkspace()
  const { mutate } = useSWRConfig()
  const instanceId = useId()
  const workspaceId = ws?.id

  useEffect(() => {
    if (!workspaceId) return

    const supabase = createClient()
    let publishStatusTimer: ReturnType<typeof setTimeout> | null = null
    const invalidatePublishStatus = (documentId?: string): void => {
      if (publishStatusTimer) clearTimeout(publishStatusTimer)
      publishStatusTimer = setTimeout(() => {
        if (
          documentId &&
          wasWorkspaceDocumentSavedRecently(documentId)
        ) {
          return
        }
        void mutate(isGithubHostedDocsPublishStatusKey)
      }, 500)
    }
    const channel = supabase
      .channel(`workspace-sync-${workspaceId}-${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "documents",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          void mutate("/api/documents")
          void mutate("/api/documents/home")
          const id =
            (payload.new as { id?: string } | null)?.id ??
            (payload.old as { id?: string } | null)?.id
          if (id) void mutate(`/api/documents/${id}`)
          // Folder detail (`/api/folders/{id}`) and topic pages derive their
          // children/documents from documents.folder_id, so a doc create/
          // move/delete changes those views without firing a folders event.
          // Invalidate any mounted folder-scoped cache; SWR skips keys that
          // aren't currently subscribed.
          void mutate(
            (key) => typeof key === "string" && key.startsWith("/api/folders/"),
          )
          invalidatePublishStatus(id)
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "folders",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        (payload) => {
          void mutate("/api/folders")
          const id =
            (payload.new as { id?: string } | null)?.id ??
            (payload.old as { id?: string } | null)?.id
          if (id) {
            void mutate(`/api/folders/${id}`)
          }
          // A child folder's add/rename/move/delete fires an event for the
          // child row only — the parent's `/api/folders/{parent_id}` child
          // listing stays stale. Default REPLICA IDENTITY also hides the
          // old parent_folder_id on UPDATE, so sweep all mounted folder-
          // detail caches.
          void mutate(
            (key) => typeof key === "string" && key.startsWith("/api/folders/"),
          )
          invalidatePublishStatus()
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "workspace_members",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        () => {
          void mutate("/api/workspace")
          void mutate("/api/team")
          void mutate("/api/workspace/usage")
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "subscriptions",
          filter: `workspace_id=eq.${workspaceId}`,
        },
        () => {
          void mutate("/api/workspace")
          void mutate("/api/workspaces")
          void mutate("/api/workspace/usage")
        },
      )
      .subscribe()

    return () => {
      if (publishStatusTimer) clearTimeout(publishStatusTimer)
      supabase.removeChannel(channel)
    }
  }, [workspaceId, instanceId, mutate])

  return null
}
