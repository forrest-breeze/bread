import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer } from "@/lib/api/authenticate-bearer";
import { handleCorsPreflight, withCors } from "@/lib/api/cors";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeSearchParams } from "@/lib/validation";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  source: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/documents
// Returns all documents for the workspace associated with the API key.
// Supports `?source=A,B` to filter by one or more `source` values.
// ---------------------------------------------------------------------------

export function OPTIONS(request: NextRequest): NextResponse {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateBearer(request);
  if (auth.error || !auth.data) {
    return withCors(request, auth.error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }
  const { workspaceId } = auth.data;

  const parsedQuery = safeSearchParams(request.nextUrl, querySchema);
  if (!parsedQuery.ok) {
    return withCors(request, parsedQuery.response);
  }
  const { limit, offset, source: sourceParam } = parsedQuery.data;

  const sources = sourceParam
    ? sourceParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : null;

  const admin = createAdminClient();

  // v1 is workspace-scope only — team/role-scoped folders stay hidden.
  const visibleFolders = await admin
    .from("folders")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("visibility", "workspace");

  if (visibleFolders.error) {
    console.error(
      "[Breezify] API v1 fetch visible folders failed:",
      visibleFolders.error.message,
    );
    return withCors(
      request,
      NextResponse.json({ error: "Failed to fetch documents" }, { status: 500 }),
    );
  }

  const visibleFolderIds = (visibleFolders.data ?? []).map((f) => f.id);
  const folderFilter =
    visibleFolderIds.length > 0
      ? `folder_id.is.null,folder_id.in.(${visibleFolderIds.join(",")})`
      : "folder_id.is.null";

  let query = admin
    .from("documents")
    .select("id, title, source, status, author, folder_id, updated_at, created_at")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .or(folderFilter);

  if (sources && sources.length > 0) {
    query = query.in("source", sources);
  }

  const primary = await query
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (primary.error) {
    console.error("[Breezify] API v1 fetch documents failed:", primary.error.message);
    return withCors(
      request,
      NextResponse.json({ error: "Failed to fetch documents" }, { status: 500 }),
    );
  }

  return withCors(request, NextResponse.json({ results: primary.data }));
}
