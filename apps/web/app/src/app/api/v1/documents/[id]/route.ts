import { type NextRequest, NextResponse } from "next/server";
import { authenticateBearer } from "@/lib/api/authenticate-bearer";
import { handleCorsPreflight, withCors } from "@/lib/api/cors";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeRouteParams, uuidParamSchema } from "@/lib/validation";

// ---------------------------------------------------------------------------
// GET /api/v1/documents/[id]
// Returns full details (with content) for a specific document.
// ---------------------------------------------------------------------------

export function OPTIONS(request: NextRequest): NextResponse {
  return handleCorsPreflight(request);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const auth = await authenticateBearer(request);
  if (auth.error || !auth.data) {
    return withCors(request, auth.error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }
  const { workspaceId } = auth.data;

  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return withCors(request, parsedParams.response);
  const { id } = parsedParams.data;

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("documents")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .single();

  if (error || !data) {
    console.error("[Breezify] API v1 fetch document failed:", error?.message);
    return withCors(
      request,
      NextResponse.json({ error: "Document not found or access denied" }, { status: 404 }),
    );
  }

  // v1 only serves workspace-visible content. Block documents in team- or
  // role-scoped folders.
  if (data.folder_id) {
    const folder = await admin
      .from("folders")
      .select("visibility")
      .eq("id", data.folder_id)
      .eq("workspace_id", workspaceId)
      .single();

    if (folder.error || folder.data?.visibility !== "workspace") {
      return withCors(
        request,
        NextResponse.json({ error: "Document not found or access denied" }, { status: 404 }),
      );
    }
  }

  return withCors(request, NextResponse.json(data));
}
