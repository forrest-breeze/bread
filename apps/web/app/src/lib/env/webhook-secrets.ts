import { NextResponse } from 'next/server'

type Provider = 'github' | 'slack' | 'instagram'

const REQUIRED_SECRETS: Record<Provider, readonly string[]> = {
  github: ['GITHUB_WEBHOOK_SECRET'],
  slack: ['SLACK_SIGNING_SECRET'],
  // Both are required before the webhook can be registered with Meta: the
  // verify token answers the subscription handshake, the app secret proves
  // every subsequent delivery came from Meta.
  instagram: ['INSTAGRAM_APP_SECRET', 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN'],
} as const

const loggedMisconfigs: Set<string> = new Set()

export interface AssertOk {
  ok: true
}

export interface AssertFailure {
  ok: false
  response: NextResponse
}

export function assertWebhookSecrets(
  provider: Provider,
): AssertOk | AssertFailure {
  const missing: string[] = []
  for (const name of REQUIRED_SECRETS[provider]) {
    const value = process.env[name]
    if (!value || value.length === 0) {
      missing.push(name)
    }
  }

  if (missing.length === 0) {
    return { ok: true }
  }

  for (const name of missing) {
    const key = `${provider}:${name}`
    if (!loggedMisconfigs.has(key)) {
      loggedMisconfigs.add(key)
      console.error(
        `[Bread] webhook-secrets: provider=${provider} missing=${name}`,
      )
    }
  }

  return {
    ok: false,
    response: NextResponse.json(
      { error: 'Server misconfigured: webhook secret missing' },
      { status: 500 },
    ),
  }
}

export function __resetLoggedMisconfigsForTest(): void {
  loggedMisconfigs.clear()
}
