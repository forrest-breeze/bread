import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { safeJsonBody } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

const putBodySchema = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(["active", "vacation", "departed"]).optional(),
  avatar_url: z.string().max(2048).nullable().optional(),
  role: z.string().trim().max(120).nullable().optional(),
});

interface OwnedWorkspace {
  id: string;
  name: string;
}

interface OwnedWorkspacesResult {
  /** Workspaces the user owns that still have other active members. Account
   *  deletion is blocked until these are transferred or deleted manually. */
  sharedOwned: OwnedWorkspace[];
  /** Workspaces the user owns where they are the only active member. These
   *  are deleted alongside the account. */
  soloOwned: OwnedWorkspace[];
}

async function getOwnedWorkspaces(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<{ data: OwnedWorkspacesResult | null; error: unknown }> {
  const { data: memberships, error: membershipError } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId)
    .eq("role", "owner");

  if (membershipError) {
    return { data: null, error: membershipError };
  }

  const workspaceIds = (memberships ?? []).map((m) => m.workspace_id);

  if (workspaceIds.length === 0) {
    return { data: { sharedOwned: [], soloOwned: [] }, error: null };
  }

  const { data: workspaces, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, name")
    .in("id", workspaceIds);

  if (workspaceError) {
    return { data: null, error: workspaceError };
  }

  // For each owned workspace, check whether any *other* active member exists.
  // Pending/expired invites don't count — they aren't active members yet.
  const { data: otherMembers, error: otherError } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .in("workspace_id", workspaceIds)
    .eq("status", "active")
    .neq("user_id", userId);

  if (otherError) {
    return { data: null, error: otherError };
  }

  const sharedIds = new Set((otherMembers ?? []).map((m) => m.workspace_id));
  const sharedOwned: OwnedWorkspace[] = [];
  const soloOwned: OwnedWorkspace[] = [];

  for (const ws of workspaces ?? []) {
    const entry = { id: ws.id, name: ws.name };
    if (sharedIds.has(ws.id)) {
      sharedOwned.push(entry);
    } else {
      soloOwned.push(entry);
    }
  }

  return { data: { sharedOwned, soloOwned }, error: null };
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (error) {
    console.error("[Bread] Failed to fetch profile:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch profile" },
      { status: 500 }
    );
  }

  // Fetch workspace membership to get full context
  const { getActiveWorkspace } = await import("@/lib/db/workspace");
  const membership = await getActiveWorkspace(supabase, user.id);

  let profileRole = null;
  if (membership) {
    const { data: memberData } = await supabase
      .from("workspace_members")
      .select("profile_role")
      .eq("workspace_id", membership.workspace_id)
      .eq("id", membership.id)
      .single();
    profileRole = memberData?.profile_role || null;
  }

  const { data: owned, error: ownedError } = await getOwnedWorkspaces(supabase, user.id);

  if (ownedError || !owned) {
    console.error("[Bread] Failed to fetch owned workspaces:", (ownedError as Error | null)?.message);
    return NextResponse.json(
      { error: "Failed to fetch profile" },
      { status: 500 }
    );
  }

  // Ensure avatar_url falls back to auth metadata if missing in profile table
  const profile = {
    ...data,
    role: profileRole,
    can_delete_account: owned.sharedOwned.length === 0,
    owned_workspaces: [...owned.sharedOwned, ...owned.soloOwned],
    shared_owned_workspaces: owned.sharedOwned,
    solo_owned_workspaces: owned.soloOwned,
    avatar_url: data.avatar_url || user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
  };

  return NextResponse.json(profile);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const parsed = await safeJsonBody(request, putBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.display_name !== undefined) updates.display_name = body.display_name;
  if (body.status !== undefined) updates.status = body.status;
  if (body.avatar_url !== undefined) updates.avatar_url = body.avatar_url;

  const { data, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    console.error("[Bread] Failed to update profile:", error.message);
    return NextResponse.json(
      { error: "Failed to update profile" },
      { status: 500 }
    );
  }

  let currentRole = null;

  if (body.role !== undefined) {
    const { getActiveWorkspace } = await import("@/lib/db/workspace");
    const membership = await getActiveWorkspace(supabase, user.id);

    if (membership) {
      const { data: memberData, error: memberError } = await supabase
        .from("workspace_members")
        .update({ profile_role: body.role })
        .eq("workspace_id", membership.workspace_id)
        .eq("id", membership.id)
        .select("profile_role")
        .single();

      if (!memberError && memberData) {
        currentRole = memberData.profile_role;
      } else if (memberError) {
        console.error("[Bread] Failed to update workspace member role:", memberError.message);
      }
    }
  }

  const { data: owned, error: ownedError } = await getOwnedWorkspaces(supabase, user.id);

  if (ownedError || !owned) {
    console.error("[Bread] Failed to fetch owned workspaces:", (ownedError as Error | null)?.message);
    return NextResponse.json(
      { error: "Failed to update profile" },
      { status: 500 }
    );
  }

  // Ensure returned data also has the fallback applied
  const profile = {
    ...data,
    role: currentRole !== null ? currentRole : (body.role || null),
    can_delete_account: owned.sharedOwned.length === 0,
    owned_workspaces: [...owned.sharedOwned, ...owned.soloOwned],
    shared_owned_workspaces: owned.sharedOwned,
    solo_owned_workspaces: owned.soloOwned,
    avatar_url: data.avatar_url || user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
  };

  return NextResponse.json(profile);
}

export async function DELETE(): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const { data: owned, error: ownedError } = await getOwnedWorkspaces(supabase, user.id);

  if (ownedError || !owned) {
    console.error("[Bread] Failed to fetch owned workspaces:", (ownedError as Error | null)?.message);
    return NextResponse.json(
      { error: "Failed to validate account deletion" },
      { status: 500 }
    );
  }

  if (owned.sharedOwned.length > 0) {
    const workspaceNames = owned.sharedOwned.map((w) => w.name).join(", ");
    return NextResponse.json(
      {
        error:
          owned.sharedOwned.length === 1
            ? `Transfer or delete the workspace "${workspaceNames}" before deleting your account.`
            : `Transfer or delete your owned workspaces before deleting your account: ${workspaceNames}.`,
      },
      { status: 409 }
    );
  }

  const admin = createAdminClient();
  const soloOwnedIds = owned.soloOwned.map((w) => w.id);

  // Delete the auth user FIRST. Public rows cascade from auth.users, which
  // removes this user's workspace_members row. If this step fails no
  // workspace data has been touched yet, so the account and its data stay
  // intact and the user can retry.
  const { error: authDeleteError } = await admin.auth.admin.deleteUser(user.id);

  if (authDeleteError) {
    console.error("[Bread] Failed to delete auth user:", authDeleteError.message);
    return NextResponse.json(
      { error: "Failed to delete account" },
      { status: 500 }
    );
  }

  // Sweep workspaces that were classified as solo-owned. The RPC re-checks
  // "no active members remaining" at delete time in the same SQL statement,
  // so if someone joined between classification and here, their workspace
  // is spared — closing the TOCTOU gap that a blind in().delete() would leave.
  if (soloOwnedIds.length > 0) {
    const { error: sweepError } = await admin.rpc("delete_orphaned_workspaces", {
      p_workspace_ids: soloOwnedIds,
    });

    if (sweepError) {
      // Auth user is already gone — log loudly but still return success so
      // the client finishes sign-out cleanly. Any workspace left behind
      // because someone joined in the gap is recoverable.
      console.error(
        "[Bread] Failed to sweep orphaned workspaces after account deletion:",
        sweepError.message,
      );
    }
  }

  // Clear the current session cookie if it still exists.
  await supabase.auth.signOut();

  return NextResponse.json({ ok: true });
}
