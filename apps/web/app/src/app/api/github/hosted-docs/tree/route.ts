import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRouteUser } from '@/lib/auth/route-auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getActiveWorkspace } from '@/lib/db/workspace'
import {
  getInstallationToken,
  getRepository,
  getRepositoryCommit,
  getRepositoryTree,
  listInstallationRepos,
} from '@/lib/github/github'
import { withGitHubRetry } from '@/lib/github/retry'
import { safeSearchParams } from '@/lib/validation'
import type { GitHubHostedDocsTree } from '@/lib/github/types'

const querySchema = z.object({
  repo_id: z.coerce.number().int().positive(),
})

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response } = await requireRouteUser(supabase)
  if (!user) return response

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace || (workspace.role !== 'admin' && workspace.role !== 'owner')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const parsed = safeSearchParams(request.nextUrl, querySchema)
  if (!parsed.ok) return parsed.response

  const admin = createAdminClient()
  try {
    const { data: integration, error } = await admin
      .from('github_integrations')
      .select('installation_id')
      .eq('workspace_id', workspace.workspace_id)
      .maybeSingle()
    if (error) throw error
    if (!integration) {
      return NextResponse.json(
        { error: 'Connect GitHub before choosing documentation folders.' },
        { status: 409 },
      )
    }

    const installationId = Number(integration.installation_id)
    const repositories = await withGitHubRetry(() =>
      listInstallationRepos(installationId),
    )
    const repo = repositories.find((candidate) => candidate.id === parsed.data.repo_id)
    if (!repo) {
      return NextResponse.json(
        { error: 'This GitHub App installation cannot access that repository.' },
        { status: 404 },
      )
    }
    const token = await withGitHubRetry(() => getInstallationToken(installationId))
    const metadata = await withGitHubRetry(() => getRepository(token, repo.full_name))
    const commit = await withGitHubRetry(() =>
      getRepositoryCommit(token, repo.full_name, metadata.default_branch),
    )
    const tree = await withGitHubRetry(() =>
      getRepositoryTree(token, repo.full_name, commit.commit.tree.sha),
    )
    // Only surface folders that actually contain Markdown/MDX somewhere below
    // them. A repository can have thousands of source/build directories; those
    // are irrelevant to downstream docs hosting and make a picker unusable.
    const docFolders = new Set<string>()
    for (const entry of tree.tree) {
      if (entry.type !== 'blob' || !/\.(md|mdx)$/i.test(entry.path)) continue
      const parts = entry.path.split('/').slice(0, -1)
      for (let index = 1; index <= parts.length; index++) {
        docFolders.add(parts.slice(0, index).join('/'))
      }
    }
    const folders = [...docFolders]
      .sort((a, b) => {
        const depthA = a.split('/').length
        const depthB = b.split('/').length
        return depthA - depthB || a.localeCompare(b)
      })

    const body: GitHubHostedDocsTree = {
      repoId: repo.id,
      repoFullName: repo.full_name,
      ref: metadata.default_branch,
      commitSha: commit.sha,
      truncated: tree.truncated,
      folders,
    }
    return NextResponse.json(body)
  } catch (err) {
    console.error('[Bread] GET /api/github/hosted-docs/tree failed:', err)
    return NextResponse.json({ error: 'Could not load the repository folders.' }, { status: 502 })
  }
}
