import { type NextRequest, NextResponse } from "next/server"
import { authenticateBearer, type BearerAuth } from "@/lib/api/authenticate-bearer"
import { createAdminClient } from "@/lib/supabase/admin"
import { MAX_OPENAPI_SPEC_BYTES } from "@/lib/github/github-hosted-openapi"
import {
  deleteOpenApiSource,
  OPENAPI_SOURCE_SLUG_RE,
  syncOpenApiSource,
} from "@/lib/openapi/openapi-source"
import {
  openApiSourceRepositoryPath,
  removeOpenApiSourceFromLinkedRepository,
  writeOpenApiSourceToLinkedRepository,
} from "@/lib/github/readme/readme-service"

// PUT /api/v1/openapi/<name> — publish an OpenAPI spec (replaces ReadMe's
// `rdme openapi upload`). Called from CI with a workspace API key:
//
//   curl -X PUT "$BREEZE_DOCS_URL/api/v1/openapi/payments-api" \
//     -H "Authorization: Bearer $BREEZE_DOCS_API_KEY" \
//     -H "x-breezify-workspace: breeze" \
//     -H "Content-Type: application/json" \
//     --data-binary @src/openapi/specs/latest/openapi.json
//
// The body may be JSON or YAML. When the workspace is linked to a GitHub
// repository in the ReadMe format, the spec is also committed to
// reference/<name>.json|yaml there; the response reports it under `github`.
//
// DELETE removes the spec's generated pages. Both need a key with the
// "admin" scope acting as editor or above.

export const runtime = "nodejs"
export const maxDuration = 300

function canPublish(auth: BearerAuth): boolean {
  // Machine endpoint: explicit credentials only. People use Settings instead.
  if (auth.kind === "supabase") return false
  return (
    auth.scopes.includes("admin") &&
    (auth.role === "owner" || auth.role === "admin" || auth.role === "editor")
  )
}

async function authorize(
  request: NextRequest,
  params: Promise<{ slug: string }>,
): Promise<{ workspaceId: string; slug: string } | NextResponse> {
  const { slug } = await params
  if (!OPENAPI_SOURCE_SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: "Name must be lowercase letters, digits and dashes (max 63)." },
      { status: 400 },
    )
  }
  const auth = await authenticateBearer(request)
  if (auth.error) return auth.error
  if (!auth.data || !canPublish(auth.data)) {
    return NextResponse.json(
      { error: "Requires a workspace API key with the admin scope (editor role or above)." },
      { status: 403 },
    )
  }
  return { workspaceId: auth.data.workspaceId, slug }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const authorized = await authorize(request, params)
  if (authorized instanceof NextResponse) return authorized

  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_OPENAPI_SPEC_BYTES) {
    return NextResponse.json(
      { error: `Spec exceeds the ${MAX_OPENAPI_SPEC_BYTES}-byte limit.` },
      { status: 413 },
    )
  }
  const raw = await request.text()

  try {
    const admin = createAdminClient()
    const outcome = await syncOpenApiSource(admin, {
      workspaceId: authorized.workspaceId,
      slug: authorized.slug,
      raw,
      syncedBy: "api",
    })
    if (!outcome.ok) {
      return NextResponse.json(
        { error: "Invalid OpenAPI spec.", issues: outcome.issues },
        { status: 422 },
      )
    }
    // With a ReadMe-format repository linked, the definition is also written
    // to reference/ on GitHub, as ReadMe does after `rdme openapi upload`.
    const github = await writeOpenApiSourceToLinkedRepository(
      admin,
      authorized.workspaceId,
      authorized.slug,
    )
    return NextResponse.json({ ...outcome.result, ...(github ? { github } : {}) })
  } catch (err) {
    console.error("[Breeze] OpenAPI upload failed:", err)
    return NextResponse.json({ error: "Failed to publish the spec." }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const authorized = await authorize(request, params)
  if (authorized instanceof NextResponse) return authorized
  try {
    const admin = createAdminClient()
    const repoPath = await openApiSourceRepositoryPath(
      admin,
      authorized.workspaceId,
      authorized.slug,
    )
    const result = await deleteOpenApiSource(admin, authorized)
    const github = await removeOpenApiSourceFromLinkedRepository(admin, authorized.workspaceId, {
      slug: authorized.slug,
      repoPath,
    })
    return NextResponse.json({ ...result, ...(github ? { github } : {}) })
  } catch (err) {
    console.error("[Breeze] OpenAPI source delete failed:", err)
    return NextResponse.json({ error: "Failed to remove the spec." }, { status: 500 })
  }
}
