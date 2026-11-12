import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { isS3Configured, publicUrlFor, getSignedReadUrl } from "@/lib/storage/s3";
import { safeRouteParams, uuidParamSchema } from "@/lib/validation";

// ---------------------------------------------------------------------------
// GET /api/media/[id] — resolve a media_objects row to a fetchable URL.
//
// This is the read half of the S3 offload: a document body references an
// asset by its stable id (e.g. ![alt](/api/media/<id>)) and never embeds the
// bytes. We resolve the id to the S3 key and 302 to either a CDN/public URL
// (S3_PUBLIC_BASE_URL) or a short-lived signed URL.
//
// Authz is enforced by RLS: the user-scoped client only returns the row when
// the caller is a member of its workspace (the "Members can read media_objects"
// policy). No admin client here — that would bypass the workspace boundary.
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  if (!isS3Configured()) {
    return NextResponse.json(
      { error: "Media storage is not configured" },
      { status: 501 },
    );
  }

  // RLS scopes this to media in a workspace the caller belongs to.
  const { data: media, error } = await supabase
    .from("media_objects")
    .select("storage_key, mime")
    .eq("id", id)
    .not("verified_at", "is", null)
    .single();

  if (error || !media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const key = (media as { storage_key: string }).storage_key;
  const url = publicUrlFor(key) ?? (await getSignedReadUrl(key));

  // Don't let the (expiring) signed redirect get cached as if permanent.
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
