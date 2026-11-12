/**
 * Tests for assertWebhookSecrets — webhook secret fail-fast helper.
 *
 * Covers plan `docs/plans/webhook-fail-fast-secrets.md` §5.1 U1–U6.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  assertWebhookSecrets,
  __resetLoggedMisconfigsForTest,
} from './webhook-secrets'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  __resetLoggedMisconfigsForTest()
})

describe('assertWebhookSecrets', () => {
  describe('github', () => {
    it('U1: returns ok when GITHUB_WEBHOOK_SECRET is set', () => {
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'whsec_github')

      const result = assertWebhookSecrets('github')

      expect(result.ok).toBe(true)
    })

    it('U2: returns 500 NextResponse when GITHUB_WEBHOOK_SECRET is empty', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')

      const result = assertWebhookSecrets('github')

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.response.status).toBe(500)
      await expect(result.response.json()).resolves.toEqual({
        error: 'Server misconfigured: webhook secret missing',
      })
    })
  })

  describe('slack', () => {
    it('U3: returns 500 when SLACK_SIGNING_SECRET is empty', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubEnv('SLACK_SIGNING_SECRET', '')

      const result = assertWebhookSecrets('slack')

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.response.status).toBe(500)
    })

    it('returns ok when SLACK_SIGNING_SECRET is set', () => {
      vi.stubEnv('SLACK_SIGNING_SECRET', 'slack-signing')

      const result = assertWebhookSecrets('slack')

      expect(result.ok).toBe(true)
    })
  })

  describe('logging', () => {
    it('U5: logs at most once per (provider, var) per cold start', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')

      assertWebhookSecrets('github')
      assertWebhookSecrets('github')

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(
        '[Bread] webhook-secrets: provider=github missing=GITHUB_WEBHOOK_SECRET',
      )
    })

    it('U6: logs once per missing var when multiple vars missing', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubEnv('INSTAGRAM_APP_SECRET', '')
      vi.stubEnv('INSTAGRAM_WEBHOOK_VERIFY_TOKEN', '')

      assertWebhookSecrets('instagram')

      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy).toHaveBeenCalledWith(
        '[Bread] webhook-secrets: provider=instagram missing=INSTAGRAM_APP_SECRET',
      )
      expect(spy).toHaveBeenCalledWith(
        '[Bread] webhook-secrets: provider=instagram missing=INSTAGRAM_WEBHOOK_VERIFY_TOKEN',
      )
    })

    it('does not log when all required secrets are present', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'whsec_github')

      assertWebhookSecrets('github')

      expect(spy).not.toHaveBeenCalled()
    })

    it('logs independently per provider', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', '')
      vi.stubEnv('SLACK_SIGNING_SECRET', '')

      assertWebhookSecrets('github')
      assertWebhookSecrets('slack')

      expect(spy).toHaveBeenCalledTimes(2)
    })
  })
})
