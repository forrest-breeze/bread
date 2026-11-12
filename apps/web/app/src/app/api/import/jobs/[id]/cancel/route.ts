import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeRouteParams } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

const ParamsSchema = z.object({ id: z.string().uuid() });

export async function POST(
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
  if (ws.role !== "admin" && ws.role !== "owner") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("import_jobs")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.id)
    .eq("workspace_id", ws.workspace_id)
    .in("status", ["pending", "running"])
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[Bread] cancel import job:", error.message);
    return NextResponse.json({ error: "Cancel failed" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "Job not cancellable (already finished)" },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true });
}
