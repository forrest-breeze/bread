import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { countActiveMembers, getActiveWorkspace } from "@/lib/db/workspace";
import { getWorkspaceSubscription } from "@/lib/db/subscription";
import { requireRouteUser } from "@/lib/auth/route-auth";
import {
  PLAN_MEDIA_STORAGE_LIMIT_BYTES,
  resolveEntitlementPlanId,
} from "@/lib/billing/catalog";

export interface WorkspaceUsageResponse {
  periodStart: string | null;
  periodEnd: string | null;
  members: {
    count: number;
  };
  compute: {
    opsSuccess: number;
    opsError: number;
    opsSkip: number;
    tokensInput: number;
    tokensOutput: number;
    durationMs: number;
  };
  storage: {
    bytes: number;
    mediaBytes: number;
    mediaLimitBytes: number;
  };
}

interface UsageRow {
  workspace_id: string;
  period_start: string | null;
  period_end: string | null;
  stage: string | null;
  model: string | null;
  ops_success: number | null;
  ops_error: number | null;
  ops_skip: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  duration_ms: number | null;
}

export async function GET(): Promise<NextResponse<WorkspaceUsageResponse | { error: string }>> {
  try {
    const supabase = await createClient();
    const { user, response: authResponse } = await requireRouteUser(supabase);

    if (!user) {
      return authResponse;
    }

    const workspace = await getActiveWorkspace(supabase, user.id);
    if (!workspace) {
      return NextResponse.json({ error: "No workspace found" }, { status: 404 });
    }

    if (workspace.role !== "admin" && workspace.role !== "owner") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 },
      );
    }

    const admin = createAdminClient();

    const [
      { data: usageRows, error: usageError },
      { data: storageBytes },
      { data: mediaUsage },
      subscription,
      activeMembers,
    ] = await Promise.all([
      admin
        .from("workspace_usage_current_period")
        .select(
          "workspace_id, period_start, period_end, stage, model, ops_success, ops_error, ops_skip, tokens_input, tokens_output, duration_ms",
        )
        .eq("workspace_id", workspace.workspace_id),
      admin.rpc("workspace_storage_bytes", {
        target_workspace_id: workspace.workspace_id,
      }),
      admin
        .from("workspace_media_usage")
        .select("bytes_used")
        .eq("workspace_id", workspace.workspace_id)
        .maybeSingle(),
      getWorkspaceSubscription(workspace.workspace_id),
      countActiveMembers(workspace.workspace_id),
    ]);

    if (usageError) {
      console.error("[Bread] workspace/usage query failed:", usageError.message);
      return NextResponse.json({ error: "Failed to load usage" }, { status: 500 });
    }

    const rows = (usageRows ?? []) as UsageRow[];
    const compute = rows.reduce(
      (acc, row) => {
        acc.opsSuccess += row.ops_success ?? 0;
        acc.opsError += row.ops_error ?? 0;
        acc.opsSkip += row.ops_skip ?? 0;
        acc.tokensInput += row.tokens_input ?? 0;
        acc.tokensOutput += row.tokens_output ?? 0;
        acc.durationMs += row.duration_ms ?? 0;
        return acc;
      },
      {
        opsSuccess: 0,
        opsError: 0,
        opsSkip: 0,
        tokensInput: 0,
        tokensOutput: 0,
        durationMs: 0,
      },
    );

    const periodStart = rows[0]?.period_start ?? subscription?.current_period_start ?? null;
    const periodEnd = rows[0]?.period_end ?? subscription?.current_period_end ?? null;

    const mediaBytes =
      typeof (mediaUsage as { bytes_used?: unknown } | null)?.bytes_used ===
      "number"
        ? (mediaUsage as { bytes_used: number }).bytes_used
        : 0;
    const mediaPlanId = resolveEntitlementPlanId(subscription);

    return NextResponse.json({
      periodStart,
      periodEnd,
      members: { count: activeMembers },
      compute,
      storage: {
        bytes: typeof storageBytes === "number" ? storageBytes : 0,
        mediaBytes,
        mediaLimitBytes: PLAN_MEDIA_STORAGE_LIMIT_BYTES[mediaPlanId],
      },
    });
  } catch (error) {
    console.error("[Bread] workspace/usage handler:", error);
    return NextResponse.json({ error: "Failed to load usage" }, { status: 500 });
  }
}
