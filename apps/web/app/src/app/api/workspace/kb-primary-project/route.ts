import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { safeJsonBody, slugSchema } from "@/lib/validation"
import { normalizeWorkspaceSettings } from "@/lib/workspace-settings"
import { resolvePublishedProjectByWorkspace } from "@/lib/portal/experiences"

// ---------------------------------------------------------------------------
// Primary portal project for the public KB.
//
// PUT    { projectSlug }  — set workspaces.settings->>'kb_primary_project' (merge).
// DELETE                  — clear it (root falls back to the legacy "docs" project).
//
// The "primary project" is where the workspace root (`/p/<slug>`) redirects when
// no project is published at the root itself. We verify the chosen slug names a
// published, public KB project in this workspace so the root never redirects to
// a 404. Both gates: requireRouteUser() → getActiveWorkspace() → admin/owner.
// ---------------------------------------------------------------------------

const putBodySchema = z.object({
  projectSlug: slugSchema,
})

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "owner"
}

async function loadSettings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("workspaces")
    .select("settings")
    .eq("id", workspaceId)
    .single()
  if (error) throw error
  return data?.settings && typeof data.settings === "object"
    ? (data.settings as Record<string, unknown>)
    : {}
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()

  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  try {
    const membership = await getActiveWorkspace(supabase, user.id)
    if (!membership) {
      return NextResponse.json({ error: "No workspace found" }, { status: 404 })
    }
    if (!isAdminRole(membership.role)) {
      return NextResponse.json(
        { error: "Only admins can change the primary project" },
        { status: 403 },
      )
    }

    const parsed = await safeJsonBody(request, putBodySchema)
    if (!parsed.ok) return parsed.response

    const projectSlug = parsed.data.projectSlug

    // The root only redirects to a published, public project — reject a slug
    // that doesn't resolve so the configured target can never 404.
    const project = await resolvePublishedProjectByWorkspace(
      membership.workspace_id,
      projectSlug,
    )
    if (!project) {
      return NextResponse.json(
        { error: "That project isn't published yet. Publish it first." },
        { status: 400 },
      )
    }

    const existing = (await loadSettings(supabase, membership.workspace_id)) ?? {}
    const nextSettings = normalizeWorkspaceSettings({
      ...existing,
      kb_primary_project: projectSlug,
    })

    const { error } = await supabase
      .from("workspaces")
      .update({ settings: nextSettings, updated_at: new Date().toISOString() })
      .eq("id", membership.workspace_id)

    if (error) {
      console.error("[Bread] kb-primary-project: update failed:", error.message)
      return NextResponse.json(
        { error: "Failed to update primary project" },
        { status: 500 },
      )
    }

    return NextResponse.json({ kb_primary_project: projectSlug })
  } catch (err) {
    console.error("[Bread] kb-primary-project:", err)
    return NextResponse.json(
      { error: "Failed to update primary project" },
      { status: 500 },
    )
  }
}

export async function DELETE(): Promise<NextResponse> {
  const supabase = await createClient()

  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  try {
    const membership = await getActiveWorkspace(supabase, user.id)
    if (!membership) {
      return NextResponse.json({ error: "No workspace found" }, { status: 404 })
    }
    if (!isAdminRole(membership.role)) {
      return NextResponse.json(
        { error: "Only admins can change the primary project" },
        { status: 403 },
      )
    }

    const existing = (await loadSettings(supabase, membership.workspace_id)) ?? {}
    // normalizeWorkspaceSettings drops kb_primary_project when absent, so
    // spreading without the key removes it from the persisted jsonb.
    const merged = { ...existing }
    delete merged.kb_primary_project
    const nextSettings = normalizeWorkspaceSettings(merged)

    const { error } = await supabase
      .from("workspaces")
      .update({ settings: nextSettings, updated_at: new Date().toISOString() })
      .eq("id", membership.workspace_id)

    if (error) {
      console.error("[Bread] kb-primary-project: clear failed:", error.message)
      return NextResponse.json(
        { error: "Failed to clear primary project" },
        { status: 500 },
      )
    }

    return NextResponse.json({ kb_primary_project: null })
  } catch (err) {
    console.error("[Bread] kb-primary-project:", err)
    return NextResponse.json(
      { error: "Failed to clear primary project" },
      { status: 500 },
    )
  }
}
