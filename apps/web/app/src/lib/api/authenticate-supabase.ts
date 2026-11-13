import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOMAIN_NOT_ALLOWED_MESSAGE, isAllowedEmail } from "@/lib/auth/allowed-email";

export interface SupabaseSessionAuth {
  userId: string;
  workspaceId: string;
}

/**
 * Authenticate a request using a Supabase session access token (JWT) in the
 * Authorization: Bearer header, scoped to the workspace given by the
 * `x-breezify-workspace` header. This lets authenticated clients reuse a normal
 * Supabase user session for bearer-authenticated workspace routes.
 */
export async function authenticateSupabaseSession(request: NextRequest): Promise<{
  data?: SupabaseSessionAuth;
  error?: NextResponse;
}> {
  const admin = createAdminClient();

  // 1. Extract the Bearer token.
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  // 2. Validate the JWT against Supabase Auth.
  let userId: string;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) {
      return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    if (!isAllowedEmail(data.user.email)) {
      return {
        error: NextResponse.json({ error: DOMAIN_NOT_ALLOWED_MESSAGE }, { status: 403 }),
      };
    }
    userId = data.user.id;
  } catch {
    return {
      error: NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 503 },
      ),
    };
  }

  // 3. Extract and validate the workspace slug from headers.
  const workspaceSlug = request.headers.get("x-breezify-workspace")?.trim();
  if (!workspaceSlug) {
    return {
      error: NextResponse.json(
        { error: "Missing x-breezify-workspace header" },
        { status: 400 },
      ),
    };
  }

  // 4. Verify user has access to this workspace and get its ID.
  let workspaceId: string;
  try {
    const { data: membership, error: membershipError } = await admin
      .from("workspace_members")
      .select("workspace_id, workspaces!inner(slug)")
      .eq("user_id", userId)
      .eq("workspaces.slug", workspaceSlug)
      .neq("status", "invited")
      .single();

    if (membershipError || !membership) {
      return {
        error: NextResponse.json(
          { error: "Forbidden: No access to this workspace" },
          { status: 403 },
        ),
      };
    }
    workspaceId = membership.workspace_id;
  } catch {
    return {
      error: NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 503 },
      ),
    };
  }

  return { data: { userId, workspaceId } };
}
