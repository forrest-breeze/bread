import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { getActiveWorkspace } from "@/lib/db/workspace"

export const runtime = "nodejs"

export interface OpenApiSourceListItem {
  slug: string
  title: string
  version: string | null
  operation_count: number
  root_folder_id: string | null
  last_synced_at: string
  last_synced_by: string
}

/** GET /api/openapi-sources — the active workspace's OpenAPI sources. */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response } = await requireRouteUser(supabase)
  if (!user) return response
  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) return NextResponse.json({ error: "No workspace" }, { status: 404 })

  const { data, error } = await createAdminClient()
    .from("openapi_sources")
    .select("slug, title, version, operation_count, root_folder_id, last_synced_at, last_synced_by")
    .eq("workspace_id", workspace.workspace_id)
    .order("title", { ascending: true })
  if (error) {
    console.error("[Breeze] openapi sources list:", error.message)
    return NextResponse.json({ error: "Failed to load OpenAPI sources" }, { status: 500 })
  }
  return NextResponse.json({ sources: (data ?? []) as OpenApiSourceListItem[] })
}
