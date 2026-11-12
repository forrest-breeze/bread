import { type NextRequest, NextResponse } from "next/server";
import type { CredentialRole, PatScope, WorkspaceRole } from "@bread/core";
import { authenticatePAT } from "@/lib/api/authenticate-pat";
import { authenticateApiKey } from "@/lib/api/authenticate-api-key";
import { authenticateSupabaseSession } from "@/lib/api/authenticate-supabase";

/**
 * Discriminated union describing which credential was used. Routes that only
 * care about `workspaceId` can ignore `kind`; routes that need a `userId` or
 * PAT scopes must narrow on `kind`.
 */
export type BearerAuth =
  | {
      kind: "supabase";
      userId: string;
      workspaceId: string;
    }
  | {
      kind: "pat";
      userId: string;
      workspaceId: string;
      tokenHash: string;
      scopes: PatScope[];
      /** Effective folder-visibility tier (member role, possibly downscoped). */
      role: WorkspaceRole;
    }
  | {
      kind: "api_key";
      workspaceId: string;
      /** Folder-visibility tier this key acts as. */
      role: CredentialRole;
      /** Action capability (read / capture / admin). */
      scopes: PatScope[];
    };

/**
 * Effective folder-visibility role for a credential, or null when there is no
 * restriction to apply. Supabase user sessions read through RLS (which
 * already gates folder access by the member's role), so they pass null and
 * keep full access; PAT / API-key paths run through the service-role client
 * and carry an explicit role that the retrieval RPCs enforce.
 */
export function callerRoleFromAuth(auth: BearerAuth): string | null {
  return auth.kind === "supabase" ? null : auth.role;
}

/**
 * Supabase access tokens are JWTs — three base64url segments joined by `.`.
 * PATs and workspace API keys use the `bread_sk_` / `bread_pk_` schemes and
 * never contain `.` characters, so this check is a safe discriminator.
 */
function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Try each accepted credential type in priority order:
 *   1. Supabase session JWT — only when
 *      `x-bread-workspace` is present AND the token looks like a JWT.
 *   2. Personal Access Token.
 *   3. Workspace API key (integrations / MCP / API clients).
 *
 * Callers should check `error` before `data`, as with the individual
 * authenticators.
 */
export async function authenticateBearer(request: NextRequest): Promise<{
  data?: BearerAuth;
  error?: NextResponse;
}> {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const workspaceSlug = request.headers.get("x-bread-workspace")?.trim() ?? "";

  // 1. Supabase session path — only attempt when the shape matches a JWT and
  //    the workspace header is present (required for the membership lookup).
  //    If it succeeds we return; on failure we fall through to PAT/API key so
  //    a user with a stale session still has a usable credential path.
  if (token && workspaceSlug && looksLikeJwt(token)) {
    const supa = await authenticateSupabaseSession(request);
    if (supa.data) {
      return {
        data: {
          kind: "supabase",
          userId: supa.data.userId,
          workspaceId: supa.data.workspaceId,
        },
      };
    }
  }

  // 2. Personal Access Token.
  const pat = await authenticatePAT(request);
  if (pat.data) {
    return {
      data: {
        kind: "pat",
        userId: pat.data.userId,
        workspaceId: pat.data.workspaceId,
        tokenHash: pat.data.tokenHash,
        scopes: pat.data.scopes,
        role: pat.data.role,
      },
    };
  }

  // 3. Workspace API key.
  const apiKey = await authenticateApiKey(request);
  if (apiKey.data) {
    return {
      data: {
        kind: "api_key",
        workspaceId: apiKey.data.workspaceId,
        role: apiKey.data.role,
        scopes: apiKey.data.scopes,
      },
    };
  }

  // No credential matched — prefer the API-key 401 if we got that far (its
  // error shape is the simplest, matching the request's likely intent when
  // neither a PAT nor a session was valid).
  return {
    error:
      apiKey.error ??
      pat.error ??
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  };
}
