"use client";

import { useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useFolders } from "@/hooks/swr";
import { ImportDialog } from "@/components/settings/import-dialog";
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
} from "@/components/ui/alert-dialog";

// ---------------------------------------------------------------------------
// Export / Import card for the workspace settings page.
//
// Export is a synchronous download of the Breezify-format JSON (whole workspace
// or a single user folder). Import opens the unified <ImportDialog />, which
// hosts four source tabs (Breezify JSON, Notion, Confluence, Obsidian) — each
// either drops a file or collects per-source credentials and then routes to
// the import job detail page for live progress.
// ---------------------------------------------------------------------------

interface WorkspaceDataManagementCardProps {
  isAdmin: boolean;
}

type ReindexStatus =
  | { kind: "idle" }
  | { kind: "running"; attempted: number; total: number; failed: number }
  | { kind: "done"; updated: number; total: number; failed: number }
  | { kind: "error"; message: string };

interface ReindexBatchResponse {
  attempted: number;
  updated: number;
  errors: Array<{ id: string; error: string }>;
  nextCursor: string | null;
  done: boolean;
  remainingAtStart: number;
}

export function WorkspaceDataManagementCard({
  isAdmin,
}: WorkspaceDataManagementCardProps) {
  const { data: folders } = useFolders();

  const [exportFolderId, setExportFolderId] = useState<string>("__all__");
  const [exporting, setExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [reindexConfirmOpen, setReindexConfirmOpen] = useState(false);
  const [reindexStatus, setReindexStatus] = useState<ReindexStatus>({
    kind: "idle",
  });
  // State updates are asynchronous, so the disabled button alone cannot stop
  // a rapid double click from starting two cursor loops.
  const reindexRunningRef = useRef(false);

  const userFolders = (folders ?? []).filter((f) => f.kind === "user");

  const handleExport = () => {
    setExporting(true);
    try {
      const url =
        exportFolderId === "__all__"
          ? "/api/workspace/export"
          : `/api/workspace/export?folder_id=${encodeURIComponent(exportFolderId)}`;
      window.location.assign(url);
    } finally {
      setTimeout(() => setExporting(false), 800);
    }
  };

  const handleReindex = async (): Promise<void> => {
    if (reindexRunningRef.current) return;
    reindexRunningRef.current = true;
    let cursor: string | null = null;
    let attempted = 0;
    let updated = 0;
    let failed = 0;
    let total = 0;
    setReindexStatus({ kind: "running", attempted, total, failed });

    try {
      do {
        const response = await fetch("/api/workspace/reindex-embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ after: cursor }),
        });
        const body = (await response.json().catch(() => ({}))) as
          | ReindexBatchResponse
          | { error?: string };
        if (!response.ok || !("attempted" in body)) {
          throw new Error(
            "error" in body && body.error
              ? body.error
              : `Re-index failed (${response.status})`,
          );
        }

        if (total === 0) total = body.remainingAtStart;
        attempted += body.attempted;
        updated += body.updated;
        failed += body.errors.length;
        cursor = body.nextCursor;
        setReindexStatus({ kind: "running", attempted, total, failed });

        if (body.done) break;
        if (!cursor) throw new Error("Re-index stopped before completion.");
      } while (cursor);

      setReindexStatus({ kind: "done", updated, total, failed });
    } catch (err) {
      setReindexStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Re-index failed.",
      });
    } finally {
      reindexRunningRef.current = false;
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Data Management</CardTitle>
          <CardDescription>
            Export the workspace as a Breezify-format JSON backup, or import from a
            prior export, Notion, Confluence Cloud, or Obsidian.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="export-scope">Export scope</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={exportFolderId}
                onValueChange={(value) => setExportFolderId(value as string)}
                disabled={!isAdmin || exporting}
              >
                <SelectTrigger id="export-scope" className="max-w-xs">
                  <SelectValue>
                    {exportFolderId === "__all__"
                      ? "Entire workspace"
                      : userFolders.find((f) => f.id === exportFolderId)
                          ?.display_name ?? "Select folder"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Entire workspace</SelectItem>
                  {userFolders.map((folder) => (
                    <SelectItem key={folder.id} value={folder.id}>
                      {folder.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={!isAdmin || exporting}
              >
                {exporting ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Download className="mr-2 size-4" />
                )}
                Export
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Exports include titles, content, and folder structure. Embeddings
              are not included — they&apos;re regenerated on import.
            </p>
          </div>

          <div className="space-y-2 border-t pt-4">
            <Label>Import</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImportOpen(true)}
                disabled={!isAdmin}
              >
                <Upload className="mr-2 size-4" />
                Import
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Pick a source — Breezify JSON, Notion, Confluence Cloud, or Obsidian.
            </p>
          </div>

          <div className="space-y-2 border-t pt-4">
            <Label>Search index</Label>
            <div className="flex flex-wrap items-center gap-2">
              <AlertDialog
                open={reindexConfirmOpen}
                onOpenChange={setReindexConfirmOpen}
              >
                <AlertDialogTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!isAdmin || reindexStatus.kind === "running"}
                    >
                      {reindexStatus.kind === "running" ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 size-4" />
                      )}
                      Re-index embeddings
                    </Button>
                  }
                />
                <AlertDialogContent size="sm">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Re-index workspace embeddings?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This regenerates document and semantic-search chunk vectors
                      for the documents visible in this workspace. Unfiled GitHub
                      repository sources are retried from GitHub settings. This can
                      take several minutes and consumes embedding-provider quota.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        setReindexConfirmOpen(false);
                        void handleReindex();
                      }}
                    >
                      Start re-index
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <ReindexStatusLabel status={reindexStatus} />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Use this to repair missing embedding coverage or rebuild the
              semantic search index after an embedding-model change.
            </p>
          </div>
        </CardContent>
      </Card>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        isAdmin={isAdmin}
      />
    </>
  );
}

function ReindexStatusLabel({
  status,
}: {
  status: ReindexStatus;
}): React.ReactElement | null {
  if (status.kind === "idle") return null;
  if (status.kind === "running") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {status.total > 0
          ? `Re-indexing ${status.attempted}/${status.total}`
          : "Preparing re-index…"}
        {status.failed > 0 ? ` (${status.failed} failed)` : null}
      </span>
    );
  }
  if (status.kind === "done") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-500" />
        Re-indexed {status.updated}/{status.total} documents
        {status.failed > 0 ? ` (${status.failed} failed)` : null}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-destructive">
      <AlertCircle className="size-3.5" />
      {status.message}
    </span>
  );
}
