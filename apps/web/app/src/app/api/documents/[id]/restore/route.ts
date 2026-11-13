import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeRouteParams, uuidParamSchema } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

// ---------------------------------------------------------------------------
// POST /api/documents/[id]/restore
// Restores a soft-deleted document from trash.
// ---------------------------------------------------------------------------

export async function POST(
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

  const restoredAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("documents")
    .update({ deleted_at: null, updated_at: restoredAt })
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id)
    .not("deleted_at", "is", null)
    .select("id, title, source, status, author, folder_id, deleted_at, updated_at")
    .maybeSingle();

  if (error) {
    console.error("[Breezify] Failed to restore document:", error.message);
    return NextResponse.json(
      { error: "Failed to restore document" },
      { status: 500 },
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "Document not found in trash" },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, document: data });
}
