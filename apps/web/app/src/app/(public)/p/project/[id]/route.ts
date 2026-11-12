import { NextResponse, type NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { breezeOnlyResponse } from "@/lib/auth/require-breeze"

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Breeze internal tool: portals are Breeze-only (see lib/auth/require-breeze.ts).
  const denied = await breezeOnlyResponse();
  if (denied) return denied;

  const { id } = await params

  if (!UUID_RE.test(id)) {
    return new Response("Invalid project ID format", { status: 400 })
  }

  const admin = createAdminClient()

  // 1. Fetch the project
  const { data: project, error: projectError } = await admin
    .from("workspace_experiences")
    .select("slug, workspace_id, status")
    .eq("id", id)
    .eq("kind", "kb")
    .eq("audience", "public")
    .maybeSingle()

  if (projectError || !project) {
    return new Response("Project not found", { status: 404 })
  }

  // 2. Fetch the owning workspace
  const { data: workspace, error: workspaceError } = await admin
    .from("workspaces")
    .select("slug, settings")
    .eq("id", project.workspace_id)
    .maybeSingle()

  if (workspaceError || !workspace) {
    return new Response("Workspace not found", { status: 404 })
  }

  const settings = (workspace.settings as Record<string, unknown> | null) ?? {}
  const customDomain =
    typeof settings.kb_custom_domain === "string"
      ? settings.kb_custom_domain.trim().toLowerCase()
      : null

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""

  // 3. A project-level domain route is the most specific canonical address:
  // it can mount this project at a dedicated host root or below a shared-host
  // path. Query errors intentionally fall back to the legacy address so this
  // route remains deploy-safe while the migration rolls out.
  const { data: projectDomainRoute, error: projectDomainRouteError } = await admin
    .from("portal_domain_routes")
    .select("domain, path_prefix")
    .eq("workspace_id", project.workspace_id)
    .eq("project_slug", project.slug)
    .maybeSingle()

  const routeDomain =
    !projectDomainRouteError &&
    typeof projectDomainRoute?.domain === "string" &&
    projectDomainRoute.domain.trim()
      ? projectDomainRoute.domain.trim().toLowerCase()
      : null
  const routePath =
    routeDomain && typeof projectDomainRoute?.path_prefix === "string"
      ? projectDomainRoute.path_prefix === "/"
        ? ""
        : projectDomainRoute.path_prefix.replace(/\/+$/, "")
      : null

  if (routeDomain && routePath !== null) {
    let destination = `https://${routeDomain}${routePath}`
    const searchParams = request.nextUrl.search
    if (searchParams) destination += searchParams
    return NextResponse.redirect(destination, 307)
  }

  // 4. Legacy workspace-wide custom domains keep their existing behavior;
  // otherwise use the always-on /p/<workspace> address on the app host.
  const canonicalOrigin = customDomain
    ? `https://${customDomain}`
    : `${appUrl.replace(/\/+$/, "")}/p/${workspace.slug}`

  // 5. Construct the redirect path for this specific project.
  const isDefaultProject = project.slug === workspace.slug
  let destination = isDefaultProject
    ? canonicalOrigin
    : `${canonicalOrigin}/${project.slug}`

  // Preserves any incoming search params or hash if needed
  const searchParams = request.nextUrl.search
  if (searchParams) {
    destination += searchParams
  }

  return NextResponse.redirect(destination, 307)
}
