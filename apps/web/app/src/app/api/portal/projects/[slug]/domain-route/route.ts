import { NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { listPortalProjects } from "@/lib/portal/experiences-write"
import { safeJsonBody, safeRouteParams, slugSchema } from "@/lib/validation"
import {
  customDomainErrorMessage,
  validatePortalRouteDomain,
} from "@/lib/workspace-settings"

const routeParamsSchema = z.object({ slug: slugSchema })
const putBodySchema = z.object({
  domain: z.string().trim().min(1).max(253),
  mode: z.enum(["domain", "path"]),
})

function canManage(role: string): boolean {
  return role === "admin" || role === "owner"
}

async function authorize(
  context: { params: Promise<{ slug: string }> },
): Promise<
  | {
      ok: true
      supabase: Awaited<ReturnType<typeof createClient>>
      workspaceId: string
      slug: string
    }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return { ok: false, response: authResponse }

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "No active workspace" },
        { status: 400 },
      ),
    }
  }
  if (!canManage(workspace.role)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Only workspace admins and owners can manage portal addresses" },
        { status: 403 },
      ),
    }
  }

  const parsedParams = safeRouteParams(await context.params, routeParamsSchema)
  if (!parsedParams.ok) return { ok: false, response: parsedParams.response }
  const { slug } = parsedParams.data

  try {
    const projects = await listPortalProjects(workspace.workspace_id)
    if (!projects.some((project) => project.slug === slug)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Portal project not found" },
          { status: 404 },
        ),
      }
    }
  } catch (error) {
    console.error("[Bread] portal domain route project lookup:", error)
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Failed to load portal project" },
        { status: 500 },
      ),
    }
  }

  return {
    ok: true,
    supabase,
    workspaceId: workspace.workspace_id,
    slug,
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const auth = await authorize(context)
  if (!auth.ok) return auth.response

  const { data, error } = await auth.supabase
    .from("portal_domain_routes")
    .select("domain, path_prefix")
    .eq("workspace_id", auth.workspaceId)
    .eq("project_slug", auth.slug)
    .maybeSingle()

  if (error) {
    console.error("[Bread] portal domain route GET:", error.message)
    return NextResponse.json(
      { error: "Failed to load the project address" },
      { status: 500 },
    )
  }

  return NextResponse.json({
    route: data
      ? {
          projectSlug: auth.slug,
          domain: data.domain,
          pathPrefix: data.path_prefix,
          mode: data.path_prefix === "/" ? "domain" : "path",
        }
      : null,
  })
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const auth = await authorize(context)
  if (!auth.ok) return auth.response

  const parsed = await safeJsonBody(request, putBodySchema)
  if (!parsed.ok) return parsed.response

  // Grandfather the route's saved domain: a project keeps a domain it already
  // holds even if the reservation rules tightened after it was saved.
  const { data: existingRoute } = await auth.supabase
    .from("portal_domain_routes")
    .select("domain")
    .eq("workspace_id", auth.workspaceId)
    .eq("project_slug", auth.slug)
    .maybeSingle()

  const { domain, error: domainError } = validatePortalRouteDomain(
    parsed.data.domain,
    parsed.data.mode === "path",
    existingRoute?.domain,
  )
  if (domainError) {
    return NextResponse.json(
      { error: customDomainErrorMessage(domainError) },
      { status: 400 },
    )
  }

  const pathPrefix = parsed.data.mode === "path" ? `/${auth.slug}` : "/"
  const { error } = await auth.supabase.from("portal_domain_routes").upsert(
    {
      workspace_id: auth.workspaceId,
      project_slug: auth.slug,
      domain,
      path_prefix: pathPrefix,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,project_slug" },
  )

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "That domain and path are already used by another project." },
        { status: 409 },
      )
    }
    console.error("[Bread] portal domain route PUT:", error.message)
    return NextResponse.json(
      { error: "Failed to save the project address" },
      { status: 500 },
    )
  }

  return NextResponse.json({
    route: {
      projectSlug: auth.slug,
      domain,
      pathPrefix,
      mode: parsed.data.mode,
    },
  })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const auth = await authorize(context)
  if (!auth.ok) return auth.response

  const { error } = await auth.supabase
    .from("portal_domain_routes")
    .delete()
    .eq("workspace_id", auth.workspaceId)
    .eq("project_slug", auth.slug)

  if (error) {
    console.error("[Bread] portal domain route DELETE:", error.message)
    return NextResponse.json(
      { error: "Failed to remove the project address" },
      { status: 500 },
    )
  }

  return NextResponse.json({ route: null })
}
