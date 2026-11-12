import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { getKbCustomDomain } from "@/lib/workspace-settings";
import { publicKbBaseDomain } from "@/lib/public-kb-handle";
import { listPortalProjects } from "@/lib/portal/experiences-write";
import { safeSearchParams, slugSchema } from "@/lib/validation";

const verifyQuerySchema = z.object({
  type: z.enum(["custom", "subdomain", "path", "project"]).default("custom"),
  project: slugSchema.optional(),
});

// ---------------------------------------------------------------------------
// Connection verification for the public-KB custom domain / subdomain.
//
// GET ?type=custom|subdomain — fetch the workspace's configured public host and
// confirm it resolves back to THIS workspace's portal. The proxy stamps an
// "x-bread-portal: <slug>" header on every portal rewrite (see proxy.ts); a
// match means DNS + routing + TLS are all live. We only ever fetch the
// workspace's own stored address (never arbitrary user input), over https.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 6000;

type VerifyResult = {
  connected: boolean;
  host: string | null;
  reason: string | null;
};

type ManagedCloudflareRoutes = Record<string, string>;

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

function portalProjectPath(workspaceSlug: string, projectSlug: string): string {
  return projectSlug === workspaceSlug
    ? `/p/${workspaceSlug}`
    : `/p/${workspaceSlug}/${projectSlug}`;
}

async function loadManagedCloudflareRoutes(
  workspaceId: string,
  domain: string,
): Promise<ManagedCloudflareRoutes | null> {
  const { data, error } = await createAdminClient()
    .from("cloudflare_portal_deployments")
    .select("routes, status")
    .eq("workspace_id", workspaceId)
    .eq("domain", domain)
    .maybeSingle();
  if (error || data?.status !== "connected" || !data.routes) return null;
  if (typeof data.routes !== "object" || Array.isArray(data.routes)) return null;
  return Object.fromEntries(
    Object.entries(data.routes).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }
  if (!isAdminRole(membership.role)) {
    return NextResponse.json(
      { error: "Only admins can verify the portal address" },
      { status: 403 },
    );
  }

  const { data: workspace, error } = await supabase
    .from("workspaces")
    .select("slug, settings")
    .eq("id", membership.workspace_id)
    .single();

  if (error || !workspace) {
    return NextResponse.json(
      { error: "Failed to load workspace" },
      { status: 500 },
    );
  }

  const parsed = safeSearchParams(request.nextUrl, verifyQuerySchema);
  if (!parsed.ok) return parsed.response;
  const { type, project } = parsed.data;

  if (type === "project") {
    if (!project) {
      return NextResponse.json(
        { error: "A project is required" },
        { status: 400 },
      );
    }
    const { data: route, error: routeError } = await supabase
      .from("portal_domain_routes")
      .select("domain, path_prefix")
      .eq("workspace_id", membership.workspace_id)
      .eq("project_slug", project)
      .maybeSingle();
    if (routeError) {
      return NextResponse.json(
        { error: "Failed to load the project address" },
        { status: 500 },
      );
    }
    if (!route) {
      const result: VerifyResult = {
        connected: false,
        host: null,
        reason: "No project address configured.",
      };
      return NextResponse.json(result);
    }
    const managedRoutes =
      route.path_prefix === "/"
        ? null
        : await loadManagedCloudflareRoutes(
            membership.workspace_id,
            route.domain,
          );
    return NextResponse.json(
      await probePortalUrl({
        host: route.domain,
        pathname: route.path_prefix,
        workspaceSlug: workspace.slug,
        requireReverseProxy: route.path_prefix !== "/",
        managedCloudflareRoute:
          managedRoutes?.[route.path_prefix] ===
          portalProjectPath(workspace.slug, project),
      }),
    );
  }

  if (type === "path") {
    const host = getKbCustomDomain(workspace.settings) || null;
    if (!host) {
      const result: VerifyResult = {
        connected: false,
        host: null,
        reason: "No shared domain configured.",
      };
      return NextResponse.json(result);
    }

    try {
      const projects = (await listPortalProjects(membership.workspace_id)).filter(
        (candidate) =>
          candidate.publishedVersion != null && candidate.slug !== workspace.slug,
      );
      if (projects.length === 0) {
        const result: VerifyResult = {
          connected: false,
          host,
          reason: "Publish a project path before checking the connection.",
        };
        return NextResponse.json(result);
      }
      const managedRoutes = await loadManagedCloudflareRoutes(
        membership.workspace_id,
        host,
      );
      const checks = await Promise.all(
        projects.map(async (candidate) => ({
          slug: candidate.slug,
          result: await probePortalUrl({
            host,
            pathname: `/${candidate.slug}`,
            workspaceSlug: workspace.slug,
            requireReverseProxy: true,
            managedCloudflareRoute:
              managedRoutes?.[`/${candidate.slug}`] ===
              portalProjectPath(workspace.slug, candidate.slug),
          }),
        })),
      );
      const failed = checks.find((check) => !check.result.connected);
      if (failed) {
        return NextResponse.json({
          connected: false,
          host,
          reason: `/${failed.slug}: ${failed.result.reason ?? "Not connected."}`,
        } satisfies VerifyResult);
      }
      return NextResponse.json({ connected: true, host, reason: null } satisfies VerifyResult);
    } catch (projectError) {
      console.error("[Bread] portal path verification:", projectError);
      return NextResponse.json(
        { error: "Failed to load portal projects" },
        { status: 500 },
      );
    }
  }

  // Resolve the host to probe from stored workspace state — not from input.
  let host: string | null = null;
  if (type === "subdomain") {
    const base = publicKbBaseDomain();
    if (base && workspace.slug) host = `${workspace.slug}.${base}`;
  } else {
    host = getKbCustomDomain(workspace.settings) || null;
  }

  if (!host) {
    const result: VerifyResult = {
      connected: false,
      host: null,
      reason: `No ${type === "subdomain" ? "subdomain" : "custom domain"} configured.`,
    };
    return NextResponse.json(result);
  }

  const result = await probePortalUrl({
    host,
    pathname: "/",
    workspaceSlug: workspace.slug,
    requireReverseProxy: false,
  });
  return NextResponse.json(result);
}

// A single cold-start or DNS blip shouldn't flip the connection badge to "not
// connected" — retry one network-level failure before reporting it.
async function fetchWithOneRetry(url: string): Promise<Response> {
  const attempt = (): Promise<Response> =>
    fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "Bread-Portal-Verify/1.0" },
    });
  try {
    return await attempt();
  } catch {
    return await attempt();
  }
}

export async function probePortalUrl({
  host,
  pathname,
  workspaceSlug,
  requireReverseProxy,
  managedCloudflareRoute = false,
}: {
  host: string;
  pathname: string;
  workspaceSlug: string;
  requireReverseProxy: boolean;
  managedCloudflareRoute?: boolean;
}): Promise<VerifyResult> {
  try {
    const res = await fetchWithOneRetry(`https://${host}${pathname}`);

    if (res.status >= 300 && res.status < 400) {
      return {
        connected: false,
        host,
        reason: "Redirecting away instead of staying on the configured URL.",
      };
    }
    const marker = res.headers.get("x-bread-portal");
    const proxyMarker = res.headers.get("x-bread-proxy");
    if (
      marker === workspaceSlug &&
      (!requireReverseProxy ||
        proxyMarker === "cloudflare-worker-v1" ||
        proxyMarker === "reverse-proxy-v1")
    ) {
      return { connected: true, host, reason: null };
    }
    if (marker) {
      // The host serves a Bread portal, but for a different workspace.
      return {
        connected: false,
        host,
        reason: "This domain points to a different workspace's portal.",
      };
    }
    // Some hosting adapters discard response headers stamped by Next's proxy
    // pass-through. A Bread-managed Worker still proves the route is live when
    // its marker is present AND the server-side deployment record maps this
    // exact domain/path to this workspace project. The caller computes that
    // second condition from the service-role-only deployment table.
    if (
      managedCloudflareRoute &&
      proxyMarker === "cloudflare-worker-v1"
    ) {
      return { connected: true, host, reason: null };
    }
    if (requireReverseProxy && !proxyMarker) {
      return {
        connected: false,
        host,
        reason: "The reverse-proxy route is not active yet.",
      };
    }
    return {
      connected: false,
      host,
      reason:
        "Reachable, but not serving this portal yet — check the proxy or DNS configuration.",
    };
  } catch {
    // DNS not resolving, TLS not provisioned, or timeout.
    return {
      connected: false,
      host,
      reason: "Couldn't reach the domain yet. DNS changes can take a while.",
    };
  }
}
