import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";

export const dynamic = "force-dynamic";

// Portal doc links carry `public_slug`, falling back to the document id.
const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// GET /api/documents/resolve?ref=<public slug or id>
// Maps a portal doc link back to the workspace document so the portal builder
// can open a doc clicked inside its live preview in the editor.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = refSchema.safeParse(
    new URL(request.url).searchParams.get("ref"),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid document ref" }, { status: 400 });
  }
  const ref = parsed.data;

  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("documents")
    .select("id")
    .eq("workspace_id", workspace.workspace_id)
    .is("deleted_at", null)
    .or(
      UUID_RE.test(ref)
        ? `public_slug.eq.${ref},id.eq.${ref}`
        : `public_slug.eq.${ref}`,
    )
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[Bread] Failed to resolve document ref:", error.message);
    return NextResponse.json(
      { error: "Failed to resolve document" },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  return NextResponse.json({ id: (data as { id: string }).id });
}
