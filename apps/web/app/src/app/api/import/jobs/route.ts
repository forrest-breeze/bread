import { type NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeJsonBody } from "@/lib/validation";
import { CreateJobSchema } from "@/lib/import/schemas";
import { runImportJob } from "@/lib/import/runner";
import { requireRouteUser } from "@/lib/auth/route-auth";

// ---------------------------------------------------------------------------
// GET  /api/import/jobs — list workspace jobs (members)
// POST /api/import/jobs — create + kick off (admins only)
// ---------------------------------------------------------------------------

async function requireAdmin(): Promise<{
  userId: string;
  workspaceId: string;
} | { error: NextResponse }> {
  const supabase = await createClient();
  // Propagate the helper's response as-is: it distinguishes a real
  // no-session 401 from a transient auth-infrastructure 503, and collapsing
  // the latter into a 401 would make clients treat a blip as a logged-out
  // session.
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) {
    return { error: authResponse };
  }
  const ws = await getActiveWorkspace(supabase, user.id);
  if (!ws) {
    return {
      error: NextResponse.json({ error: "No workspace" }, { status: 401 }),
    };
  }
  if (ws.role !== "admin" && ws.role !== "owner") {
    return {
      error: NextResponse.json({ error: "Admin only" }, { status: 403 }),
    };
  }
  return { userId: user.id, workspaceId: ws.workspace_id };
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;
  const ws = await getActiveWorkspace(supabase, user.id);
  if (!ws) return NextResponse.json({ error: "No workspace" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("import_jobs")
    .select(
      "id, source, status, total_items, processed_items, succeeded_items, failed_items, skipped_items, error_message, started_by, started_at, completed_at, created_at",
    )
    .eq("workspace_id", ws.workspace_id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[Breezify] GET /api/import/jobs:", error.message);
    return NextResponse.json({ error: "Service unavailable" }, { status: 500 });
  }
  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const parsed = await safeJsonBody(req, CreateJobSchema);
  if (!parsed.ok) return parsed.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("import_jobs")
    .insert({
      workspace_id: auth.workspaceId,
      source: parsed.data.source,
      source_config: parsed.data.source_config,
      started_by: auth.userId,
      status: "pending",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[Breezify] POST /api/import/jobs insert:", error?.message);
    return NextResponse.json({ error: "Failed to create job" }, { status: 500 });
  }

  const jobId = (data as { id: string }).id;
  after(async () => {
    try {
      await runImportJob(jobId);
    } catch (err) {
      console.error("[Breezify] import runner crashed:", jobId, err);
    }
  });

  return NextResponse.json({ ok: true, job_id: jobId }, { status: 201 });
}
