import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getPortalEntitlementsForWorkspace } from "@/lib/db/subscription"
import { z } from "zod"
import { safeJsonBody, slugSchema } from "@/lib/validation"
import {
  getPortalVersionRow,
  getOrCreateDraft,
  saveDraft,
  listPortalVersions,
  type PortalVersionSummary,
} from "@/lib/portal/experiences-write"

// ---------------------------------------------------------------------------
// /api/portal/versions — a project's saved edit history.
//
// GET ?project=<slug> → { versions: PortalVersionSummary[] } newest first.
//
// Read-only companion to /api/portal/publish (which owns publish + rollback).
// Gated the same way as the draft route: the history exposes the shape of an
// unpublished-at-the-time layout, so it is admin/owner + portal-editor only.
// ---------------------------------------------------------------------------

interface VersionsResponse {
  versions: PortalVersionSummary[]
}

function canManage(role: string): boolean {
  return role === "admin" || role === "owner"
}

function projectSlugFromRequest(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get("project")
  if (!raw) return undefined
  const parsed = slugSchema.safeParse(raw)
  if (!parsed.success) throw new Error("Invalid project slug")
  return parsed.data
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let projectSlug: string | undefined
  try {
    projectSlug = projectSlugFromRequest(request)
  } catch {
    return NextResponse.json({ error: "Invalid project slug" }, { status: 400 })
  }

  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 })
  }
  if (!canManage(workspace.role)) {
    return NextResponse.json(
      { error: "Only workspace admins and owners can view portal versions" },
      { status: 403 },
    )
  }
  const entitlements = await getPortalEntitlementsForWorkspace(
    workspace.workspace_id,
  )
  if (!entitlements.portalEditor) {
    return NextResponse.json(
      {
        error: "Portal editor requires a paid plan",
        message: "This workspace cannot manage portal versions.",
        code: "payment_required",
      },
      { status: 402 },
    )
  }

  try {
    const versions = await listPortalVersions(
      workspace.workspace_id,
      projectSlug,
    )
    const body: VersionsResponse = { versions }
    return NextResponse.json(body)
  } catch (err) {
    console.error("[Bread] portal versions GET:", err)
    return NextResponse.json(
      { error: "Failed to load portal versions" },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let projectSlug: string | undefined
  try {
    projectSlug = projectSlugFromRequest(request)
  } catch {
    return NextResponse.json({ error: "Invalid project slug" }, { status: 400 })
  }

  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 })
  }
  if (!canManage(workspace.role)) {
    return NextResponse.json(
      { error: "Only workspace admins and owners can view portal versions" },
      { status: 403 },
    )
  }
  const entitlements = await getPortalEntitlementsForWorkspace(
    workspace.workspace_id,
  )
  if (!entitlements.portalEditor) {
    return NextResponse.json(
      {
        error: "Portal editor requires a paid plan",
        message: "This workspace cannot manage portal versions.",
        code: "payment_required",
      },
      { status: 402 },
    )
  }

  try {
    const parsed = await safeJsonBody(request, z.object({ version: z.number().int().positive() }))
    if (!parsed.ok) return parsed.response
    const payload = parsed.data
    const edit = await getPortalVersionRow(workspace.workspace_id, payload.version, projectSlug)
    if (!edit) return NextResponse.json({ error: "Saved edit not found" }, { status: 404 })
    await getOrCreateDraft(workspace.workspace_id, user.id, projectSlug)
    await saveDraft(workspace.workspace_id, edit.spec, projectSlug, user.id, payload.version)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[Bread] portal versions GET:", err)
    return NextResponse.json(
      { error: "Failed to load portal versions" },
      { status: 500 },
    )
  }
}
