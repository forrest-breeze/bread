import { type NextRequest, NextResponse } from "next/server";
import type { CredentialRole, PatScope } from "@breezify/core";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashBearerToken } from "@/lib/api/hash-bearer-token";
import { touchLastUsed } from "@/lib/api/touch-last-used";

export interface ApiKeyAuth {
  workspaceId: string;
  /** Folder-visibility tier this key acts as. */
  role: CredentialRole;
  /** Action capability (read / capture / admin). */
  scopes: PatScope[];
}

export async function authenticateApiKey(request: NextRequest): Promise<{
  data?: ApiKeyAuth;
  error?: NextResponse;
}> {
  const keyHash = hashBearerToken(request);
  if (keyHash === null) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  try {
    const admin = createAdminClient();
    const { data: keyRow, error: keyError } = await admin
      .from("api_keys")
      .select("workspace_id, role, scopes, expires_at, revoked_at")
      .eq("key_hash", keyHash)
      .single();

    if (keyError || !keyRow) {
      return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }

    if (keyRow.revoked_at) {
      return { error: NextResponse.json({ error: "Key revoked" }, { status: 401 }) };
    }

    // expires_at is nullable — null means never expires (legacy keys).
    if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() <= Date.now()) {
      return { error: NextResponse.json({ error: "Key expired" }, { status: 401 }) };
    }

    // Fire-and-forget, throttled to ~once / 5 min per key (see touch-last-used):
    // the audit timestamp is best-effort and not critical to the auth outcome,
    // and writing it on every request from polling clients churns the DB.
    touchLastUsed("api_keys", "key_hash", keyHash);

    return {
      data: {
        workspaceId: keyRow.workspace_id,
        role: keyRow.role as CredentialRole,
        scopes: (keyRow.scopes ?? []) as PatScope[],
      },
    };
  } catch {
    return {
      error: NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 503 },
      ),
    };
  }
}
