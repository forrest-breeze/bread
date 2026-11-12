import "server-only";

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DOCUMENT_SYNC_CONCURRENCY,
  hasEquivalentHostedContent,
  hostedContentHash,
  mapWithConcurrency,
  refreshHostedDocumentIndex,
  upsertOpenApiFolder,
} from "@/lib/github/github-hosted-docs";
import { applyGitHubHostedDocumentUpdate } from "@/lib/github/github-hosted-document-update";
import {
  parseHostedOpenApiSpec,
  type GeneratedOpenApiSpec,
  type OpenApiSpecIssue,
} from "@/lib/github/github-hosted-openapi";

// ---------------------------------------------------------------------------
// OpenAPI sources: specs pushed to this tool directly (CI or Settings upload),
// replacing ReadMe as the API reference host.
//
// Each source has a stable slug. An upload parses the spec with the same
// renderer the GitHub sync uses and mirrors it as generated pages: one folder
// per spec (named after info.title), one subfolder per tag, one page per
// operation. The spec is the source of truth: on every upload, changed pages
// are updated (with a version snapshot), new operations are added, and
// operations that disappeared are removed.
// ---------------------------------------------------------------------------

export const OPENAPI_UPLOAD_OPERATION_KIND = "openapi_upload_operation";
export const OPENAPI_SOURCE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface OpenApiSourceSyncResult {
  slug: string;
  title: string;
  version: string | null;
  operationCount: number;
  created: number;
  updated: number;
  removed: number;
}

export type OpenApiSourceSyncOutcome =
  | { ok: true; result: OpenApiSourceSyncResult }
  | { ok: false; issues: OpenApiSpecIssue[] };

interface UploadedOperationRow {
  id: string;
  title: string;
  content: string;
  status?: string | null;
  folder_id: string | null;
  sort_order: number | null;
  source_metadata: Record<string, unknown> | null;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

export function sourceFolderName(slug: string, tag?: string): string {
  const base = `openapi-source-${slug}`;
  return tag === undefined ? base : `${base}-tag-${shortHash(tag)}`;
}

export function parseOpenApiUpload(
  slug: string,
  raw: string,
): { spec: GeneratedOpenApiSpec | null; issues: OpenApiSpecIssue[] } {
  if (!OPENAPI_SOURCE_SLUG_RE.test(slug)) {
    return {
      spec: null,
      issues: [{ path: slug, message: "name must be lowercase letters, digits and dashes (max 63)" }],
    };
  }
  return parseHostedOpenApiSpec({
    specPath: `${slug}.json`,
    raw,
    repoId: 0,
    slugPrefix: "openapi",
  });
}

export async function syncOpenApiSource(
  admin: SupabaseClient,
  input: { workspaceId: string; slug: string; raw: string; syncedBy: string },
): Promise<OpenApiSourceSyncOutcome> {
  const parsed = parseOpenApiUpload(input.slug, input.raw);
  if (!parsed.spec) return { ok: false, issues: parsed.issues };
  const spec = parsed.spec;

  const rootFolderId = await upsertOpenApiFolder(admin, {
    workspaceId: input.workspaceId,
    name: sourceFolderName(input.slug),
    displayName: spec.title,
    parentId: null,
    sortOrder: null,
  });
  const tagFolderIds = new Map<string, string>();
  for (const operation of spec.operations) {
    if (tagFolderIds.has(operation.tag)) continue;
    tagFolderIds.set(
      operation.tag,
      await upsertOpenApiFolder(admin, {
        workspaceId: input.workspaceId,
        name: sourceFolderName(input.slug, operation.tag),
        displayName: operation.tag,
        parentId: rootFolderId,
        sortOrder: operation.tagOrder,
      }),
    );
  }

  const { data: existingData, error: existingError } = await admin
    .from("documents")
    .select("id, title, content, status, folder_id, sort_order, source_metadata")
    .eq("workspace_id", input.workspaceId)
    .contains("source_metadata", {
      kind: OPENAPI_UPLOAD_OPERATION_KIND,
      openapi_source_slug: input.slug,
    })
    .is("deleted_at", null);
  if (existingError) throw new Error(`OpenAPI document lookup: ${existingError.message}`);

  const existing = new Map<string, UploadedOperationRow>();
  const staleIds: string[] = [];
  for (const row of (existingData ?? []) as UploadedOperationRow[]) {
    const key = row.source_metadata?.openapi_operation_key;
    if (typeof key !== "string" || existing.has(key)) staleIds.push(row.id);
    else existing.set(key, row);
  }
  const activeKeys = new Set(spec.operations.map((operation) => operation.key));
  for (const [key, row] of existing) {
    if (!activeKeys.has(key)) staleIds.push(row.id);
  }

  let created = 0;
  let updated = 0;
  const syncedAt = new Date().toISOString();

  const syncOperation = async (
    operation: GeneratedOpenApiSpec["operations"][number],
  ): Promise<void> => {
    const folderId = tagFolderIds.get(operation.tag)!;
    const metadata = {
      kind: OPENAPI_UPLOAD_OPERATION_KIND,
      openapi_source_slug: input.slug,
      openapi_operation_key: operation.key,
      openapi_spec_title: spec.title,
      openapi_spec_version: spec.version,
      openapi_content_hash: hostedContentHash(operation.content),
      synced_at: syncedAt,
    };
    const row = existing.get(operation.key);
    if (!row) {
      const { data: inserted, error } = await admin
        .from("documents")
        .insert({
          workspace_id: input.workspaceId,
          title: operation.title,
          content: operation.content,
          document_type: "page",
          public_slug: operation.publicSlug,
          folder_id: folderId,
          sort_order: operation.order,
          source: "docs",
          status: "Published",
          author: "OpenAPI",
          source_metadata: metadata,
        })
        .select("id")
        .single();
      if (error || !inserted) {
        throw new Error(`OpenAPI document insert: ${error?.message ?? "no row returned"}`);
      }
      created++;
      await refreshHostedDocumentIndex((inserted as { id: string }).id, input.workspaceId, operation.content);
      return;
    }

    if (row.folder_id !== folderId || (row.sort_order ?? null) !== operation.order) {
      const { error } = await admin
        .from("documents")
        .update({ folder_id: folderId, sort_order: operation.order })
        .eq("id", row.id)
        .eq("workspace_id", input.workspaceId);
      if (error) throw new Error(`OpenAPI document move: ${error.message}`);
    }
    if (hasEquivalentHostedContent(row.content, operation.content) && row.title === operation.title) {
      return;
    }
    await applyGitHubHostedDocumentUpdate(admin, {
      documentId: row.id,
      workspaceId: input.workspaceId,
      expectedTitle: row.title,
      expectedContent: row.content,
      title: operation.title,
      content: operation.content,
      sourceMetadataPatch: metadata,
      updatedAt: syncedAt,
    });
    updated++;
    await refreshHostedDocumentIndex(row.id, input.workspaceId, operation.content);
  };

  await mapWithConcurrency(spec.operations, DOCUMENT_SYNC_CONCURRENCY, syncOperation);

  const uniqueStale = [...new Set(staleIds)];
  if (uniqueStale.length > 0) {
    const { error } = await admin
      .from("documents")
      .update({ deleted_at: syncedAt, updated_at: syncedAt })
      .eq("workspace_id", input.workspaceId)
      .in("id", uniqueStale);
    if (error) throw new Error(`OpenAPI stale document cleanup: ${error.message}`);
  }

  const { error: sourceError } = await admin.from("openapi_sources").upsert(
    {
      workspace_id: input.workspaceId,
      slug: input.slug,
      title: spec.title,
      version: spec.version,
      operation_count: spec.operations.length,
      root_folder_id: rootFolderId,
      last_synced_at: syncedAt,
      last_synced_by: input.syncedBy,
    },
    { onConflict: "workspace_id,slug" },
  );
  if (sourceError) throw new Error(`OpenAPI source record: ${sourceError.message}`);

  return {
    ok: true,
    result: {
      slug: input.slug,
      title: spec.title,
      version: spec.version,
      operationCount: spec.operations.length,
      created,
      updated,
      removed: uniqueStale.length,
    },
  };
}

/** Remove a source: its generated pages (soft-deleted), folders, and record. */
export async function deleteOpenApiSource(
  admin: SupabaseClient,
  input: { workspaceId: string; slug: string },
): Promise<{ removed: number }> {
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("documents")
    .update({ deleted_at: now, updated_at: now, folder_id: null })
    .eq("workspace_id", input.workspaceId)
    .contains("source_metadata", {
      kind: OPENAPI_UPLOAD_OPERATION_KIND,
      openapi_source_slug: input.slug,
    })
    .is("deleted_at", null)
    .select("id");
  if (error) throw new Error(`OpenAPI source page removal: ${error.message}`);

  // Tag folders are children of the spec's root folder; delete by hierarchy,
  // never by name prefix (slug "api" must not touch "api-v2").
  const { data: root, error: rootError } = await admin
    .from("folders")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("name", sourceFolderName(input.slug))
    .maybeSingle();
  if (rootError) throw new Error(`OpenAPI source folder lookup: ${rootError.message}`);
  if (root) {
    const rootId = (root as { id: string }).id;
    const { error: tagError } = await admin
      .from("folders")
      .delete()
      .eq("workspace_id", input.workspaceId)
      .eq("parent_folder_id", rootId);
    if (tagError) throw new Error(`OpenAPI tag folder removal: ${tagError.message}`);
    const { error: rootDeleteError } = await admin
      .from("folders")
      .delete()
      .eq("workspace_id", input.workspaceId)
      .eq("id", rootId);
    if (rootDeleteError) throw new Error(`OpenAPI source folder removal: ${rootDeleteError.message}`);
  }

  const { error: sourceError } = await admin
    .from("openapi_sources")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("slug", input.slug);
  if (sourceError) throw new Error(`OpenAPI source removal: ${sourceError.message}`);

  return { removed: (data ?? []).length };
}
