import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyCronBearer } from "@/lib/api/cron-auth";
import { cleanupOrphanedMedia } from "@/lib/storage/media-gc";
import { safeSearchParams } from "@/lib/validation";

// ---------------------------------------------------------------------------
// POST /api/cron/media-gc
//
// Daily garbage collection of orphaned S3 media. A cron heartbeat (the
// .github/workflows/cron-kb-media-gc.yml GitHub Action) POSTs here with
// `Authorization: Bearer ${CRON_SECRET}`; the work runs in-process via
// cleanupOrphanedMedia — no internal HTTP hops.
//
// An asset is reaped only when no live document body references it AND it isn't
// pinned to a still-living capture, after a grace period (see media-gc.ts). The
// selector is conservative: ambiguity always keeps the row.
//
// Pass `?dryRun=1` to compute and log the would-delete count without touching
// S3 or the table. Auth is the shared CRON_SECRET, verified constant-time via
// verifyCronBearer (same secret as /api/cron/ingest-all).
//
// Reads no request body — intentionally exempt from check-route-validation.mjs.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
// Honored on Vercel (300s is the Hobby ceiling).
export const maxDuration = 300;

const querySchema = z
  .object({
    dryRun: z.enum(["0", "1"]).optional().default("0"),
  })
  .strict();

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[Bread] CRON_SECRET not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (!verifyCronBearer(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsedQuery = safeSearchParams(req.nextUrl, querySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const dryRun = parsedQuery.data.dryRun === "1";

  try {
    const counts = await cleanupOrphanedMedia({ dryRun });
    return NextResponse.json({ ok: true, ...counts });
  } catch (err) {
    // Never leak internals to an unauthenticated-shaped surface.
    console.error("[Bread] /api/cron/media-gc failed:", err);
    return NextResponse.json({ error: "Cleanup failed" }, { status: 503 });
  }
}
