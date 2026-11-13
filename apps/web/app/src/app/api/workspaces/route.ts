import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { isTransientSupabaseError } from "@/lib/supabase/transient-error";
import { resolvePortalPlanEntitlements } from "@/lib/billing/catalog";
import type { SubscriptionRow } from "@/lib/types";

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const { data: memberships, error: memError } = await supabase
    .from("workspace_members")
    .select("workspace_id, role")
    .eq("user_id", user.id);

  if (memError) {
    if (isTransientSupabaseError(memError)) {
      console.warn("[Breezify] Workspace memberships temporarily unavailable:", memError.message);
      return NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 503 },
      );
    }

    console.error("[Breezify] Failed to fetch memberships:", memError.message);
    return NextResponse.json(
      { error: "Failed to fetch memberships" },
      { status: 500 }
    );
  }

  if (!memberships?.length) {
    return NextResponse.json([]);
  }

  const workspaceIds = memberships.map((m) => m.workspace_id);

  const { data: workspaces, error } = await supabase
    .from("workspaces")
    .select("*")
    .in("id", workspaceIds);

  if (error) {
    if (isTransientSupabaseError(error)) {
      console.warn("[Breezify] Workspace list temporarily unavailable:", error.message);
      return NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 503 },
      );
    }

    console.error("[Breezify] Failed to fetch workspaces:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch workspaces" },
      { status: 500 }
    );
  }

  // One batched subscriptions read for every membership, resolved to
  // entitlements locally. The previous per-workspace
  // getPortalEntitlementsForWorkspace fan-out was an N+1 that scaled with
  // membership count — fine at 2 workspaces, a connection-pool hazard at 100.
  // A workspace with no subscription row resolves as free (same fallback the
  // single-row helper uses); the lazy free-row self-heal is skipped here since
  // a read-only list shouldn't write.
  const admin = createAdminClient();
  const { data: subscriptionRows, error: subsError } = await admin
    .from("subscriptions")
    .select("workspace_id, plan_id, tier, status")
    .in("workspace_id", workspaceIds);
  if (subsError) {
    console.error(
      "[Breezify] Failed to fetch workspace subscriptions:",
      subsError.message,
    );
  }
  const subscriptionByWorkspace = new Map(
    (
      (subscriptionRows ?? []) as Pick<
        SubscriptionRow,
        "workspace_id" | "plan_id" | "tier" | "status"
      >[]
    ).map((row) => [row.workspace_id, row]),
  );

  const result = (workspaces ?? []).map((ws) => {
    const portalEntitlements = resolvePortalPlanEntitlements(
      subscriptionByWorkspace.get(ws.id) ?? null,
    );

    return {
      ...ws,
      user_role:
        memberships.find((m) => m.workspace_id === ws.id)?.role ?? "viewer",
      portal_editor_enabled: portalEntitlements.portalEditor,
      portal_ai_builder_enabled: portalEntitlements.portalAiBuilder,
      portal_assistant_enabled: portalEntitlements.portalAssistant,
      portal_translations_enabled: portalEntitlements.portalTranslations,
      portal_reporting_enabled: portalEntitlements.portalReporting,
      portal_reporting_max_days: portalEntitlements.portalReportingMaxDays,
      portal_project_limit: portalEntitlements.portalProjectLimit,
      portal_branding_removal_enabled:
        portalEntitlements.portalBrandingRemoval,
    };
  });

  return NextResponse.json(result);
}
