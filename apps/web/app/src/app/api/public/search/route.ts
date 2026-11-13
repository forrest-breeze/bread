import { NextResponse } from "next/server"
import { z } from "zod"
import { headers } from "next/headers"
import { searchPublic, type PublicSearchHit } from "@/lib/public-kb"
import { resolvePortalBase } from "@/lib/public-kb-portal-base"
import { checkPublicRateLimit } from "@/lib/public-kb-ratelimit"

// ---------------------------------------------------------------------------
// Public portal search — JSON results for the in-portal command palette.
//
// AUTH EXCEPTION (CLAUDE.md §1): intentionally UNAUTHENTICATED public endpoint
// for anonymous portal visitors, analogous to `searchPublic` on the server-
// rendered results page and `/api/public/ask`. It deliberately does NOT call
// `requireRouteUser()`. Compensated by:
//   • strict input validation at the boundary (Zod),
//   • per-IP rate limiting (checkPublicRateLimit),
//   • published-workspace gating (resolvePortalBase → 404 for private),
//   • visibility scoping inside searchPublic — the SINGLE retrieval guard.
// Retrieval MUST go through searchPublic; this route never reads documents
// directly.
// ---------------------------------------------------------------------------

// Reads query params + request headers and rate-limits — never static.
export const dynamic = "force-dynamic"

const MAX_HITS = 8

const querySchema = z.object({
  // Portal base path: "<workspace>" or "<workspace>/<project>".
  portal: z.string().trim().min(1).max(140),
  q: z.string().trim().min(2).max(200),
})

export interface PublicSearchResponse {
  hits: PublicSearchHit[]
}

async function clientIp(): Promise<string> {
  const h = await headers()
  const forwarded = h.get("x-forwarded-for")
  if (forwarded) return forwarded.split(",")[0]?.trim() || "anon"
  return h.get("x-real-ip") || "anon"
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url)
  const parsed = querySchema.safeParse({
    portal: url.searchParams.get("portal") ?? "",
    q: url.searchParams.get("q") ?? "",
  })
  if (!parsed.success) {
    return NextResponse.json({ hits: [] } satisfies PublicSearchResponse)
  }
  const { portal, q } = parsed.data

  const allowed = await checkPublicRateLimit(`search:${portal}:${await clientIp()}`, 30, 60)
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many searches. Please wait a moment and try again." },
      { status: 429 },
    )
  }

  // Resolve the portal base ("<workspace>" or "<workspace>/<project>") the same
  // way the portal pages do, gated to published+public. Anything else returns
  // 404 so we never leak private content's existence.
  const resolved = await resolvePortalBase(portal)
  if (!resolved) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  const { workspace, scope } = resolved

  try {
    // Visibility-scoped retrieval — the single security guard for what an
    // anonymous visitor may see. Never bypass with the admin client.
    const hits = await searchPublic(workspace.id, q, MAX_HITS, scope)
    return NextResponse.json({ hits } satisfies PublicSearchResponse)
  } catch (err) {
    console.error("[Breezify] public search:", err)
    return NextResponse.json(
      { error: "We couldn't search right now. Please try again." },
      { status: 500 },
    )
  }
}
