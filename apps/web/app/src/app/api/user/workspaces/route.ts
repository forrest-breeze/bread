import { createHash } from "crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOMAIN_NOT_ALLOWED_MESSAGE, isAllowedEmail } from "@/lib/auth/allowed-email";
import { isBreezeUserId } from "@/lib/auth/breeze-user";

// ---------------------------------------------------------------------------
// GET /api/user/workspaces
// Returns the list of workspaces available to the authenticated user.
// Auth: Bearer token is either
//   1. a Supabase session access token (JWT) — used by authenticated clients
//      app, which forwards its web session tokens, or
//   2. a Personal Access Token (PAT) — for user-scoped API clients.
// The token type is detected by shape: JWTs have three `.`-separated segments.
// ---------------------------------------------------------------------------

/** A Supabase access token is a JWT (three non-empty `.`-separated segments). */
function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const admin = createAdminClient();

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let userId: string | null = null;

  try {
    // 1. Supabase session path — only attempted when the token shape matches a
    //    JWT. On success we skip the PAT lookup; on failure we fall through so
    //    a legitimate PAT that happens to contain dots (future-proofing) still
    //    works.
    if (looksLikeJwt(token)) {
      try {
        const { data: userData, error: userError } = await admin.auth.getUser(token);
        // Breeze internal tool: non-Breeze sessions are rejected outright.
        if (!userError && userData?.user) {
          if (!isAllowedEmail(userData.user.email)) {
            return NextResponse.json({ error: DOMAIN_NOT_ALLOWED_MESSAGE }, { status: 403 });
          }
          userId = userData.user.id;
        }
      } catch (err) {
        console.error("[Bread] workspaces API: Supabase session lookup failed:", err);
      }
    }

    // 2. PAT path — used by API clients and as a fallback for the session path.
    if (!userId) {
      const tokenHash = createHash("sha256").update(token).digest("hex");

      const { data: keyRow, error: keyError } = await admin
        .from("personal_access_tokens")
        .select("user_id, revoked_at, expires_at")
        .eq("token_hash", tokenHash)
        .single();

      if (keyError || !keyRow) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      // Same rules as authenticatePAT: revoked or expired tokens are dead.
      if (keyRow.revoked_at || new Date(keyRow.expires_at).getTime() <= Date.now()) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (!(await isBreezeUserId(admin, keyRow.user_id))) {
        return NextResponse.json({ error: DOMAIN_NOT_ALLOWED_MESSAGE }, { status: 403 });
      }

      userId = keyRow.user_id;

      // Update last_used_at non-fatally
      (async () => {
        try {
          await admin
            .from("personal_access_tokens")
            .update({ last_used_at: new Date().toISOString() })
            .eq("token_hash", tokenHash);
        } catch {
          /* non-fatal */
        }
      })();
    }

    // Fetch workspaces for this user
    const { data: workspaces, error } = await admin
      .from("workspace_members")
      .select(
        `
        role,
        workspaces (
          name,
          slug
        )
      `
      )
      .eq("user_id", userId)
      .neq("status", "invited"); // Only include active memberships

    if (error) {
      console.error("[Bread] Failed to fetch workspaces:", error.message);
      return NextResponse.json(
        { error: "Failed to fetch workspaces" },
        { status: 500 }
      );
    }

    type WorkspaceMembership = {
      role: string;
      workspaces: { slug: string; name: string } | { slug: string; name: string }[];
    };

    const formatted = (workspaces as unknown as WorkspaceMembership[])
      .map((w) => {
        const ws = Array.isArray(w.workspaces) ? w.workspaces[0] : w.workspaces;
        return {
          slug: ws?.slug,
          name: ws?.name,
          role: w.role,
        };
      })
      .filter((w): w is { slug: string; name: string; role: string } => !!w.slug);

    return NextResponse.json({ workspaces: formatted });
  } catch (err) {
    console.error("[Bread] Unexpected error in workspaces API:", err);
    return NextResponse.json(
      { error: "Service temporarily unavailable" },
      { status: 503 }
    );
  }
}
