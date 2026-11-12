import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PLAN_MEMBER_LIMITS, resolveEntitlementPlanId } from "@/lib/billing/catalog";
import { getWorkspaceSubscription } from "@/lib/db/subscription";
import { markProspectWorkspaceConverted } from "@/lib/db/prospect";
import { countActiveMembers } from "@/lib/db/workspace";
import { getPostHogClient } from "@/lib/posthog-server";
import { getAllowedDomains } from "@/lib/workspace-settings";
import { safeJsonBody, safeSearchParams } from "@/lib/validation";
import type { WorkspaceRole } from "@bread/core";
import { requireRouteUser } from "@/lib/auth/route-auth";

const postBodySchema = z
  .object({
    workspace_id: z.string().uuid().optional(),
    invite_code: z.string().min(1).max(120).optional(),
  })
  .refine((d) => d.workspace_id || d.invite_code, {
    message: "workspace_id or invite_code is required",
  });

const putBodySchema = z.object({ invite_id: z.string().uuid() });

const deleteQuerySchema = z.object({ id: z.string().uuid() });

async function getWorkspaceMemberLimit(workspaceId: string): Promise<number | null> {
  const subscription = await getWorkspaceSubscription(workspaceId);
  return PLAN_MEMBER_LIMITS[resolveEntitlementPlanId(subscription)];
}

/** GET — find workspaces the user can join (domain match) and pending invites. */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();

  const { user } = await requireRouteUser(supabase);

  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const userDomain = user.email.split("@")[1]?.toLowerCase();

  const pendingInvitesQuery = admin
    .from("workspace_members")
    .select("id, workspace_id, role, created_at")
    .eq("user_id", user.id)
    .eq("status", "invited");

  const membershipsQuery = admin
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id);

  // Domain-matched workspaces: admins opt in by listing their allowed domains
  // in workspaces.settings.allowed_domains. Supabase translates `.contains`
  // on a jsonb column to the `@>` operator.
  const domainWorkspacesQuery = userDomain
    ? admin
        .from("workspaces")
        .select("id, name, icon_url")
        .contains("settings", { allowed_domains: [userDomain] })
    : Promise.resolve({ data: [] });

  const [
    { data: pendingInvites },
    { data: memberships },
    { data: matchedWorkspaces },
  ] = await Promise.all([
    pendingInvitesQuery,
    membershipsQuery,
    domainWorkspacesQuery,
  ]);

  let pendingWorkspaces: { id: string; name: string; icon_url: string | null; role: string; invite_id: string }[] = [];
  if (pendingInvites?.length) {
    const wsIds = pendingInvites.map((i) => i.workspace_id);
    const { data: workspaces } = await admin
      .from("workspaces")
      .select("id, name, icon_url")
      .in("id", wsIds);

    pendingWorkspaces = (workspaces ?? []).map((ws) => {
      const invite = pendingInvites.find((i) => i.workspace_id === ws.id)!;
      return { ...ws, role: invite.role, invite_id: invite.id };
    });
  }

  // Exclude workspaces the user already belongs to (active or invited).
  const memberIds = new Set(memberships?.map((m) => m.workspace_id) ?? []);
  const domainWorkspaces = (matchedWorkspaces ?? [])
    .filter((ws) => !memberIds.has(ws.id))
    .map((ws) => ({
      id: ws.id,
      name: ws.name,
      icon_url: ws.icon_url,
    }));

  return NextResponse.json({
    pending_invites: pendingWorkspaces,
    domain_workspaces: domainWorkspaces,
  });
}

/** POST — join a workspace by ID (domain match) or invite code. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user } = await requireRouteUser(supabase);

  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  const { workspace_id: workspaceId, invite_code: inviteCode } = parsed.data;

  const admin = createAdminClient();
  let resolvedWorkspaceId: string;
  let assignedRole: WorkspaceRole = "viewer";

  if (inviteCode) {
    // First, check invite_links table
    const { data: inviteLink } = await admin
      .from("invite_links")
      .select("id, workspace_id, is_active, expires_at, max_uses, use_count, role")
      .eq("code", inviteCode)
      .maybeSingle();

    if (inviteLink) {
      // Validate the invite link
      if (!inviteLink.is_active) {
        return NextResponse.json(
          { error: "This invite link has been revoked" },
          { status: 410 }
        );
      }
      if (inviteLink.expires_at && new Date(inviteLink.expires_at) < new Date()) {
        return NextResponse.json(
          { error: "This invite link has expired" },
          { status: 410 }
        );
      }
      if (inviteLink.max_uses !== null && inviteLink.use_count >= inviteLink.max_uses) {
        return NextResponse.json(
          { error: "This invite link has reached its maximum uses" },
          { status: 410 }
        );
      }

      resolvedWorkspaceId = inviteLink.workspace_id;
      assignedRole = inviteLink.role as WorkspaceRole;

      // Increment use_count after validation (before insert to avoid counting failed joins)
      // We'll increment after successful join below
    } else {
      // Fall back to legacy invite code in settings JSONB
      const { data: workspaces } = await admin
        .from("workspaces")
        .select("id, settings")
        .filter("settings->>invite_code", "eq", inviteCode);

      if (!workspaces?.length) {
        return NextResponse.json(
          { error: "Invalid invite code" },
          { status: 404 }
        );
      }

      resolvedWorkspaceId = workspaces[0].id;
    }
  } else {
    // Join by workspace ID — require the user's email domain to be listed in
    // the workspace's allowed_domains setting.
    const { data: workspace, error: wsError } = await admin
      .from("workspaces")
      .select("id, settings")
      .eq("id", workspaceId!)
      .single();

    if (wsError || !workspace) {
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 404 }
      );
    }

    const userDomain = user.email.split("@")[1]?.toLowerCase();
    const allowedDomains = getAllowedDomains(workspace.settings);
    if (!userDomain || !allowedDomains.includes(userDomain)) {
      return NextResponse.json(
        { error: "Your email domain isn't allowed to join this workspace" },
        { status: 403 }
      );
    }

    resolvedWorkspaceId = workspace.id;
  }

  const existingMembershipQuery = admin
    .from("workspace_members")
    .select("id, status")
    .eq("workspace_id", resolvedWorkspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  const [
    memberLimit,
    currentMembers,
    { data: existing },
  ] = await Promise.all([
    getWorkspaceMemberLimit(resolvedWorkspaceId),
    countActiveMembers(resolvedWorkspaceId),
    existingMembershipQuery,
  ]);

  // Existing active members should not be blocked by plan downgrades.
  if (existing && existing.status !== "invited" && existing.status !== "expired") {
    return NextResponse.json(
      { error: "Already a member of this workspace" },
      { status: 409 }
    );
  }

  // Enforce member cap for the workspace's current plan before creating a new
  // active membership or promoting a pending/expired invite.
  if (memberLimit !== null && currentMembers >= memberLimit) {
    return NextResponse.json(
      {
        error: `This workspace is at its plan member limit (${memberLimit}).`,
        code: "member_limit_reached",
        memberLimit,
      },
      { status: 402 }
    );
  }

  if (existing) {
    // Activate pending or expired invite (joining via link/code counts as acceptance)
    const { error: activateError } = await admin
      .from("workspace_members")
      .update({ status: "active", role: assignedRole })
      .eq("id", existing.id);

    if (activateError) {
      console.error("[Bread] Failed to activate workspace membership:", activateError.message);
      return NextResponse.json(
        { error: "Failed to join workspace" },
        { status: 500 }
      );
    }
    after(() => markProspectWorkspaceConverted(resolvedWorkspaceId));
    return NextResponse.json({ success: true, workspace_id: resolvedWorkspaceId });
  }

  // Add member with the assigned role
  const { error: joinError } = await admin
    .from("workspace_members")
    .insert({
      workspace_id: resolvedWorkspaceId,
      user_id: user.id,
      role: assignedRole,
      status: "active",
    });

  if (joinError) {
    console.error("[Bread] Failed to join workspace:", joinError.message);
    return NextResponse.json(
      { error: "Failed to join workspace" },
      { status: 500 }
    );
  }

  // A first member joining a headless prospect workspace (outbound portal)
  // graduates it into a real customer workspace.
  after(() => markProspectWorkspaceConverted(resolvedWorkspaceId));

  // Increment use_count on the invite link if it was used
  if (inviteCode) {
    after(async () => {
      try {
        const { data: usedLink } = await admin
          .from("invite_links")
          .select("id, use_count")
          .eq("code", inviteCode)
          .maybeSingle();

        if (usedLink) {
          await admin
            .from("invite_links")
            .update({ use_count: usedLink.use_count + 1 })
            .eq("id", usedLink.id);
        }
      } catch (err) {
        console.error("[Bread] Failed to increment invite link use count:", err);
      }
    });
  }

  after(async () => {
    try {
      const posthog = getPostHogClient();
      posthog.capture({
        distinctId: user.id,
        event: 'workspace_joined',
        properties: {
          workspace_id: resolvedWorkspaceId,
          join_method: inviteCode ? 'invite_code' : 'domain_match',
          assigned_role: assignedRole,
        },
      });
      await posthog.shutdown();
    } catch (err) {
      console.error("[Bread] workspace_joined posthog flush failed:", err);
    }
  });

  return NextResponse.json({ success: true, workspace_id: resolvedWorkspaceId });
}

/** PUT — accept a pending workspace invite. */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const parsed = await safeJsonBody(request, putBodySchema);
  if (!parsed.ok) return parsed.response;
  const { invite_id: inviteId } = parsed.data;

  const admin = createAdminClient();

  // Verify this invite belongs to the user
  const { data: invite } = await admin
    .from("workspace_members")
    .select("id, workspace_id, status")
    .eq("id", inviteId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  if (invite.status === "expired") {
    return NextResponse.json(
      { error: "This invite has expired — please ask the workspace owner to re-send it" },
      { status: 410 }
    );
  }

  if (invite.status !== "invited") {
    return NextResponse.json({ error: "Invite is no longer pending" }, { status: 409 });
  }

  // Enforce member cap before promoting the pending invite. A pending invite
  // is not counted as an active member, so accepting it increments the active
  // count and must respect the plan's member limit — mirrors the POST handler.
  const memberLimit = await getWorkspaceMemberLimit(invite.workspace_id);
  if (memberLimit !== null) {
    const currentMembers = await countActiveMembers(invite.workspace_id);
    if (currentMembers >= memberLimit) {
      return NextResponse.json(
        {
          error: `This workspace is at its plan member limit (${memberLimit}).`,
          code: "member_limit_reached",
          memberLimit,
        },
        { status: 402 }
      );
    }
  }

  const { error } = await admin
    .from("workspace_members")
    .update({ status: "active" })
    .eq("id", invite.id);

  if (error) {
    console.error("[Bread] Failed to accept invite:", error.message);
    return NextResponse.json({ error: "Failed to accept invite" }, { status: 500 });
  }

  after(() => markProspectWorkspaceConverted(invite.workspace_id));
  after(async () => {
    try {
      const posthogInvite = getPostHogClient();
      posthogInvite.capture({
        distinctId: user.id,
        event: 'invite_accepted',
        properties: {
          workspace_id: invite.workspace_id,
          invite_id: inviteId,
        },
      });
      await posthogInvite.shutdown();
    } catch (err) {
      console.error("[Bread] invite_accepted posthog flush failed:", err);
    }
  });

  return NextResponse.json({ success: true, workspace_id: invite.workspace_id });
}

/** DELETE — decline a pending workspace invite. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const parsedQuery = safeSearchParams(request.nextUrl, deleteQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const { id: inviteId } = parsedQuery.data;

  const admin = createAdminClient();

  // Verify this invite belongs to the user and is still pending
  const { data: invite } = await admin
    .from("workspace_members")
    .select("id")
    .eq("id", inviteId)
    .eq("user_id", user.id)
    .eq("status", "invited")
    .maybeSingle();

  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  const { error } = await admin
    .from("workspace_members")
    .delete()
    .eq("id", invite.id);

  if (error) {
    console.error("[Bread] Failed to decline invite:", error.message);
    return NextResponse.json({ error: "Failed to decline invite" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
