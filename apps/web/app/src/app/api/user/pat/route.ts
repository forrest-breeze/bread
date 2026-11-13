import { createHash, randomBytes } from "crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { safeSearchParams } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

const MAX_TTL_DAYS = 365;

// Each field has its own default, so safeParse({}) yields a fully-populated
// payload — supporting clients that POST with an empty body.
const postBodySchema = z.object({
  name: z.string().trim().min(1).max(120).default("Capture Session"),
  scopes: z
    .array(z.enum(["capture", "read", "admin"]))
    .min(1)
    .default(["capture"]),
  ttl_days: z.number().int().min(1).max(MAX_TTL_DAYS).default(90),
});

const deleteQuerySchema = z.object({
  id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// GET /api/user/pat
// Lists Personal Access Tokens for the authenticated user.
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  // We can use the standard supabase client here because we added RLS policies
  const { data, error } = await supabase
    .from("personal_access_tokens")
    .select("id, name, last_used_at, created_at, expires_at, scopes, revoked_at")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[Breezify] Failed to fetch personal access tokens:", error.message);
    return NextResponse.json({ error: "Failed to fetch tokens" }, { status: 500 });
  }

  return NextResponse.json({ tokens: data });
}

// ---------------------------------------------------------------------------
// POST /api/user/pat
// Creates a new Personal Access Token for the authenticated user.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const admin = createAdminClient();

  // Generate a secure raw token formatted standardly:
  // breezify_pat_<random_base62_string>
  const rawPrefix = "breezify_pat_";
  // We use standard hex instead of base62 to avoid extra dependencies,
  // or simple base64url.
  const rawSecret = randomBytes(24).toString("base64url");
  const rawToken = `${rawPrefix}${rawSecret}`;

  // Hash it before storing
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  // Empty / malformed body is acceptable here (some clients mint tokens with
  // POST + no body), so we treat parse failures as "no body provided" and
  // let the schema's defaults kick in. Only structured-but-invalid bodies
  // (wrong shape, bad scope, bad ttl) return 400.
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // empty body is fine
  }
  const parsedBody = postBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsedBody.error.flatten() },
      { status: 400 },
    );
  }
  const { name, scopes, ttl_days: ttlDays } = parsedBody.data;

  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();

  // Multiple PATs per user are supported by design — one per client
  // (local MCP, CI, etc.). Callers that want
  // rotation semantics (e.g. reauthorizing a local integration)
  // are responsible for revoking their prior token via DELETE before
  // minting a new one; we don't rotate centrally because it'd kick
  // every other client of the same user off at the same time.

  const { data, error } = await admin
    .from("personal_access_tokens")
    .insert({
      user_id: user.id,
      name,
      token_hash: tokenHash,
      scopes,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[Breezify] Failed to generate personal access token:", error?.message);
    return NextResponse.json({ error: "Failed to create token" }, { status: 500 });
  }

  // Return the raw token EXACTLY ONCE.
  // It is functionally impossible to recover it after this response.
  return NextResponse.json({ token: rawToken, id: data.id }, { status: 201 });
}

// ---------------------------------------------------------------------------
// DELETE /api/user/pat
// Revokes a Personal Access Token for the authenticated user.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const parsedQuery = safeSearchParams(new URL(request.url), deleteQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const { id } = parsedQuery.data;

  const { error } = await supabase
    .from("personal_access_tokens")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    console.error("[Breezify] Failed to revoke personal access token:", error.message);
    return NextResponse.json({ error: "Failed to revoke token" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
