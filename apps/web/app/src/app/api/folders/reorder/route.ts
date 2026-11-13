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
  // "topic" = internal KB topic folders; "user" = regular folders, whose
  // top-level rows are the public portal sidebar's section headers.
  kind: z.enum(["topic", "user"]),
  ordered_ids: z.array(z.string().uuid()).min(1).max(500),
});

// ---------------------------------------------------------------------------
// PATCH /api/folders/reorder
// Persists the explicit order for folders of one kind in the KB portal sidebar.
// Workspace admins only. Reordering intentionally does not touch updated_at;
// that timestamp is reserved for actual content/name edits.
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
      { error: "Only workspace admins can reorder folders" },
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
    .from("folders")
    .select("id")
    .eq("workspace_id", workspace.workspace_id)
    .eq("kind", parsed.data.kind)
    .in("id", orderedIds);

  if (foundError) {
    console.error("[Breezify] folders/reorder: folder lookup failed:", foundError.message);
    return NextResponse.json({ error: "Failed to reorder folders" }, { status: 500 });
  }

  const foundIds = new Set((found ?? []).map((row) => (row as { id: string }).id));
  if (foundIds.size !== orderedIds.length) {
    return NextResponse.json(
      { error: `All ordered_ids must be ${parsed.data.kind} folders in this workspace` },
      { status: 400 },
    );
  }

  const writes = await Promise.all(
    orderedIds.map((id, index) =>
      admin
        .from("folders")
        .update({ sort_order: index })
        .eq("id", id)
        .eq("workspace_id", workspace.workspace_id)
        .eq("kind", parsed.data.kind),
    ),
  );

  const failed = writes.find((result) => result.error);
  if (failed?.error) {
    console.error("[Breezify] folders/reorder: update failed:", failed.error.message);
    return NextResponse.json({ error: "Failed to reorder folders" }, { status: 500 });
  }

  // Folder order feeds the public portal's cached taxonomy (sidebar headers).
  revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 });

  return NextResponse.json({ success: true, ordered_ids: orderedIds });
}
