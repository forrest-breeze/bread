import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeRouteParams } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const params = await context.params;
  const parsed = safeRouteParams(params, ParamsSchema);
  if (!parsed.ok) return parsed.response;

  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;
  const ws = await getActiveWorkspace(supabase, user.id);
  if (!ws) return NextResponse.json({ error: "No workspace" }, { status: 401 });

  const admin = createAdminClient();
  const { data: job, error } = await admin
    .from("import_jobs")
    .select("*")
    .eq("id", parsed.data.id)
    .eq("workspace_id", ws.workspace_id)
    .maybeSingle();

  if (error) {
    console.error("[Bread] GET /api/import/jobs/[id]:", error.message);
    return NextResponse.json({ error: "Service unavailable" }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: items } = await admin
    .from("import_job_items")
    .select("id, source_ref, title, status, document_id, error_message, processed_at")
    .eq("job_id", parsed.data.id)
    .order("processed_at", { ascending: false })
    .limit(200);

  // Strip credentials from source_config before returning (defense-in-depth;
  // scrubSensitiveConfig in the runner already nulls them post-completion).
  const cfg = (job as { source_config: Record<string, unknown> }).source_config ?? {};
  const safeCfg = { ...cfg };
  delete safeCfg.access_token;
  delete safeCfg.api_token;

  return NextResponse.json({
    job: { ...job, source_config: safeCfg },
    items: items ?? [],
  });
}
