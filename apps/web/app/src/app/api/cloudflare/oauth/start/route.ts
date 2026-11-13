import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireCloudflareWorkspace } from "@/lib/cloudflare/route-auth";
import {
  buildCloudflareAuthorizeUrl,
  issueCloudflareOAuthState,
  loadCloudflareOAuthConfig,
} from "@/lib/cloudflare/oauth";
import { loadPortalProxyConfig } from "@/lib/cloudflare/deploy";
import { safeSearchParams } from "@/lib/validation";
import {
  absoluteOAuthReturnUrl,
  appendOAuthResult,
  sanitizeOAuthReturnPath,
} from "@/lib/oauth-return";

const QuerySchema = z.object({
  target_domain: z.string().trim().min(1).max(253),
  return_to: z.string().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireCloudflareWorkspace({ admin: true });
  const query = safeSearchParams(request.nextUrl, QuerySchema);
  const returnPath = sanitizeOAuthReturnPath(
    query.ok ? query.data.return_to : null,
    "/settings",
  );
  const fail = (error: string): NextResponse =>
    NextResponse.redirect(
      absoluteOAuthReturnUrl(
        request,
        appendOAuthResult(returnPath, { cloudflare_error: error }),
      ),
    );
  if (!auth.ok) return fail("unauthorized");
  if (!query.ok) return fail("invalid_domain");

  const config = loadCloudflareOAuthConfig();
  if (!config) return fail("server_misconfigured");
  try {
    const proxy = await loadPortalProxyConfig(
      auth.workspaceId,
      query.data.target_domain,
    );
    const state = await issueCloudflareOAuthState({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      targetDomain: proxy.domain,
      returnPath,
    });
    return NextResponse.redirect(buildCloudflareAuthorizeUrl(config, state));
  } catch (error) {
    console.error("[Breezify] Cloudflare OAuth start:", error);
    return fail("invalid_configuration");
  }
}

