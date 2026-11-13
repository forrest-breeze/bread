"use client"

import React, { useMemo, useRef, useState } from "react"
import Link from "next/link"
import { Check, Copy, FileJson, Trash2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
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
import { useOpenApiSources, useWorkspace, type OpenApiSourceItem } from "@/hooks/swr"

// ---------------------------------------------------------------------------
// Settings -> Integrations -> OpenAPI.
//
// Breeze's API reference used to be published to ReadMe by the "Publish
// OpenAPI Specs" GitHub Action (rdme openapi upload). This page replaces that:
// specs are uploaded here (by the same Action, with a workspace API key, or by
// hand below) and each operation becomes a page.
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const DEFAULT_SLUG = "payments-api"

interface Issue {
  path: string
  message: string
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

function syncedByLabel(value: string): string {
  // "github:<owner>/<repo>@<sha>" is a spec read from the linked repository.
  if (value.startsWith("github:")) return `Synced from ${value.slice("github:".length)}`
  return value === "api" ? "GitHub Actions / API" : "Uploaded in Settings"
}

export default function OpenApiIntegrationPage(): React.JSX.Element {
  const { data, isLoading, mutate } = useOpenApiSources()
  const { data: workspace } = useWorkspace()
  const sources = data?.sources ?? []

  return (
    <div className="space-y-8">
      <header>
        <h2 className="text-base font-semibold">OpenAPI</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Publish API reference pages from an OpenAPI spec (JSON or YAML, 3.0 /
          3.1 or Swagger 2.0). Each operation becomes a page, grouped by tag.
          Every upload replaces the previous one: changed pages update, new
          operations appear and removed ones are deleted. When a repository is
          linked under{" "}
          <Link href="/settings/integrations/github" className="underline">
            GitHub
          </Link>
          , specs in its <code>reference/</code> folder are listed here too,
          and uploads are written back to that folder.
        </p>
      </header>

      <section aria-labelledby="openapi-sources">
        <h3 id="openapi-sources" className="text-sm font-medium">
          Published specs
        </h3>
        {isLoading ? (
          <Skeleton className="mt-3 h-16 w-full" />
        ) : sources.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No specs yet. Upload one below or publish from GitHub Actions.
          </p>
        ) : (
          <ul className="mt-3 divide-y rounded-md border">
            {sources.map((source) => (
              <SourceRow key={source.slug} source={source} onRemoved={() => void mutate()} />
            ))}
          </ul>
        )}
      </section>

      <UploadForm onUploaded={() => void mutate()} />

      <GitHubActionsSnippet workspaceSlug={workspace?.slug ?? "breeze"} />
    </div>
  )
}

function SourceRow({
  source,
  onRemoved,
}: {
  source: OpenApiSourceItem
  onRemoved: () => void
}): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove(): Promise<void> {
    setRemoving(true)
    setError(null)
    try {
      const res = await fetch(`/api/openapi-sources/${source.slug}`, { method: "DELETE" })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? "Failed to remove the spec.")
      }
      setConfirmOpen(false)
      onRemoved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove the spec.")
    } finally {
      setRemoving(false)
    }
  }

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <FileJson className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {source.title}
          {source.version ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">v{source.version}</span>
          ) : null}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <code>{source.slug}</code> · {source.operation_count} operations · updated{" "}
          {formatWhen(source.last_synced_at)} · {syncedByLabel(source.last_synced_by)}
        </p>
        {source.root_folder_id ? (
          <Link
            href={`/knowledge/folder/${source.root_folder_id}`}
            className="mt-1 inline-block text-xs underline underline-offset-2"
          >
            View pages
          </Link>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        aria-label={`Remove ${source.title}`}
      >
        <Trash2 className="size-4" />
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={(open) => !removing && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {source.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes its {source.operation_count} generated pages and their
              folders. Publishing the spec again recreates them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={removing} onClick={() => void remove()}>
              {removing ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}

function UploadForm({ onUploaded }: { onUploaded: () => void }): React.JSX.Element {
  const [slug, setSlug] = useState(DEFAULT_SLUG)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const slugValid = SLUG_RE.test(slug)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!file || !slugValid) return
    setUploading(true)
    setMessage(null)
    setError(null)
    setIssues([])
    try {
      const res = await fetch(`/api/openapi-sources/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: await file.text(),
      })
      const body = (await res.json().catch(() => ({}))) as {
        error?: string
        issues?: Issue[]
        title?: string
        operationCount?: number
        created?: number
        updated?: number
        removed?: number
        github?: { committed?: boolean; path?: string | null; reason?: string; message?: string }
      }
      if (!res.ok) {
        setError(body.error ?? "Upload failed.")
        setIssues(body.issues ?? [])
        return
      }
      // With a GitHub repository linked, say what happened to the file there.
      const github = body.github
      const githubNote = !github
        ? ""
        : github.committed
          ? ` Committed to ${github.path} on GitHub.`
          : github.reason === "pull_request_mode"
            ? " It will be included in the next publish to GitHub."
            : github.reason === "failed"
              ? ` ${github.message ?? "It could not be written to GitHub."}`
              : ""
      setMessage(
        `Published ${body.title}: ${body.operationCount} operations (${body.created} new, ${body.updated} updated, ${body.removed} removed).${githubNote}`,
      )
      setFile(null)
      if (fileRef.current) fileRef.current.value = ""
      onUploaded()
    } catch {
      setError("Upload failed. Check your connection and try again.")
    } finally {
      setUploading(false)
    }
  }

  return (
    <section aria-labelledby="openapi-upload">
      <h3 id="openapi-upload" className="text-sm font-medium">
        Upload a spec
      </h3>
      <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-3 rounded-md border p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="openapi-slug">Name</Label>
            <Input
              id="openapi-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value.trim().toLowerCase())}
              aria-invalid={!slugValid}
            />
            <p className="text-xs text-muted-foreground">
              Stable ID for this spec. Uploading to the same name replaces it.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="openapi-file">Spec file (JSON or YAML)</Label>
            <Input
              id="openapi-file"
              ref={fileRef}
              type="file"
              accept=".json,.yaml,.yml,application/json,application/yaml"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>
        {!slugValid ? (
          <p className="text-xs text-destructive">
            Use lowercase letters, digits and dashes (max 63).
          </p>
        ) : null}
        <Button type="submit" size="sm" disabled={!file || !slugValid || uploading}>
          <Upload className="mr-1.5 size-4" />
          {uploading ? "Publishing…" : "Publish"}
        </Button>
        {message ? <p className="text-sm">{message}</p> : null}
        {error ? (
          <div role="alert" className="text-sm text-destructive">
            <p>{error}</p>
            {issues.length > 0 ? (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {issues.map((issue, i) => (
                  <li key={i}>{issue.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </form>
    </section>
  )
}

function GitHubActionsSnippet({ workspaceSlug }: { workspaceSlug: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const origin = typeof window === "undefined" ? "https://<your-app>" : window.location.origin
  const snippet = useMemo(
    () => `      - name: Publish OpenAPI spec to Breeze Docs
        env:
          BREEZE_DOCS_API_KEY: \${{ secrets.BREEZE_DOCS_API_KEY }}
          VERSION: \${{ github.event.inputs.version }}
        run: |
          curl --fail-with-body -sS -X PUT \\
            "${origin}/api/v1/openapi/${DEFAULT_SLUG}" \\
            -H "Authorization: Bearer \${BREEZE_DOCS_API_KEY}" \\
            -H "x-bread-workspace: ${workspaceSlug}" \\
            -H "Content-Type: application/json" \\
            --data-binary "@src/openapi/specs/\${VERSION}/openapi.json"`,
    [origin, workspaceSlug],
  )

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked; the snippet stays selectable.
    }
  }

  return (
    <section aria-labelledby="openapi-ci">
      <h3 id="openapi-ci" className="text-sm font-medium">
        Publish from GitHub Actions
      </h3>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          In{" "}
          <Link href="/settings/developer" className="underline underline-offset-2">
            Settings → Developer
          </Link>
          , create a workspace API key with <strong>Admin actions</strong> and the{" "}
          <strong>editor</strong> role.
        </li>
        <li>
          Save it as the <code>BREEZE_DOCS_API_KEY</code> secret in the repository.
        </li>
        <li>
          In <code>.github/workflows/upload_openapi_spec.yml</code>, replace the
          “Install rdme” and “Upload OpenAPI spec to ReadMe” steps with:
        </li>
      </ol>
      <div className="relative mt-3">
        <pre className="overflow-x-auto rounded-md border bg-muted/40 p-4 text-xs leading-relaxed">
          <code>{snippet}</code>
        </pre>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute right-2 top-2"
          onClick={() => void copy()}
          aria-label="Copy workflow step"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </section>
  )
}
