import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { mintApiKey } from "@/lib/api/mint-api-key";

// ---------------------------------------------------------------------------
// POST /api/workspace/api-keys/:id/rotate
// Issues a new secret for an existing key, in place. Owner/admin only, scoped
// to the active workspace.
//
// Rotation keeps the row — id, name, role, scopes, and expiry all survive — so
// the key keeps its identity in the list and nothing downstream has to be
// re-described. Only the secret changes, which means the previous secret stops
// authenticating the moment this returns.
//
// This is also the recovery path for keys minted before `key_encrypted`
// existed: their original plaintext is unrecoverable, but rotating gives them a
// fresh secret that is revealable from then on.
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

  const { rawKey, keyHash, keyEncrypted } = mintApiKey();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .update({
      key_hash: keyHash,
      key_encrypted: keyEncrypted,
      // Usage history describes the retired secret, not this one.
      last_used_at: null,
    })
    .eq("id", parsedParams.data.id)
    .eq("workspace_id", workspace.workspace_id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[Breezify] Failed to rotate API key:", error.message);
    return NextResponse.json({ error: "Failed to rotate API key" }, { status: 500 });
  }
  // No row matched: either the id doesn't exist or it belongs to another
  // workspace. Both are a 404 here — the caller learns nothing either way.
  if (!data) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  return NextResponse.json({ key: rawKey, id: data.id });
}
