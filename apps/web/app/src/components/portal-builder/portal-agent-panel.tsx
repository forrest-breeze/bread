"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import Image from "next/image"
import MarkdownIt from "markdown-it"
import {
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"

// Agent replies come back as markdown (bold, lists, links). Render them like the
// support chat does — markdown-it with raw HTML disabled (the agent never needs
// to emit HTML, and disabling it avoids an injection surface).
const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true })
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { runPortalAgent, type PortalAgentToolCall } from "@/lib/api/portal"
import type { PortalLayout } from "@/lib/portal/schema"
import {
  usePortalBuilderChat,
  type PortalCheckpointTurn,
} from "@/hooks/use-portal-builder-chat"

// ---------------------------------------------------------------------------
// Chat panel for natural-language portal edits. Posts the current draft + the
// user's instruction to /api/portal/agent and hands the returned layout up to
// the parent, which applies it to the editing buffer. The agent does all the
// layout work — there are no manual generate/section controls.
//
// The transcript persists (same storage as the @agent chat) via
// usePortalBuilderChat, and each user turn snapshots the layout as it was before
// that edit so it can be restored — a Cursor-style checkpoint history.
// ---------------------------------------------------------------------------

// `pending` marks a locally-appended user turn whose exchange has not been
// persisted yet (its agent call failed, or is still running). It matters for
// checkpoint restore: only saved turns have a row in storage, so pending ones
// must not be counted when mapping a transcript cut back onto stored messages.
type ChatTurn = PortalCheckpointTurn & { pending?: boolean }

/** Everything needed to run — or re-run — one agent request. */
interface AgentAttempt {
  text: string
  attachments: File[]
  displayText: string
  checkpoint: PortalLayout
  history: Array<{ role: "user" | "agent"; text: string }>
  userTurnId: string
}

// Done-state copy for each builder op, mirroring the main agent loop's tool-step
// cards. The route already returns a human `summary` per step; this is the
// fallback label when one is absent.
const STEP_DONE_COPY: Record<string, string> = {
  insertNode: "Added an element",
  updateNode: "Updated an element",
  removeNode: "Removed an element",
  moveNode: "Rearranged the layout",
  setTheme: "Updated the theme",
  defineComponent: "Created a component",
  setFolderIcon: "Changed a folder icon",
  updateSidebarNode: "Renamed a section",
  generateFullPortal: "Generated the portal",
}

function PortalToolStep({ step }: { step: PortalAgentToolCall }): React.ReactElement {
  const label = step.summary || STEP_DONE_COPY[step.op] || step.op
  return (
    <div className="ml-2 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      {step.ok ? (
        <CheckIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <TriangleAlertIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      )}
      <span className="min-w-0 truncate">{step.ok ? label : `${label} failed`}</span>
    </div>
  )
}

/**
 * Placeholder transcript shown while the persisted thread loads.
 *
 * Without it the panel rendered its "no messages yet" state during the fetch,
 * so opening a project that HAS a conversation flashed an empty chat before the
 * history appeared — the one reading that is always wrong. The shapes mirror the
 * real bubbles (right-aligned user, muted agent block, a step card) so the swap
 * to the loaded transcript doesn't jump.
 */
function ChatTranscriptSkeleton(): React.ReactElement {
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">Loading conversation</span>

      <div className="flex justify-end">
        <Skeleton className="h-9 w-1/2 rounded-lg" />
      </div>

      <div className="space-y-1.5">
        <Skeleton className="ml-2 h-8 w-2/3 rounded-lg" />
        <div className="space-y-1.5 rounded-lg bg-muted/40 px-3 py-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      </div>

      <div className="flex justify-end">
        <Skeleton className="h-9 w-2/5 rounded-lg" />
      </div>

      <div className="space-y-1.5 rounded-lg bg-muted/40 px-3 py-2">
        <Skeleton className="h-3 w-10/12" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  )
}

/**
 * One icon-only action on a chat turn (edit, restore). Icon-only keeps the
 * hover row unobtrusive next to the message, so the label lives in the tooltip
 * AND in aria-label — the icon alone is not an accessible name.
 */
function TurnActionButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-6 items-center justify-center rounded-md transition-colors",
        "text-muted-foreground hover:bg-muted hover:text-foreground",
        "disabled:opacity-50 disabled:hover:bg-transparent",
      )}
    >
      {children}
    </button>
  )
}

interface PortalAgentPanelProps {
  layout: PortalLayout
  onLayoutChange: (layout: PortalLayout) => void
  /** Restores a checkpoint layout (applies + persists it like an agent edit). */
  onRestoreCheckpoint?: (layout: PortalLayout) => void
  projectSlug?: string | null
  /** Scopes the persisted thread; a workspace switch re-resolves it. */
  workspaceId?: string | null
  className?: string
}

const MAX_AGENT_MESSAGE_LENGTH = 4000
const MAX_ATTACHMENT_TEXT_LENGTH = 1000

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isTextLikeFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true
  return /\.(css|csv|html|json|jsx|md|mdx|ts|tsx|txt|xml|yaml|yml)$/i.test(file.name)
}

async function buildAgentMessage(message: string, attachments: File[]): Promise<string> {
  const trimmed = message.trim()
  if (attachments.length === 0) return trimmed.slice(0, MAX_AGENT_MESSAGE_LENGTH)

  const sections: string[] = []
  for (const file of attachments) {
    const meta = `${file.name} (${file.type || "file"}, ${formatFileSize(file.size)})`
    if (!isTextLikeFile(file)) {
      sections.push(`- ${meta}`)
      continue
    }

    try {
      const text = await file.text()
      const clipped = text.slice(0, MAX_ATTACHMENT_TEXT_LENGTH)
      sections.push(`- ${meta}\n${clipped}`)
    } catch {
      sections.push(`- ${meta} (could not read contents)`)
    }
  }

  return `${trimmed}\n\nAttached builder context:\n${sections.join("\n\n")}`.slice(
    0,
    MAX_AGENT_MESSAGE_LENGTH,
  )
}

function attachmentKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`
}

function AttachmentPreview({
  file,
  onRemove,
}: {
  file: File
  onRemove: () => void
}): React.ReactElement {
  const isImage = file.type.startsWith("image/")
  const preview = useMemo(() => {
    if (!isImage) return null
    return URL.createObjectURL(file)
  }, [file, isImage])

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  return (
    <div
      className="group relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/50"
      title={file.name}
    >
      {isImage && preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt={file.name} className="size-full object-cover" />
      ) : (
        <FileTextIcon className="size-4 text-muted-foreground" />
      )}
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={(event) => {
          event.preventDefault()
          onRemove()
        }}
        className="absolute right-0.5 top-0.5 rounded-full bg-background/90 p-0.5 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

export function PortalAgentPanel({
  layout,
  onLayoutChange,
  onRestoreCheckpoint,
  projectSlug,
  workspaceId,
  className,
}: PortalAgentPanelProps): React.ReactElement {
  const [message, setMessage] = useState("")
  const [attachments, setAttachments] = useState<File[]>([])
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileDragOver, setFileDragOver] = useState(false)
  // The user turn currently open for editing, and its working text.
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState("")
  // Agent turn showing a "copied" confirmation, and the timer that clears it.
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Turn awaiting restore confirmation (null = the dialog is closed).
  const [pendingRestore, setPendingRestore] = useState<ChatTurn | null>(null)
  // How many turns AFTER the pending one would go with it. Naming the number
  // is what makes the dialog worth reading — "and the 4 that follow it" tells
  // you the cost; a generic "are you sure" does not.
  const pendingRestoreIndex = pendingRestore
    ? turns.findIndex((turn) => turn.id === pendingRestore.id)
    : -1
  const restoreDropCount =
    pendingRestoreIndex === -1 ? 0 : turns.length - pendingRestoreIndex - 1
  // The last request that failed, kept so the error banner can offer a retry.
  const [failedAttempt, setFailedAttempt] = useState<AgentAttempt | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Durable transcript + checkpoints (same storage as the @agent chat).
  const { turns: persistedTurns, ready, saveExchange, truncate } =
    usePortalBuilderChat(projectSlug ?? null, workspaceId ?? null)

  // Reconcile the local buffer with the persisted thread during render (the repo
  // lint rule forbids setState-in-effect). Two phases: clear immediately when the
  // project/workspace changes so a stale transcript never flashes, then adopt the
  // persisted turns once the hook reports them ready.
  const threadKey = `${workspaceId ?? ""}:${projectSlug ?? ""}`
  const [localThreadKey, setLocalThreadKey] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  if (threadKey !== localThreadKey) {
    setLocalThreadKey(threadKey)
    setTurns([])
    setHydrated(false)
    setEditingTurnId(null)
    setEditingText("")
    setError(null)
    setFailedAttempt(null)
  } else if (!hydrated && ready) {
    setHydrated(true)
    setTurns(persistedTurns)
  }

  // Cursor-style restore: put the portal back to how it was before this turn AND
  // roll the transcript back to it — the turns that came after described edits
  // that no longer exist, so they (and any error they left on screen) go with
  // them. The cut is persisted too, otherwise a reload resurrects them.
  // Restore is destructive in two directions at once — it reverts the portal
  // AND truncates the stored transcript, both of which autosave — so the icon
  // only opens a confirmation. A stray click on a hover-revealed control must
  // not be able to throw work away.
  function confirmRestore(turn: ChatTurn): void {
    if (!turn.checkpoint || !onRestoreCheckpoint) return
    setPendingRestore(turn)
  }

  function restoreCheckpoint(turn: ChatTurn): void {
    if (!turn.checkpoint || !onRestoreCheckpoint) return
    const index = turns.findIndex((t) => t.id === turn.id)
    if (index === -1) return
    // A restore undoes this turn, so the turn ITSELF goes too, not just what
    // followed it — an instruction left on screen after its effect was undone
    // no longer describes the portal. The prompt is handed back to the composer
    // instead, ready to be reworded and sent again.
    const kept = turns.slice(0, index)
    setTurns(kept)
    setError(null)
    setFailedAttempt(null)
    setEditingTurnId(null)
    setEditingText("")
    void truncate(kept.filter((t) => !t.pending).length)
    // Guarded like dismissError: never clobber something already typed.
    if (message.trim().length === 0 && attachments.length === 0) {
      setMessage(turn.text)
      textareaRef.current?.focus()
    }
    onRestoreCheckpoint(turn.checkpoint)
    setPendingRestore(null)
  }

  // Copy a reply as the MARKDOWN the agent wrote, not the rendered HTML — it
  // pastes cleanly into an issue or a doc, which is the point of copying it.
  // The confirmation resets on a timer, cleared on unmount.
  async function copyReply(turn: ChatTurn): Promise<void> {
    try {
      await navigator.clipboard.writeText(turn.text)
    } catch {
      // Clipboard access can be denied (permissions, insecure origin). Nothing
      // was copied, so leave the button in its idle state rather than lying.
      return
    }
    setCopiedTurnId(turn.id)
    if (copyResetRef.current !== null) clearTimeout(copyResetRef.current)
    copyResetRef.current = setTimeout(() => {
      copyResetRef.current = null
      setCopiedTurnId(null)
    }, 2000)
  }

  function beginEdit(turn: ChatTurn): void {
    if (busy) return
    setEditingTurnId(turn.id)
    setEditingText(turn.text)
  }

  function cancelEdit(): void {
    setEditingTurnId(null)
    setEditingText("")
  }

  // Edit-and-resubmit: rewrite a past instruction and run it again in place.
  // The turn being edited and everything after it are replaced by the new
  // exchange, and the request replays against that turn's checkpoint — the
  // layout as it was BEFORE the original ran — so the result reflects the new
  // wording alone instead of compounding on the edit it supersedes.
  //
  // The portal is deliberately NOT rewound up-front: the agent's result is
  // derived from the checkpoint and replaces the layout wholesale, so the end
  // state is the same, and a failed request leaves the portal untouched rather
  // than silently rolled back.
  async function submitEdit(turn: ChatTurn): Promise<void> {
    const text = editingText.trim()
    if (!text || busy) return
    const index = turns.findIndex((t) => t.id === turn.id)
    if (index === -1) return

    const base = turn.checkpoint ?? layout
    const kept = turns.slice(0, index)
    const history = kept.map((t) => ({ role: t.role, text: t.text }))
    const userTurnId = crypto.randomUUID()

    setEditingTurnId(null)
    setEditingText("")
    setError(null)
    setFailedAttempt(null)
    void truncate(kept.filter((t) => !t.pending).length)
    setTurns([
      ...kept,
      { id: userTurnId, role: "user", text, checkpoint: base, pending: true },
    ])

    await runAttempt({
      text,
      attachments: [],
      displayText: text,
      checkpoint: base,
      history,
      userTurnId,
    })
  }

  // Auto-size the composer: start compact, grow with content up to a cap, then
  // let it scroll. Reset to "auto" first so it also shrinks when text is removed.
  // Drop the copy-confirmation timer if the panel goes away first.
  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) clearTimeout(copyResetRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const MAX_HEIGHT = 160
    textarea.style.height = "auto"
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT)}px`
    textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? "auto" : "hidden"
  }, [message])

  function appendAttachments(files: FileList | File[]): void {
    const incoming = Array.from(files)
    if (incoming.length === 0) return
    setAttachments((current) => {
      const seen = new Set(current.map(attachmentKey))
      const next = [...current]
      for (const file of incoming) {
        const key = attachmentKey(file)
        if (!seen.has(key)) {
          seen.add(key)
          next.push(file)
        }
      }
      return next
    })
  }

  // Runs one attempt against the agent. Split out from `send` so a failure can
  // be retried with the exact same prompt, attachments, checkpoint and history —
  // the retry re-runs the request rather than appending a duplicate user turn.
  async function runAttempt(attempt: AgentAttempt): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const agentMessage = await buildAgentMessage(
        attempt.text || "Use the attached context.",
        attempt.attachments,
      )
      // Run against the attempt's OWN base layout, not the current prop. For a
      // fresh send the two are the same, but an edit-and-resubmit replays the
      // turn against the layout as it was BEFORE the original — so the new
      // instruction lands on the same starting point the old one did, rather
      // than stacking on top of the edit it is replacing.
      const result = await runPortalAgent(
        agentMessage,
        attempt.checkpoint,
        projectSlug,
        attempt.history,
      )
      onLayoutChange(result.layout)
      setFailedAttempt(null)
      setTurns((prev) => [
        // The exchange is about to be persisted, so the user turn is no longer
        // local-only — clear its pending flag (see ChatTurn).
        ...prev.map((turn) =>
          turn.id === attempt.userTurnId ? { ...turn, pending: undefined } : turn,
        ),
        {
          id: crypto.randomUUID(),
          role: "agent" as const,
          text: result.reply,
          steps: result.toolCalls,
        },
      ])
      // Persist the exchange durably (best-effort; never blocks the UI).
      void saveExchange({
        userText: attempt.displayText,
        checkpoint: attempt.checkpoint,
        replyText: result.reply,
        steps: result.toolCalls,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "The agent failed. Try again.")
      setFailedAttempt(attempt)
    } finally {
      setBusy(false)
    }
  }

  async function send(prompt?: string): Promise<void> {
    const text = (prompt ?? message).trim()
    if ((!text && attachments.length === 0) || busy) return
    const displayText =
      text ||
      `${attachments.length} attached file${attachments.length === 1 ? "" : "s"}`
    // Snapshot the layout before this edit so the turn can be restored later.
    const checkpoint = layout
    // crypto.randomUUID is fine in client UI (determinism only matters in ops).
    const userTurnId = crypto.randomUUID()
    const userTurn: ChatTurn = {
      id: userTurnId,
      role: "user",
      text: displayText,
      checkpoint,
      pending: true,
    }
    // Snapshot the prior transcript before appending this turn — it becomes the
    // conversational context the (otherwise stateless) agent route replays.
    const history = turns.map((turn) => ({ role: turn.role, text: turn.text }))
    const sent = attachments
    // The restore marker belongs to the point that was restored; a new turn
    // moves the conversation past it.
    setTurns((prev) => [...prev, userTurn])
    setMessage("")
    setAttachments([])
    await runAttempt({
      text,
      attachments: sent,
      displayText,
      checkpoint,
      history,
      userTurnId,
    })
  }

  // Dismissing a failure also drops the turn it produced — a user message with
  // neither a reply nor an error reads as a bug — and hands the prompt back to
  // the composer so nothing typed is lost (unless something new is in there).
  function dismissError(): void {
    const attempt = failedAttempt
    setError(null)
    setFailedAttempt(null)
    if (!attempt) return
    setTurns((prev) => prev.filter((turn) => turn.id !== attempt.userTurnId))
    if (message.trim().length === 0 && attachments.length === 0) {
      setMessage(attempt.text)
      setAttachments(attempt.attachments)
    }
  }

  return (
    <div className={cn("flex h-full flex-col gap-3", className)}>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-none" aria-live="polite">
        {!hydrated ? (
          <ChatTranscriptSkeleton />
        ) : turns.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-center">
            <Image
              src="/breeze-mark.png"
              alt="Breeze"
              width={32}
              height={32}
              className="opacity-15 object-contain"
              priority={false}
            />
          </div>
        ) : null}
        {turns.map((turn) => {
          if (turn.role === "user") {
            const canRestore = Boolean(turn.checkpoint && onRestoreCheckpoint)
            return (
              <div key={turn.id} className="group/turn flex flex-col items-end gap-1">
                {editingTurnId === turn.id ? (
                  <div className="w-full space-y-1.5">
                    <Textarea
                      value={editingText}
                      autoFocus
                      rows={2}
                      onChange={(event) => setEditingText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault()
                          cancelEdit()
                          return
                        }
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault()
                          void submitEdit(turn)
                        }
                      }}
                      className="min-h-16 resize-none text-sm"
                      aria-label="Edit message"
                    />
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={cancelEdit}
                        className="h-7 px-2 text-xs"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void submitEdit(turn)}
                        disabled={busy || editingText.trim().length === 0}
                        className="h-7 px-2 text-xs"
                      >
                        Resubmit
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="max-w-[92%] rounded-lg bg-primary/10 px-3 py-2 text-sm text-foreground">
                      <p className="whitespace-pre-wrap break-words">{turn.text}</p>
                    </div>
                    <div
                      className={cn(
                        "flex items-center gap-0.5 transition-opacity",
                        "opacity-0 focus-within:opacity-100 group-hover/turn:opacity-100",
                      )}
                    >
                      <TurnActionButton
                        label="Edit and resubmit this message"
                        onClick={() => beginEdit(turn)}
                        disabled={busy}
                      >
                        <PencilIcon className="size-3" />
                      </TurnActionButton>
                      {canRestore ? (
                        <TurnActionButton
                          label="Undo this message and put it back in the composer"
                          onClick={() => confirmRestore(turn)}
                          disabled={busy}
                        >
                          <RotateCcwIcon className="size-3" />
                        </TurnActionButton>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            )
          }
          return (
            <div key={turn.id} className="group/turn space-y-1.5">
              {turn.steps && turn.steps.length > 0 ? (
                <div className="space-y-1">
                  {turn.steps.map((step, index) => (
                    <PortalToolStep key={`${turn.id}-step-${index}`} step={step} />
                  ))}
                </div>
              ) : null}
              {turn.text ? (
                <>
                  <div className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                    <div
                      className="breezify-editor !min-h-0 max-w-none break-words text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_li>p]:my-0 [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:pl-4 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:pl-4"
                      dangerouslySetInnerHTML={{
                        __html: markdown.render(turn.text || ""),
                      }}
                    />
                  </div>
                  <div
                    className={cn(
                      "flex items-center gap-0.5 transition-opacity",
                      copiedTurnId === turn.id
                        ? "opacity-100"
                        : "opacity-0 focus-within:opacity-100 group-hover/turn:opacity-100",
                    )}
                  >
                    <TurnActionButton
                      label={
                        copiedTurnId === turn.id ? "Copied" : "Copy this reply"
                      }
                      onClick={() => void copyReply(turn)}
                    >
                      {copiedTurnId === turn.id ? (
                        <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <CopyIcon className="size-3" />
                      )}
                    </TurnActionButton>
                  </div>
                </>
              ) : null}
            </div>
          )
        })}
        {busy ? <p className="text-sm text-muted-foreground">Working…</p> : null}
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="break-words">{error}</p>
              {failedAttempt ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  disabled={busy}
                  onClick={() => {
                    if (failedAttempt) void runAttempt(failedAttempt)
                  }}
                >
                  <RotateCcwIcon className="size-3" />
                  Retry
                </Button>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss error"
              onClick={dismissError}
              className="shrink-0 rounded-md p-0.5 opacity-70 transition-opacity hover:opacity-100"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          "relative shrink-0 rounded-xl border border-border bg-muted/20 p-3 pb-11 transition-colors focus-within:ring-1 focus-within:ring-ring",
          fileDragOver && "border-primary bg-primary/5 ring-2 ring-primary/20",
        )}
        onDragOver={(event) => {
          event.preventDefault()
          setFileDragOver(true)
        }}
        onDragLeave={(event) => {
          event.preventDefault()
          setFileDragOver(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setFileDragOver(false)
          appendAttachments(event.dataTransfer.files)
        }}
      >
        <Textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Describe what to build, or drop in context..."
          className="max-h-40 min-h-9 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent disabled:opacity-100 dark:bg-transparent dark:disabled:bg-transparent"
          disabled={busy}
          maxLength={MAX_AGENT_MESSAGE_LENGTH}
        />
        {attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2 pr-9">
            {attachments.map((file, index) => (
              <AttachmentPreview
                key={`${attachmentKey(file)}-${index}`}
                file={file}
                onRemove={() =>
                  setAttachments((current) => current.filter((_, i) => i !== index))
                }
              />
            ))}
          </div>
        ) : null}
        {fileDragOver ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-background/80 text-sm font-medium text-foreground">
            Drop files to attach
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) appendAttachments(event.target.files)
            event.target.value = ""
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute bottom-2 left-2 text-muted-foreground hover:text-foreground"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          <PlusIcon className="size-4" />
          <span className="sr-only">Attach file</span>
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          className="absolute bottom-2 right-2"
          onClick={() => void send()}
          disabled={busy || (message.trim().length === 0 && attachments.length === 0)}
        >
          {busy ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
          <span className="sr-only">Send</span>
        </Button>
      </div>

      <AlertDialog
        open={pendingRestore !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRestore(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this message?</AlertDialogTitle>
            <AlertDialogDescription>
              The portal goes back to how it was before this message. This
              message
              {restoreDropCount > 0
                ? ` and the ${restoreDropCount} message${
                    restoreDropCount === 1 ? "" : "s"
                  } after it`
                : ""}{" "}
              will be removed from the conversation, and the prompt returns to
              the composer so you can send it again. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRestore) restoreCheckpoint(pendingRestore)
              }}
            >
              Undo message
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
