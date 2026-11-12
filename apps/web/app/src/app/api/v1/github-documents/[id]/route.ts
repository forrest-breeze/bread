import { type NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { authenticateBearer, type BearerAuth } from "@/lib/api/authenticate-bearer"
import { handleCorsPreflight, withCors } from "@/lib/api/cors"
import {
  checkoutGitHubDocument,
  getGitHubDocumentState,
  GitHubDocumentSyncError,
  GitHubDraftRevisionError,
  publishGitHubDocument,
  saveGitHubDocumentDraft,
} from "@/lib/github/github-document-sync"
import { safeJsonBody, safeRouteParams, uuidParamSchema } from "@/lib/validation"

export const runtime = "nodejs"

const editSchema = z.object({
  content: z.string(),
  expected_revision: z.number().int().positive().optional(),
})
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("checkout") }),
  z.object({
    action: z.literal("publish"),
    mode: z.enum(["pr", "commit"]).default("pr"),
    commit_message: z.string().max(200).optional(),
    pull_request_title: z.string().max(240).optional(),
    pull_request_body: z.string().max(20_000).optional(),
    expected_revision: z.number().int().positive().optional(),
  }),
])

export function OPTIONS(request: NextRequest): NextResponse {
  return handleCorsPreflight(request)
}

function canWrite(auth: BearerAuth): boolean {
  // This machine-editing endpoint requires a credential with an explicit
  // effective role. Browser sessions use the cookie-authenticated document
  // routes, where the current workspace membership is checked directly.
  if (auth.kind === "supabase") return false
  return (
    auth.scopes.includes("admin") &&
    (auth.role === "owner" ||
      auth.role === "admin" ||
      auth.role === "editor")
  )
}

function createdBy(auth: BearerAuth): string | null {
  return auth.kind === "api_key" ? null : auth.userId
}

function errorResponse(request: NextRequest, error: unknown): NextResponse {
  if (error instanceof GitHubDraftRevisionError) {
    return withCors(
      request,
      NextResponse.json(
        {
          error: error.message,
          code: error.code,
          current: error.current,
        },
        { status: error.status },
      ),
    )
  }
  if (error instanceof GitHubDocumentSyncError) {
    return withCors(
      request,
      NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      ),
    )
  }
  console.error("[Bread] API v1 GitHub document operation failed:", error)
  return withCors(
    request,
    NextResponse.json(
      {
        error:
          "GitHub could not complete this operation. Confirm that the GitHub App has write access.",
      },
      { status: 502 },
    ),
  )
}

async function authenticateWriter(
  request: NextRequest,
): Promise<{ auth: BearerAuth } | { response: NextResponse }> {
  const result = await authenticateBearer(request)
  if (!result.data) {
    return {
      response: withCors(
        request,
        result.error ??
          NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      ),
    }
  }
  if (!canWrite(result.data)) {
    return {
      response: withCors(
        request,
        NextResponse.json(
          { error: "An admin-scoped editor credential is required" },
          { status: 403 },
        ),
      ),
    }
  }
  return { auth: result.data }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authenticated = await authenticateWriter(request)
  if ("response" in authenticated) return authenticated.response
  const parsedParams = safeRouteParams(await params, uuidParamSchema)
  if (!parsedParams.ok) return withCors(request, parsedParams.response)
  try {
    const state = await getGitHubDocumentState(
      authenticated.auth.workspaceId,
      parsedParams.data.id,
    )
    return withCors(request, NextResponse.json(state))
  } catch (error) {
    return errorResponse(request, error)
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authenticated = await authenticateWriter(request)
  if ("response" in authenticated) return authenticated.response
  const parsedParams = safeRouteParams(await params, uuidParamSchema)
  if (!parsedParams.ok) return withCors(request, parsedParams.response)
  const parsed = await safeJsonBody(request, editSchema)
  if (!parsed.ok) return withCors(request, parsed.response)
  try {
    const session = await saveGitHubDocumentDraft(
      authenticated.auth.workspaceId,
      parsedParams.data.id,
      {
        content: parsed.data.content,
        createdBy: createdBy(authenticated.auth),
        expectedRevision: parsed.data.expected_revision,
      },
    )
    return withCors(request, NextResponse.json({ session }))
  } catch (error) {
    return errorResponse(request, error)
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authenticated = await authenticateWriter(request)
  if ("response" in authenticated) return authenticated.response
  const parsedParams = safeRouteParams(await params, uuidParamSchema)
  if (!parsedParams.ok) return withCors(request, parsedParams.response)
  const parsed = await safeJsonBody(request, actionSchema)
  if (!parsed.ok) return withCors(request, parsed.response)
  try {
    if (parsed.data.action === "checkout") {
      const session = await checkoutGitHubDocument(
        authenticated.auth.workspaceId,
        parsedParams.data.id,
        createdBy(authenticated.auth),
      )
      const state = await getGitHubDocumentState(
        authenticated.auth.workspaceId,
        parsedParams.data.id,
      )
      return withCors(request, NextResponse.json({ session, state }))
    }

    const published = await publishGitHubDocument(
      authenticated.auth.workspaceId,
      parsedParams.data.id,
      {
        mode: parsed.data.mode,
        message: parsed.data.commit_message,
        prTitle: parsed.data.pull_request_title,
        prBody: parsed.data.pull_request_body,
        expectedRevision: parsed.data.expected_revision,
      },
    )
    return withCors(
      request,
      NextResponse.json(published, { status: published.ok ? 200 : 409 }),
    )
  } catch (error) {
    return errorResponse(request, error)
  }
}
