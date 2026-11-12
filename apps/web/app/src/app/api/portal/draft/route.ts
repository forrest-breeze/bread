import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getPortalEntitlementsForWorkspace } from "@/lib/db/subscription"
import { safeJsonBody, slugSchema } from "@/lib/validation"
import {
  getPublicTaxonomyFresh,
  getPublicDocumentsFresh,
  type PortalScopeEntry,
} from "@/lib/public-kb"
import {
  buildWorkspaceHeaderDefaults,
  normalizePortalLayoutForPublicData,
} from "@/lib/portal/build-default"
import {
  discardDraft,
  draftDivergesFromPublished,
  getOrCreateDraft,
  getDraftOrSynthesize,
  saveDraft,
  type PortalExperienceRow,
} from "@/lib/portal/experiences-write"
import { validatePortalLayout, type PortalLayout } from "@/lib/portal/schema"
import {
  getKbFooter,
  getKbHeader,
  getLandingPageUrl,
  getPortalChromeScope,
} from "@/lib/workspace-settings"

// ---------------------------------------------------------------------------
// /api/portal/draft — the admin portal-builder's draft layout.
//
// GET  returns the workspace's draft layout, creating one (cloned from the
//      published spec or the default layout) if none exists.
// PUT  validates and persists an edited draft.
//
// Both require an admin/owner role on the active workspace — the public portal
// is workspace-scoped state that only managers may shape.
// ---------------------------------------------------------------------------

interface DraftResponse {
  version: number
  spec: PortalLayout
  projectSlug: string | null
  scope: PortalScopeEntry[] | null
  /** True when the draft has saved spec/scope changes not yet published. */
  divergedFromPublished: boolean
}

function canManage(role: string): boolean {
  return role === "admin" || role === "owner"
}

function portalEditorPaymentRequired(): NextResponse {
  return NextResponse.json(
    {
      error: "Portal editor requires a paid plan",
      message: "This workspace cannot edit and publish portals.",
      code: "payment_required",
    },
    { status: 402 },
  )
}

const putBodySchema = z.object({
  // Validated structurally here, then re-validated against the full portal
  // schema by saveDraft before persistence.
  spec: z.unknown(),
  projectSlug: slugSchema.optional(),
})

function projectSlugFromRequest(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get("project")
  if (!raw) return undefined
  const parsed = slugSchema.safeParse(raw)
  if (!parsed.success) throw new Error("Invalid project slug")
  return parsed.data
}

function forcePoweredBy(layout: PortalLayout): PortalLayout {
  if (layout.footer?.showPoweredBy !== false) return layout
  return {
    ...layout,
    footer: { ...layout.footer, showPoweredBy: true },
  }
}

function removeUnentitledLocalization(layout: PortalLayout): PortalLayout {
  if (!layout.localization) return layout
  const next = { ...layout }
  delete next.localization
  return next
}

// Build the editor's DraftResponse from a draft row: validate the stored spec,
// then normalize it against the project's (scoped) public taxonomy + documents so
// the builder receives the same shape it renders. Shared by GET and DELETE.
async function buildDraftResponse(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  draft: PortalExperienceRow,
): Promise<NextResponse> {
  const validation = validatePortalLayout(draft.spec)
  if (!validation.ok) {
    console.error("[Bread] portal draft: stored draft invalid:", validation.error)
    return NextResponse.json({ error: "Stored draft is invalid" }, { status: 500 })
  }
  const [{ data: rawWorkspaceRow }, taxonomy, documents, divergedFromPublished] =
    await Promise.all([
      supabase
        .from("workspaces")
        .select("slug, settings")
        .eq("id", workspaceId)
        .maybeSingle(),
      // Fresh (uncached) reads: the builder must reflect content written
      // moments ago (e.g. onboarding's seeded docs); the public 60s cache can
      // serve a pre-write empty snapshot that would strip the sidebar and
      // document lists from the draft the editor loads.
      getPublicTaxonomyFresh(workspaceId, draft.scope),
      getPublicDocumentsFresh(workspaceId, draft.scope),
      draftDivergesFromPublished(workspaceId, draft),
    ])
  const workspaceRow = rawWorkspaceRow as {
    slug?: string | null
    settings?: Record<string, unknown> | null
  } | null
  const slug =
    typeof draft.slug === "string" && draft.slug
      ? draft.slug
      : typeof workspaceRow?.slug === "string" && workspaceRow.slug
        ? workspaceRow.slug
        : "preview"
  const body: DraftResponse = {
    version: draft.version,
    projectSlug: draft.slug,
    scope: draft.scope,
    divergedFromPublished,
    spec: normalizePortalLayoutForPublicData({
      slug,
      layout: validation.data,
      taxonomy,
      documents,
      workspaceFooter: getKbFooter(workspaceRow?.settings),
      workspaceHeader: buildWorkspaceHeaderDefaults({
        websiteUrl: getLandingPageUrl(workspaceRow?.settings),
        header: getKbHeader(workspaceRow?.settings),
      }),
      workspaceChromeScope: getPortalChromeScope(workspaceRow?.settings),
    }),
  }
  return NextResponse.json(body)
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
      { error: "Only workspace admins and owners can edit the portal" },
      { status: 403 },
    )
  }
  const entitlements = await getPortalEntitlementsForWorkspace(
    workspace.workspace_id,
  )
  if (!entitlements.portalEditor) {
    return portalEditorPaymentRequired()
  }

  try {
    const draft = await getDraftOrSynthesize(
      workspace.workspace_id,
      projectSlug,
    )
    return await buildDraftResponse(supabase, workspace.workspace_id, draft)
  } catch (err) {
    console.error("[Bread] portal draft GET:", err)
    return NextResponse.json({ error: "Failed to load draft" }, { status: 500 })
  }
}

// DELETE discards the project's draft edits, resetting the draft to the live
// published version (spec + scope + template). Returns the reset draft in the
// same shape as GET so the editor can adopt it without a follow-up refetch.
export async function DELETE(request: NextRequest): Promise<NextResponse> {
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
      { error: "Only workspace admins and owners can edit the portal" },
      { status: 403 },
    )
  }
  const entitlements = await getPortalEntitlementsForWorkspace(
    workspace.workspace_id,
  )
  if (!entitlements.portalEditor) {
    return portalEditorPaymentRequired()
  }

  try {
    const draft = await discardDraft(workspace.workspace_id, user.id, projectSlug)
    return await buildDraftResponse(supabase, workspace.workspace_id, draft)
  } catch (err) {
    console.error("[Bread] portal draft DELETE:", err)
    return NextResponse.json({ error: "Failed to discard draft" }, { status: 500 })
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 })
  }
  if (!canManage(workspace.role)) {
    return NextResponse.json(
      { error: "Only workspace admins and owners can edit the portal" },
      { status: 403 },
    )
  }
  const entitlements = await getPortalEntitlementsForWorkspace(
    workspace.workspace_id,
  )
  if (!entitlements.portalEditor) {
    return portalEditorPaymentRequired()
  }

  const parsed = await safeJsonBody(request, putBodySchema)
  if (!parsed.ok) return parsed.response
  let projectSlug: string | undefined
  try {
    projectSlug = parsed.data.projectSlug ?? projectSlugFromRequest(request)
  } catch {
    return NextResponse.json({ error: "Invalid project slug" }, { status: 400 })
  }

  const validation = validatePortalLayout(parsed.data.spec)
  if (!validation.ok) {
    return NextResponse.json(
      { error: "Invalid layout", detail: validation.error },
      { status: 400 },
    )
  }
  let spec = entitlements.portalBrandingRemoval
    ? validation.data
    : forcePoweredBy(validation.data)
  if (!entitlements.portalTranslations) {
    spec = removeUnentitledLocalization(spec)
  }

  try {
    // Ensure a draft row exists before saving (a fresh workspace may not have one).
    await getOrCreateDraft(workspace.workspace_id, user.id, projectSlug)
    const saved = await saveDraft(
      workspace.workspace_id,
      spec,
      projectSlug,
      user.id,
    )
    const body: DraftResponse = {
      version: saved.version,
      projectSlug: saved.slug,
      scope: saved.scope,
      divergedFromPublished: await draftDivergesFromPublished(
        workspace.workspace_id,
        saved,
      ),
      spec,
    }
    return NextResponse.json(body)
  } catch (err) {
    console.error("[Bread] portal draft PUT:", err)
    return NextResponse.json({ error: "Failed to save draft" }, { status: 500 })
  }
}
