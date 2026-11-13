import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { makeDocumentPreview } from "@/lib/document-preview"

export const dynamic = "force-dynamic"

const HOME_DOCUMENT_LIMIT = 12

/** Returns a bounded, excerpt-only document feed for the Documents home. */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)

  if (!user) return authResponse

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 })
  }

  const { data, error, count } = await supabase
    .from("documents")
    .select(
      "id, title, content, source, status, author, folder_id, updated_at",
      { count: "exact" },
    )
    .eq("workspace_id", workspace.workspace_id)
    .is("deleted_at", null)
    // Unfiled GitHub rows are repository context for search/agents, not
    // curated pages for the human Documents home. A folder assignment is the
    // explicit promotion mechanism.
    .or("folder_id.not.is.null,source.is.null,source.neq.GitHub")
    .order("updated_at", { ascending: false })
    .limit(HOME_DOCUMENT_LIMIT)

  if (error) {
    console.error("[Breezify] Failed to fetch document home feed:", error.message)
    return NextResponse.json(
      { error: "Failed to fetch documents" },
      { status: 500 },
    )
  }

  return NextResponse.json({
    documents: (data ?? []).map(({ content, ...document }) => ({
      ...document,
      preview: makeDocumentPreview(content ?? ""),
    })),
    total: count ?? data?.length ?? 0,
  })
}
