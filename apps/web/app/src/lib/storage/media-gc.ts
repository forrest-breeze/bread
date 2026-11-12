// ---------------------------------------------------------------------------
// Media garbage collection — delete S3-backed assets that no live surface
// references anymore.
//
// A `media_objects` row (and its S3 object) is safe to drop only when BOTH of
// these hold:
//   - no document body still references it, and
//   - it isn't tied to a capture that is still alive (a capture awaiting
//     synthesis may insert the asset into a doc at any moment).
//
// Plus a grace period: only assets older than `olderThanDays` are even
// considered, so a freshly-uploaded asset that hasn't been wired into a body
// yet is never reaped mid-flight.
//
// The rule is intentionally CONSERVATIVE — when a signal is ambiguous (e.g. a
// capture_id that we couldn't confirm is gone), the row is KEPT. Deleting a
// still-referenced asset breaks a live doc; keeping an orphan one extra cycle
// costs only storage. We bias hard toward the cheap mistake.
//
// `selectOrphans` is a pure function over already-materialized sets so the
// reaping logic is unit-testable without any DB/S3. `cleanupOrphanedMedia`
// is the thin I/O shell that gathers those sets and performs the deletes.
// ---------------------------------------------------------------------------

import { createAdminClient } from "@/lib/supabase/admin";
import { isS3Configured, deleteObject } from "@/lib/storage/s3";
import { extractMediaIds } from "@/lib/storage/media-refs";

/** A candidate `media_objects` row, narrowed to the columns GC needs. */
export interface MediaRow {
  id: string;
  capture_id: string | null;
  storage_key: string;
  created_at: string;
}

/** Page size for the documents / media scans — keeps memory bounded. */
const PAGE_SIZE = 1000;

/**
 * Pure orphan selector. A row is an orphan iff ALL hold:
 *   - `created_at < cutoffIso` (older than the grace period), AND
 *   - `id` is NOT in `referencedIds` (no document body references it), AND
 *   - `capture_id` is null OR `capture_id` is NOT in `liveCaptureIds`
 *     (not pinned by a still-living capture).
 *
 * Conservative by construction: a row is only returned when every condition
 * affirmatively says "safe to delete". Any uncertainty (still referenced,
 * still-live capture, too new) keeps it.
 */
export function selectOrphans(
  mediaRows: MediaRow[],
  referencedIds: Set<string>,
  liveCaptureIds: Set<string>,
  cutoffIso: string,
): MediaRow[] {
  return mediaRows.filter((row) => {
    // Too new — inside the grace period, keep.
    if (!(row.created_at < cutoffIso)) return false;
    // Still referenced by a document body, keep.
    if (referencedIds.has(row.id)) return false;
    // Pinned by a capture that still exists, keep.
    if (row.capture_id !== null && liveCaptureIds.has(row.capture_id)) {
      return false;
    }
    return true;
  });
}

export interface CleanupResult {
  scanned: number;
  referenced: number;
  deleted: number;
  dryRun: boolean;
}

/**
 * Reap orphaned media. Gathers the referenced-id set from live document bodies
 * and the live-capture set, runs `selectOrphans`, then deletes each orphan from
 * S3 (when configured) and the `media_objects` table.
 *
 * Note: `documents.content` is the canonical body store, so it is the only
 * reference source scanned here. Scanning `document_versions` history and
 * topic/wiki pages is a deliberate future extension — until then those surfaces
 * are covered transitively because anything still surfaced lives in a current
 * `documents` row, and the grace period absorbs short-lived editing churn.
 */
export async function cleanupOrphanedMedia({
  olderThanDays = 7,
  dryRun = false,
}: {
  olderThanDays?: number;
  dryRun?: boolean;
}): Promise<CleanupResult> {
  const admin = createAdminClient();
  const cutoffIso = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  // a/b. Build the referenced-id set by paging through live document bodies.
  const referencedIds = new Set<string>();
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("documents")
      .select("id, content")
      .is("deleted_at", null)
      // Stable order is REQUIRED for correct paging — without it PostgREST may
      // skip a row across pages, dropping its ids from the referenced set and
      // wrongly orphaning a live asset. id is unique, so paging is exhaustive.
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error("[Bread] media-gc: document scan failed:", error.message);
      // Fail closed: an incomplete reference set could orphan a live asset.
      return { scanned: 0, referenced: referencedIds.size, deleted: 0, dryRun };
    }
    const rows = (data ?? []) as { id: string; content: string | null }[];
    for (const row of rows) {
      if (!row.content) continue;
      for (const id of extractMediaIds(row.content)) referencedIds.add(id);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // c. Load candidate media rows.
  const mediaRows: MediaRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await admin
      .from("media_objects")
      .select("id, capture_id, storage_key, created_at")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error("[Bread] media-gc: media scan failed:", error.message);
      return {
        scanned: mediaRows.length,
        referenced: referencedIds.size,
        deleted: 0,
        dryRun,
      };
    }
    const rows = (data ?? []) as MediaRow[];
    mediaRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

  // c (cont). Resolve which of the candidates' capture_ids still exist.
  const liveCaptureIds = new Set<string>();
  const candidateCaptureIds = [
    ...new Set(
      mediaRows
        .map((r) => r.capture_id)
        .filter((c): c is string => c !== null),
    ),
  ];
  for (let from = 0; from < candidateCaptureIds.length; from += PAGE_SIZE) {
    const slice = candidateCaptureIds.slice(from, from + PAGE_SIZE);
    const { data, error } = await admin
      .from("captures")
      .select("id")
      .in("id", slice);
    if (error) {
      console.error("[Bread] media-gc: capture scan failed:", error.message);
      // Fail closed: treat every candidate capture as live so nothing pinned
      // to a capture is reaped on an incomplete read.
      for (const id of candidateCaptureIds) liveCaptureIds.add(id);
      break;
    }
    for (const row of (data ?? []) as { id: string }[]) {
      liveCaptureIds.add(row.id);
    }
  }

  // d. Select orphans.
  const orphans = selectOrphans(
    mediaRows,
    referencedIds,
    liveCaptureIds,
    cutoffIso,
  );

  // e. Delete each orphan (or, on dryRun, just count).
  let deleted = 0;
  if (!dryRun) {
    const s3Enabled = isS3Configured();
    for (const orphan of orphans) {
      try {
        if (s3Enabled) await deleteObject(orphan.storage_key);
        const { error } = await admin
          .from("media_objects")
          .delete()
          .eq("id", orphan.id);
        if (error) {
          console.error(
            `[Bread] media-gc: row delete failed for ${orphan.id}:`,
            error.message,
          );
          continue;
        }
        deleted += 1;
      } catch (err) {
        // S3 (or row) delete threw — leave the row so a later run retries.
        console.error(
          `[Bread] media-gc: delete failed for ${orphan.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } else {
    deleted = orphans.length;
  }

  // f. One-line summary.
  console.log(
    `[Bread] media-gc: scanned=${mediaRows.length} referenced=${referencedIds.size} orphans=${orphans.length} deleted=${deleted}${dryRun ? " (dryRun)" : ""}`,
  );

  return {
    scanned: mediaRows.length,
    referenced: referencedIds.size,
    deleted,
    dryRun,
  };
}
