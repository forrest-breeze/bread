import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { z } from "zod";
import { safeSearchParams } from "@/lib/validation";
import { validateHandle, handleErrorMessage } from "@/lib/public-kb-handle";

// ---------------------------------------------------------------------------
// GET /api/workspace/slug/check?slug=<candidate>
//
// Live availability check for the editable workspace identifier (the `slug`
// keying /p/<slug> portal URLs) so the settings UI can give feedback before the
// user commits. Format + reserved-word checks reuse validateHandle; global
// uniqueness is checked across ALL workspaces with the admin client because RLS
// would hide other workspaces' rows. The authoritative guard stays the slug
// unique index on save (PUT /api/workspace surfaces a 23505 as a 409) — this
// endpoint is advisory.
//
// Unlike the handle, an empty slug is NOT "clear" — the slug is required, so an
// empty value reports unavailable rather than available.
// ---------------------------------------------------------------------------

interface CheckResult {
  available: boolean;
  /** User-facing reason when unavailable; null when available. */
  error: string | null;
}

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

const querySchema = z.object({
  slug: z.string().optional().default(""),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }
  if (!isAdminRole(membership.role)) {
    return NextResponse.json(
      { error: "Only admins can change the identifier" },
      { status: 403 },
    );
  }

  const parsedQuery = safeSearchParams(request.nextUrl, querySchema);
  if (!parsedQuery.ok) return parsedQuery.response;

  const { slug: raw } = parsedQuery.data;
  const { handle: slug, error } = validateHandle(raw);

  // No valid slug: either the field is empty (required — unavailable) or the
  // input failed a format/reserved check (report why). Either way it's a 200
  // advisory result, not an error response.
  if (!slug) {
    const result: CheckResult = error
      ? { available: false, error: handleErrorMessage(error) }
      : { available: false, error: "Workspace identifier is required." };
    return NextResponse.json(result);
  }

  const admin = createAdminClient();
  const { data, error: queryError } = await admin
    .from("workspaces")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (queryError) {
    console.error("[Breezify] slug check failed:", queryError.message);
    return NextResponse.json(
      { error: "Couldn't check availability" },
      { status: 500 },
    );
  }

  // Taken only if another workspace owns it — the caller re-claiming their own
  // slug is available (a no-op save).
  const taken = data !== null && data.id !== membership.workspace_id;
  const result: CheckResult = taken
    ? { available: false, error: "That identifier is already taken." }
    : { available: true, error: null };
  return NextResponse.json(result);
}
