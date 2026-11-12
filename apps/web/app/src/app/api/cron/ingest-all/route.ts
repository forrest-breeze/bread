import { type NextRequest, NextResponse } from "next/server";
import { verifyCronBearer } from "@/lib/api/cron-auth";
import { runGitHubSweep } from "@/lib/github/run-sweep";

// ---------------------------------------------------------------------------
// POST /api/cron/ingest-all
//
// The scheduled GitHub sync. A cron heartbeat (the
// .github/workflows/cron-kb-ingest.yml GitHub Action, hourly) POSTs here with
// `Authorization: Bearer ${CRON_SECRET}`. It runs the GitHub sweep in-process:
// refresh GitHub-hosted docs links and advance repository indexing, plan-gated
// to Business/Enterprise workspaces in the cron path. It is the fallback for
// missed push webhooks.
//
// Auth is the shared CRON_SECRET (also used by /api/github/sweep), verified
// constant-time via verifyCronBearer.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
// Honored on Vercel (300s is the Hobby ceiling). The per-source
// SOURCE_DEADLINE_MS below still bounds each source independently.
export const maxDuration = 300;

/** A source's payload, or an `{ error }` marker when it threw — never both. */
type SourceResult<T> = T | { error: string };

// Per-source wall-clock budget. The route buffers one response and emits zero
// bytes until Promise.all resolves, so a proxy idle-read timeout or the
// function cap can kill it (this limit dates from Netlify's short synchronous
// cap and is kept as a conservative bound). Capping each source guarantees the
// response always returns in time, turning a tick that would 502 into a 200
// that simply reports the slow source as errored. A deadline-tripped source is
// retried next tick (cursors only advance after a fully caught-up run). The
// per-call AbortSignal timeouts inside each worker keep a hung socket from
// lingering; this is the outer backstop so no worker can wedge the whole fan-out.
const SOURCE_DEADLINE_MS = 20_000;

// Each source is wrapped so one failure never aborts the others. settle() never
// rejects, so the outer Promise.all always resolves with all six results.
async function settle<T>(label: string, work: Promise<T>): Promise<SourceResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`deadline exceeded after ${SOURCE_DEADLINE_MS}ms`)),
        SOURCE_DEADLINE_MS,
      );
    });
    // Promise.race attaches a reaction to `work`, so a late rejection from an
    // orphaned (deadline-lost) worker is still observed — no unhandled rejection.
    return await Promise.race([work, deadline]);
  } catch (err) {
    console.error(`[Bread] /api/cron/ingest-all ${label}:`, err);
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[Bread] CRON_SECRET not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (!verifyCronBearer(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const github = await settle("github", runGitHubSweep());

  return NextResponse.json({
    ok: true,
    results: { github },
  });
}
