import { createHmac, timingSafeEqual } from 'node:crypto'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { getInstallationDetails } from '@/lib/github/github'
import { withGitHubRetry } from '@/lib/github/retry'
import { getTokenCache } from '@/lib/github/token-cache-factory'
import {
  absoluteOAuthReturnUrl,
  appendOAuthResult,
  sanitizeOAuthReturnPath,
} from '@/lib/oauth-return'

// CSRF protection lives in the HMAC-signed state below. This schema is the
// shape gate — bound installation_id to a positive integer and state to a
// reasonable length so an attacker can't blow up downstream parsing.
const querySchema = z.object({
  installation_id: z.coerce.number().int().positive().optional(),
  state: z.string().min(1).max(2048).optional(),
  error: z.string().max(100).optional(),
})

// ---------------------------------------------------------------------------
// GET /api/github/app/callback
// GitHub redirects here after a user installs or updates the App.
// Verifies the signed state, fetches installation details from GitHub,
// and upserts a row in github_integrations.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)

  const returnPath = sanitizeOAuthReturnPath(
    request.cookies.get('breezify-github-oauth-return')?.value,
    '/settings/integrations/github',
  )
  const redirectWithResult = (params: { error?: string; connected?: string }) => {
    const response = NextResponse.redirect(
      absoluteOAuthReturnUrl(request, appendOAuthResult(returnPath, params)),
    )
    response.cookies.delete('breezify-github-oauth-return')
    return response
  }

  const parsedQuery = querySchema.safeParse(Object.fromEntries(searchParams))
  if (!parsedQuery.success) {
    return redirectWithResult({ error: 'invalid_request' })
  }
  const {
    installation_id: installationId,
    state: stateParam,
    error: errorParam,
  } = parsedQuery.data

  // User denied the installation or GitHub returned an error
  if (errorParam) {
    return redirectWithResult({ error: 'access_denied' })
  }

  if (installationId === undefined || !stateParam) {
    return redirectWithResult({ error: 'invalid_request' })
  }

  // Verify and decode signed state: format is "base64url(payload).hmac_hex"
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? ''
  if (!webhookSecret) {
    return redirectWithResult({ error: 'server_misconfigured' })
  }

  let workspaceId: string
  let userId: string | null = null

  try {
    const dotIndex = stateParam.lastIndexOf('.')
    if (dotIndex === -1) throw new Error('Malformed state')

    const payload = stateParam.slice(0, dotIndex)
    const receivedSig = stateParam.slice(dotIndex + 1)
    const expectedSig = createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex')

    // Convert hex strings to binary for constant-time comparison.
    // Using 'hex' encoding ensures malformed input produces a shorter buffer
    // (caught by the length check) rather than a same-length ASCII buffer.
    const expected = Buffer.from(expectedSig, 'hex')
    const received = Buffer.from(receivedSig, 'hex')

    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error('State signature mismatch')
    }

    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf-8'),
    ) as { workspaceId?: string; userId?: string; exp?: number }

    if (!decoded.workspaceId) throw new Error('Missing workspaceId in state')
    if (decoded.exp && Date.now() > decoded.exp) throw new Error('State token expired')

    workspaceId = decoded.workspaceId
    userId = decoded.userId ?? null
  } catch {
    return redirectWithResult({ error: 'invalid_state' })
  }

  // Fetch installation account details from GitHub
  let accountLogin: string
  let accountType: string

  try {
    const installation = await withGitHubRetry(() =>
      getInstallationDetails(installationId),
    )
    accountLogin = installation.account.login
    accountType = installation.account.type
    // Reconfiguring an existing installation can change its selected
    // repositories. Tokens minted before that change keep the old repository
    // scope, so the settings page must not reuse one after GitHub redirects.
    await getTokenCache().clear(installationId)
  } catch (err) {
    console.error('[Breezify] GitHub App callback — failed to fetch installation details:', err)
    return redirectWithResult({ error: 'github_api_error' })
  }

  // Re-verify the user still has admin/owner role in this workspace.
  // The initiate route validated this, but the role may have changed
  // between initiation and callback (TOCTOU protection).
  const admin = createAdminClient()

  if (!userId) {
    return redirectWithResult({ error: 'unauthorized' })
  }

  const { data: membership } = await admin
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single()
    .overrideTypes<{ role: string }, { merge: false }>()

  if (!membership || (membership.role !== 'admin' && membership.role !== 'owner')) {
    return redirectWithResult({ error: 'unauthorized' })
  }

  // Upsert github_integrations
  try {
    const { error } = await admin.from('github_integrations').upsert(
      {
        workspace_id: workspaceId,
        installation_id: installationId,
        github_account_login: accountLogin,
        github_account_type: accountType,
        installed_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'installation_id' },
    )

    if (error) throw error
  } catch (err) {
    console.error('[Breezify] GitHub App callback upsert failed:', err)
    return redirectWithResult({ error: 'db_error' })
  }

  return redirectWithResult({ connected: '1' })
}
