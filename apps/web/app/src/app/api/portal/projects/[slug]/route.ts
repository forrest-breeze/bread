import { NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { isPortalEditorEnabledForWorkspace } from "@/lib/db/subscription"
import {
  portalScopeEntrySchema,
  safeJsonBody,
  safeRouteParams,
  slugSchema,
} from "@/lib/validation"
import type { PortalScopeEntry } from "@/lib/public-kb"
import {
  deletePortalProject,
  renamePortalProject,
  updatePortalProjectPath,
  updatePortalProjectScope,
} from "@/lib/portal/experiences-write"

// ---------------------------------------------------------------------------
// PATCH /api/portal/projects/[slug]
// Rename a project ({ name }) and/or update its draft folder scope ({ scope }).
// Both are optional, but at least one must be present. The legacy scope-update
// client still PATCHes /api/portal/projects with { projectSlug, scope }; this
// per-slug route is the additive, RESTful surface for the project switcher UX.
//
// DELETE /api/portal/projects/[slug]
// Permanently remove a non-default project (all versions), taking down its
// workspace-scoped public project path.
// Auth: Supabase session + admin/owner. Workspace-scoped.
// ---------------------------------------------------------------------------

const routeParamsSchema = z.object({ slug: slugSchema })

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: slugSchema.optional(),
    // 400, not 50: doc-level scoping materializes one { doc } entry per picked
    // document (see /api/portal/projects).
    scope: z.array(portalScopeEntrySchema).max(400).nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.slug !== undefined || body.scope !== undefined, {
    message: "Provide a name and/or scope to update",
  })

function canManage(role: string): boolean {
  return role === "admin" || role === "owner"
}

function portalEditorPaymentRequired(): NextResponse {
  return NextResponse.json(
    {
      error: "The portal editor is not enabled for this workspace",
      message: "This workspace cannot manage portal projects.",
      code: "payment_required",
    },
    { status: 402 },
  )
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 })
  }
  if (!canManage(workspace.role)) {
    return NextResponse.json(
      { error: "Only workspace admins and owners can manage portal projects" },
      { status: 403 },
    )
  }
  if (!(await isPortalEditorEnabledForWorkspace(workspace.workspace_id))) {
    return portalEditorPaymentRequired()
  }

  const parsedParams = safeRouteParams(await context.params, routeParamsSchema)
  if (!parsedParams.ok) return parsedParams.response
  const { slug } = parsedParams.data

  const parsed = await safeJsonBody(request, patchBodySchema)
  if (!parsed.ok) return parsed.response

  try {
    const result: {
      slug: string
      previousSlug?: string
      name?: string
      scope?: PortalScopeEntry[] | null
      draftVersion?: number
    } = { slug }

    if (parsed.data.name !== undefined) {
      const renamed = await renamePortalProject(workspace.workspace_id, {
        slug,
        name: parsed.data.name,
      })
      result.name = renamed.name
    }

    if (parsed.data.slug !== undefined) {
      const renamedPath = await updatePortalProjectPath(workspace.workspace_id, {
        currentSlug: result.slug,
        slug: parsed.data.slug,
      })
      result.previousSlug = renamedPath.previousSlug
      result.slug = renamedPath.slug
    }

    if (parsed.data.scope !== undefined) {
      const scopeResult = await updatePortalProjectScope(
        workspace.workspace_id,
        user.id,
        result.slug,
        parsed.data.scope,
      )
      result.scope = scopeResult.scope
      result.draftVersion = scopeResult.draftVersion
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error("[Breezify] portal project PATCH:", err)
    const message = err instanceof Error ? err.message : "Failed to update project"
    const status =
      message.includes("unknown project") ||
      message.includes("unavailable folders") ||
      message.includes("unavailable documents") ||
      message.includes("name is required") ||
      message.includes("already taken") ||
      message.includes("reserved") ||
      message.includes("workspace root") ||
      message.includes("invalid project slug")
        ? 400
        : 500
    return NextResponse.json(
      {
        error: message.includes("workspace root")
          ? "The portal lives at the workspace root; its path can't change."
          : "Failed to update project",
      },
      { status },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 })
  }
  if (!canManage(workspace.role)) {
    return NextResponse.json(
      { error: "Only workspace admins and owners can manage portal projects" },
      { status: 403 },
    )
  }
  if (!(await isPortalEditorEnabledForWorkspace(workspace.workspace_id))) {
    return portalEditorPaymentRequired()
  }

  const parsedParams = safeRouteParams(await context.params, routeParamsSchema)
  if (!parsedParams.ok) return parsedParams.response
  const { slug } = parsedParams.data

  try {
    const result = await deletePortalProject(workspace.workspace_id, slug)
    return NextResponse.json(result)
  } catch (err) {
    console.error("[Breezify] portal project DELETE:", err)
    const message = err instanceof Error ? err.message : "Failed to delete project"
    const status = message.includes("unknown project") ? 400 : 500
    return NextResponse.json({ error: "Failed to delete project" }, { status })
  }
}
