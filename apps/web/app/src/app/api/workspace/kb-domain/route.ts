import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { safeJsonBody } from "@/lib/validation";
import {
  getKbCustomDomain,
  normalizeWorkspaceSettings,
  validateCustomDomain,
  customDomainErrorMessage,
} from "@/lib/workspace-settings";

// ---------------------------------------------------------------------------
// Custom-domain provisioning for the public KB.
//
// PUT    { domain }  — set workspaces.settings->>'kb_custom_domain' (merge).
// DELETE             — clear it.
//
// Both gates: requireRouteUser() → getActiveWorkspace() → admin/owner role.
// The DB unique index (workspaces_kb_custom_domain_key) enforces global
// uniqueness; a collision surfaces as a Postgres 23505 → 409 here. The domain
// only serves content once the workspace KB is published (settings.kb_public).
// ---------------------------------------------------------------------------

const putBodySchema = z.object({
  // Bound the raw length here; the bare-host format, own-host, and infra-host
  // checks run via validateCustomDomain so API + UI share one source of truth.
  domain: z.string().trim().min(1).max(253),
});

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "owner";
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  try {
    const membership = await getActiveWorkspace(supabase, user.id);
    if (!membership) {
      return NextResponse.json({ error: "No workspace found" }, { status: 404 });
    }
    if (!isAdminRole(membership.role)) {
      return NextResponse.json(
        { error: "Only admins can change the custom domain" },
        { status: 403 },
      );
    }

    const parsed = await safeJsonBody(request, putBodySchema);
    if (!parsed.ok) return parsed.response;

    // Load current settings before validating: re-saving the domain the
    // workspace already holds must stay valid even when the reservation rules
    // tightened after it was saved (the dogfood workspace owns the KB apex).
    const { data: current, error: currentError } = await supabase
      .from("workspaces")
      .select("settings")
      .eq("id", membership.workspace_id)
      .single();

    if (currentError) {
      console.error(
        "[Breezify] kb-domain: failed to load current settings:",
        currentError.message,
      );
      return NextResponse.json(
        { error: "Failed to update custom domain" },
        { status: 500 },
      );
    }

    // normalizeWorkspaceSettings spreads + preserves unknown keys, so one pass
    // over the merged object keeps the rest of `settings` intact.
    const existing =
      current?.settings && typeof current.settings === "object"
        ? (current.settings as Record<string, unknown>)
        : {};

    const { domain, error: domainError } = validateCustomDomain(
      parsed.data.domain,
      getKbCustomDomain(existing),
    );
    if (domainError) {
      return NextResponse.json(
        { error: customDomainErrorMessage(domainError) },
        { status: 400 },
      );
    }
    const nextSettings = normalizeWorkspaceSettings({
      ...existing,
      kb_custom_domain: domain,
    });

    const { error } = await supabase
      .from("workspaces")
      .update({ settings: nextSettings, updated_at: new Date().toISOString() })
      .eq("id", membership.workspace_id);

    if (error) {
      // Unique-violation on workspaces_kb_custom_domain_key: another workspace
      // already claimed this domain.
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "That domain is already in use by another workspace." },
          { status: 409 },
        );
      }
      console.error("[Breezify] kb-domain: update failed:", error.message);
      return NextResponse.json(
        { error: "Failed to update custom domain" },
        { status: 500 },
      );
    }

    return NextResponse.json({ kb_custom_domain: domain });
  } catch (err) {
    console.error("[Breezify] kb-domain:", err);
    return NextResponse.json(
      { error: "Failed to update custom domain" },
      { status: 500 },
    );
  }
}

export async function DELETE(): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  try {
    const membership = await getActiveWorkspace(supabase, user.id);
    if (!membership) {
      return NextResponse.json({ error: "No workspace found" }, { status: 404 });
    }
    if (!isAdminRole(membership.role)) {
      return NextResponse.json(
        { error: "Only admins can change the custom domain" },
        { status: 403 },
      );
    }

    const { data: current, error: currentError } = await supabase
      .from("workspaces")
      .select("settings")
      .eq("id", membership.workspace_id)
      .single();

    if (currentError) {
      console.error(
        "[Breezify] kb-domain: failed to load current settings:",
        currentError.message,
      );
      return NextResponse.json(
        { error: "Failed to clear custom domain" },
        { status: 500 },
      );
    }

    // normalizeWorkspaceSettings drops kb_custom_domain when it's absent/empty,
    // so spreading without the key removes it from the persisted jsonb.
    const existing =
      current?.settings && typeof current.settings === "object"
        ? (current.settings as Record<string, unknown>)
        : {};
    const merged = { ...existing };
    delete merged.kb_custom_domain;
    const nextSettings = normalizeWorkspaceSettings(merged);

    const { error } = await supabase
      .from("workspaces")
      .update({ settings: nextSettings, updated_at: new Date().toISOString() })
      .eq("id", membership.workspace_id);

    if (error) {
      console.error("[Breezify] kb-domain: clear failed:", error.message);
      return NextResponse.json(
        { error: "Failed to clear custom domain" },
        { status: 500 },
      );
    }

    return NextResponse.json({ kb_custom_domain: null });
  } catch (err) {
    console.error("[Breezify] kb-domain:", err);
    return NextResponse.json(
      { error: "Failed to clear custom domain" },
      { status: 500 },
    );
  }
}
