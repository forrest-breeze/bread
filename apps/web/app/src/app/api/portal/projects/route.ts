import { NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getPortalEntitlementsForWorkspace } from "@/lib/db/subscription"
import { portalScopeEntrySchema, safeJsonBody, slugSchema } from "@/lib/validation"
import {
  createPortalProject,
  listPortalProjects,
  updatePortalProjectScope,
  updatePortalProjectVisibility,
} from "@/lib/portal/experiences-write"

// Doc-level scoping materializes one { doc } entry per picked document, so the
// entry cap must comfortably exceed folder counts. 400 bounds abuse while
// leaving room for a folder's worth of individual picks.
const MAX_SCOPE_ENTRIES = 400

const patchBodySchema = z.object({
  projectSlug: slugSchema.optional(),
  scope: z.array(portalScopeEntrySchema).max(MAX_SCOPE_ENTRIES).nullable().optional(),
  visibility: z.enum(["public", "private"]).optional(),
})

const postBodySchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(80),
  scope: z.array(portalScopeEntrySchema).max(MAX_SCOPE_ENTRIES).optional(),
})

function canManage(role: string): boolean {
  return role === "admin" || role === "owner"
}

function portalEditorPaymentRequired(message?: string): NextResponse {
  return NextResponse.json(
    {
      error: "Portal editor requires a paid plan",
      message: message ?? "This workspace cannot manage portal projects.",
      code: "payment_required",
    },
    { status: 402 },
  )
}

export async function GET(): Promise<NextResponse> {
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
  const entitlements = await getPortalEntitlementsForWorkspace(workspace.workspace_id)
  if (!entitlements.portalEditor) {
    return portalEditorPaymentRequired()
  }

  try {
    const projects = await listPortalProjects(workspace.workspace_id)
    return NextResponse.json({ projects })
  } catch (err) {
    console.error("[Bread] portal projects GET:", err)
    return NextResponse.json(
      { error: "Failed to load portal projects" },
      { status: 500 },
    )
  }
}

export async function POST(request: Request): Promise<NextResponse> {
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
  const entitlements = await getPortalEntitlementsForWorkspace(workspace.workspace_id)
  if (!entitlements.portalEditor) {
    return portalEditorPaymentRequired()
  }

  const existingProjects = await listPortalProjects(workspace.workspace_id)
  // One portal per workspace. Workspaces that already had several keep them
  // serving, but no new ones can be added.
  if (existingProjects.length > 0) {
    return NextResponse.json(
      {
        error: "This workspace already has a portal",
        code: "portal_exists",
      },
      { status: 409 },
    )
  }

  const parsed = await safeJsonBody(request, postBodySchema)
  if (!parsed.ok) return parsed.response

  try {
    const project = await createPortalProject(workspace.workspace_id, user.id, {
      slug: parsed.data.slug,
      name: parsed.data.name,
      scope: parsed.data.scope ?? null,
    })
    return NextResponse.json({ project }, { status: 201 })
  } catch (err) {
    console.error("[Bread] portal projects POST:", err)
    const message = err instanceof Error ? err.message : "Failed to create project"
    const status =
      message.includes("already taken") ||
      message.includes("reserved") ||
      message.includes("invalid project slug") ||
      message.includes("unavailable folders") ||
      message.includes("unavailable documents")
        ? 400
        : 500
    return NextResponse.json({ error: "Failed to create project" }, { status })
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
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
  const entitlements = await getPortalEntitlementsForWorkspace(workspace.workspace_id)
  if (!entitlements.portalEditor) {
    return portalEditorPaymentRequired()
  }

  const parsed = await safeJsonBody(request, patchBodySchema)
  if (!parsed.ok) return parsed.response

  try {
    if (parsed.data.visibility !== undefined) {
      const result = await updatePortalProjectVisibility(
        workspace.workspace_id,
        user.id,
        parsed.data.projectSlug,
        parsed.data.visibility,
      )
      return NextResponse.json(result)
    }
    if (parsed.data.scope !== undefined) {
      const result = await updatePortalProjectScope(
        workspace.workspace_id,
        user.id,
        parsed.data.projectSlug,
        parsed.data.scope,
      )
      return NextResponse.json(result)
    }
    return NextResponse.json({ error: "No update specified" }, { status: 400 })
  } catch (err) {
    console.error("[Bread] portal projects PATCH:", err)
    const message = err instanceof Error ? err.message : "Failed to update project"
    const status =
      message.includes("unknown project") ||
      message.includes("unavailable folders") ||
      message.includes("unavailable documents")
        ? 400
        : 500
    return NextResponse.json({ error: "Failed to update project" }, { status })
  }
}
