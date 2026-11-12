"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { PortalAgentToolCall } from "@/lib/api/portal"
import type { PortalLayout } from "@/lib/portal/schema"

// ---------------------------------------------------------------------------
// Persistence for the KB portal builder chat. Reuses the same conversations /
// chat_messages storage as the `@agent` chat (see useAgentChat) — same 90-day
// retention, same /api/conversations routes — but the portal agent is
// request/response rather than SSE, so the streaming `useChat` half can't be
// shared. This hook owns just the durable half: find-or-create the single
// builder thread per project, load its transcript, and append exchanges.
//
// Layout checkpoints ride in the existing `chat_messages.parts` jsonb: each user
// turn carries the layout as it was BEFORE that turn's edit, so the panel can
// offer a Cursor-style "restore to this point" affordance.
// ---------------------------------------------------------------------------

export interface PortalCheckpointTurn {
  id: string
  role: "user" | "agent"
  text: string
  /** Applied builder steps — rendered as step cards above an agent reply. */
  steps?: PortalAgentToolCall[]
  /** Layout as it was before this (user) turn's edit. Drives checkpoint restore. */
  checkpoint?: PortalLayout
}

/** One message part as stored in chat_messages.parts (an array of records). */
type StoredPart =
  | { type: "text"; text: string }
  | { type: "portal-checkpoint"; layout: PortalLayout }
  | { type: "portal-steps"; steps: PortalAgentToolCall[] }

interface StoredMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  parts: StoredPart[] | null
}

interface UsePortalBuilderChatReturn {
  /** Transcript loaded from the persisted thread (empty until ready). */
  turns: PortalCheckpointTurn[]
  /** False until the persisted thread has been located/loaded for this project. */
  ready: boolean
  /**
   * Persist one exchange (a user turn + the agent's reply), creating the thread
   * lazily on first save. Returns the two persisted turns (with server ids) so
   * the caller can reconcile its optimistic state. Never throws — a failed save
   * keeps the chat usable and just isn't durable.
   */
  saveExchange: (input: {
    userText: string
    checkpoint: PortalLayout
    replyText: string
    steps: PortalAgentToolCall[]
  }) => Promise<void>
  /**
   * Drop every persisted message after the first `keep`, so a checkpoint
   * restore that rolls the transcript back survives a reload. No-op when the
   * thread was never created. Never throws — a failed truncate just leaves the
   * dropped turns in storage.
   */
  truncate: (keep: number) => Promise<void>
}

// In-flight transcript cuts, keyed by thread ("<workspaceId>:<projectSlug>").
//
// MODULE-SCOPED ON PURPOSE. A checkpoint restore also saves the restored layout,
// and that save briefly swaps the builder to its skeleton — which UNMOUNTS the
// panel and this hook. Component state and refs die with it, so a remount that
// happens while the DELETE is still in flight would re-read the pre-cut rows and
// put the removed messages straight back on screen. This registry outlives the
// remount: the new instance waits for the cut, then clamps to it.
//
// An entry lives only as long as its DELETE. Once storage agrees, it is removed
// so later messages can legitimately grow the thread past the old cut.
const inFlightCuts = new Map<string, { keep: number; done: Promise<void> }>()

function partsToTurn(message: StoredMessage): PortalCheckpointTurn {
  const parts = message.parts ?? []
  const role = message.role === "assistant" ? "agent" : "user"
  const text =
    parts.find((p): p is Extract<StoredPart, { type: "text" }> => p.type === "text")
      ?.text ?? message.content
  const checkpoint = parts.find(
    (p): p is Extract<StoredPart, { type: "portal-checkpoint" }> =>
      p.type === "portal-checkpoint",
  )?.layout
  const steps = parts.find(
    (p): p is Extract<StoredPart, { type: "portal-steps" }> => p.type === "portal-steps",
  )?.steps
  return { id: message.id, role, text, steps, checkpoint }
}

export function usePortalBuilderChat(
  projectSlug: string | null | undefined,
  workspaceId: string | null | undefined,
): UsePortalBuilderChatReturn {
  const [turns, setTurns] = useState<PortalCheckpointTurn[]>([])
  const [ready, setReady] = useState(false)
  // The persisted conversation id, resolved lazily. Held in a ref (not state) so
  // saveExchange can read/write it without a stale closure or extra renders.
  const conversationIdRef = useRef<string | null>(null)
  // Guards concurrent create calls so a burst of sends resolves one thread.
  const creatingRef = useRef<Promise<string | null> | null>(null)
  // Shortest transcript a checkpoint restore has cut this thread to, so a load
  // that races the DELETE can't read the dropped turns back. Null = no cut.
  const truncatedToRef = useRef<number | null>(null)

  // Clear the buffer synchronously during render when the target thread changes
  // so a project/workspace switch never flashes the prior transcript. Reconciled
  // in render (the repo lint rule forbids setState-in-effect); the async load in
  // the effect below fills it back in. With no project there's nothing to load,
  // so it's immediately ready and blank.
  const loadKey = `${workspaceId ?? ""}:${projectSlug ?? ""}`
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  if (loadKey !== pendingKey) {
    setPendingKey(loadKey)
    setTurns([])
    setReady(!projectSlug)
  }

  // Load the existing thread for this (workspace, project). All setState here
  // runs after an await (never synchronously in the effect body), so it doesn't
  // trip set-state-in-effect. workspaceId participates so a workspace switch
  // re-resolves the thread.
  useEffect(() => {
    conversationIdRef.current = null
    creatingRef.current = null
    truncatedToRef.current = null
    if (!projectSlug) return

    let cancelled = false
    void (async () => {
      try {
        // A cut from a previous instance of this hook may still be in flight
        // (see inFlightCuts). Let it land before reading, and remember how deep
        // it was so the read can be clamped even if it raced ahead anyway.
        const pendingCut = inFlightCuts.get(loadKey)
        const pendingKeep = pendingCut?.keep ?? null
        if (pendingCut) await pendingCut.done.catch(() => {})
        if (cancelled) return
        if (pendingKeep !== null) {
          truncatedToRef.current =
            truncatedToRef.current === null
              ? pendingKeep
              : Math.min(truncatedToRef.current, pendingKeep)
        }
        const listRes = await fetch(
          `/api/conversations?surface=portal_builder&project=${encodeURIComponent(projectSlug)}`,
        )
        if (!listRes.ok) return
        const list = (await listRes.json()) as Array<{ id: string }>
        const existing = list[0]
        if (!existing) return
        if (!cancelled) conversationIdRef.current = existing.id
        const detailRes = await fetch(`/api/conversations/${existing.id}`)
        if (!detailRes.ok) return
        const detail = (await detailRes.json()) as { messages?: StoredMessage[] }
        if (cancelled) return
        const loaded = (detail.messages ?? []).map(partsToTurn)
        const cut = truncatedToRef.current
        setTurns(cut !== null && loaded.length > cut ? loaded.slice(0, cut) : loaded)
      } catch {
        // Non-fatal: an unreadable thread just starts the panel blank.
      } finally {
        if (!cancelled) setReady(true)
      }
    })()

    return () => {
      cancelled = true
    }
    // loadKey is derived from the other two, so it never widens this effect.
  }, [loadKey, projectSlug, workspaceId])

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    if (conversationIdRef.current) return conversationIdRef.current
    if (creatingRef.current) return creatingRef.current
    if (!projectSlug) return null

    const create = (async (): Promise<string | null> => {
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ surface: "portal_builder", projectSlug }),
        })
        if (!res.ok) return null
        const data = (await res.json()) as { id: string }
        conversationIdRef.current = data.id
        return data.id
      } catch {
        return null
      } finally {
        creatingRef.current = null
      }
    })()
    creatingRef.current = create
    return create
  }, [projectSlug])

  const saveExchange = useCallback<UsePortalBuilderChatReturn["saveExchange"]>(
    async ({ userText, checkpoint, replyText, steps }) => {
      const conversationId = await ensureConversation()
      if (!conversationId) return
      try {
        await fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content: userText,
                parts: [
                  { type: "text", text: userText },
                  { type: "portal-checkpoint", layout: checkpoint },
                ],
              },
              {
                role: "assistant",
                content: replyText,
                parts: [
                  { type: "text", text: replyText },
                  ...(steps.length > 0
                    ? [{ type: "portal-steps", steps }]
                    : []),
                ],
              },
            ],
          }),
        })
      } catch {
        // Non-fatal — the turn already shows locally; it just isn't durable.
      }
    },
    [ensureConversation],
  )

  const truncate = useCallback<UsePortalBuilderChatReturn["truncate"]>(
    async (keep) => {
      const kept = Math.max(0, Math.trunc(keep))
      // Roll THIS hook's transcript back too, not just the server's. The panel
      // adopts `turns` whenever it (re)hydrates, so leaving the dropped turns
      // here means any later hydration — a project/workspace switch and back —
      // resurrects the text the restore was supposed to remove.
      setTurns((prev) => (prev.length > kept ? prev.slice(0, kept) : prev))
      // Also clamp whatever the next load reads back: the DELETE below is
      // in-flight, so a reload racing it would otherwise re-read the old rows.
      truncatedToRef.current =
        truncatedToRef.current === null
          ? kept
          : Math.min(truncatedToRef.current, kept)
      const conversationId = conversationIdRef.current
      if (!conversationId) return
      // Publish the cut before awaiting it. The restore that called this also
      // kicks off a draft save, and that save can unmount this hook mid-flight
      // — the registry is what lets the remounted instance still honor it.
      const previous = inFlightCuts.get(loadKey)
      const done = (async (): Promise<void> => {
        try {
          await fetch(
            `/api/conversations/${conversationId}/messages?keep=${kept}`,
            { method: "DELETE" },
          )
        } catch {
          // Non-fatal — the panel has already rolled its own transcript back.
        }
      })()
      inFlightCuts.set(loadKey, {
        keep: previous ? Math.min(previous.keep, kept) : kept,
        done,
      })
      try {
        await done
      } finally {
        // Storage now agrees, so stop clamping — later messages must be able to
        // grow the thread past this cut.
        if (inFlightCuts.get(loadKey)?.done === done) inFlightCuts.delete(loadKey)
      }
    },
    [loadKey],
  )

  return { turns, ready, saveExchange, truncate }
}
