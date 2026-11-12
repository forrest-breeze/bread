import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /api/documents/trash
// Lists soft-deleted documents for the active workspace.
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
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

  const { data, error } = await supabase
    .from("documents")
    .select("id, title, source, author, folder_id, deleted_at, updated_at")
    .eq("workspace_id", workspace.workspace_id)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });

  if (error) {
    console.error("[Bread] Failed to fetch document trash:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch trash" },
      { status: 500 },
    );
  }

  return NextResponse.json({ documents: data ?? [] });
}
