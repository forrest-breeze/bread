import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeJsonBody } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { PUBLIC_KB_CACHE_TAG } from "@/lib/public-kb";

export const dynamic = "force-dynamic";

const reorderBodySchema = z.object({
  ordered_ids: z.array(z.string().uuid()).min(1).max(500),
});

// ---------------------------------------------------------------------------
// PATCH /api/documents/reorder
// Persists an explicit order for documents dragged around the KB sidebar
// (sort_order = array index). The ids are expected to be the siblings of one
// folder, but the route only requires that every id is a live document in the
// active workspace — sibling grouping is a client concern. Mirrors
// /api/folders/reorder: admin/owner only, and reordering intentionally does
// not touch updated_at.
// ---------------------------------------------------------------------------

export async function PATCH(request: Request): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }

  if (!["owner", "admin"].includes(workspace.role)) {
    return NextResponse.json(
      { error: "Only workspace admins can reorder documents" },
      { status: 403 },
    );
  }

  const parsed = await safeJsonBody(request, reorderBodySchema);
  if (!parsed.ok) return parsed.response;

  const orderedIds = [...new Set(parsed.data.ordered_ids)];
  if (orderedIds.length !== parsed.data.ordered_ids.length) {
    return NextResponse.json(
      { error: "ordered_ids must not contain duplicates" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  const { data: found, error: foundError } = await admin
    .from("documents")
    .select("id")
    .eq("workspace_id", workspace.workspace_id)
    .is("deleted_at", null)
    .in("id", orderedIds);

  if (foundError) {
    console.error(
      "[Breezify] documents/reorder: document lookup failed:",
      foundError.message,
    );
    return NextResponse.json(
      { error: "Failed to reorder documents" },
      { status: 500 },
    );
  }

  const foundIds = new Set((found ?? []).map((row) => (row as { id: string }).id));
  if (foundIds.size !== orderedIds.length) {
    return NextResponse.json(
      { error: "All ordered_ids must be documents in this workspace" },
      { status: 400 },
    );
  }

  const writes = await Promise.all(
    orderedIds.map((id, index) =>
      admin
        .from("documents")
        .update({ sort_order: index })
        .eq("id", id)
        .eq("workspace_id", workspace.workspace_id),
    ),
  );

  const failed = writes.find((result) => result.error);
  if (failed?.error) {
    console.error(
      "[Breezify] documents/reorder: update failed:",
      failed.error.message,
    );
    return NextResponse.json(
      { error: "Failed to reorder documents" },
      { status: 500 },
    );
  }

  // Document order feeds the public portal's cached sidebar/folder listings.
  revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 });

  return NextResponse.json({ success: true, ordered_ids: orderedIds });
}
