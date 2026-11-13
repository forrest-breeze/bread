import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateInviteCode } from "@/app/api/workspace/route";
import { safeJsonBody, safeSearchParams } from "@/lib/validation";
import type { InviteLinkRow } from "@/lib/types";
import { WorkspaceRole, canManageRole } from "@breezify/core";
import { requireRouteUser } from "@/lib/auth/route-auth";

const workspaceRoleEnum = z.enum([
  "owner",
  "admin",
  "editor",
  "viewer",
  "agent-only",
]);

const postBodySchema = z
  .object({ role: workspaceRoleEnum.optional() })
  .default({});

const patchBodySchema = z.object({ role: workspaceRoleEnum });

const deleteQuerySchema = z.object({ id: z.string().uuid() });

async function getAdminWorkspace(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<{ workspace_id: string; role: WorkspaceRole } | null> {
  const { getActiveWorkspace } = await import("@/lib/db/workspace");
  const active = await getActiveWorkspace(supabase, userId);
  if (!active) return null;
  return { workspace_id: active.workspace_id, role: active.role as WorkspaceRole };
}

/** GET — retrieve the current workspace's active invite link (admin only). */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getAdminWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const admin = createAdminClient();

  // Check for existing active invite link
  const { data: existingLink } = await admin
    .from("invite_links")
    .select("*")
    .eq("workspace_id", membership.workspace_id)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingLink) {
    return NextResponse.json({ invite_link: existingLink as InviteLinkRow });
  }

  // Lazily create if none exists
  const code = generateInviteCode(16);
  const { data: newLink, error } = await admin
    .from("invite_links")
    .insert({
      workspace_id: membership.workspace_id,
      code,
      created_by: user.id,
      role: "viewer",
    })
    .select()
    .single();

  if (error) {
    console.error("[Breezify] Failed to create invite link:", error.message);
    return NextResponse.json({ error: "Failed to create invite link" }, { status: 500 });
  }

  return NextResponse.json({ invite_link: newLink as InviteLinkRow });
}

/** POST — regenerate the invite link (deactivates old, creates new). Admin only. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getAdminWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // POST allows an empty body — defaults role to "viewer". Only structurally
  // invalid bodies (wrong shape / unknown role) return 400.
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // empty body is fine
  }
  const parsedBody = postBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsedBody.error.flatten() },
      { status: 400 },
    );
  }
  let nextRole: WorkspaceRole = "viewer";
  if (parsedBody.data.role) {
    if (!canManageRole(membership.role, parsedBody.data.role as WorkspaceRole)) {
      return NextResponse.json(
        { error: "You can't assign that role" },
        { status: 403 }
      );
    }
    nextRole = parsedBody.data.role as WorkspaceRole;
  }

  const admin = createAdminClient();

  // Deactivate all existing active links for this workspace
  await admin
    .from("invite_links")
    .update({ is_active: false })
    .eq("workspace_id", membership.workspace_id)
    .eq("is_active", true);

  // Create new invite link
  const code = generateInviteCode(16);
  const { data: newLink, error } = await admin
    .from("invite_links")
    .insert({
      workspace_id: membership.workspace_id,
      code,
      created_by: user.id,
      role: nextRole,
    })
    .select()
    .single();

  if (error) {
    console.error("[Breezify] Failed to regenerate invite link:", error.message);
    return NextResponse.json({ error: "Failed to regenerate invite link" }, { status: 500 });
  }

  return NextResponse.json({ invite_link: newLink as InviteLinkRow });
}

/** PATCH — update the role on the active invite link (preserves the URL). Admin only. */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getAdminWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const parsed = await safeJsonBody(request, patchBodySchema);
  if (!parsed.ok) return parsed.response;
  const { role } = parsed.data;
  if (!canManageRole(membership.role, role as WorkspaceRole)) {
    return NextResponse.json(
      { error: "You can't assign that role" },
      { status: 403 }
    );
  }

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("invite_links")
    .update({ role })
    .eq("workspace_id", membership.workspace_id)
    .eq("is_active", true)
    .select()
    .maybeSingle();

  if (error) {
    console.error("[Breezify] Failed to update invite link role:", error.message);
    return NextResponse.json({ error: "Failed to update invite link" }, { status: 500 });
  }

  if (!updated) {
    return NextResponse.json({ error: "No active invite link" }, { status: 404 });
  }

  return NextResponse.json({ invite_link: updated as InviteLinkRow });
}

/** DELETE — revoke an invite link by ID. Admin only. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getAdminWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const parsedQuery = safeSearchParams(request.nextUrl, deleteQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const { id: linkId } = parsedQuery.data;

  const admin = createAdminClient();

  const { error } = await admin
    .from("invite_links")
    .update({ is_active: false })
    .eq("id", linkId)
    .eq("workspace_id", membership.workspace_id);

  if (error) {
    console.error("[Breezify] Failed to revoke invite link:", error.message);
    return NextResponse.json({ error: "Failed to revoke invite link" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
