import { type NextRequest, NextResponse } from 'next/server'
import { requireRouteUser } from "@/lib/auth/route-auth"
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { listInstallationRepos } from '@/lib/github/github'
import { withGitHubRetry } from '@/lib/github/retry'
import type { GitHubAvailableRepo } from '@/lib/github/types'

// ---------------------------------------------------------------------------
// GET /api/github/repos/available
//
// Lists every repository the workspace's GitHub App installation can access,
// so the settings UI can offer a dropdown instead of making admins type
// "owner/repo" (and look up numeric repo IDs). Admin/owner only, mirroring the
// rest of /api/github/repos. Read-only: it does not mutate monitored_repos.
// ---------------------------------------------------------------------------

async function requireAdmin(): Promise<{ workspaceId: string } | null> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase);

  if (!user) return null;

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace || (workspace.role !== 'admin' && workspace.role !== 'owner')) {
    return null
  }

  return { workspaceId: workspace.workspace_id }
}

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!(await isWorkspaceOnPaidTier(auth.workspaceId))) {
    return NextResponse.json(
      { error: 'Integrations require a paid plan.' },
      { status: 402 },
    )
  }

  const admin = createAdminClient()

  try {
    // Resolve the installation_id from the workspace's GitHub integration.
    const { data: integration, error: integrationError } = await admin
      .from('github_integrations')
      .select('installation_id')
      .eq('workspace_id', auth.workspaceId)
      .single()
      .overrideTypes<{ installation_id: number }, { merge: false }>()

    if (integrationError || !integration) {
      return NextResponse.json(
        { error: 'No GitHub integration found for this workspace' },
        { status: 400 },
      )
    }

    const repositories: GitHubAvailableRepo[] = await withGitHubRetry(() =>
      listInstallationRepos(integration.installation_id),
    )

    // Stable alphabetical order so the dropdown doesn't reshuffle between loads.
    repositories.sort((a, b) => a.full_name.localeCompare(b.full_name))

    return NextResponse.json({ repositories })
  } catch (err) {
    console.error('[Bread] GET /api/github/repos/available failed:', err)
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 500 },
    )
  }
}
