import { NextResponse } from "next/server"
import { z } from "zod"
import { headers } from "next/headers"
import { isFolderInScope } from "@/lib/public-kb"
import { resolvePortalBase } from "@/lib/public-kb-portal-base"
import { checkPublicRateLimit } from "@/lib/public-kb-ratelimit"
import { createAdminClient } from "@/lib/supabase/admin"
import { logPortalEvent, portalVisitorId } from "@/lib/portal/analytics-capture"
import { isPortalReportingEnabledForWorkspace } from "@/lib/db/subscription"

// ---------------------------------------------------------------------------
// Public portal analytics beacon — records anonymous pageviews, doc views, and
// search clicks fired by <PortalViewBeacon> on the public portal pages.
//
// AUTH EXCEPTION (CLAUDE.md §1): intentionally UNAUTHENTICATED, like
// /api/public/search and /api/public/ask. Compensated by:
//   • strict Zod validation at the boundary,
//   • per-IP rate limiting (checkPublicRateLimit),
//   • published-public-workspace gating (404-equivalent: silently dropped),
//   • doc_view/search_click document_id is verified to be a real, visible doc
//     in the resolved workspace so injected ids can't inflate "most viewed".
//
// Always returns 204 (even on bad input / drop) so a beacon never surfaces an
// error to the visitor and bots learn nothing about what exists.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic"

function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 })
}

const bodySchema = z.object({
  // Portal base path: "<workspace>" or "<workspace>/<project>".
  portal: z.string().trim().min(1).max(140),
  type: z.enum([
    "pageview",
    "doc_view",
    "search",
    "search_click",
    "helpful",
    "not_helpful",
  ]),
  documentId: z.string().uuid().optional(),
  path: z.string().max(512).optional(),
  // Committed search query + result count — only meaningful for type "search".
  query: z.string().trim().min(1).max(200).optional(),
  resultCount: z.number().int().min(0).max(1000).optional(),
})

interface ClientMeta {
  ip: string
  ua: string
  referrerHost: string | null
}

async function clientMeta(): Promise<ClientMeta> {
  const h = await headers()
  const forwarded = h.get("x-forwarded-for")
  const ip = forwarded
    ? forwarded.split(",")[0]?.trim() || "anon"
    : h.get("x-real-ip") || "anon"
  const ua = h.get("user-agent") || ""
  let referrerHost: string | null = null
  const ref = h.get("referer")
  if (ref) {
    try {
      referrerHost = new URL(ref).host
    } catch {
      referrerHost = null
    }
  }
  return { ip, ua, referrerHost }
}

export async function POST(request: Request): Promise<NextResponse> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return noContent()
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return noContent()
  const { portal, type, documentId, path, query, resultCount } = parsed.data

  const { ip, ua, referrerHost } = await clientMeta()

  const allowed = await checkPublicRateLimit(`track:${portal}:${ip}`, 120, 60)
  if (!allowed) return noContent()

  // Resolve the portal base ("<workspace>" or "<workspace>/<project>") exactly
  // like the portal pages. Anything not published+public is silently dropped.
  const resolved = await resolvePortalBase(portal)
  if (!resolved) return noContent()
  const { workspace, experienceId, scope } = resolved
  if (!(await isPortalReportingEnabledForWorkspace(workspace.id))) {
    return noContent()
  }

  // Verify any document_id is a real, visible doc in this workspace so a
  // forged beacon can't inflate a doc's view count (or its helpful/not_helpful
  // tally). Cheap indexed lookup.
  const docScopedType =
    type === "doc_view" ||
    type === "search_click" ||
    type === "helpful" ||
    type === "not_helpful"
  let docId: string | null = null
  if (docScopedType && documentId) {
    const admin = createAdminClient()
    const { data: doc } = await admin
      .from("documents")
      .select("id, folder_id")
      .eq("id", documentId)
      .eq("workspace_id", workspace.id)
      .is("deleted_at", null)
      .in("document_type", ["source", "page"])
      .maybeSingle()
    if (!doc) return noContent()
    // For a scoped project, only count docs inside its folder scope so a forged
    // beacon can't attribute an out-of-scope doc to the project. Mirrors the
    // doc page's isDocInScope gate (workspace-level docs are never in scope).
    if (scope !== null) {
      const folderId = (doc as { folder_id: string | null }).folder_id
      if (!folderId) return noContent()
      if (!(await isFolderInScope(workspace.id, folderId, scope))) {
        return noContent()
      }
    }
    docId = documentId
  }

  logPortalEvent({
    workspaceId: workspace.id,
    experienceId,
    eventType: type,
    visitorId: portalVisitorId(ip, ua, workspace.id),
    documentId: docId,
    path: path ?? null,
    queryText: type === "search" ? query ?? null : null,
    resultCount: type === "search" ? resultCount ?? null : null,
    referrerHost,
  })

  return noContent()
}
