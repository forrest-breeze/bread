/**
 * Tests for recordWebhookDelivery — the idempotency gate for inbound
 * GitHub + Slack webhooks. Backed by the webhook_deliveries table with
 * composite PK (source, event_id) and INSERT ... ON CONFLICT DO NOTHING.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(),
}))

import { recordWebhookDelivery } from './webhook-dedup'
import { createAdminClient } from '@/lib/supabase/admin'

function mockInsert(result: { count: number | null; error: unknown | null }) {
  const insert = vi.fn().mockResolvedValue(result)
  const from = vi.fn(() => ({ insert }))
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<
    typeof createAdminClient
  >)
  return { from, insert }
}

beforeEach(() => vi.clearAllMocks())

describe('recordWebhookDelivery', () => {
  it('returns { isNew: true } when the row is inserted for the first time', async () => {
    const { from, insert } = mockInsert({ count: 1, error: null })
    const out = await recordWebhookDelivery('github', 'evt-123')

    expect(from).toHaveBeenCalledWith('webhook_deliveries')
    expect(insert).toHaveBeenCalledWith(
      { source: 'github', event_id: 'evt-123' },
      { count: 'exact' },
    )
    expect(out.isNew).toBe(true)
  })

  it('returns { isNew: false } when the row already exists (no-op on conflict)', async () => {
    mockInsert({ count: 0, error: null })
    expect((await recordWebhookDelivery('github', 'evt-123')).isNew).toBe(false)
  })

  it('treats 23505 (unique violation) as duplicate', async () => {
    mockInsert({ count: null, error: { code: '23505' } })
    expect((await recordWebhookDelivery('slack', 'evt-x')).isNew).toBe(false)
  })

  it('fails open on unexpected DB errors so webhook processing is not blocked', async () => {
    mockInsert({ count: null, error: { code: 'PGRST500', message: 'boom' } })
    // fail-open: return isNew=true so the handler still processes the event.
    // The alternative (fail-closed) would turn transient DB blips into
    // permanent event loss.
    const out = await recordWebhookDelivery('github', 'evt-123')
    expect(out.isNew).toBe(true)
    expect(out.error).toBeDefined()
  })



  it('rejects empty event_id (prevents accidentally dedup-ing every event)', async () => {
    const { insert } = mockInsert({ count: 1, error: null })
    const out = await recordWebhookDelivery('github', '')
    expect(out.isNew).toBe(true)
    expect(out.error).toMatch(/event_id/i)
    expect(insert).not.toHaveBeenCalled()
  })
})
