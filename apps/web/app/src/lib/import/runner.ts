import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ImportJobRow,
  ImportItemStatus,
  ImportSource,
} from "@breezify/core";
import { runNotionImport } from "@/lib/import/notion";
import { runConfluenceImport } from "@/lib/import/confluence";
import { runObsidianImport } from "@/lib/import/obsidian";
import { runWebsiteImport } from "@/lib/import/website";

// ---------------------------------------------------------------------------
// Shared bulk-import job runner.
//
// Each importer receives a JobContext with callbacks so it never touches
// the DB directly — keeps importers easy to test with in-memory contexts.
// Status transitions: pending → running → completed | failed. Per-item rows
// are appended as the importer makes progress; counters bump atomically via
// the increment_import_job_progress RPC.
// ---------------------------------------------------------------------------

export interface JobItemEvent {
  source_ref: string;
  title?: string | null;
  status: Exclude<ImportItemStatus, "pending">;
  document_id?: string | null;
  error?: string | null;
}

export interface JobContext {
  jobId: string;
  workspaceId: string;
  startedBy: string | null;
  sourceConfig: Record<string, unknown>;
  /** Called once when the importer knows the total. May be called again with
   *  a refined number (e.g. after pagination completes). */
  setTotal: (n: number) => Promise<void>;
  /** Called per item. Idempotent on (job_id, source_ref) via unique. */
  recordItem: (event: JobItemEvent) => Promise<void>;
  /** Check whether the job has been cancelled. Importers should call between
   *  items to abort early. */
  isCancelled: () => Promise<boolean>;
}

export async function runImportJob(jobId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: jobData, error: loadErr } = await admin
    .from("import_jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (loadErr || !jobData) {
    console.error("[Breezify] runImportJob: load failed", jobId, loadErr?.message);
    return;
  }

  const job = jobData as ImportJobRow;
  if (job.status !== "pending") {
    return;
  }

  await admin
    .from("import_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", jobId);

  const ctx: JobContext = {
    jobId,
    workspaceId: job.workspace_id,
    startedBy: job.started_by,
    sourceConfig: job.source_config,
    setTotal: async (n) => {
      await admin
        .from("import_jobs")
        .update({ total_items: n })
        .eq("id", jobId);
    },
    recordItem: async (event) => {
      const { error: insertErr } = await admin
        .from("import_job_items")
        .upsert(
          {
            job_id: jobId,
            source_ref: event.source_ref,
            title: event.title ?? null,
            status: event.status,
            document_id: event.document_id ?? null,
            error_message: event.error ?? null,
            processed_at: new Date().toISOString(),
          },
          { onConflict: "job_id,source_ref" },
        );
      if (insertErr) {
        console.error(
          "[Breezify] import item upsert failed:",
          insertErr.message,
        );
        return;
      }
      const { error: rpcErr } = await admin.rpc(
        "increment_import_job_progress",
        { p_job_id: jobId, p_status: event.status },
      );
      if (rpcErr) {
        console.error(
          "[Breezify] increment_import_job_progress failed:",
          rpcErr.message,
        );
      }
    },
    isCancelled: async () => {
      const { data } = await admin
        .from("import_jobs")
        .select("status")
        .eq("id", jobId)
        .maybeSingle();
      return (data as { status: string } | null)?.status === "cancelled";
    },
  };

  try {
    await dispatch(job.source, ctx);
    // If the job was cancelled mid-run, the cancel route already moved status.
    const { data: post } = await admin
      .from("import_jobs")
      .select("status")
      .eq("id", jobId)
      .maybeSingle();
    if ((post as { status: string } | null)?.status === "running") {
      await admin
        .from("import_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId);
    }
  } catch (err) {
    console.error("[Breezify] runImportJob failed:", jobId, err);
    await admin
      .from("import_jobs")
      .update({
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId);
  } finally {
    await scrubSensitiveConfig(jobId);
  }
}

function dispatch(source: ImportSource, ctx: JobContext): Promise<void> {
  switch (source) {
    case "notion":
      return runNotionImport(ctx);
    case "confluence":
      return runConfluenceImport(ctx);
    case "obsidian":
      return runObsidianImport(ctx);
    case "website":
      return runWebsiteImport(ctx);
    default: {
      const _exhaustive: never = source;
      throw new Error(`Unknown import source: ${String(_exhaustive)}`);
    }
  }
}

// W5: strip access_token / api_token from source_config after job ends so
// the credential doesn't linger past the run. We keep the rest of the config
// (db_ids, space_keys, upload_id) for debugging / replay.
async function scrubSensitiveConfig(jobId: string): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("import_jobs")
    .select("source_config")
    .eq("id", jobId)
    .maybeSingle();
  const cfg = (data as { source_config: Record<string, unknown> } | null)
    ?.source_config;
  if (!cfg) return;
  let dirty = false;
  const next = { ...cfg };
  for (const k of ["access_token", "api_token"]) {
    if (k in next) {
      delete next[k];
      dirty = true;
    }
  }
  if (dirty) {
    await admin
      .from("import_jobs")
      .update({ source_config: next })
      .eq("id", jobId);
  }
}
