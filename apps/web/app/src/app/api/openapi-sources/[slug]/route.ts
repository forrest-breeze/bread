import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { MAX_OPENAPI_SPEC_BYTES } from "@/lib/github/github-hosted-openapi"
import {
  deleteOpenApiSource,
  OPENAPI_SOURCE_SLUG_RE,
  syncOpenApiSource,
} from "@/lib/openapi/openapi-source"

// Settings -> Integrations -> OpenAPI: upload (PUT) or remove (DELETE) a spec
// as a signed-in member. Editors and above may publish; admins may remove.

export const runtime = "nodejs"
export const maxDuration = 300

const PUBLISH_ROLES = new Set(["owner", "admin", "editor"])
const REMOVE_ROLES = new Set(["owner", "admin"])

async function resolve(
  params: Promise<{ slug: string }>,
  allowedRoles: Set<string>,
): Promise<{ workspaceId: string; slug: string; userId: string } | NextResponse> {
  const { slug } = await params
  if (!OPENAPI_SOURCE_SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: "Name must be lowercase letters, digits and dashes (max 63)." },
      { status: 400 },
    )
  }
  const supabase = await createClient()
  const { user, response } = await requireRouteUser(supabase)
  if (!user) return response
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 })
  if (!allowedRoles.has(workspace.role)) {
    return NextResponse.json({ error: "Your role cannot change OpenAPI sources." }, { status: 403 })
  }
  return { workspaceId: workspace.workspace_id, slug, userId: user.id }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const ctx = await resolve(params, PUBLISH_ROLES)
  if (ctx instanceof NextResponse) return ctx
  if (Number(request.headers.get("content-length") ?? "0") > MAX_OPENAPI_SPEC_BYTES) {
    return NextResponse.json(
      { error: `Spec exceeds the ${MAX_OPENAPI_SPEC_BYTES}-byte limit.` },
      { status: 413 },
    )
  }
  try {
    const outcome = await syncOpenApiSource(createAdminClient(), {
      workspaceId: ctx.workspaceId,
      slug: ctx.slug,
      raw: await request.text(),
      syncedBy: `user:${ctx.userId}`,
    })
    if (!outcome.ok) {
      return NextResponse.json({ error: "Invalid OpenAPI spec.", issues: outcome.issues }, { status: 422 })
    }
    return NextResponse.json(outcome.result)
  } catch (err) {
    console.error("[Breeze] OpenAPI upload (settings) failed:", err)
    return NextResponse.json({ error: "Failed to publish the spec." }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const ctx = await resolve(params, REMOVE_ROLES)
  if (ctx instanceof NextResponse) return ctx
  try {
    return NextResponse.json(await deleteOpenApiSource(createAdminClient(), ctx))
  } catch (err) {
    console.error("[Breeze] OpenAPI source delete (settings) failed:", err)
    return NextResponse.json({ error: "Failed to remove the spec." }, { status: 500 })
  }
}
