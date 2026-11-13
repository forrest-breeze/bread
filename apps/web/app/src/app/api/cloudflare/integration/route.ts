import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCloudflareWorkspace } from "@/lib/cloudflare/route-auth";
import {
  getCloudflareConnectorStatus,
  removeCloudflareWorkspaceConnection,
} from "@/lib/cloudflare/deploy";
import {
  loadCloudflareOAuthConfig,
  revokeCloudflareToken,
} from "@/lib/cloudflare/oauth";
import { safeSearchParams } from "@/lib/validation";

const QuerySchema = z.object({
  domain: z.string().trim().max(253).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireCloudflareWorkspace();
  if (!auth.ok) return auth.response;
  const query = safeSearchParams(request.nextUrl, QuerySchema);
  if (!query.ok) return query.response;
  const status = await getCloudflareConnectorStatus(
    auth.workspaceId,
    query.data.domain ?? null,
  );
  return NextResponse.json(status);
}

export async function DELETE(): Promise<NextResponse> {
  const auth = await requireCloudflareWorkspace({ admin: true });
  if (!auth.ok) return auth.response;
  const config = loadCloudflareOAuthConfig();
  if (!config) {
    return NextResponse.json({ error: "Cloudflare OAuth is not configured" }, { status: 503 });
  }
  try {
    const token = await removeCloudflareWorkspaceConnection(auth.workspaceId);
    if (token) {
      try {
        await revokeCloudflareToken(config, token);
      } catch (error) {
        // The managed Worker and routes are already gone. Finish deleting the
        // encrypted local credential even if Cloudflare's revoke endpoint is
        // temporarily unavailable; the app can no longer use the token.
        console.error("[Breezify] Cloudflare token revoke after cleanup:", error);
      }
    }
    const admin = createAdminClient();
    const { error: deploymentsError } = await admin
      .from("cloudflare_portal_deployments")
      .delete()
      .eq("workspace_id", auth.workspaceId);
    if (deploymentsError) throw deploymentsError;
    const { error: connectionError } = await admin
      .from("cloudflare_connections")
      .delete()
      .eq("workspace_id", auth.workspaceId);
    if (connectionError) throw connectionError;
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Breezify] Cloudflare disconnect:", error);
    return NextResponse.json(
      { error: "Cloudflare could not be disconnected safely" },
      { status: 502 },
    );
  }
}
