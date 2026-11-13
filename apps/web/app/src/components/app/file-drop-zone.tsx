"use client"

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSWRConfig } from "swr"
import { Upload, Loader2, AlertTriangle, X } from "lucide-react"
import { cn } from "@/lib/utils"

export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024

const ALLOWED_EXTENSIONS = [
  ".md",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
] as const

// Single source of truth for the human-readable "what can I ingest" hint,
// reused by the drag overlay and the Knowledge home empty state. Files are
// read as UTF-8 text — binary formats (PDF, DOCX, images) are not parsed.
export const SUPPORTED_FILES_HINT =
  "Text files only — .md, .txt, .ts, .tsx, .js, .jsx, .json (max 2 MB each). PDF, Word, and images aren't supported yet."

type RejectionReason = "unsupported-type" | "oversize" | "empty"

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: RejectionReason }

export function validateFile(file: File): ValidationResult {
  const lower = file.name.toLowerCase()
  const isText =
    file.type.startsWith("text/") ||
    ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
  if (!isText) return { ok: false, reason: "unsupported-type" }
  if (file.size === 0) return { ok: false, reason: "empty" }
  if (file.size > MAX_FILE_SIZE_BYTES) return { ok: false, reason: "oversize" }
  return { ok: true }
}

function reasonLabel(reason: RejectionReason): string {
  switch (reason) {
    case "unsupported-type":
      return "unsupported file type — text files only (.md, .txt, .ts, .tsx, .js, .jsx, .json)"
    case "oversize":
      return "file too large (max 2 MB)"
    case "empty":
      return "file is empty"
  }
}

type FileUploadStatus =
  | { state: "pending"; file: File }
  | { state: "uploading"; file: File }
  | { state: "success"; file: File }
  | { state: "error"; file: File; reason: string }

interface Rejection {
  file: File
  reason: RejectionReason
}

export function FileDropZone({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false)
  const [uploads, setUploads] = useState<FileUploadStatus[]>([])
  const [rejections, setRejections] = useState<Rejection[]>([])
  const [dismissed, setDismissed] = useState(false)
  const { mutate } = useSWRConfig()
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isUploading = uploads.some(
    (u) => u.state === "uploading" || u.state === "pending",
  )
  const failures = uploads.filter(
    (u): u is Extract<FileUploadStatus, { state: "error" }> =>
      u.state === "error",
  )
  const successes = uploads.filter((u) => u.state === "success")
  const totalAttempted = uploads.length
  const hasStatus =
    !dismissed &&
    (isUploading || uploads.length > 0 || rejections.length > 0)

  const clearDismissTimer = useCallback((): void => {
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      clearDismissTimer()
    }
  }, [clearDismissTimer])

  const uploadOne = useCallback(async (file: File): Promise<boolean> => {
    setUploads((prev) =>
      prev.map((u) => (u.file === file ? { state: "uploading", file } : u)),
    )
    try {
      const content = await file.text()
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: file.name, content }),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: unknown
        }
        const reason =
          typeof payload.error === "string"
            ? payload.error
            : `Server error (${res.status})`
        setUploads((prev) =>
          prev.map((u) =>
            u.file === file ? { state: "error", file, reason } : u,
          ),
        )
        return false
      }
      setUploads((prev) =>
        prev.map((u) => (u.file === file ? { state: "success", file } : u)),
      )
      return true
    } catch (err) {
      console.error("[Breezify] upload failed:", err)
      const reason = err instanceof Error ? err.message : "Network error"
      setUploads((prev) =>
        prev.map((u) =>
          u.file === file ? { state: "error", file, reason } : u,
        ),
      )
      return false
    }
  }, [])

  const processFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return

      clearDismissTimer()
      setDismissed(false)

      const accepted: File[] = []
      const nextRejections: Rejection[] = []
      for (const file of files) {
        const check = validateFile(file)
        if (check.ok) accepted.push(file)
        else nextRejections.push({ file, reason: check.reason })
      }

      setRejections(nextRejections)
      setUploads(accepted.map((file) => ({ state: "pending", file })))

      if (accepted.length === 0) return

      const results = await Promise.all(accepted.map(uploadOne))
      const anySuccess = results.some((ok) => ok)
      if (anySuccess) {
        mutate(
          (key) =>
            key === "/api/documents" || key === "/api/documents/home",
        )
      }
    },
    [clearDismissTimer, mutate, uploadOne],
  )

  const retryFailed = useCallback(async (): Promise<void> => {
    if (failures.length === 0) return
    clearDismissTimer()
    setDismissed(false)
    const toRetry = failures.map((f) => f.file)
    setUploads((prev) =>
      prev.map((u) =>
        u.state === "error" ? { state: "pending", file: u.file } : u,
      ),
    )
    const results = await Promise.all(toRetry.map(uploadOne))
    if (results.some((ok) => ok)) {
      mutate(
        (key) => key === "/api/documents" || key === "/api/documents/home",
      )
    }
  }, [clearDismissTimer, failures, mutate, uploadOne])

  useEffect(() => {
    if (
      !isUploading &&
      failures.length === 0 &&
      rejections.length === 0 &&
      successes.length > 0 &&
      dismissTimerRef.current === null
    ) {
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null
        setUploads([])
      }, 3000)
    }
  }, [isUploading, failures.length, rejections.length, successes.length])

  const handleDragOver = useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    if (
      e.clientX <= rect.left ||
      e.clientX >= rect.right ||
      e.clientY <= rect.top ||
      e.clientY >= rect.bottom
    ) {
      setIsDragging(false)
    }
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent): Promise<void> => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      const files = Array.from(e.dataTransfer.files)
      await processFiles(files)
    },
    [processFiles],
  )

  const statusNode = useMemo(() => {
    if (!hasStatus) return null

    if (isUploading) {
      const completed = successes.length
      const total = totalAttempted
      return (
        <>
          <Loader2 className="size-4 animate-spin text-primary" />
          <span className="text-sm font-medium">
            Uploading {completed + 1} of {total}…
          </span>
        </>
      )
    }

    const errorRows = [
      ...failures.map((f) => ({
        name: f.file.name,
        reason: f.reason,
      })),
      ...rejections.map((r) => ({
        name: r.file.name,
        reason: reasonLabel(r.reason),
      })),
    ]

    if (errorRows.length > 0) {
      const failedCount = errorRows.length
      const attempted = totalAttempted + rejections.length
      return (
        <div className="flex max-w-sm flex-col gap-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 text-destructive" />
            <span className="text-sm font-medium">
              {failedCount} of {attempted} files failed to upload
            </span>
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {errorRows.map((row) => (
              <li key={row.name} className="truncate">
                <span className="font-medium text-foreground">{row.name}</span>
                {" — "}
                {row.reason}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            {failures.length > 0 && (
              <button
                type="button"
                onClick={retryFailed}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-accent"
              >
                Retry failed
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setDismissed(true)
                setUploads([])
                setRejections([])
              }}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              Dismiss
            </button>
          </div>
        </div>
      )
    }

    if (successes.length > 0) {
      return (
        <span className="text-sm font-medium">
          Uploaded {successes.length} of {successes.length} files
        </span>
      )
    }

    return null
  }, [
    hasStatus,
    isUploading,
    successes.length,
    totalAttempted,
    failures,
    rejections,
    retryFailed,
  ])

  return (
    <div
      role="region"
      aria-label="Drop files to upload"
      aria-busy={isUploading}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative min-h-full w-full"
    >
      {children}

      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-8 bg-background/80 backdrop-blur-sm transition-all animate-in fade-in duration-200">
          <div className="flex h-full w-full flex-col items-center justify-center gap-6 rounded-2xl border-4 border-dashed border-primary/40 bg-background/50 text-center shadow-2xl scale-in-95 animate-in duration-200">
            <div className="rounded-full bg-primary/10 p-8">
              <Upload className="size-16 text-primary animate-bounce" />
            </div>
            <div className="space-y-2">
              <h3 className="text-3xl font-bold tracking-tight">
                Drop files to upload
              </h3>
              <p className="text-lg text-muted-foreground max-w-md mx-auto">
                Your files will be automatically processed and added to your
                knowledge base.
              </p>
              <p className="text-sm text-muted-foreground/80 max-w-md mx-auto">
                {SUPPORTED_FILES_HINT}
              </p>
            </div>
          </div>
        </div>
      )}

      {hasStatus && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "absolute bottom-4 right-4 z-50 flex items-start gap-2 rounded-lg border px-4 py-3 shadow-lg animate-in slide-in-from-bottom-2",
            failures.length > 0 || rejections.length > 0
              ? "border-destructive bg-destructive/10"
              : "border-border bg-background",
          )}
        >
          {statusNode}
          {!isUploading && failures.length === 0 && rejections.length === 0 && (
            <button
              type="button"
              onClick={() => {
                setDismissed(true)
                setUploads([])
                setRejections([])
              }}
              aria-label="Dismiss"
              className="ml-2 rounded-md p-1 text-muted-foreground hover:bg-accent"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
