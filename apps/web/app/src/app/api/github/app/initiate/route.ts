import { createHmac } from 'node:crypto'
import { requireRouteUser } from "@/lib/auth/route-auth"
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getActiveWorkspace } from '@/lib/db/workspace'
import { isWorkspaceOnPaidTier } from '@/lib/db/subscription'
import { safeSearchParams } from '@/lib/validation'
import {
  absoluteOAuthReturnUrl,
  appendOAuthResult,
  sanitizeOAuthReturnPath,
} from '@/lib/oauth-return'

const QuerySchema = z.object({ return_to: z.string().optional() })

// ---------------------------------------------------------------------------
// GET /api/github/app/initiate
// Redirects the user to GitHub's App installation page.
// Requires the user to be an admin or owner of a paid active workspace.
//
// The state parameter is HMAC-signed so the callback route can verify it
// was issued by this server and extract the workspace + user IDs.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { user } = await requireRouteUser(supabase);

  const query = safeSearchParams(request.nextUrl, QuerySchema)
  const returnPath = sanitizeOAuthReturnPath(
    query.ok ? query.data.return_to : null,
    '/settings/integrations/github',
  )
  const getReturnUrl = (error: string): string =>
    absoluteOAuthReturnUrl(request, appendOAuthResult(returnPath, { error }))

  if (!user) {
    return NextResponse.redirect(getReturnUrl('unauthorized'))
  }

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace || (workspace.role !== 'admin' && workspace.role !== 'owner')) {
    return NextResponse.redirect(getReturnUrl('unauthorized'))
  }
  if (!(await isWorkspaceOnPaidTier(workspace.workspace_id))) {
    return NextResponse.redirect(getReturnUrl('payment_required'))
  }

  const appSlug = process.env.GITHUB_APP_SLUG
  if (!appSlug) {
    console.error('[Breezify] GitHub initiate: GITHUB_APP_SLUG is not set')
    return NextResponse.redirect(getReturnUrl('server_misconfigured'))
  }

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? ''
  if (!webhookSecret) {
    console.error('[Breezify] GitHub initiate: GITHUB_WEBHOOK_SECRET is not set')
    return NextResponse.redirect(getReturnUrl('server_misconfigured'))
  }

  // Build HMAC-signed state: base64url(payload) + "." + HMAC-SHA256(payload, secret)
  // Includes a 15-minute expiry to prevent replay attacks.
  const exp = Date.now() + 15 * 60 * 1000
  const payload = Buffer.from(
    JSON.stringify({ workspaceId: workspace.workspace_id, userId: user.id, exp }),
  ).toString('base64url')
  const sig = createHmac('sha256', webhookSecret).update(payload).digest('hex')
  const state = `${payload}.${sig}`

  const installUrl = new URL(`https://github.com/apps/${appSlug}/installations/new`)
  installUrl.searchParams.set('state', state)

  const response = NextResponse.redirect(installUrl.toString())
  response.cookies.set('breezify-github-oauth-return', returnPath, {
    httpOnly: true,
    maxAge: 15 * 60,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })
  return response
}
