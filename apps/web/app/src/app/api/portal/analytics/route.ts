import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getPortalEntitlementsForWorkspace } from "@/lib/db/subscription"
import { createAdminClient } from "@/lib/supabase/admin"
import { resolvePublishedProjectBySlug } from "@/lib/portal/experiences"
import { z } from "zod"
import { safeSearchParams } from "@/lib/validation"
import {
  aggregatePortalOverview,
  getPortalOverview,
} from "@/lib/portal/analytics-queries"

// ---------------------------------------------------------------------------
// Reporting > Overview data source. Workspace-scoped: any member of the active
// workspace can read its portal analytics. Reads go through the admin client
// (the membership check above is the authorization gate); RLS on portal_events
// independently scopes members to their own workspace.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic"

// Presets cap at 365d; portal_events is designed for ~180-day retention
// (prune_portal_events), so 6–12 month views can be partial once pruning runs.
const ALLOWED_DAYS = new Set([7, 14, 30, 90, 180, 365])

const querySchema = z.object({
  days: z.string().optional(),
  project: z.string().optional(),
})

export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 })
  }
  const entitlements = await getPortalEntitlementsForWorkspace(workspace.workspace_id)
  if (!entitlements.portalReporting) {
    return NextResponse.json(
      {
        error: "Portal reporting is not enabled for this workspace",
        message: "This workspace cannot view portal analytics.",
        code: "payment_required",
      },
      { status: 402 },
    )
  }

  const parsedQuery = safeSearchParams(new URL(request.url), querySchema)
  if (!parsedQuery.ok) return parsedQuery.response

  const { days: daysStr, project: projectSlug } = parsedQuery.data
  const daysParam = Number(daysStr ?? "30")
  const requestedDays = ALLOWED_DAYS.has(daysParam) ? daysParam : 30
  const days =
    entitlements.portalReportingMaxDays === null
      ? requestedDays
      : Math.min(requestedDays, entitlements.portalReportingMaxDays)

  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  const range = { from, to }

  // No project filter → workspace-wide rollup across every portal.
  let experienceId: string | undefined = undefined
  if (projectSlug) {
    const project = await resolvePublishedProjectBySlug(projectSlug)
    // Only honor a project that belongs to the active workspace; a foreign or
    // unknown slug yields an empty result rather than a cross-workspace read.
    if (project && project.workspaceId === workspace.workspace_id) {
      experienceId = project.experienceId
    } else {
      return NextResponse.json(
        aggregatePortalOverview([], new Map(), range),
      )
    }
  }

  try {
    const admin = createAdminClient()
    const overview = await getPortalOverview(admin, {
      workspaceId: workspace.workspace_id,
      experienceId,
      range,
    })
    return NextResponse.json(overview)
  } catch (err) {
    console.error("[Breezify] portal analytics GET:", err)
    return NextResponse.json(
      { error: "Failed to load portal analytics" },
      { status: 500 },
    )
  }
}
