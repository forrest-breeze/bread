import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  consumeCloudflareOAuthState,
  exchangeCloudflareCode,
  loadCloudflareOAuthConfig,
  storeCloudflareConnection,
} from "@/lib/cloudflare/oauth";
import { deployWorkspacePortalToCloudflare } from "@/lib/cloudflare/deploy";
import {
  absoluteOAuthReturnUrl,
  appendOAuthResult,
  sanitizeOAuthReturnPath,
} from "@/lib/oauth-return";

const QuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(2048).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

// Only OAuth-standard error codes round-trip into the return URL; anything
// else (or anything malformed) collapses to access_denied so the param can't
// become an open reflection vector.
const PASSTHROUGH_ERRORS = new Set([
  "access_denied",
  "invalid_scope",
  "invalid_request",
  "unauthorized_client",
  "unsupported_response_type",
  "server_error",
  "temporarily_unavailable",
]);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const query = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  const state = query.success && query.data.state
    ? await consumeCloudflareOAuthState(query.data.state)
    : null;
  const returnPath = sanitizeOAuthReturnPath(state?.returnPath, "/settings");
  const redirect = (params: Record<string, string>): NextResponse =>
    NextResponse.redirect(
      absoluteOAuthReturnUrl(request, appendOAuthResult(returnPath, params)),
    );

  if (!query.success || !state) return redirect({ cloudflare_error: "invalid_state" });
  if (query.data.error) {
    console.error(
      "[Breezify] Cloudflare OAuth denied:",
      query.data.error,
      query.data.error_description ?? "",
    );
    return redirect({
      cloudflare_error: PASSTHROUGH_ERRORS.has(query.data.error)
        ? query.data.error
        : "access_denied",
    });
  }
  if (!query.data.code) return redirect({ cloudflare_error: "invalid_request" });

  const config = loadCloudflareOAuthConfig();
  if (!config) return redirect({ cloudflare_error: "server_misconfigured" });

  // Re-check the initiating user's workspace role after the external consent
  // round trip so a removed/demoted admin cannot finish a stale authorization.
  const { data: membership } = await createAdminClient()
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", state.workspaceId)
    .eq("user_id", state.userId)
    .eq("status", "active")
    .maybeSingle();
  if (
    !membership ||
    (membership.role !== "admin" && membership.role !== "owner")
  ) {
    return redirect({ cloudflare_error: "unauthorized" });
  }

  try {
    const tokens = await exchangeCloudflareCode(config, query.data.code);
    await storeCloudflareConnection({
      workspaceId: state.workspaceId,
      userId: state.userId,
      tokens,
    });
  } catch (error) {
    console.error("[Breezify] Cloudflare OAuth callback:", error);
    return redirect({ cloudflare_error: "token_exchange_failed" });
  }

  try {
    await deployWorkspacePortalToCloudflare(state.workspaceId, state.targetDomain);
  } catch (error) {
    console.error("[Breezify] Cloudflare initial deployment:", error);
    return redirect({
      cloudflare_connected: "1",
      cloudflare_error: "deployment_failed",
    });
  }
  return redirect({ cloudflare_connected: "1", cloudflare_deployed: "1" });
}

