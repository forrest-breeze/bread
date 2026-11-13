"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useSWRConfig } from "swr"
import { createClient } from "@/lib/supabase/client"
import {
  useDocument,
  useGitHubDocumentState,
  useWorkspace,
} from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { cn } from "@/lib/utils"
import {
  Loader2,
  Check,
  AlertCircle,
  Code2,
  Eye,
  History,
  ChevronDown,
  RotateCcw,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TiptapEditor, type TiptapEditorRef } from "@/components/app/editor/tiptap-editor"
import { VersionHistoryPanel } from "@/components/app/version-history-panel"
import type { OutlinePage } from "@/components/app/document-outline"
import { TabTitle } from "@/components/tab-title"
import { DocumentControls } from "@/components/app/document-controls-slot"
import { RelativeTime } from "@/components/app/relative-time"
import {
  readDraft,
  writeDraft,
  clearDraft,
  type DocumentDraft,
} from "@/lib/document-draft"
import {
  buildMarkdownExport,
  documentHtmlToMarkdown,
} from "@/lib/document-export"
import { usePortalEditorExit } from "@/components/portal-builder/portal-editor-exit-context"
import { GitHubDocumentToolbar } from "@/components/app/github-document-toolbar"
import { TextDiffViewer } from "@/components/app/text-diff-viewer"
import { buildBreezifyGitHubDraft } from "@/lib/github/github-hosted-publish"
import {
  notifyWorkspaceDocumentSaved,
  PREPARE_WORKSPACE_PUBLISH_EVENT,
  type PrepareWorkspacePublishEventDetail,
} from "@/lib/workspace-publish-events"

type Page = OutlinePage

const NODE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const NODE_ID_LENGTH = 8

function generatePageNodeId(): string {
  const bytes = new Uint8Array(NODE_ID_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < NODE_ID_LENGTH; i++) {
    out += NODE_ID_ALPHABET[bytes[i] % NODE_ID_ALPHABET.length]
  }
  return out
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Documents are edited as one continuous body. Legacy page-break markers stay
 * inline (the editor renders them as dividers), so loading and saving a
 * document round-trips its HTML unchanged.
 */
function documentAsPage(html: string): Page[] {
  return [{ name: "", nodeId: null, html: html ?? "" }]
}

/** Reassembles isolated pages into a single HTML document for persistence. */
function pagesToHtml(pages: Page[]): string {
  const parts: string[] = []
  pages.forEach((page, i) => {
    if (i === 0) {
      if (page.nodeId || page.name) {
        const id = page.nodeId ?? generatePageNodeId()
        const nameAttr = page.name
          ? ` data-name="${escapeHtmlAttr(page.name)}"`
          : ""
        parts.push(
          `<div data-type="page-break" data-node-id="${id}"${nameAttr}></div>`,
        )
      }
      parts.push(page.html)
      return
    }
    const id = page.nodeId ?? generatePageNodeId()
    const nameAttr = page.name
      ? ` data-name="${escapeHtmlAttr(page.name)}"`
      : ""
    parts.push(
      `<div data-type="page-break" data-node-id="${id}"${nameAttr}></div>`,
    )
    parts.push(page.html)
  })
  return parts.join("")
}

/** Converts Markdown $...$ / $$...$$ notation to Tiptap math node HTML. */
function convertMathSyntax(content: string): string {
  if (!content) return content
  // Block math first so $$ isn't consumed by the inline pass
  let result = content.replace(/\$\$([\s\S]+?)\$\$/g, (_, latex: string) => {
    const escaped = latex.trim().replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    return `<div data-type="math-block" data-latex="${escaped}"></div>`
  })
  // Inline math: only convert when the content looks like actual LaTeX, not
  // currency. Requires a leading non-digit character and either a LaTeX
  // command (\alpha, \frac) or a math operator. Prevents "$400M...$35k" from
  // being swallowed as a single inline math span.
  result = result.replace(/\$([^$\n]+?)\$/g, (match, latex: string) => {
    const trimmed = latex.trim()
    if (!trimmed) return match
    if (/^[\d,]/.test(trimmed)) return match
    const looksLikeMath =
      /\\[a-zA-Z]/.test(trimmed) || /[=<>≤≥±∑∏∫^_]/.test(trimmed)
    if (!looksLikeMath) return match
    const escaped = trimmed.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    return `<span data-type="math-inline" data-latex="${escaped}"></span>`
  })
  return result
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

type SaveState = "idle" | "saving" | "saved" | "error"

// Debounce for the local crash-recovery draft. This only writes to
// localStorage — the server is updated solely on an explicit Save.
const DRAFT_DEBOUNCE_MS = 800
// Quiet period after the last edit before it autosaves to the server. Autosaves
// are non-final, so the server coalesces them into one history version; ⌘S,
// hiding the tab and leaving the document save as final versions.
const AUTOSAVE_DEBOUNCE_MS = 1500
const SAVED_CONFIRMATION_MS = 1_800
const UNTITLED_TITLE_PATTERN = /^Untitled( \(\d+\))?$/
type RepositoryEditorMode = "visual" | "source"

interface RepositoryMarkdownParts {
  frontmatter: string
  body: string
}

function splitRepositoryMarkdown(content: string): RepositoryMarkdownParts {
  const normalized = content.replace(/\r\n?/g, "\n")
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: "", body: normalized }
  }
  const closing = normalized.indexOf("\n---", 4)
  if (closing === -1) return { frontmatter: "", body: normalized }
  const boundaryEnd = normalized.indexOf("\n", closing + 4)
  if (boundaryEnd === -1) {
    return { frontmatter: normalized, body: "" }
  }
  return {
    frontmatter: normalized.slice(0, boundaryEnd).trimEnd(),
    body: normalized.slice(boundaryEnd + 1).replace(/^\n+/, ""),
  }
}

function joinRepositoryMarkdown(
  frontmatter: string,
  pages: Page[],
): string {
  const sections: string[] = []
  for (const [index, page] of pages.entries()) {
    if (page.name.trim()) {
      sections.push(`## ${page.name.trim()}`)
    } else if (pages.length > 1 && index > 0) {
      sections.push("---")
    }
    const markdown = documentHtmlToMarkdown(page.html)
    if (markdown) sections.push(markdown)
  }
  const body = sections.join("\n\n").trim()
  if (!frontmatter) return body ? `${body}\n` : ""
  return body ? `${frontmatter}\n\n${body}\n` : `${frontmatter}\n`
}

function isFreshUntitled(title: string, content: string): boolean {
  return UNTITLED_TITLE_PATTERN.test(title) && content.trim() === ""
}

interface DocumentEditorProps {
  documentId: string
}

export function DocumentEditor({ documentId }: DocumentEditorProps): React.ReactElement {
  const documentKey = `/api/documents/${documentId}`
  const hasHydrated = useHasHydrated()
  const { cache, mutate: globalMutate } = useSWRConfig()
  const cachedDoc = cache.get(documentKey)?.data as
    | { __optimistic?: boolean }
    | undefined
  const skipInitialRevalidate = cachedDoc?.__optimistic === true
  const { data: doc, isLoading, mutate } = useDocument(documentId, {
    revalidateIfStale: !skipInitialRevalidate,
    revalidateOnMount: !skipInitialRevalidate,
  })
  const { data: workspace } = useWorkspace()
  const exitPortalEditor = usePortalEditorExit()
  const isGitHubDocument =
    doc?.source === "GitHub" &&
    doc.source_metadata?.kind === "repository_file"
  const hostedRepositoryDocumentId =
    !isGitHubDocument &&
    typeof doc?.source_metadata?.repository_document_id === "string"
      ? doc.source_metadata.repository_document_id
      : null
  const isHostedGitHubCopy = Boolean(
    !isGitHubDocument &&
      typeof doc?.source_metadata?.canonical_repo_path === "string" &&
      typeof doc?.source_metadata?.repo_full_name === "string",
  )
  const hostedHasConflict = Boolean(
    isHostedGitHubCopy && doc?.source_metadata?.github_hosted_conflict === true,
  )
  const canResolveHostedConflict = Boolean(
    hostedRepositoryDocumentId &&
      workspace &&
      ["owner", "admin", "editor"].includes(workspace.user_role),
  )
  const {
    data: githubState,
    isLoading: githubStateLoading,
    error: githubStateError,
    mutate: mutateGitHubState,
  } = useGitHubDocumentState(
    isGitHubDocument ? documentId : hostedRepositoryDocumentId,
    {
      enabled:
        isGitHubDocument ||
        (hostedHasConflict && Boolean(hostedRepositoryDocumentId)),
    },
  )
  const canEditGitHubDocument =
    !isGitHubDocument ||
    Boolean(
      githubState &&
        !githubStateError &&
        workspace &&
        ["owner", "admin", "editor"].includes(workspace.user_role),
    )

  const [title, setTitle] = useState("")
  const [pages, setPages] = useState<Page[]>([
    { name: "", nodeId: null, html: "" },
  ])
  const [activePage, setActivePage] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [savedConfirmationVisible, setSavedConfirmationVisible] = useState(false)
  // Reactive mirror of dirtyRef so the Save button, the leave guard, and the
  // "unsaved changes" hint can re-render. dirtyRef remains the source of truth
  // for the ref-based save path.
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  // A newer local draft recovered from a crash / earlier session, awaiting the
  // user's decision to restore or discard it.
  const [restorableDraft, setRestorableDraft] = useState<DocumentDraft | null>(
    null,
  )
  const [historyOpen, setHistoryOpen] = useState(false)
  const [repositoryEditorMode, setRepositoryEditorMode] =
    useState<RepositoryEditorMode>("visual")
  const [repositorySource, setRepositorySource] = useState("")
  const [hostedConflictOpen, setHostedConflictOpen] = useState(false)
  const [hostedConflictBusy, setHostedConflictBusy] = useState(false)
  const [hostedConflictError, setHostedConflictError] = useState<string | null>(
    null,
  )
  const [hostedConflictBreezifyDraft, setHostedConflictBreezifyDraft] = useState("")

  // Use refs for save logic so we always have fresh values without
  // needing to re-create the save function on every keystroke
  const titleRef = useRef(title)
  const contentRef = useRef("")
  const contentJsonRef = useRef<Record<string, unknown> | null>(null)
  const pagesRef = useRef<Page[]>(pages)
  const activePageRef = useRef(activePage)
  const dirtyRef = useRef(false)
  const docIdRef = useRef(documentId)
  const savingRef = useRef(false)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const deletedRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedConfirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const titleFieldRef = useRef<HTMLTextAreaElement | null>(null)
  const editorRef = useRef<TiptapEditorRef>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const isGitHubDocumentRef = useRef(false)
  const canEditGitHubDocumentRef = useRef(false)
  const githubStateRef = useRef(githubState)
  const repositoryEditorModeRef =
    useRef<RepositoryEditorMode>(repositoryEditorMode)
  const repositorySourceRef = useRef(repositorySource)
  const repositoryFrontmatterRef = useRef("")

  titleRef.current = title
  pagesRef.current = pages
  activePageRef.current = activePage
  docIdRef.current = documentId
  deletedRef.current = Boolean(doc?.deleted_at)
  isGitHubDocumentRef.current = isGitHubDocument
  canEditGitHubDocumentRef.current = canEditGitHubDocument
  githubStateRef.current = githubState
  repositoryEditorModeRef.current = repositoryEditorMode
  repositorySourceRef.current = repositorySource

  // Track whether we've initialized from fetched data
  const initializedRef = useRef<string | null>(null)

  const hideSavedConfirmation = useCallback((): void => {
    if (savedConfirmationTimerRef.current) {
      clearTimeout(savedConfirmationTimerRef.current)
      savedConfirmationTimerRef.current = null
    }
    setSavedConfirmationVisible(false)
  }, [])

  const showSavedConfirmation = useCallback((): void => {
    if (savedConfirmationTimerRef.current) {
      clearTimeout(savedConfirmationTimerRef.current)
    }
    setSavedConfirmationVisible(true)
    savedConfirmationTimerRef.current = setTimeout(() => {
      savedConfirmationTimerRef.current = null
      setSavedConfirmationVisible(false)
    }, SAVED_CONFIRMATION_MS)
  }, [])

  // Real-time subscription for this specific document
  useEffect(() => {
    const supabase = createClient()
    const channelName = `document-editor-${documentId}`
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "documents",
          filter: `id=eq.${documentId}`,
        },
        () => {
          // Only re-fetch if we don't have unsaved local changes to avoid
          // overwriting the user's current work mid-keystroke.
          if (!dirtyRef.current) {
            void mutate()
            if (isGitHubDocumentRef.current) {
              void mutateGitHubState()
            }
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [documentId, mutate, mutateGitHubState])

  // Editor and MCP writes share one branch-backed draft row. Revalidate the
  // GitHub state when another collaborator updates that row; never replace
  // unsaved keystrokes in this browser.
  useEffect(() => {
    if (!isGitHubDocument) return
    const supabase = createClient()
    const channel = supabase
      .channel(`github-document-session-${documentId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "github_document_edit_sessions",
          filter: `document_id=eq.${documentId}`,
        },
        () => {
          if (!dirtyRef.current && !savingRef.current) {
            void mutateGitHubState()
          }
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [documentId, isGitHubDocument, mutateGitHubState])

  // Populate fields when document loads, and apply remote updates when the
  // user has no pending edits (live sync across clients).
  useEffect(() => {
    if (!doc) return
    // A GitHub refresh is optional for viewing: repository-file documents
    // already carry their last indexed content. Keep waiting while the live
    // request is in flight, but fall back to that cached copy if it fails.
    if (isGitHubDocument && !githubState && !githubStateError) return
    const repositoryContent = isGitHubDocument
      ? githubState?.session?.draft_content ??
        githubState?.repository_content ??
        doc.content
      : null
    const repositoryParts = repositoryContent
      ? splitRepositoryMarkdown(repositoryContent)
      : { frontmatter: "", body: "" }
    const persistedContent = isGitHubDocument
      ? repositoryParts.body
      : doc.content
    const processed = convertMathSyntax(persistedContent)

    if (initializedRef.current !== doc.id) {
      const initialPages = documentAsPage(processed)
      setTitle(doc.title)
      setPages(initialPages)
      setActivePage(0)
      titleRef.current = doc.title
      pagesRef.current = initialPages
      activePageRef.current = 0
      contentRef.current = pagesToHtml(initialPages)
      contentJsonRef.current = null
      dirtyRef.current = false
      setHasUnsavedChanges(false)
      setSaveState("idle")
      hideSavedConfirmation()
      initializedRef.current = doc.id
      if (isGitHubDocument && repositoryContent !== null) {
        repositorySourceRef.current = repositoryContent
        repositoryFrontmatterRef.current = repositoryParts.frontmatter
        setRepositorySource(repositoryContent)
        const repositoryPath =
          githubState?.repository.file_path ??
          (typeof doc.source_metadata?.path === "string"
            ? doc.source_metadata.path
            : "")
        const initialMode: RepositoryEditorMode =
          githubState?.editable && repositoryPath.toLowerCase().endsWith(".mdx")
            ? "source"
            : "visual"
        repositoryEditorModeRef.current = initialMode
        setRepositoryEditorMode(initialMode)
      }

      // Crash recovery: if a local draft is newer than the server's last save
      // and actually differs from what we just loaded, offer to restore it.
      const draft = readDraft(doc.id)
      const persistedDraftValue =
        isGitHubDocument && repositoryContent !== null
          ? repositoryContent
          : contentRef.current
      if (
        draft &&
        new Date(draft.savedAt).getTime() > new Date(doc.updated_at).getTime() &&
        draft.content !== persistedDraftValue
      ) {
        setRestorableDraft(draft)
      } else {
        setRestorableDraft(null)
        if (draft) clearDraft(doc.id)
      }
      // Newly-created docs land with a placeholder "Untitled" title and empty
      // body — focus the title field so the user can name it without an extra
      // click. Existing docs let Tiptap's autoFocus put the cursor in the body.
      if (isFreshUntitled(doc.title, doc.content)) {
        // Delay past Tiptap's setTimeout(0) autoFocus so the title field wins.
        setTimeout(() => {
          const field = titleFieldRef.current
          if (!field) return
          field.focus()
          field.setSelectionRange(0, field.value.length)
        }, 16)
      }
      return
    }

    // Remote update for the doc we're already viewing. Never clobber local
    // edits that haven't been saved yet or are in the middle of saving.
    if (dirtyRef.current || savingRef.current) return

    if (isGitHubDocument && repositoryContent !== null) {
      if (repositoryContent !== repositorySourceRef.current) {
        repositorySourceRef.current = repositoryContent
        repositoryFrontmatterRef.current = repositoryParts.frontmatter
        setRepositorySource(repositoryContent)
      }
    }

    if (doc.title !== titleRef.current) {
      setTitle(doc.title)
      titleRef.current = doc.title
    }

    const nextPages = documentAsPage(processed)
    const nextHtml = pagesToHtml(nextPages)
    if (nextHtml !== contentRef.current) {
      setPages(nextPages)
      pagesRef.current = nextPages
      contentRef.current = nextHtml
      contentJsonRef.current = null
      // Clamp the active page in case the remote update shrank the document
      if (activePageRef.current >= nextPages.length) {
        const clamped = Math.max(0, nextPages.length - 1)
        setActivePage(clamped)
        activePageRef.current = clamped
      }
    }
  }, [
    doc,
    githubState,
    githubStateError,
    hideSavedConfirmation,
    isGitHubDocument,
  ])

  // Write the current document to the local crash-recovery draft (synchronous,
  // localStorage only — never the server).
  const writeDraftNow = useCallback((): void => {
    const content = isGitHubDocumentRef.current
      ? repositoryEditorModeRef.current === "source"
        ? repositorySourceRef.current
        : joinRepositoryMarkdown(
            repositoryFrontmatterRef.current,
            pagesRef.current,
          )
      : contentRef.current
    writeDraft(docIdRef.current, {
      title: titleRef.current,
      content,
      savedAt: new Date().toISOString(),
    })
  }, [])

  // Pull the visible TipTap state into refs before saving. This protects the
  // explicit save path from a pending editor update being one render behind.
  const syncActiveEditorContent = useCallback((): void => {
    if (deletedRef.current) return

    const editor = editorRef.current?.getEditor()
    if (!editor) return

    const html = editor.getHTML()
    const current = pagesRef.current
    const index = activePageRef.current
    const active = current[index]
    if (!active || active.html === html) return

    const nextPages = current.slice()
    nextPages[index] = { ...active, html }
    pagesRef.current = nextPages
    setPages(nextPages)
    contentRef.current = pagesToHtml(nextPages)
    contentJsonRef.current = null
    dirtyRef.current = true
    setHasUnsavedChanges(true)
  }, [])

  // Core save function using refs (stable identity). Resolves to true when the
  // document is persisted (or there was nothing to persist), false on failure.
  const doSave = useCallback(async function saveLatest(
    options: { finalize?: boolean } = {},
  ): Promise<boolean> {
    const finalize = options.finalize ?? true
    if (deletedRef.current) return false
    if (
      isGitHubDocumentRef.current &&
      !canEditGitHubDocumentRef.current
    ) {
      return false
    }

    if (
      !isGitHubDocumentRef.current ||
      repositoryEditorModeRef.current === "visual"
    ) {
      syncActiveEditorContent()
    }

    if (savingRef.current) {
      const inFlight = savePromiseRef.current
      if (!inFlight) return false
      const ok = await inFlight
      if (!ok) return false
      return dirtyRef.current ? saveLatest(options) : true
    }

    if (!dirtyRef.current) return true

    const id = docIdRef.current
    const payload = {
      title: titleRef.current,
      content: contentRef.current,
      content_json: contentJsonRef.current,
    }
    const repositoryContentAtRequest = isGitHubDocumentRef.current
      ? repositoryEditorModeRef.current === "source"
        ? repositorySourceRef.current
        : joinRepositoryMarkdown(
            repositoryFrontmatterRef.current,
            pagesRef.current,
          )
      : null

    savingRef.current = true
    setSaveState("saving")
    // Keep a local copy until this exact payload is confirmed as the latest
    // saved state. If the request fails or newer edits arrive mid-flight, the
    // recovery draft must stay available.
    writeDraftNow()

    if (!isGitHubDocumentRef.current) {
      // Optimistically update the local cache for database-owned documents.
      mutate(
        (current: any) => (current ? { ...current, ...payload } : current),
        { revalidate: false },
      )
    }

    const savePromise = (async (): Promise<boolean> => {
      try {
        const githubDocument = isGitHubDocumentRef.current
        // Repository drafts save to the shared branch session. Database-owned
        // notes keep their existing explicit snapshot behavior.
        const res = githubDocument
          ? await fetch(`/api/documents/${id}/github`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: repositoryContentAtRequest ?? "",
                ...(githubStateRef.current?.session
                  ? {
                      expected_revision:
                        githubStateRef.current.session.draft_revision,
                    }
                  : {}),
              }),
              keepalive: true,
            })
          : await fetch(`/api/documents/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...payload, finalize_version: finalize }),
              keepalive: true,
            })

        if (!res.ok) throw new Error("Save failed")

        const currentRepositoryContent = githubDocument
          ? repositoryEditorModeRef.current === "source"
            ? repositorySourceRef.current
            : joinRepositoryMarkdown(
                repositoryFrontmatterRef.current,
                pagesRef.current,
              )
          : null
        const savedPayloadIsStillCurrent = githubDocument
          ? currentRepositoryContent === repositoryContentAtRequest
          : titleRef.current === payload.title &&
            contentRef.current === payload.content

        if (savedPayloadIsStillCurrent) {
          dirtyRef.current = false
          setHasUnsavedChanges(false)
          // The server is now authoritative — drop the local crash-recovery draft.
          clearDraft(id)
          setSaveState("saved")
          showSavedConfirmation()
        } else {
          dirtyRef.current = true
          setHasUnsavedChanges(true)
          writeDraftNow()
          setSaveState("idle")
        }

        if (githubDocument && repositoryContentAtRequest !== null) {
          repositorySourceRef.current = repositoryContentAtRequest
          setRepositorySource(repositoryContentAtRequest)
          await mutateGitHubState()
          return true
        }

        // Refresh updated_at locally so the "Saved Xm ago" badge flips to
        // "just now" without waiting for the next refetch.
        const savedAt = new Date().toISOString()
        mutate(
          (current: any) =>
            current ? { ...current, updated_at: savedAt } : current,
          { revalidate: false },
        )

        // Optimistically update the documents list cache (title may have changed)
        globalMutate(
          "/api/documents",
          (current: unknown) =>
            Array.isArray(current)
              ? current.map((d: Record<string, unknown>) =>
                  d.id === id
                    ? { ...d, title: payload.title, updated_at: savedAt }
                    : d,
                )
              : current,
          { revalidate: false },
        )

        notifyWorkspaceDocumentSaved({ documentId: id, savedAt })

        return true
      } catch {
        if (isGitHubDocumentRef.current) {
          await mutateGitHubState()
        }
        dirtyRef.current = true
        setHasUnsavedChanges(true)
        writeDraftNow()
        setSaveState("error")
        return false
      } finally {
        savingRef.current = false
        savePromiseRef.current = null
      }
    })()

    savePromiseRef.current = savePromise
    return savePromise
  }, [
    mutate,
    mutateGitHubState,
    globalMutate,
    showSavedConfirmation,
    syncActiveEditorContent,
    writeDraftNow,
  ])

  // Workspace publishing lives in the Knowledge sidebar, but it must not race
  // an unsaved document in the main pane. Repository-file drafts have their own
  // GitHub toolbar and deliberately do not participate in this workspace flow.
  useEffect(() => {
    if (!doc || doc.deleted_at || isGitHubDocument) return

    const handlePrepareWorkspacePublish = (event: Event): void => {
      const detail = (
        event as CustomEvent<PrepareWorkspacePublishEventDetail>
      ).detail
      detail?.waitUntil(doSave())
    }

    window.addEventListener(
      PREPARE_WORKSPACE_PUBLISH_EVENT,
      handlePrepareWorkspacePublish,
    )
    return () => {
      window.removeEventListener(
        PREPARE_WORKSPACE_PUBLISH_EVENT,
        handlePrepareWorkspacePublish,
      )
    }
  }, [doSave, doc, isGitHubDocument])

  // After an edit: a quick local crash-recovery draft, then a debounced,
  // non-final autosave to the server once typing pauses.
  const scheduleDraftWrite = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(writeDraftNow, DRAFT_DEBOUNCE_MS)
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null
      void doSave({ finalize: false })
    }, AUTOSAVE_DEBOUNCE_MS)
  }, [doSave, writeDraftNow])

  // Mark the document as having unsaved edits and queue a draft write.
  const markDirty = useCallback((): void => {
    if (deletedRef.current) return
    dirtyRef.current = true
    setHasUnsavedChanges(true)
    setSaveState("idle")
    hideSavedConfirmation()
    scheduleDraftWrite()
  }, [hideSavedConfirmation, scheduleDraftWrite])

  const handleTitleChange = (value: string): void => {
    setTitle(value)
    titleRef.current = value
    markDirty()
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault()
      editorRef.current?.focus()
    }
  }

  const handleRepositorySourceChange = (value: string): void => {
    repositorySourceRef.current = value
    setRepositorySource(value)
    markDirty()
  }

  const switchRepositoryEditorMode = (
    mode: RepositoryEditorMode,
  ): void => {
    if (mode === repositoryEditorModeRef.current) return
    if (mode === "source") {
      if (dirtyRef.current) {
        syncActiveEditorContent()
        const nextSource = joinRepositoryMarkdown(
          repositoryFrontmatterRef.current,
          pagesRef.current,
        )
        repositorySourceRef.current = nextSource
        setRepositorySource(nextSource)
      }
    } else {
      const parts = splitRepositoryMarkdown(repositorySourceRef.current)
      repositoryFrontmatterRef.current = parts.frontmatter
      const nextPages = documentAsPage(convertMathSyntax(parts.body))
      pagesRef.current = nextPages
      setPages(nextPages)
      contentRef.current = pagesToHtml(nextPages)
      contentJsonRef.current = null
      setActivePage(0)
      activePageRef.current = 0
    }
    repositoryEditorModeRef.current = mode
    setRepositoryEditorMode(mode)
  }

  const applyRepositoryContent = useCallback((content: string): void => {
    const parts = splitRepositoryMarkdown(content)
    repositorySourceRef.current = content
    repositoryFrontmatterRef.current = parts.frontmatter
    setRepositorySource(content)
    const nextPages = documentAsPage(convertMathSyntax(parts.body))
    pagesRef.current = nextPages
    setPages(nextPages)
    contentRef.current = pagesToHtml(nextPages)
    contentJsonRef.current = null
    setActivePage(0)
    activePageRef.current = 0
    dirtyRef.current = false
    setHasUnsavedChanges(false)
    setSaveState("saved")
    clearDraft(docIdRef.current)
  }, [])

  const commitPages = useCallback(
    (nextPages: Page[]): void => {
      pagesRef.current = nextPages
      setPages(nextPages)
      contentRef.current = pagesToHtml(nextPages)
      contentJsonRef.current = null
      markDirty()
    },
    [markDirty],
  )

  // Tiptap normalized the active page's HTML after setContent (e.g. parsed
  // markdown into heading nodes or assigned nodeIds). Mirror the normalized
  // HTML into state so the outline can find the headings — but don't mark
  // the doc dirty, since no user edit happened.
  const handleContentNormalize = useCallback((html: string): void => {
    const current = pagesRef.current
    const index = activePageRef.current
    if (!current[index]) return
    if (current[index].html === html) return
    const nextPages = current.slice()
    nextPages[index] = { ...nextPages[index], html }
    pagesRef.current = nextPages
    setPages(nextPages)
    contentRef.current = pagesToHtml(nextPages)
  }, [])

  const handleContentChange = (html: string): void => {
    const current = pagesRef.current
    const index = activePageRef.current
    if (!current[index]) return
    if (current[index].html === html) return
    const nextPages = current.slice()
    nextPages[index] = { ...nextPages[index], html }
    commitPages(nextPages)
  }

  const handleJSONUpdate = (json: Record<string, unknown>): void => {
    // Editor JSON only reflects the active page; the full document is
    // reconstructed from HTML at save time, so we intentionally drop
    // per-page JSON to avoid persisting a partial tree.
    contentJsonRef.current = null
    void json
  }

  useEffect(() => {
    const field = titleFieldRef.current
    if (!field) return

    field.style.height = "0px"
    field.style.height = `${field.scrollHeight}px`
  }, [title])

  // Save now as a final version (⌘S, hiding the tab, leaving the document).
  const flushSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    void doSave()
  }, [doSave])

  // Keyboard shortcut: Cmd/Ctrl+S
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        flushSave()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [flushSave])

  // Tab close / refresh / hide: write the local recovery draft synchronously,
  // then save to the server (keepalive, so the request outlives the page).
  useEffect(() => {
    const saveOnLeave = (): void => {
      if (deletedRef.current || !dirtyRef.current) return
      writeDraftNow()
      flushSave()
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") saveOnLeave()
    }

    window.addEventListener("pagehide", saveOnLeave)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      window.removeEventListener("pagehide", saveOnLeave)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [flushSave, writeDraftNow])

  // On unmount (switching documents or leaving Knowledge): keep a local
  // recovery draft and save the latest edits to the server. The refs still
  // point at this document, and the keepalive request outlives the component.
  const flushSaveRef = useRef(flushSave)
  useEffect(() => {
    flushSaveRef.current = flushSave
  }, [flushSave])
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (savedConfirmationTimerRef.current) {
        clearTimeout(savedConfirmationTimerRef.current)
      }
      if (dirtyRef.current && !deletedRef.current) {
        writeDraftNow()
        flushSaveRef.current()
      } else if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current)
      }
    }
  }, [writeDraftNow])

  // Load a recovered draft into the editor (user opted to restore).
  const restoreDraft = useCallback((): void => {
    if (!restorableDraft) return
    const repositoryParts = isGitHubDocumentRef.current
      ? splitRepositoryMarkdown(restorableDraft.content)
      : null
    const draftPages = documentAsPage(
      convertMathSyntax(repositoryParts?.body ?? restorableDraft.content),
    )
    setTitle(restorableDraft.title)
    titleRef.current = restorableDraft.title
    if (repositoryParts) {
      repositorySourceRef.current = restorableDraft.content
      repositoryFrontmatterRef.current = repositoryParts.frontmatter
      setRepositorySource(restorableDraft.content)
    }
    setPages(draftPages)
    pagesRef.current = draftPages
    contentRef.current = pagesToHtml(draftPages)
    contentJsonRef.current = null
    setActivePage(0)
    activePageRef.current = 0
    dirtyRef.current = true
    setHasUnsavedChanges(true)
    setSaveState("idle")
    setRestorableDraft(null)
  }, [restorableDraft])

  // Discard a recovered draft (keep the server version that's already loaded).
  const dismissDraft = useCallback((): void => {
    clearDraft(docIdRef.current)
    setRestorableDraft(null)
  }, [])

  const getExportInput = useCallback(() => {
    syncActiveEditorContent()

    return {
      title: titleRef.current,
      pages: pagesRef.current,
      updatedAt: doc?.updated_at,
    }
  }, [doc?.updated_at, syncActiveEditorContent])

  const openHostedConflictResolver = useCallback((): void => {
    if (!githubState) return
    const exportInput = getExportInput()
    setHostedConflictBreezifyDraft(
      buildBreezifyGitHubDraft({
        repositoryContent: githubState.repository_content,
        breezifyTitle: exportInput.title,
        breezifyMarkdown: buildMarkdownExport(exportInput),
      }),
    )
    setHostedConflictError(null)
    setHostedConflictOpen(true)
  }, [getExportInput, githubState])

  const acceptHostedGitHubVersion = useCallback(async (): Promise<void> => {
    setHostedConflictBusy(true)
    setHostedConflictError(null)
    try {
      const response = await fetch(
        `/api/documents/${documentId}/github-hosted-conflict`,
        { method: "POST" },
      )
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(payload?.error ?? "Could not use the GitHub version.")
      }
      initializedRef.current = null
      await Promise.all([mutate(), globalMutate("/api/documents")])
      setHostedConflictOpen(false)
    } catch (error) {
      setHostedConflictError(
        error instanceof Error
          ? error.message
          : "Could not use the GitHub version.",
      )
    } finally {
      setHostedConflictBusy(false)
    }
  }, [documentId, globalMutate, mutate])

  // The SWR cache is seeded synchronously from localStorage (see swr-provider),
  // so `doc` can be present on the first client render while the server (no
  // localStorage) rendered the skeleton. Hold the skeleton until hydration
  // completes so both trees match; the cached doc paints on the next render.
  if (
    !hasHydrated ||
    !doc ||
    (isGitHubDocument && !githubState && !githubStateError)
  ) {
    if (
      !hasHydrated ||
      isLoading ||
      (isGitHubDocument && githubStateLoading && !githubStateError)
    ) {
      return (
        <div className="flex h-full flex-col">
          <TabTitle title="Knowledge" />
          <div className="shrink-0 border-b border-border bg-background/95">
            <div className="flex items-center justify-between gap-3 px-6 py-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-20 rounded-full" />
                <Skeleton className="h-8 w-24 rounded-full" />
                <Skeleton className="h-4 w-36" />
              </div>
              <Skeleton className="size-8 rounded-full" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-10 space-y-4">
              <Skeleton className="h-10 w-3/4" />
              <div className="pt-4 space-y-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-10/12" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-9/12" />
              </div>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <TabTitle title="Knowledge" />
        <AlertCircle className="size-8 text-muted-foreground/30" />
        <p className="mt-3 text-sm text-muted-foreground">
          Document not found or you don’t have access.
        </p>
      </div>
    )
  }

  const isDeleted = Boolean(doc.deleted_at)
  const deletedAt = doc.deleted_at ?? doc.updated_at
  const editedTimestamp =
    isGitHubDocument && githubState?.session
      ? githubState.session.updated_at
      : isDeleted
        ? deletedAt
        : doc.updated_at
  const editedPrefix = isDeleted
    ? "Moved to trash"
    : isGitHubDocument && githubStateError
      ? "Indexed"
      : isGitHubDocument && githubState?.session
        ? "Draft edited"
        : "Edited"

  return (
    <div className="flex h-full flex-col">
      <TabTitle title={title.trim() || "Untitled"} />
      <DocumentControls>
        <div className="flex min-w-0 items-center gap-2">
          {isDeleted ? (
            <Badge
              variant="secondary"
              className="h-6 rounded-full px-2 text-[11px] font-medium"
            >
              In trash
            </Badge>
          ) : null}
          {/* Edits autosave as you type and save on ⌘S, tab switch and when
              leaving the document, so the only save UI is this status. */}
          <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-w-0 gap-1.5 px-2.5 font-normal text-muted-foreground"
                />
              }
              aria-label="Open version history"
            >
              <History className="size-3.5 shrink-0" aria-hidden="true" />
              {saveState === "saving" ? (
                <span className="flex items-center gap-1" role="status">
                  <Loader2 className="size-3 animate-spin" />
                  Saving…
                </span>
              ) : savedConfirmationVisible ? (
                <span
                  className="flex items-center gap-1"
                  role="status"
                  aria-live="polite"
                >
                  <Check className="size-3.5 text-emerald-600" />
                  Saved
                </span>
              ) : (
                <RelativeTime
                  isoDate={editedTimestamp}
                  prefix={editedPrefix}
                  className="truncate"
                  title={formatDate(editedTimestamp)}
                />
              )}
              <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              aria-label="Version history"
              className="h-[min(28rem,var(--available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-hidden p-0"
            >
              {historyOpen && (
                <VersionHistoryPanel
                  documentId={documentId}
                  onClose={() => setHistoryOpen(false)}
                  onRestore={() => {
                    initializedRef.current = null
                    void mutate()
                    if (isGitHubDocument) void mutateGitHubState()
                  }}
                />
              )}
            </PopoverContent>
          </Popover>

          {saveState === "error" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5 border-destructive/40 px-2.5 text-destructive hover:text-destructive"
              onClick={() => flushSave()}
              title="Autosave failed — click to retry"
            >
              <AlertCircle className="size-3.5" />
              Retry save
            </Button>
          ) : null}

          {isGitHubDocument && githubState?.editable && (
            <div
              className="flex items-center rounded-full border p-0.5"
              role="group"
              aria-label="Repository editor mode"
            >
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-6 rounded-full px-2 text-[11px]",
                  repositoryEditorMode === "visual" && "bg-muted",
                )}
                aria-pressed={repositoryEditorMode === "visual"}
                onClick={() => switchRepositoryEditorMode("visual")}
              >
                <Eye className="size-3" />
                Visual
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-6 rounded-full px-2 text-[11px]",
                  repositoryEditorMode === "source" && "bg-muted",
                )}
                aria-pressed={repositoryEditorMode === "source"}
                onClick={() => switchRepositoryEditorMode("source")}
              >
                <Code2 className="size-3" />
                Source
              </Button>
            </div>
          )}

          {isGitHubDocument && githubState && (
            <GitHubDocumentToolbar
              documentId={documentId}
              state={githubState}
              hasUnsavedChanges={hasUnsavedChanges}
              saveDraft={doSave}
              refresh={mutateGitHubState}
              onUseDeployment={applyRepositoryContent}
              disabled={
                isDeleted ||
                !canEditGitHubDocument ||
                !githubState.editable ||
                saveState === "saving"
              }
            />
          )}
        </div>
      </DocumentControls>

      {/* Editor + History layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Editor area */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-10">
            {isDeleted && (
              <div className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <div>
                    <p className="font-medium text-foreground">
                      This note has been moved to trash
                    </p>
                    <p className="text-muted-foreground">
                      Restore it before making more edits.
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  render={<a href="/settings/trash" />}
                  className="shrink-0"
                >
                  View trash
                </Button>
              </div>
            )}

            {isGitHubDocument && githubStateError && !isDeleted && (
              <div
                role="alert"
                className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <div>
                    <p className="font-medium text-foreground">
                      Live GitHub access is unavailable
                    </p>
                    <p className="text-muted-foreground">
                      Showing the last indexed copy. Reconnect the repository or
                      retry to restore live editing and GitHub history.
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    render={<a href="/settings/integrations/github" />}
                  >
                    GitHub settings
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void mutateGitHubState()}
                  >
                    Retry
                  </Button>
                </div>
              </div>
            )}

            {isHostedGitHubCopy && hostedHasConflict && !isDeleted && (
              <div
                role="alert"
                className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <div>
                    <p className="font-medium text-foreground">
                      GitHub and Breezify both changed
                    </p>
                    <p className="text-muted-foreground">
                      Automatic sync preserved this Breezify version. Review it
                      beside the current GitHub file before choosing which version
                      continues.
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="shrink-0"
                  disabled={
                    !canResolveHostedConflict ||
                    githubStateLoading ||
                    !githubState ||
                    Boolean(githubStateError)
                  }
                  onClick={openHostedConflictResolver}
                >
                  {githubStateLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  Review conflict
                </Button>
              </div>
            )}

            {/* Crash-recovery banner: a newer local draft is available. */}
            {restorableDraft && !isDeleted && (
              <div className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2.5">
                  <RotateCcw className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <div>
                    <p className="font-medium text-foreground">
                      Unsaved changes recovered
                    </p>
                    <p className="text-muted-foreground">
                      You have edits from a previous session that were never
                      saved.
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={dismissDraft}>
                    Discard
                  </Button>
                  <Button
                    size="sm"
                    onClick={restoreDraft}
                    disabled={
                      isGitHubDocument && !canEditGitHubDocument
                    }
                  >
                    Restore
                  </Button>
                </div>
              </div>
            )}

            {isGitHubDocument && githubState && !githubState.editable && (
              <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div>
                  <p className="font-medium text-foreground">
                    This repository file is read-only here
                  </p>
                  <p className="text-muted-foreground">
                    Visual branch editing supports Markdown and MDX files.
                    Open this file on GitHub to edit its source safely.
                  </p>
                </div>
              </div>
            )}

            {isGitHubDocument &&
              githubState?.editable &&
              !canEditGitHubDocument && (
                <div className="mb-6 flex items-start gap-2.5 rounded-lg border bg-muted/40 p-4 text-sm">
                  <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="font-medium text-foreground">
                      Viewing this GitHub draft
                    </p>
                    <p className="text-muted-foreground">
                      Your workspace role can inspect the file and its complete
                      history. An editor, admin, or owner can change and publish
                      the shared draft.
                    </p>
                  </div>
                </div>
              )}

            {isGitHubDocument &&
              githubState?.session?.status === "conflict" && (
                <div
                  role="alert"
                  className="mb-6 flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-600" />
                  <div>
                    <p className="font-medium text-foreground">
                      Publishing needs conflict review
                    </p>
                    <p className="text-muted-foreground">
                      GitHub and this draft changed overlapping lines. Your
                      draft is safe. Reconcile it in Source mode and save, or
                      choose “Review conflict” from the GitHub menu.
                    </p>
                  </div>
                </div>
              )}

            {isGitHubDocument &&
              githubState?.behind_deployment &&
              githubState.session?.status !== "conflict" && (
                <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-blue-500/30 bg-blue-500/10 p-4 text-sm">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-blue-600" />
                  <div>
                    <p className="font-medium text-foreground">
                      The deployment branch changed
                    </p>
                    <p className="text-muted-foreground">
                      Breezify will merge non-overlapping GitHub changes when you
                      publish and will stop before writing if review is needed.
                    </p>
                  </div>
                </div>
              )}

            {/* Title — in the portal builder's preview, a close control sits
                where the rendered portal shows its edit (pencil) icon. */}
            <div className="flex items-start gap-3">
              <textarea
                ref={titleFieldRef}
                value={title}
                onChange={(e) => {
                  if (!isGitHubDocument) handleTitleChange(e.target.value)
                }}
                onKeyDown={handleTitleKeyDown}
                readOnly={isDeleted || isGitHubDocument}
                rows={1}
                className={cn(
                  "min-w-0 flex-1 resize-none overflow-hidden bg-transparent text-3xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/35 md:text-4xl",
                  // In the builder's preview frame, cue that the title is
                  // editable in place (Notion-style hover wash).
                  !(isDeleted || isGitHubDocument) &&
                    "rounded-md transition-colors [[data-preview-editor]_&]:hover:bg-muted/55 [[data-preview-editor]_&]:focus:bg-transparent",
                  (isDeleted || isGitHubDocument) &&
                    "cursor-default text-muted-foreground",
                )}
                placeholder="Untitled"
              />
              {exitPortalEditor ? (
                <button
                  type="button"
                  title="Close editor"
                  onClick={exitPortalEditor}
                  className="inline-flex h-9 shrink-0 items-center justify-center px-1 text-sm font-medium text-red-500 transition-colors hover:text-red-600 dark:hover:text-red-400"
                >
                  Cancel
                </button>
              ) : null}
            </div>

            {isGitHubDocument && repositoryEditorMode === "source" ? (
              <div className="mt-6">
                <label htmlFor="repository-source-editor" className="sr-only">
                  Markdown source for {githubState?.repository.file_path}
                </label>
                <textarea
                  id="repository-source-editor"
                  value={repositorySource}
                  onChange={(event) =>
                    handleRepositorySourceChange(event.target.value)
                  }
                  readOnly={
                    isDeleted ||
                    !canEditGitHubDocument ||
                    !githubState?.editable
                  }
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="min-h-[60vh] w-full resize-y rounded-lg border bg-muted/20 p-4 font-mono text-sm leading-6 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 read-only:cursor-default read-only:opacity-70"
                />
              </div>
            ) : (
              /* Rich text editor — shows only the active page's body. */
              <div className="mt-4">
                <TiptapEditor
                  ref={editorRef}
                  documentId={documentId}
                  content={pages[activePage]?.html ?? ""}
                  onUpdate={handleContentChange}
                  onNormalize={handleContentNormalize}
                  onJSONUpdate={handleJSONUpdate}
                  autoFocus
                  editable={
                    !isDeleted &&
                    canEditGitHubDocument &&
                    (!isGitHubDocument || Boolean(githubState?.editable))
                  }
                />
              </div>
            )}
          </div>
        </div>

      </div>

      <Dialog
        open={hostedConflictOpen}
        onOpenChange={(open) => {
          if (!hostedConflictBusy) setHostedConflictOpen(open)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Resolve GitHub and Breezify changes</DialogTitle>
            <DialogDescription>
              Compare the complete GitHub file with the linked Breezify version.
              Nothing is written to GitHub until workspace changes are published
              together in one pull request.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
              <span>Current GitHub version</span>
              <span>Current Breezify version</span>
            </div>
            <TextDiffViewer
              previousText={githubState?.repository_content ?? ""}
              nextText={hostedConflictBreezifyDraft}
              emptyMessage="The two versions now match."
              className="max-h-[45vh] overflow-auto shadow-none"
            />
          </div>

          {hostedConflictError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {hostedConflictError}
            </p>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              disabled={hostedConflictBusy}
              onClick={() => setHostedConflictOpen(false)}
            >
              Continue editing
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                variant="outline"
                disabled={hostedConflictBusy}
                onClick={() => void acceptHostedGitHubVersion()}
              >
                {hostedConflictBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Use GitHub version
              </Button>
              <Button
                disabled={hostedConflictBusy}
                onClick={() => {
                  setHostedConflictOpen(false)
                }}
              >
                Keep Breezify for workspace publish
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}
