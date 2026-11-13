import { type NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { verifyGitHubSignature } from '@/lib/github/github'
import {
  extractRepositoryPushInfo,
  handleRepositoryPush,
} from '@/lib/github/github-repo-ingest'
import {
  extractGitHubDocsCheckInfo,
  handleGitHubDocsCheck,
} from '@/lib/github/github-docs-check'
import { getTokenCache } from '@/lib/github/token-cache-factory'
import { markGitHubDocumentPullRequestState } from '@/lib/github/github-document-sync'
import { recordWebhookDelivery } from '@/lib/api/webhook-dedup'
import { assertWebhookSecrets } from '@/lib/env/webhook-secrets'
import {
  extractHostedBranchPush,
  handleHostedBranchPush,
} from '@/lib/github/readme/readme-webhook'

// ---------------------------------------------------------------------------
// Runtime: Node.js required for crypto HMAC operations
// ---------------------------------------------------------------------------
export const runtime = 'nodejs'

function logWebhookFailure(message: string, error: unknown): void {
  const status = (error as { status?: unknown })?.status
  console.error(message, {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(typeof status === 'number' ? { status } : {}),
  })
}

// ---------------------------------------------------------------------------
// POST /api/github/webhook
//
// Receives GitHub webhook events, verifies the signature, and dispatches
// repository and App-owned check events via after() for non-blocking processing.
//
// Returns 200 OK immediately for all valid requests. Heavy work (API calls,
// document ingestion) runs asynchronously after the response streams.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Read raw body — must be untouched for signature verification
  const rawBody = await request.text()

  // 2. Fail-fast on missing GITHUB_WEBHOOK_SECRET before any further work
  const check = assertWebhookSecrets('github')
  if (!check.ok) return check.response
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET as string

  // 3. Verify HMAC-SHA256 signature
  const signatureHeader = request.headers.get('x-hub-signature-256') ?? ''
  if (!verifyGitHubSignature(rawBody, signatureHeader, webhookSecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // 4. Parse body (safe now — signature verified)
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // 5. Extract repository-push, App-check, or permission activity.
  const eventType = request.headers.get('x-github-event') ?? ''
  const pushInfo = extractRepositoryPushInfo(eventType, payload)
  const docsCheckInfo = extractGitHubDocsCheckInfo(eventType, payload)
  // A ReadMe-format docs link can follow a branch other than the default.
  const branchPushInfo = pushInfo ? null : extractHostedBranchPush(eventType, payload)
  const installationTokenScopeChanged =
    (eventType === 'installation' &&
      payload.action === 'new_permissions_accepted') ||
    (eventType === 'installation_repositories' &&
      (payload.action === 'added' || payload.action === 'removed'))
  const tokenScopeInstallationId =
    installationTokenScopeChanged &&
    typeof (payload.installation as { id?: unknown } | undefined)?.id === 'number' &&
    ((payload.installation as { id: number }).id > 0)
      ? (payload.installation as { id: number }).id
      : null

  if (
    eventType !== 'pull_request' &&
    !pushInfo &&
    !branchPushInfo &&
    !docsCheckInfo &&
    !tokenScopeInstallationId
  ) {
    // Not an event we care about — acknowledge and exit.
    return NextResponse.json({ ok: true })
  }

  // 6. Idempotency gate — GitHub retries with the same X-GitHub-Delivery UUID
  //    on non-2xx responses. First delivery runs the handler; retries are
  //    acknowledged but skipped.
  const deliveryId = request.headers.get('x-github-delivery') ?? ''
  if (deliveryId) {
    const dedup = await recordWebhookDelivery('github', deliveryId)
    if (dedup.error) {
      console.error('[Breezify] GitHub webhook dedup error:', dedup.error)
    }
    if (!dedup.isNew) {
      return NextResponse.json({ ok: true, duplicate: true })
    }
  }

  // 7. Return 200 immediately; dispatch heavy work after the response.
  after(async () => {
    // Start the check immediately. If another handler on the same delivery is
    // slow, it must not consume the serverless window before the required
    // status is created and completed.
    const docsCheckTask = docsCheckInfo
      ? handleGitHubDocsCheck(docsCheckInfo).catch((err) => {
          // Attach the rejection handler immediately. Another handler may still
          // be running when the check fails, and a late catch would leave a
          // rejected background promise temporarily unhandled.
          logWebhookFailure('[Breezify] GitHub docs check handler failed:', err)
        })
      : Promise.resolve()

    try {
      if (tokenScopeInstallationId) {
        // Tokens minted before a permission or selected-repository change
        // retain the old scope until expiry. Drop local and shared copies as
        // soon as GitHub confirms the installation change.
        await getTokenCache().clear(tokenScopeInstallationId)
      }
      if (eventType === 'pull_request') {
        await markGitHubDocumentPullRequestState(payload)
      }
      if (pushInfo) await handleRepositoryPush(pushInfo)
      if (branchPushInfo) await handleHostedBranchPush(branchPushInfo)
    } catch (err) {
      logWebhookFailure('[Breezify] GitHub webhook handler failed:', err)
    }

    await docsCheckTask
  })

  return NextResponse.json({ ok: true })
}
