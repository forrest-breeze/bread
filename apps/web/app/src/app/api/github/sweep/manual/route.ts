import { type NextRequest, NextResponse } from 'next/server'
import { requireRouteUser } from "@/lib/auth/route-auth"
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { runGitHubSweep } from '@/lib/github/run-sweep'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// POST /api/github/sweep/manual
// Admin-authenticated manual sweep trigger. No CRON_SECRET required.
// ---------------------------------------------------------------------------

export async function POST(_request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace || (workspace.role !== 'admin' && workspace.role !== 'owner')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!(await isWorkspaceOnPaidTier(workspace.workspace_id))) {
    return NextResponse.json(
      { error: 'Integrations are not enabled for this workspace.' },
      { status: 402 },
    )
  }

  try {
    const result = await runGitHubSweep(workspace.workspace_id)

    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 503 })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[Breezify] POST /api/github/sweep/manual failed:', err)
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 503 },
    )
  }
}
