import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { fireDocumentEmbeddingUpdate, fireIngestFromText } from "@/rag/ingest";
import { safeJsonBody, safeRouteParams, uuidParamSchema } from "@/lib/validation";
import type { DocumentVersionRow } from "@bread/core";
import { requireRouteUser } from "@/lib/auth/route-auth";

const postBodySchema = z.object({
  version_id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// GET /api/documents/[id]/versions
// Returns version history for a document (newest first).
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
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }
  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const { data, error } = await supabase
    .from("document_versions")
    .select("id, document_id, workspace_id, title, content, edited_by, source, created_at")
    .eq("document_id", id)
    .eq("workspace_id", workspace.workspace_id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[Bread] Failed to fetch document versions:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch versions" },
      { status: 500 },
    );
  }

  return NextResponse.json({ versions: data as DocumentVersionRow[] });
}

// ---------------------------------------------------------------------------
// POST /api/documents/[id]/versions
// Restores a document to a specific version without rewriting history.
// Body: { version_id: string }
// ---------------------------------------------------------------------------
export async function POST(
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
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }
  if (!["owner", "admin", "editor"].includes(workspace.role)) {
    return NextResponse.json(
      { error: "Editor access is required" },
      { status: 403 },
    );
  }

  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  const { version_id: versionId } = parsed.data;

  // Fetch the version to restore
  const { data: version, error: versionError } = await supabase
    .from("document_versions")
    .select("id, title, content, created_at")
    .eq("id", versionId)
    .eq("document_id", id)
    .eq("workspace_id", workspace.workspace_id)
    .single<{ id: string; title: string; content: string; created_at: string }>();

  if (versionError || !version) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  }

  const admin = createAdminClient();

  const { data: current, error: currentError } = await supabase
    .from("documents")
    .select("id, title, content, status")
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id)
    .single<{
      id: string;
      title: string;
      content: string;
      status: string | null;
    }>();

  if (currentError || !current) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  // Keep the state being replaced as a new immutable snapshot. A revert is a
  // new event in history (Git/GitHub semantics), never a destructive reset.
  const { error: snapshotError } = await admin
    .from("document_versions")
    .insert({
      document_id: id,
      workspace_id: workspace.workspace_id,
      title: current.title,
      content: current.content,
      edited_by: user.id,
      source: "restore",
    });

  if (snapshotError) {
    console.error(
      "[Bread] Failed to snapshot document before restore:",
      snapshotError.message,
    );
    return NextResponse.json(
      { error: "Failed to preserve the current version" },
      { status: 500 },
    );
  }

  // Restore the selected snapshot as the new head.
  const { error: updateError } = await supabase
    .from("documents")
    .update({
      title: version.title,
      content: version.content,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id);

  if (updateError) {
    console.error("[Bread] Failed to restore document version:", updateError.message);
    return NextResponse.json({ error: "Failed to restore version" }, { status: 500 });
  }

  // Re-index the restored content. Without this, document_section /
  // document_section_chunk keep the chunks/embeddings from the post-restore
  // state, so search returns text that no longer exists in documents.content.
  // Mirrors the same calls PATCH makes on a Published content edit.
  if (current.status === "Published" && version.content && version.content.length > 0) {
    fireIngestFromText(id, version.content);
    fireDocumentEmbeddingUpdate(id, workspace.workspace_id, version.content);
  }

  return NextResponse.json({ success: true });
}
