"use client";

import React, { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { AlertCircle, CheckCircle2, Loader2, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RemoteIcon } from "@/components/ui/remote-icon";
import { cn } from "@/lib/utils";
import { parseWorkspaceExport } from "@/lib/workspace-export/format";

// ---------------------------------------------------------------------------
// Unified Import dialog. Hosts four sources behind a tab strip with logos:
//   - Breezify JSON (drop a prior export — uses /api/workspace/import + process)
//   - Notion       (paste an integration token)
//   - Confluence   (Cloud creds)
//   - Obsidian     (drop a .zip of the vault)
//
// Notion / Confluence / Obsidian create an import_jobs row via /api/import/jobs
// and route to the job detail page so users can watch progress.
// Breezify-format JSON uses the existing two-step flow (insert + embedding
// backfill) inline in the dialog because it streams progress as it runs.
// ---------------------------------------------------------------------------

type SourceId = "breezify" | "notion" | "confluence" | "obsidian";

interface SourceDef {
  id: SourceId;
  name: string;
  logoSrc?: string;
  /** Tailwind utility class for the icon container, used when no logo */
  iconClassName?: string;
  invertInDark?: boolean;
  /** Override class applied to the logo image; takes precedence over invertInDark. */
  logoClassName?: string;
  description: string;
}

const SOURCES: SourceDef[] = [
  {
    id: "breezify",
    name: "Breezify JSON",
    logoSrc: "/breeze-mark.png",
    logoClassName: "object-contain",
    description: "Re-import a prior workspace export.",
  },
  {
    id: "notion",
    name: "Notion",
    logoSrc: "https://cdn.simpleicons.org/notion",
    invertInDark: true,
    description: "Bulk-migrate pages via an internal integration token.",
  },
  {
    id: "confluence",
    name: "Confluence",
    logoSrc: "https://cdn.simpleicons.org/confluence/2684FC",
    description: "Cloud only. Auth with email + API token.",
  },
  {
    id: "obsidian",
    name: "Obsidian",
    logoSrc: "https://cdn.simpleicons.org/obsidian/7C3AED",
    description: "Drag in a .zip of the vault (≤100 MB).",
  },
];

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  redirectToJob?: boolean;
  onJobStarted?: (jobId: string) => void;
}

export function ImportDialog({
  open,
  onOpenChange,
  isAdmin,
  redirectToJob = true,
  onJobStarted,
}: ImportDialogProps): React.JSX.Element {
  const [source, setSource] = useState<SourceId>("breezify");
  const handleJobStarted = (jobId: string): void => {
    onJobStarted?.(jobId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import</DialogTitle>
          <DialogDescription>
            Bring in existing knowledge. Each page becomes a fully editable
            Breezify document.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSource(s.id)}
              className={cn(
                "flex flex-col items-center justify-center gap-1.5 rounded-md border px-2 py-3 text-xs font-medium transition",
                source === s.id
                  ? "border-foreground bg-muted"
                  : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
              )}
            >
              <SourceLogo source={s} />
              <span>{s.name}</span>
            </button>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          {SOURCES.find((s) => s.id === source)!.description}
        </p>

        <div className="pt-2">
          {source === "breezify" && (
            <BreezifyJsonPanel isAdmin={isAdmin} onClose={() => onOpenChange(false)} />
          )}
          {source === "notion" && (
            <NotionPanel
              isAdmin={isAdmin}
              onClose={() => onOpenChange(false)}
              redirectToJob={redirectToJob}
              onJobStarted={handleJobStarted}
            />
          )}
          {source === "confluence" && (
            <ConfluencePanel
              isAdmin={isAdmin}
              onClose={() => onOpenChange(false)}
              redirectToJob={redirectToJob}
              onJobStarted={handleJobStarted}
            />
          )}
          {source === "obsidian" && (
            <ObsidianPanel
              isAdmin={isAdmin}
              onClose={() => onOpenChange(false)}
              redirectToJob={redirectToJob}
              onJobStarted={handleJobStarted}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourceLogo({ source }: { source: SourceDef }): React.JSX.Element {
  if (!source.logoSrc) {
    return (
      <div
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background text-[10px] font-semibold",
          source.iconClassName,
        )}
      >
        S
      </div>
    );
  }
  return (
    <RemoteIcon
      src={source.logoSrc}
      alt={source.name}
      size={28}
      className={source.logoClassName ?? (source.invertInDark ? "dark:invert" : "")}
    />
  );
}

// ---------------------------------------------------------------------------
// Breezify JSON panel — reuses the existing /api/workspace/import flow.
// ---------------------------------------------------------------------------

type ImportStatus =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "inserting" }
  | { kind: "processing"; total: number; processed: number; errorCount: number }
  | { kind: "done"; total: number; processed: number; errorCount: number }
  | { kind: "error"; message: string };

const PROCESS_CHUNK = 10;

async function processBreezifyChunks(
  ids: string[],
  onProgress: (processed: number, errorCount: number) => void,
): Promise<{ processed: number; errorCount: number }> {
  let processedCount = 0;
  let errorCount = 0;
  let remaining = [...ids];
  while (remaining.length > 0) {
    const batch = remaining.slice(0, PROCESS_CHUNK);
    const res = await fetch("/api/workspace/import/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentIds: batch }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Process failed (${res.status})`);
    }
    const data = (await res.json()) as {
      processed: string[];
      errors: Array<{ id: string; error: string }>;
    };
    processedCount += data.processed.length;
    errorCount += data.errors.length;
    onProgress(processedCount, errorCount);
    remaining = remaining.slice(batch.length);
  }
  return { processed: processedCount, errorCount };
}

function BreezifyJsonPanel({
  isAdmin,
  onClose,
}: {
  isAdmin: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { mutate: globalMutate } = useSWRConfig();
  const [status, setStatus] = useState<ImportStatus>({ kind: "idle" });

  const handleFile = async (file: File): Promise<void> => {
    setStatus({ kind: "parsing" });
    let text: string;
    try {
      text = await file.text();
    } catch {
      setStatus({ kind: "error", message: "Could not read file." });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setStatus({ kind: "error", message: "File is not valid JSON." });
      return;
    }
    try {
      parseWorkspaceExport(parsed);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Invalid export file.",
      });
      return;
    }

    setStatus({ kind: "inserting" });
    let ids: string[];
    try {
      const res = await fetch("/api/workspace/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Import failed (${res.status})`);
      }
      const data = (await res.json()) as { documentIds: string[] };
      ids = data.documentIds;
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Import failed.",
      });
      return;
    }
    void globalMutate("/api/folders");
    void globalMutate("/api/documents");

    const total = ids.length;
    setStatus({ kind: "processing", total, processed: 0, errorCount: 0 });
    try {
      const { processed, errorCount } = await processBreezifyChunks(
        ids,
        (p, e) => setStatus({ kind: "processing", total, processed: p, errorCount: e }),
      );
      setStatus({ kind: "done", total, processed, errorCount });
      void globalMutate("/api/documents");
    } catch (err) {
      setStatus({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Embedding backfill failed after insert.",
      });
    }
  };

  return (
    <div className="space-y-3">
      <DropZone
        accept="application/json,.json"
        helperText="Drop a Breezify-format .json export, or click to browse."
        onFile={handleFile}
        disabled={!isAdmin || status.kind === "parsing" || status.kind === "inserting" || status.kind === "processing"}
      />
      <BreezifyStatusLabel status={status} />
      {status.kind === "done" && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}

function BreezifyStatusLabel({ status }: { status: ImportStatus }): React.JSX.Element | null {
  if (status.kind === "idle") return null;
  if (status.kind === "parsing" || status.kind === "inserting") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {status.kind === "parsing" ? "Reading file…" : "Saving documents…"}
      </p>
    );
  }
  if (status.kind === "processing") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Processing embeddings {status.processed}/{status.total}
        {status.errorCount > 0 ? ` (${status.errorCount} failed)` : null}
      </p>
    );
  }
  if (status.kind === "done") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-500" />
        Imported {status.processed}/{status.total} documents
        {status.errorCount > 0 ? ` (${status.errorCount} failed)` : null}
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-xs text-destructive">
      <AlertCircle className="size-3.5" />
      {status.message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Notion / Confluence / Obsidian — POST to /api/import/jobs, redirect to job.
// ---------------------------------------------------------------------------

function NotionPanel({
  isAdmin,
  onClose,
  redirectToJob,
  onJobStarted,
}: {
  isAdmin: boolean;
  onClose: () => void;
  redirectToJob: boolean;
  onJobStarted: (jobId: string) => void;
}): React.JSX.Element {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [dbIds, setDbIds] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const databaseIds = dbIds.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      const res = await fetch("/api/import/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "notion",
          source_config: {
            access_token: token.trim(),
            database_ids: databaseIds.length > 0 ? databaseIds : undefined,
            include_subpages: true,
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; job_id?: string };
      if (!res.ok || !body.job_id) {
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      onJobStarted(body.job_id);
      onClose();
      if (redirectToJob) router.push(`/settings/workspace/import/${body.job_id}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="notion-token">Internal integration token</Label>
        <Input
          id="notion-token"
          type="password"
          placeholder="secret_..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
        />
        <p className="text-[11px] text-muted-foreground">
          In Notion: Settings → Integrations → Develop your own → New integration.
          Share the pages you want imported with this integration.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="notion-dbs">Database IDs (optional)</Label>
        <Input
          id="notion-dbs"
          placeholder="comma-separated; leave blank to import everything visible"
          value={dbIds}
          onChange={(e) => setDbIds(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!isAdmin || submitting || token.length < 8}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : "Start import"}
        </Button>
      </div>
    </div>
  );
}

function ConfluencePanel({
  isAdmin,
  onClose,
  redirectToJob,
  onJobStarted,
}: {
  isAdmin: boolean;
  onClose: () => void;
  redirectToJob: boolean;
  onJobStarted: (jobId: string) => void;
}): React.JSX.Element {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [spaces, setSpaces] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const spaceKeys = spaces.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      const res = await fetch("/api/import/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "confluence",
          source_config: {
            base_url: baseUrl.trim(),
            email: email.trim(),
            api_token: token.trim(),
            space_keys: spaceKeys.length > 0 ? spaceKeys : undefined,
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; job_id?: string };
      if (!res.ok || !body.job_id) {
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      onJobStarted(body.job_id);
      onClose();
      if (redirectToJob) router.push(`/settings/workspace/import/${body.job_id}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="conf-url">Site URL</Label>
          <Input
            id="conf-url"
            placeholder="https://your-team.atlassian.net"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="conf-email">Email</Label>
          <Input id="conf-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="conf-token">API token</Label>
          <Input
            id="conf-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="conf-spaces">Space keys (optional)</Label>
          <Input
            id="conf-spaces"
            placeholder="ENG,DESIGN — leave blank for all"
            value={spaces}
            onChange={(e) => setSpaces(e.target.value)}
          />
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          disabled={
            !isAdmin || submitting || baseUrl.length < 8 || email.length < 5 || token.length < 8
          }
        >
          {submitting ? <Loader2 className="size-4 animate-spin" /> : "Start import"}
        </Button>
      </div>
    </div>
  );
}

function ObsidianPanel({
  isAdmin,
  onClose,
  redirectToJob,
  onJobStarted,
}: {
  isAdmin: boolean;
  onClose: () => void;
  redirectToJob: boolean;
  onJobStarted: (jobId: string) => void;
}): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const upRes = await fetch("/api/import/obsidian/upload", {
        method: "POST",
        body: form,
      });
      const upBody = (await upRes.json().catch(() => ({}))) as {
        error?: string;
        upload_id?: string;
      };
      if (!upRes.ok || !upBody.upload_id) {
        setError(upBody.error ?? `Upload failed (${upRes.status})`);
        return;
      }
      const jobRes = await fetch("/api/import/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "obsidian",
          source_config: { upload_id: upBody.upload_id },
        }),
      });
      const jobBody = (await jobRes.json().catch(() => ({}))) as {
        error?: string;
        job_id?: string;
      };
      if (!jobRes.ok || !jobBody.job_id) {
        setError(jobBody.error ?? `Failed to start (${jobRes.status})`);
        return;
      }
      onJobStarted(jobBody.job_id);
      onClose();
      if (redirectToJob) router.push(`/settings/workspace/import/${jobBody.job_id}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <DropZone
        accept=".zip,application/zip"
        helperText="Drop a .zip of your Obsidian vault (≤100 MB), or click to browse."
        onFile={handleFile}
        disabled={!isAdmin || submitting}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {submitting && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Uploading and queueing job…
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable drop zone (drag-and-drop with click fallback).
// ---------------------------------------------------------------------------

interface DropZoneProps {
  accept: string;
  helperText: string;
  onFile: (file: File) => void | Promise<void>;
  disabled?: boolean;
}

function DropZone({
  accept,
  helperText,
  onFile,
  disabled,
}: DropZoneProps): React.JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const effectiveDragOver = disabled ? false : dragOver;

  const accept_list = accept.split(",").map((s) => s.trim().toLowerCase());

  const isAccepted = (f: File): boolean => {
    if (accept_list.length === 0) return true;
    const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
    const mime = f.type.toLowerCase();
    return accept_list.some((a) => a === ext || a === mime || a === "*");
  };

  const handle = (f: File | null | undefined): void => {
    if (!f) return;
    if (!isAccepted(f)) return;
    setFileName(f.name);
    void onFile(f);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !disabled && fileInput.current?.click()}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fileInput.current?.click();
        }
      }}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOver(false);
        handle(e.dataTransfer.files?.[0]);
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed px-4 py-8 text-sm transition",
        effectiveDragOver
          ? "border-foreground bg-muted"
          : "border-border hover:border-foreground/50",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <Upload className="size-5 text-muted-foreground" />
      <p className="text-muted-foreground">{helperText}</p>
      {fileName && (
        <p className="text-xs font-medium text-foreground">{fileName}</p>
      )}
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => handle(e.target.files?.[0])}
      />
    </div>
  );
}
