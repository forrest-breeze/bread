import { randomBytes } from "crypto";
import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeWorkspaceSettings } from "@/lib/workspace-settings";
import { validateHandle, handleErrorMessage } from "@/lib/public-kb-handle";
import { getPortalEntitlementsForWorkspace } from "@/lib/db/subscription";
import { isTransientSupabaseError } from "@/lib/supabase/transient-error";
import { safeJsonBody } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { PUBLIC_KB_CACHE_TAG } from "@/lib/public-kb";

const putBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  default_slack_channel: z.string().max(120).nullable().optional(),
  icon_url: z.string().max(2048).nullable().optional(),
  // Editable workspace identifier — keys the /p/<slug> portal URL. Required
  // (unlike handle, it can't be cleared); format + reserved-word checks run via
  // validateHandle below. Changing it breaks links to the old slug.
  slug: z.string().max(63).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

// Workspace-switch query param. Bad shape silently falls through to the
// default workspace lookup (preserves the original silent-coerce behavior).
const switchIdSchema = z.string().uuid();

export function generateInviteCode(length: number = 8): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export function generateSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Re-export for backwards compat — prefer getActiveWorkspace for new code.
async function getUserWorkspace(supabase: Awaited<ReturnType<typeof createClient>>, userId: string) {
  const { getActiveWorkspace } = await import("@/lib/db/workspace");
  return getActiveWorkspace(supabase, userId);
}

async function getWorkspace(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  // Support workspace switching via query param or cookie. Validate both
  // values against the uuid shape; a malformed value silently falls through
  // to the default workspace lookup rather than 400-ing — preserves the
  // pre-rollout behavior where a stale cookie didn't break the page.
  const rawSwitchId =
    request.nextUrl.searchParams.get("id") ??
    request.cookies.get("breezify-workspace")?.value ??
    null;
  const preferredId = rawSwitchId
    ? switchIdSchema.safeParse(rawSwitchId).data ?? null
    : null;

  if (preferredId) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .eq("workspace_id", preferredId)
      .single();

    if (membership) {
      const { data, error } = await supabase
        .from("workspaces")
        .select("*")
        .eq("id", membership.workspace_id)
        .single();

      if (!error && data) {
        // Portal feature flags. Billing is gone, so these resolve to the
        // enterprise limits; the assistant and translations additionally
        // require ANTHROPIC_API_KEY.
        const portal_entitlements = await getPortalEntitlementsForWorkspace(
          membership.workspace_id,
        );
        return NextResponse.json({
          ...data,
          user_role: membership.role,
          portal_editor_enabled: portal_entitlements.portalEditor,
          portal_ai_builder_enabled: portal_entitlements.portalAiBuilder,
          portal_assistant_enabled: portal_entitlements.portalAssistant,
          portal_translations_enabled: portal_entitlements.portalTranslations,
          portal_reporting_enabled: portal_entitlements.portalReporting,
          portal_reporting_max_days: portal_entitlements.portalReportingMaxDays,
          portal_project_limit: portal_entitlements.portalProjectLimit,
          portal_branding_removal_enabled:
            portal_entitlements.portalBrandingRemoval,
        });
      }
    }
    // Fall through to default if preferred workspace not accessible
  }

  const membership = await getUserWorkspace(supabase, user.id);

  if (!membership) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 }
    );
  }

  const { data, error } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", membership.workspace_id)
    .single();

  if (error) {
    console.error("[Breezify] Failed to fetch workspace:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch workspace" },
      { status: 500 }
    );
  }

  const portal_entitlements = await getPortalEntitlementsForWorkspace(
    membership.workspace_id,
  );
  return NextResponse.json({
    ...data,
    user_role: membership.role,
    portal_editor_enabled: portal_entitlements.portalEditor,
    portal_ai_builder_enabled: portal_entitlements.portalAiBuilder,
    portal_assistant_enabled: portal_entitlements.portalAssistant,
    portal_translations_enabled: portal_entitlements.portalTranslations,
    portal_reporting_enabled: portal_entitlements.portalReporting,
    portal_reporting_max_days: portal_entitlements.portalReportingMaxDays,
    portal_project_limit: portal_entitlements.portalProjectLimit,
    portal_branding_removal_enabled: portal_entitlements.portalBrandingRemoval,
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    return await getWorkspace(request);
  } catch (err) {
    if (isTransientSupabaseError(err)) {
      console.warn("[Breezify] Workspace lookup temporarily unavailable:", err);
      return NextResponse.json(
        { error: "Service temporarily unavailable" },
        { status: 503 },
      );
    }

    console.error("[Breezify] Failed to fetch workspace:", err);
    return NextResponse.json(
      { error: "Failed to fetch workspace" },
      { status: 500 },
    );
  }
}

// Breeze internal tool: there is exactly one workspace, created automatically
// on first sign-in (see lib/breeze-workspace.ts). Creating more is not allowed.
export async function POST(_request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;
  return NextResponse.json(
    { error: "This tool has a single Breeze workspace; creating workspaces is disabled." },
    { status: 403 },
  );
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getUserWorkspace(supabase, user.id);

  if (!membership) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 }
    );
  }

  if (membership.role !== "admin" && membership.role !== "owner") {
    return NextResponse.json(
      { error: "Only admins can update workspace settings" },
      { status: 403 }
    );
  }

  const parsed = await safeJsonBody(request, putBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.name !== undefined) updates.name = body.name;
  if (body.default_slack_channel !== undefined)
    updates.default_slack_channel = body.default_slack_channel;
  if (body.icon_url !== undefined) updates.icon_url = body.icon_url;

  // Editable workspace identifier (slug). Required: an empty/whitespace value is
  // rejected rather than treated as "clear", since the slug keys every portal
  // link. Format/reserved checks reuse validateHandle; global uniqueness is
  // enforced by the slug unique index (23505 -> 409 below).
  if (body.slug !== undefined) {
    const result = validateHandle(body.slug);
    if (result.error) {
      return NextResponse.json(
        { error: handleErrorMessage(result.error) },
        { status: 400 },
      );
    }
    if (!result.handle) {
      return NextResponse.json(
        { error: "Workspace identifier is required." },
        { status: 400 },
      );
    }
    updates.slug = result.handle;
  }

  if (body.settings !== undefined) {
    const { data: currentWorkspace, error: currentWorkspaceError } = await supabase
      .from("workspaces")
      .select("settings")
      .eq("id", membership.workspace_id)
      .single();

    if (currentWorkspaceError) {
      console.error(
        "[Breezify] Failed to load current workspace settings:",
        currentWorkspaceError.message,
      );
      return NextResponse.json(
        { error: "Failed to update workspace" },
        { status: 500 }
      );
    }

    const currentSettings = normalizeWorkspaceSettings(currentWorkspace?.settings);
    updates.settings = normalizeWorkspaceSettings({
      ...currentSettings,
      ...body.settings,
    });
  }

  const { data, error } = await supabase
    .from("workspaces")
    .update(updates)
    .eq("id", membership.workspace_id)
    .select()
    .single();

  if (error) {
    // Unique-violation on the handle or slug index: that identifier is taken.
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "That identifier is already taken. Pick another." },
        { status: 409 },
      );
    }
    console.error("[Breezify] Failed to update workspace:", error.message);
    return NextResponse.json(
      { error: "Failed to update workspace" },
      { status: 500 }
    );
  }

  // The public portal caches the workspace row (including settings.kb_public,
  // branding, slug, name, and icon) for up to a minute. Invalidate that read
  // immediately after any workspace update so visibility changes and other
  // portal-facing settings take effect on the very next request.
  revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 });

  const portal_entitlements = await getPortalEntitlementsForWorkspace(
    membership.workspace_id,
  );
  return NextResponse.json({
    ...data,
    user_role: membership.role,
    portal_editor_enabled: portal_entitlements.portalEditor,
    portal_ai_builder_enabled: portal_entitlements.portalAiBuilder,
    portal_assistant_enabled: portal_entitlements.portalAssistant,
    portal_translations_enabled: portal_entitlements.portalTranslations,
    portal_reporting_enabled: portal_entitlements.portalReporting,
    portal_reporting_max_days: portal_entitlements.portalReportingMaxDays,
    portal_project_limit: portal_entitlements.portalProjectLimit,
    portal_branding_removal_enabled: portal_entitlements.portalBrandingRemoval,
  });
}

export async function DELETE(): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getUserWorkspace(supabase, user.id);

  if (!membership) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 }
    );
  }

  if (membership.role !== "owner") {
    return NextResponse.json(
      { error: "Only the workspace owner can delete a workspace" },
      { status: 403 }
    );
  }

  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("workspaces")
      .delete()
      .eq("id", membership.workspace_id);

    if (error) {
      console.error("[Breezify] Failed to delete workspace:", error.message);
      return NextResponse.json(
        { error: "Failed to delete workspace" },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Breezify] Failed to delete workspace:", err);
    return NextResponse.json(
      { error: "Failed to delete workspace" },
      { status: 500 }
    );
  }
}
