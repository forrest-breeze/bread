import { createHash } from "crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { touchLastUsed } from "@/lib/api/touch-last-used";
import { isBreezeUserId } from "@/lib/auth/breeze-user";
import {
  type CredentialRole,
  type PatScope,
  type WorkspaceRole,
  ROLE_RANKS,
} from "@bread/core";

export async function authenticatePAT(request: NextRequest): Promise<{
  data?: {
    userId: string;
    workspaceId: string;
    tokenHash: string;
    scopes: PatScope[];
    /**
     * Effective folder-visibility tier: the lower of the member's current
     * role and the token's optional `role` downscope.
     */
    role: WorkspaceRole;
  };
  error?: NextResponse;
}> {
  const admin = createAdminClient();

  // 1. Extract and hash the Bearer token
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");

  if (!token) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");

  // 2. Look up the PAT — get user_id, expiry, scopes, revocation, role downscope
  let userId: string;
  let scopes: PatScope[];
  let tokenRole: CredentialRole | null;

  try {
    const { data: keyRow, error: keyError } = await admin
      .from("personal_access_tokens")
      .select("user_id, expires_at, scopes, revoked_at, role")
      .eq("token_hash", tokenHash)
      .single();

    if (keyError || !keyRow) {
      return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }

    if (keyRow.revoked_at) {
      return {
        error: NextResponse.json({ error: "Token revoked" }, { status: 401 }),
      };
    }

    if (new Date(keyRow.expires_at).getTime() <= Date.now()) {
      return {
        error: NextResponse.json({ error: "Token expired" }, { status: 401 }),
      };
    }

    userId = keyRow.user_id;
    scopes = (keyRow.scopes ?? []) as PatScope[];

    // Breeze internal tool: the token's owner must be a Breeze account.
    if (!(await isBreezeUserId(admin, userId))) {
      return {
        error: NextResponse.json(
          { error: "Only Breeze accounts can use this API." },
          { status: 403 },
        ),
      };
    }
    tokenRole = (keyRow.role ?? null) as CredentialRole | null;
  } catch {
    return {
      error: NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 503 },
      ),
    };
  }

  // 3. Extract and validate the workspace slug from headers
  const workspaceSlug = request.headers.get("x-bread-workspace")?.trim();
  if (!workspaceSlug) {
    return {
      error: NextResponse.json(
        { error: "Missing x-bread-workspace header" },
        { status: 400 },
      ),
    };
  }

  // 4. Verify user has access to this workspace and get its ID + role
  let workspaceId: string;
  let effectiveRole: WorkspaceRole;
  try {
    const { data: membership, error: membershipError } = await admin
      .from("workspace_members")
      .select("workspace_id, role, workspaces!inner(slug)")
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

    // Effective role = the lower of the member's current role and the token's
    // optional downscope. A token can never grant more than its owner has,
    // even if their role changed after the token was minted.
    const memberRole = membership.role as WorkspaceRole;
    effectiveRole =
      tokenRole && ROLE_RANKS[tokenRole] < ROLE_RANKS[memberRole]
        ? tokenRole
        : memberRole;
  } catch {
    return {
      error: NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 503 },
      ),
    };
  }

  // 5. Fire-and-forget last_used_at update, throttled to ~once / 5 min per token
  //    (see touch-last-used) — best-effort audit trail, not worth a write on
  //    every request from polling CLIs.
  touchLastUsed("personal_access_tokens", "token_hash", tokenHash);

  return { data: { userId, workspaceId, tokenHash, scopes, role: effectiveRole } };
}
