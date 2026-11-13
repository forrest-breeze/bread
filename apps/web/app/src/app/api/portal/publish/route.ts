import { NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { isPortalEditorEnabledForWorkspace } from "@/lib/db/subscription"
import { safeJsonBody, slugSchema } from "@/lib/validation"
import { discardDraft, publishDraft, rollbackTo } from "@/lib/portal/experiences-write"
import { validatePortalLayout, type PortalLayout } from "@/lib/portal/schema"

// ---------------------------------------------------------------------------
// /api/portal/publish — make the draft live, or roll back to an old version.
//
// POST { confirm: true }            → publish the current draft to the public portal
// POST { rollbackToVersion: number } → restore an older version as a new published row
// POST { rollbackToVersion, resetDraft: true } → …and reset the draft to match
//
// Publishing to the PUBLIC portal is a high-blast-radius action, so it is
// double-confirmed: a publish without `confirm: true` is rejected 400. (Rollback
// names an explicit version, which is itself the confirmation.)
// ---------------------------------------------------------------------------

interface PublishResponse {
  version: number
  spec: PortalLayout
}

function canManage(role: string): boolean {
  return role === "admin" || role === "owner"
}

function portalEditorPaymentRequired(): NextResponse {
  return NextResponse.json(
    {
      error: "The portal editor is not enabled for this workspace",
      message: "This workspace cannot publish portals.",
      code: "payment_required",
    },
    { status: 402 },
  )
}

const bodySchema = z
  .object({
    confirm: z.literal(true).optional(),
    rollbackToVersion: z.number().int().positive().optional(),
    // Rollback restores the LIVE portal. Without this the builder's draft keeps
    // whatever it held before, so the editor would show one layout while the
    // public portal shows another. The version selector's "Restore" passes true
    // (confirming the loss of unpublished edits); plain rollback callers keep
    // the historical draft-preserving behavior.
    resetDraft: z.boolean().optional(),
    projectSlug: slugSchema.optional(),
  })
  .refine(
    (b) => b.confirm === true || b.rollbackToVersion !== undefined,
    "Provide confirm:true to publish, or rollbackToVersion to restore an old version.",
  )

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
      { error: "Only workspace admins and owners can publish the portal" },
      { status: 403 },
    )
  }
  if (!(await isPortalEditorEnabledForWorkspace(workspace.workspace_id))) {
    return portalEditorPaymentRequired()
  }

  const parsed = await safeJsonBody(request, bodySchema)
  if (!parsed.ok) return parsed.response
  const { confirm, rollbackToVersion, resetDraft, projectSlug } = parsed.data

  try {
    const row =
      rollbackToVersion !== undefined
        ? await rollbackTo(
            workspace.workspace_id,
            rollbackToVersion,
            user.id,
            projectSlug,
          )
        : confirm === true
          ? await publishDraft(workspace.workspace_id, user.id, projectSlug)
          : null

    // Guarded by the Zod refine, but keep the explicit 400 so a future schema
    // change can't silently fall through to a 500.
    if (!row) {
      return NextResponse.json(
        { error: "Publishing requires confirm:true" },
        { status: 400 },
      )
    }

    // Resync the draft to the restored layout. discardDraft resets it to the
    // live published row, which rollbackTo has already replaced, so this lands
    // the editor on exactly what visitors now see. A failure here leaves the
    // rollback itself intact, so it must not fail the request.
    if (rollbackToVersion !== undefined && resetDraft === true) {
      try {
        await discardDraft(workspace.workspace_id, user.id, projectSlug)
      } catch (err) {
        console.error("[Breezify] portal rollback: draft resync failed:", err)
      }
    }

    const validation = validatePortalLayout(row.spec)
    if (!validation.ok) {
      console.error("[Breezify] portal publish: published row invalid:", validation.error)
      return NextResponse.json({ error: "Published layout is invalid" }, { status: 500 })
    }
    const body: PublishResponse = { version: row.version, spec: validation.data }
    return NextResponse.json(body)
  } catch (err) {
    console.error("[Breezify] portal publish:", err)
    return NextResponse.json({ error: "Failed to publish portal" }, { status: 500 })
  }
}
