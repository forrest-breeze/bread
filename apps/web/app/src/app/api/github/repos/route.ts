import { type NextRequest, NextResponse, after } from 'next/server'
import { requireRouteUser } from "@/lib/auth/route-auth"
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { getInstallationToken } from '@/lib/github/github'
import { syncGitHubRepository } from '@/lib/github/github-repo-ingest'
import { withGitHubRetry } from '@/lib/github/retry'
import { deactivateGitHubRepositoryIndex } from '@/lib/github/github-repo-cleanup'
import { safeJsonBody, safeSearchParams } from '@/lib/validation'
import type { MonitoredRepoRow } from '@bread/core'

const postBodySchema = z.object({
  repo_full_name: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[^/]+\/[^/]+$/, 'repo_full_name must be in "owner/repo" format'),
})

const deleteQuerySchema = z.object({
  repo_id: z.coerce.number().int().positive(),
})

const patchBodySchema = z.object({
  repo_id: z.number().int().positive(),
  action: z.enum(['cancel_indexing', 'resume_indexing']),
})

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

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
// GET /api/github/repos
// Lists all monitored repos for the caller's workspace.
// ---------------------------------------------------------------------------

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  try {
    const { data, error } = await admin
      .from('monitored_repos')
      .select('*')
      .eq('workspace_id', auth.workspaceId)
      .order('created_at', { ascending: false })

    if (error) throw error

    return NextResponse.json({ repos: (data ?? []) as MonitoredRepoRow[] })
  } catch (err) {
    console.error('[Bread] GET /api/github/repos failed:', err)
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 500 },
    )
  }
}

// ---------------------------------------------------------------------------
// POST /api/github/repos
// Adds a repository to monitored_repos for the caller's workspace.
// Body: { repo_full_name }
// The repo_id is resolved automatically from the GitHub API.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  const parsed = await safeJsonBody(request, postBodySchema)
  if (!parsed.ok) return parsed.response
  const { repo_full_name } = parsed.data

  const admin = createAdminClient()

  try {
    // Resolve installation_id from the workspace's GitHub integration
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

    // Resolve repo_id from the GitHub API. getInstallationToken wrapped
    // in withGitHubRetry handles transient 5xx on the token endpoint; the
    // repos lookup below already bails with a specific error on !ghRes.ok.
    const token = await withGitHubRetry(() =>
      getInstallationToken(integration.installation_id),
    )
    const ghRes = await fetch(
      `https://api.github.com/repos/${repo_full_name}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )

    if (!ghRes.ok) {
      if (ghRes.status === 404) {
        return NextResponse.json(
          { error: `Repository "${repo_full_name}" not found or not accessible by this GitHub App installation` },
          { status: 404 },
        )
      }
      throw new Error(`GitHub API responded ${ghRes.status}`)
    }

    const ghRepo = (await ghRes.json()) as { id: number; default_branch: string }

    const { data, error } = await admin
      .from('monitored_repos')
      .insert({
        workspace_id: auth.workspaceId,
        installation_id: integration.installation_id,
        repo_full_name,
        repo_id: ghRepo.id,
        created_by: auth.userId,
      })
      .select('*')
      .single()

    if (error || !data) throw error ?? new Error('No data returned')

    // Begin indexing the default branch immediately. This is self-healing
    // through the hourly GitHub sweep, so a serverless interruption only
    // delays the remaining work.
    after(async () => {
      try {
        await syncGitHubRepository({
          workspaceId: auth.workspaceId,
          installationId: integration.installation_id,
          repoFullName: repo_full_name,
          repoId: ghRepo.id,
          ref: ghRepo.default_branch,
        })
      } catch (err) {
        console.error('[Bread] GitHub repo backfill failed:', err)
      }
    })

    return NextResponse.json({ repo: data as MonitoredRepoRow })
  } catch (err) {
    console.error('[Bread] POST /api/github/repos failed:', err)
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 500 },
    )
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/github/repos
// Stops or resumes source-file indexing without disabling PR capture.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = await safeJsonBody(request, patchBodySchema)
  if (!parsed.ok) return parsed.response
  const resume = parsed.data.action === 'resume_indexing'
  if (resume && !(await isWorkspaceOnPaidTier(auth.workspaceId))) {
    return NextResponse.json(
      { error: 'Integrations require a paid plan.' },
      { status: 402 },
    )
  }

  const admin = createAdminClient()
  try {
    const { data, error } = await admin
      .from('monitored_repos')
      .update({
        file_indexing_enabled: resume,
        file_sync_status: resume ? 'pending' : 'cancelled',
        failed_file_count: 0,
        last_file_sync_error: null,
      })
      .eq('workspace_id', auth.workspaceId)
      .eq('repo_id', parsed.data.repo_id)
      .select('*')
      .maybeSingle()

    if (error) throw error
    if (!data) {
      return NextResponse.json({ error: 'Repository monitor not found.' }, { status: 404 })
    }

    const repo = data as MonitoredRepoRow
    if (resume) {
      after(async () => {
        try {
          await syncGitHubRepository({
            workspaceId: repo.workspace_id,
            installationId: repo.installation_id,
            repoFullName: repo.repo_full_name,
            repoId: repo.repo_id,
          })
        } catch (err) {
          console.error('[Bread] GitHub repo resume failed:', err)
        }
      })
    }

    return NextResponse.json({ repo })
  } catch (err) {
    console.error('[Bread] PATCH /api/github/repos failed:', err)
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 500 },
    )
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/github/repos?repo_id=<number>
// Removes a repository from monitored_repos for the caller's workspace.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsedQuery = safeSearchParams(request.nextUrl, deleteQuerySchema)
  if (!parsedQuery.ok) return parsedQuery.response
  const { repo_id: repoId } = parsedQuery.data

  const admin = createAdminClient()

  try {
    // Repository-file documents are a generated search corpus, not user pages.
    // Deactivate them before removing the monitor so a disconnected repo does
    // not leave hundreds of hidden, searchable document rows behind.
    await deactivateGitHubRepositoryIndex(admin, auth.workspaceId, repoId)

    const { error } = await admin
      .from('monitored_repos')
      .delete()
      .eq('workspace_id', auth.workspaceId)
      .eq('repo_id', repoId)

    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[Bread] DELETE /api/github/repos failed:', err)
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 500 },
    )
  }
}
