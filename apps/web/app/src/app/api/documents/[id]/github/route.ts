import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getActiveWorkspace } from "@/lib/db/workspace"
import {
  checkoutGitHubDocument,
  discardGitHubDocumentDraft,
  getGitHubDocumentState,
  GitHubDocumentSyncError,
  GitHubDraftRevisionError,
  keepGitHubDocumentDraftVersion,
  publishGitHubDocument,
  saveGitHubDocumentDraft,
  replaceDraftWithDeploymentVersion,
} from "@/lib/github/github-document-sync"
import { createClient } from "@/lib/supabase/server"
import { safeJsonBody, safeRouteParams, uuidParamSchema } from "@/lib/validation"

export const runtime = "nodejs"

const saveBodySchema = z.object({
  content: z.string(),
  expected_revision: z.number().int().positive().optional(),
})

const actionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("checkout"),
    initial_content: z.string().max(2_000_000).optional(),
  }),
  z.object({ action: z.literal("discard") }),
  z.object({ action: z.literal("use_deployment") }),
  z.object({ action: z.literal("use_draft") }),
  z.object({
    action: z.literal("publish"),
    mode: z.enum(["commit", "pr"]).default("pr"),
    message: z.string().max(200).optional(),
    pr_title: z.string().max(240).optional(),
    pr_body: z.string().max(20_000).optional(),
    expected_revision: z.number().int().positive().optional(),
  }),
])

async function authenticateMember(): Promise<
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

function requireEditor(
  auth: { userId: string; workspaceId: string; role: string },
): NextResponse | null {
  if (!["owner", "admin", "editor"].includes(auth.role)) {
    return NextResponse.json(
      { error: "Editor access is required" },
      { status: 403 },
    )
  }
  return null
}

function syncErrorResponse(error: unknown): NextResponse {
  if (error instanceof GitHubDraftRevisionError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        current: error.current,
      },
      { status: error.status },
    )
  }
  if (error instanceof GitHubDocumentSyncError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    )
  }
  console.error("[Breezify] GitHub document sync failed:", error)
  return NextResponse.json(
    {
      error:
        "GitHub could not complete this operation. Confirm that the GitHub App has Contents and Pull requests write access, then try again.",
      code: "github_operation_failed",
    },
    { status: 502 },
  )
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await authenticateMember()
  if ("response" in auth) return auth.response
  const parsedParams = safeRouteParams(await params, uuidParamSchema)
  if (!parsedParams.ok) return parsedParams.response

  try {
    const state = await getGitHubDocumentState(
      auth.workspaceId,
      parsedParams.data.id,
    )
    return NextResponse.json(state)
  } catch (error) {
    return syncErrorResponse(error)
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await authenticateMember()
  if ("response" in auth) return auth.response
  const forbidden = requireEditor(auth)
  if (forbidden) return forbidden
  const parsedParams = safeRouteParams(await params, uuidParamSchema)
  if (!parsedParams.ok) return parsedParams.response
  const parsed = await safeJsonBody(request, saveBodySchema)
  if (!parsed.ok) return parsed.response

  try {
    const session = await saveGitHubDocumentDraft(
      auth.workspaceId,
      parsedParams.data.id,
      {
        content: parsed.data.content,
        createdBy: auth.userId,
        expectedRevision: parsed.data.expected_revision,
      },
    )
    return NextResponse.json({ session })
  } catch (error) {
    return syncErrorResponse(error)
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await authenticateMember()
  if ("response" in auth) return auth.response
  const forbidden = requireEditor(auth)
  if (forbidden) return forbidden
  const parsedParams = safeRouteParams(await params, uuidParamSchema)
  if (!parsedParams.ok) return parsedParams.response
  const parsed = await safeJsonBody(request, actionBodySchema)
  if (!parsed.ok) return parsed.response

  try {
    switch (parsed.data.action) {
      case "checkout": {
        const session = await checkoutGitHubDocument(
          auth.workspaceId,
          parsedParams.data.id,
          auth.userId,
          parsed.data.initial_content,
          { rejectExistingDraft: parsed.data.initial_content !== undefined },
        )
        return NextResponse.json({ session })
      }
      case "discard": {
        await discardGitHubDocumentDraft(
          auth.workspaceId,
          parsedParams.data.id,
        )
        return NextResponse.json({ success: true })
      }
      case "use_deployment": {
        const session = await replaceDraftWithDeploymentVersion(
          auth.workspaceId,
          parsedParams.data.id,
          auth.userId,
        )
        return NextResponse.json({ session })
      }
      case "use_draft": {
        const session = await keepGitHubDocumentDraftVersion(
          auth.workspaceId,
          parsedParams.data.id,
          auth.userId,
        )
        return NextResponse.json({ session })
      }
      case "publish": {
        const result = await publishGitHubDocument(
          auth.workspaceId,
          parsedParams.data.id,
          {
            mode: parsed.data.mode,
            message: parsed.data.message,
            prTitle: parsed.data.pr_title,
            prBody: parsed.data.pr_body,
            expectedRevision: parsed.data.expected_revision,
          },
        )
        return NextResponse.json(result, { status: result.ok ? 200 : 409 })
      }
    }
  } catch (error) {
    return syncErrorResponse(error)
  }
}
