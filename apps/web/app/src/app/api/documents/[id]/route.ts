import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import {
  ingestDocument,
  fireIngestFromText,
  fireDocumentEmbeddingUpdate,
  type ProseMirrorDoc,
} from "@/rag/ingest";
import {
  safeJsonBody,
  safeRouteParams,
  safeSearchParams,
  uuidParamSchema,
} from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

// DELETE accepts a single `?permanent=true` flag distinguishing a hard delete
// from a soft delete (move-to-trash). Validated through safeSearchParams so the
// query string is parsed against a schema, not read raw.
const deleteQuerySchema = z.object({
  permanent: z.string().optional(),
});

const patchBodySchema = z.object({
  title: z.string().max(500).optional(),
  content: z.string().optional(),
  status: z.string().max(50).optional(),
  folder_id: z.string().nullable().optional(),
  // ProseMirror doc shape is validated lightly in the route below to preserve
  // the existing fallback-to-text behavior when the editor sends a malformed
  // content_json.
  content_json: z.unknown().optional(),
  finalize_version: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/documents/[id]
// Returns a single document (including content) for the authenticated user.
// ---------------------------------------------------------------------------

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);

  if (!workspace) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 },
    );
  }

  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const addRepositoryDocumentLink = async <T extends {
    source_metadata?: unknown;
  }>(document: T): Promise<T> => {
    const metadata = document.source_metadata;
    if (!metadata || typeof metadata !== "object") return document;
    const sourceMetadata = metadata as Record<string, unknown>;
    if (sourceMetadata.kind === "repository_file") return document;
    const path = typeof sourceMetadata.canonical_repo_path === "string"
      ? sourceMetadata.canonical_repo_path
      : typeof sourceMetadata.path === "string"
        ? sourceMetadata.path
        : null;
    const repoId = typeof sourceMetadata.repo_id === "number"
      ? sourceMetadata.repo_id
      : null;
    if (!path || !repoId) return document;

    const { data: repositoryFile, error } = await supabase
      .from("github_repo_files")
      .select("document_id")
      .eq("workspace_id", workspace.workspace_id)
      .eq("repo_id", repoId)
      .eq("path", path)
      .is("removed_at", null)
      .maybeSingle();
    if (error || !repositoryFile?.document_id) return document;

    return {
      ...document,
      source_metadata: {
        ...sourceMetadata,
        repository_document_id: repositoryFile.document_id,
      },
    };
  };

  // Try with folder_id; fall back if column doesn't exist yet
  const primary = await supabase
    .from("documents")
    .select("id, title, content, source, status, author, source_metadata, folder_id, deleted_at, created_at, updated_at")
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id)
    .single();

  if (primary.error?.message?.includes("folder_id")) {
    const fallback = await supabase
      .from("documents")
      .select("id, title, content, source, status, author, source_metadata, deleted_at, created_at, updated_at")
      .eq("id", id)
      .eq("workspace_id", workspace.workspace_id)
      .single();

    if (fallback.error || !fallback.data) {
      console.error("[Bread] Failed to fetch document:", fallback.error?.message);
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    return NextResponse.json(await addRepositoryDocumentLink(fallback.data));
  }

  if (primary.error || !primary.data) {
    console.error("[Bread] Failed to fetch document:", primary.error?.message);
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  return NextResponse.json(await addRepositoryDocumentLink(primary.data));
}

// ---------------------------------------------------------------------------
// PATCH /api/documents/[id]
// Updates a document's title and/or content.
// ---------------------------------------------------------------------------

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);

  if (!workspace) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 },
    );
  }

  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const parsed = await safeJsonBody(request, patchBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.content !== undefined) updates.content = body.content;
  if (body.status !== undefined) updates.status = body.status;
  if (body.folder_id !== undefined) updates.folder_id = body.folder_id;

  const contentJson =
    body.content_json &&
    typeof body.content_json === "object" &&
    (body.content_json as { type?: unknown }).type === "doc"
      ? (body.content_json as unknown as ProseMirrorDoc)
      : null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No valid fields to update" },
      { status: 400 },
    );
  }

  // Snapshot current state as a version before overwriting (content changes only)
  if (typeof updates.content === "string") {
    try {
      const { data: current } = await supabase
        .from("documents")
        .select("title, content, deleted_at")
        .eq("id", id)
        .eq("workspace_id", workspace.workspace_id)
        .single();

      if ((current as { deleted_at?: string | null } | null)?.deleted_at) {
        return NextResponse.json(
          { error: "Document is in trash" },
          { status: 410 },
        );
      }

      if (current && (current as { content: string }).content !== updates.content) {
        const admin = createAdminClient();

        // Coalesce rapid edits into one version (Google Docs-style session grouping).
        // If a manual version by this user exists within the last 5 minutes, skip
        // creating a new one — the existing version already captures the pre-session state.
        const COALESCE_WINDOW_MS = 5 * 60 * 1000;
        const { data: recentVersion } = await admin
          .from("document_versions")
          .select("id, created_at")
          .eq("document_id", id)
          .eq("workspace_id", workspace.workspace_id)
          .eq("edited_by", user.id)
          .eq("source", "manual")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const finalizeVersion = body.finalize_version === true;
        const recentEnough =
          !finalizeVersion &&
          recentVersion &&
          Date.now() - new Date(recentVersion.created_at as string).getTime() < COALESCE_WINDOW_MS;

        if (!recentEnough) {
          await admin.from("document_versions").insert({
            document_id: id,
            workspace_id: workspace.workspace_id,
            title: (current as { title: string }).title,
            content: (current as { content: string }).content,
            edited_by: user.id,
            source: "manual",
          });
        }
      }
    } catch (err) {
      // Version snapshot is non-fatal — log and continue with the save
      console.error("[Bread] Failed to snapshot document version:", err);
    }
  }

  updates.updated_at = new Date().toISOString();

  // Strip folder_id from updates if the column doesn't exist yet
  const primary = await supabase
    .from("documents")
    .update(updates)
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id)
    .is("deleted_at", null)
    .select("id, title, content, source, status, author, source_metadata, folder_id, deleted_at, created_at, updated_at")
    .maybeSingle();

  if (primary.error?.message?.includes("folder_id")) {
    const { folder_id: _, ...safeUpdates } = updates as Record<string, unknown> & { folder_id?: unknown };
    const fallback = await supabase
      .from("documents")
      .update(safeUpdates)
      .eq("id", id)
      .eq("workspace_id", workspace.workspace_id)
      .is("deleted_at", null)
      .select("id, title, content, source, status, author, source_metadata, deleted_at, created_at, updated_at")
      .maybeSingle();

    if (fallback.error) {
      console.error("[Bread] Failed to update document:", fallback.error.message);
      return NextResponse.json({ error: "Failed to update document" }, { status: 500 });
    }

    if (!fallback.data) {
      return NextResponse.json(
        { error: "Document not found or is in trash" },
        { status: 404 },
      );
    }

    const fallbackData = fallback.data as { status?: string; content?: string | null };
    if (fallbackData.status === "Published") {
      const finalContent =
        typeof updates.content === "string" ? updates.content : fallbackData.content ?? "";
      if (contentJson) {
        fireIngest(id, contentJson);
      } else if (finalContent.length > 0) {
        fireIngestFromText(id, finalContent);
      }
      if (finalContent.length > 0) {
        fireDocumentEmbeddingUpdate(id, workspace.workspace_id, finalContent);
      }
    }
    return NextResponse.json(fallback.data);
  }

  if (primary.error) {
    console.error("[Bread] Failed to update document:", primary.error.message);
    return NextResponse.json({ error: "Failed to update document" }, { status: 500 });
  }

  if (!primary.data) {
    return NextResponse.json(
      { error: "Document not found or is in trash" },
      { status: 404 },
    );
  }

  const primaryData = primary.data as { status?: string; content?: string | null };
  if (primaryData.status === "Published") {
    const finalContent =
      typeof updates.content === "string" ? updates.content : primaryData.content ?? "";
    if (contentJson) {
      fireIngest(id, contentJson);
    } else if (finalContent.length > 0) {
      fireIngestFromText(id, finalContent);
    }
    if (finalContent.length > 0) {
      fireDocumentEmbeddingUpdate(id, workspace.workspace_id, finalContent);
    }
  }
  return NextResponse.json(primary.data);
}

// Fire-and-forget hierarchical ingest. Keeps the save response snappy; a
// failed re-ingest is logged, never surfaced to the editor.
function fireIngest(documentId: string, tiptapDoc: ProseMirrorDoc): void {
  void ingestDocument(documentId, tiptapDoc).catch((err) => {
    console.error("[Bread] ingestDocument failed:", err);
  });
}

// ---------------------------------------------------------------------------
// POST /api/documents/[id]
// Forwards to PATCH to support navigator.sendBeacon (which only uses POST).
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  return PATCH(request, { params });
}

// ---------------------------------------------------------------------------
// DELETE /api/documents/[id]
// Deletes a document from the authenticated user's active workspace.
// ---------------------------------------------------------------------------

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);

  if (!workspace) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 },
    );
  }

  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const parsedQuery = safeSearchParams(new URL(request.url), deleteQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const permanent = parsedQuery.data.permanent === "true";

  if (permanent) {
    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", id)
      .eq("workspace_id", workspace.workspace_id)
      .not("deleted_at", "is", null);

    if (error) {
      console.error("[Bread] Failed to permanently delete document:", error.message);
      return NextResponse.json(
        { error: "Failed to permanently delete document" },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, permanent: true });
  }

  const deletedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("documents")
    .update({ deleted_at: deletedAt, updated_at: deletedAt })
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id)
    .is("deleted_at", null)
    .select("id, title, deleted_at, updated_at")
    .maybeSingle();

  if (error) {
    console.error("[Bread] Failed to delete document:", error.message);
    return NextResponse.json(
      { error: "Failed to delete document" },
      { status: 500 },
    );
  }

  if (!data) {
    const existing = await supabase
      .from("documents")
      .select("id, title, deleted_at, updated_at")
      .eq("id", id)
      .eq("workspace_id", workspace.workspace_id)
      .maybeSingle();

    if (existing.error || !existing.data) {
      return NextResponse.json(
        { error: "Document not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      moved_to_trash: true,
      document: existing.data,
    });
  }

  return NextResponse.json({
    success: true,
    moved_to_trash: true,
    document: data,
  });
}
