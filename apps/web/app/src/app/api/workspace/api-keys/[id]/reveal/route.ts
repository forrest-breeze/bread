import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { decryptToken } from "@/lib/security/token-crypto";

// ---------------------------------------------------------------------------
// POST /api/workspace/api-keys/:id/reveal
// Returns the plaintext secret for one workspace API key. Owner/admin only,
// and scoped to the active workspace so an id from another workspace 404s.
//
// POST rather than GET on purpose: a secret must never land in a URL that
// browsers, proxies, or the Next router cache might retain, and POST keeps
// this out of prefetch/replay paths.
// ---------------------------------------------------------------------------

const paramsSchema = z.object({ id: z.string().uuid() });

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const parsedParams = paramsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid key id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 });
  }

  if (!["owner", "admin"].includes(workspace.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .select("key_encrypted")
    .eq("id", parsedParams.data.id)
    .eq("workspace_id", workspace.workspace_id)
    .maybeSingle();

  if (error) {
    console.error("[Breezify] Failed to load API key for reveal:", error.message);
    return NextResponse.json({ error: "Failed to reveal API key" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  // Minted before retrievable secrets shipped, so only the hash exists. This is
  // permanent for that key — rotation is the only path back to a usable secret.
  if (!data.key_encrypted) {
    return NextResponse.json(
      {
        error:
          "This key was created before keys became viewable, so its secret can't be recovered. Revoke it and generate a new one.",
      },
      { status: 409 },
    );
  }

  const key = decryptToken(data.key_encrypted);
  if (!key) {
    // Wrong/rotated BREEZIFY_TOKEN_ENC_KEY, or tampered ciphertext. token-crypto
    // has already logged the specific cause.
    return NextResponse.json(
      { error: "Failed to decrypt this key. Check BREEZIFY_TOKEN_ENC_KEY." },
      { status: 500 },
    );
  }

  return NextResponse.json({ key });
}
