import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/db/workspace'
import type { GitHubIntegrationRow } from '@bread/core'

// ---------------------------------------------------------------------------
// Auth helpers — mirror the Slack integrations route.
// `requireAuth` gates reads (any workspace member may view connection status);
import { requireRouteUser } from "@/lib/auth/route-auth";
// `requireAdmin` gates mutations (only admin/owner may add or remove the app).
// ---------------------------------------------------------------------------

async function requireAuth(): Promise<{
  userId: string
  workspaceId: string
} | null> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase);

  if (!user) return null;

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) return null

  return { userId: user.id, workspaceId: workspace.workspace_id }
}

async function requireAdmin(): Promise<{
  userId: string
  workspaceId: string
} | null> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase);

  if (!user) return null;

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace || (workspace.role !== 'admin' && workspace.role !== 'owner'))
    return null

  return { userId: user.id, workspaceId: workspace.workspace_id }
}

// ---------------------------------------------------------------------------
// GET /api/github/integrations
// Returns the GitHub App integration for the caller's workspace, or null.
// Accessible to all workspace members so they can see connection status.
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  try {
    const { data, error } = await admin
      .from('github_integrations')
      .select('*')
      .eq('workspace_id', auth.workspaceId)
      .maybeSingle()

    if (error) throw error
    if (!data) return NextResponse.json({ integration: null })

    return NextResponse.json({ integration: data as GitHubIntegrationRow })
  } catch (err) {
    console.error('[Bread] GET /api/github/integrations failed:', err)
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 500 },
    )
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/github/integrations
// Removes the GitHub App integration for the caller's workspace.
// ---------------------------------------------------------------------------

export async function DELETE(_request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  try {
    const { error: sourceError } = await admin
      .from('github_hosted_docs_sources')
      .delete()
      .eq('workspace_id', auth.workspaceId)
    if (sourceError) throw sourceError

    const { error } = await admin
      .from('github_integrations')
      .delete()
      .eq('workspace_id', auth.workspaceId)

    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[Bread] DELETE /api/github/integrations failed:', err)
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 500 },
    )
  }
}
