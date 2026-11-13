import { type NextRequest, NextResponse } from 'next/server'
import { runGitHubSweep } from '@/lib/github/run-sweep'

export const runtime = 'nodejs'

// ---------------------------------------------------------------------------
// GET /api/github/sweep
// Cron-authenticated retry-sweep endpoint. Auth via Bearer token matching
// CRON_SECRET. On the scheduled path runGitHubSweep() is invoked in-process by
// the unified /api/cron/ingest-all fan-out; this route stays for targeted
// manual triggering (send `Authorization: Bearer ${CRON_SECRET}`).
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET ?? ''
  if (!cronSecret) {
    console.error('[Breezify] GitHub sweep: CRON_SECRET env var is not set')
    return NextResponse.json(
      { error: 'Server misconfigured' },
      { status: 500 },
    )
  }

  const authHeader = request.headers.get('authorization') ?? ''
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runGitHubSweep()

    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: 503 })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error('[Breezify] GET /api/github/sweep failed:', err)
    return NextResponse.json(
      { error: 'Service temporarily unavailable' },
      { status: 500 },
    )
  }
}
