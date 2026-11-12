import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getActiveWorkspace } from "@/lib/db/workspace"
import {
  GitHubDocumentSyncError,
  listGitHubDocumentHistory,
} from "@/lib/github/github-document-sync"
import { createClient } from "@/lib/supabase/server"
import {
  safeRouteParams,
  safeSearchParams,
  uuidParamSchema,
} from "@/lib/validation"

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient()
  const auth = await requireRouteUser(supabase)
  if (!auth.user) return auth.response
  const workspace = await getActiveWorkspace(supabase, auth.user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 })
  }
  const parsedParams = safeRouteParams(await params, uuidParamSchema)
  if (!parsedParams.ok) return parsedParams.response
  const parsedQuery = safeSearchParams(request.nextUrl, querySchema)
  if (!parsedQuery.ok) return parsedQuery.response

  try {
    const history = await listGitHubDocumentHistory(
      workspace.workspace_id,
      parsedParams.data.id,
      parsedQuery.data.page,
    )
    return NextResponse.json(history)
  } catch (error) {
    if (error instanceof GitHubDocumentSyncError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      )
    }
    console.error("[Bread] GitHub document history failed:", error)
    return NextResponse.json(
      { error: "Could not load GitHub history" },
      { status: 502 },
    )
  }
}
