import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireCloudflareWorkspace } from "@/lib/cloudflare/route-auth";
import {
  deployWorkspacePortalToCloudflare,
  PortalProxyConfigurationError,
} from "@/lib/cloudflare/deploy";
import { CloudflareApiError } from "@/lib/cloudflare/api";
import { safeJsonBody } from "@/lib/validation";

const BodySchema = z.object({
  domain: z.string().trim().min(1).max(253),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await requireCloudflareWorkspace({ admin: true });
  if (!auth.ok) return auth.response;
  const parsed = await safeJsonBody(request, BodySchema);
  if (!parsed.ok) return parsed.response;
  try {
    const deployment = await deployWorkspacePortalToCloudflare(
      auth.workspaceId,
      parsed.data.domain,
    );
    return NextResponse.json({
      deployment: {
        status: deployment.status,
        domain: deployment.domain,
        scriptName: deployment.script_name,
        deployedAt: deployment.deployed_at,
        lastError: deployment.last_error,
        needsDeploy: false,
      },
    });
  } catch (error) {
    const status =
      error instanceof CloudflareApiError && error.status === 401
        ? 401
        : error instanceof PortalProxyConfigurationError
          ? 400
          : 502;
    console.error("[Breezify] Cloudflare deploy:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cloudflare deployment failed" },
      { status },
    );
  }
}

