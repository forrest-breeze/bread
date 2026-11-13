import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getActiveWorkspace } from "@/lib/db/workspace"
import {
  getGitHubDocumentRevision,
  GitHubDocumentSyncError,
  restoreGitHubDocumentRevisionToDraft,
} from "@/lib/github/github-document-sync"
import { createClient } from "@/lib/supabase/server"
import { safeRouteParams } from "@/lib/validation"

const paramsSchema = z.object({
  id: z.string().uuid(),
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
})

async function authenticate(): Promise<
  | { userId: string; workspaceId: string; role: string }
  | { response: NextResponse }
> {
  const supabase = await createClient()
  const auth = await requireRouteUser(supabase)
  if (!auth.user) return { response: auth.response }
  const workspace = await getActiveWorkspace(supabase, auth.user.id)
  if (!workspace) {
    return {
      response: NextResponse.json(
        { error: "No workspace found" },
        { status: 404 },
      ),
    }
  }
  return {
    userId: auth.user.id,
    workspaceId: workspace.workspace_id,
    role: workspace.role,
  }
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof GitHubDocumentSyncError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    )
  }
  console.error("[Breezify] GitHub revision operation failed:", error)
  return NextResponse.json(
    { error: "Could not load this GitHub revision" },
    { status: 502 },
  )
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sha: string }> },
): Promise<NextResponse> {
  const auth = await authenticate()
  if ("response" in auth) return auth.response
  const parsed = safeRouteParams(await params, paramsSchema)
  if (!parsed.ok) return parsed.response
  try {
    const revision = await getGitHubDocumentRevision(
      auth.workspaceId,
      parsed.data.id,
      parsed.data.sha,
    )
    return NextResponse.json(revision)
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * Reverting is additive: it copies an old Git blob into the current shared
 * draft. No Git commits or local snapshots are deleted.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sha: string }> },
): Promise<NextResponse> {
  const auth = await authenticate()
  if ("response" in auth) return auth.response
  if (!["owner", "admin", "editor"].includes(auth.role)) {
    return NextResponse.json(
      { error: "Editor access is required" },
      { status: 403 },
    )
  }
  const parsed = safeRouteParams(await params, paramsSchema)
  if (!parsed.ok) return parsed.response
  try {
    const session = await restoreGitHubDocumentRevisionToDraft(
      auth.workspaceId,
      parsed.data.id,
      parsed.data.sha,
      auth.userId,
    )
    return NextResponse.json({ session })
  } catch (error) {
    return errorResponse(error)
  }
}
