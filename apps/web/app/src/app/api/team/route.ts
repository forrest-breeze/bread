import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { countActiveMembers, getActiveWorkspace } from "@/lib/db/workspace";
import { getWorkspaceSubscription } from "@/lib/db/subscription";
import { PLAN_MEMBER_LIMITS, resolveEntitlementPlanId } from "@/lib/billing/catalog";
import { sendInviteEmail } from "@/lib/email";
import {
  emailSchema,
  roleEnum,
  safeJsonBody,
  safeSearchParams,
} from "@/lib/validation";
import type { TeamMember } from "@/lib/types";
import { WorkspaceRole, canManageRole } from "@bread/core";
import { requireRouteUser } from "@/lib/auth/route-auth";

const postBodySchema = z.object({
  email: emailSchema,
  role: roleEnum.default("viewer"),
  resend: z.boolean().default(false),
});

const putBodySchema = z.object({
  member_id: z.string().uuid(),
  role: roleEnum,
});

const deleteQuerySchema = z.object({
  id: z.string().uuid(),
});

/**
 * Returns the max active members for a workspace, or `null` if the workspace
 * is on a plan without a member cap (business, enterprise).
 */
async function getWorkspaceMemberLimit(workspaceId: string): Promise<number | null> {
  const subscription = await getWorkspaceSubscription(workspaceId);
  return PLAN_MEMBER_LIMITS[resolveEntitlementPlanId(subscription)];
}

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);

  if (!membership) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 }
    );
  }

  // Fetch workspace members
  const { data: members, error } = await supabase
    .from("workspace_members")
    .select("id, user_id, role, status, invited_email, profile_role")
    .eq("workspace_id", membership.workspace_id)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[Bread] Failed to fetch team:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch team" },
      { status: 500 }
    );
  }

  // Fetch profiles separately (no direct FK between workspace_members and profiles)
  const memberUserIds = (members ?? [])
    .map((m) => m.user_id)
    .filter((id): id is string => id !== null && id !== undefined);

  const adminClient = createAdminClient();
  const { data: profiles, error: profilesError } = memberUserIds.length > 0
    ? await adminClient
      .from("profiles")
      .select("user_id, display_name, email, avatar_url, status")
      .in("user_id", memberUserIds)
    : { data: [], error: null };

  if (profilesError) {
    console.error("[Bread] Failed to fetch profiles:", JSON.stringify(profilesError, null, 2));
  }

  const profilesByUserId = new Map(
    (profiles ?? []).map((p) => [p.user_id, p])
  );

  // Count contributions per user/author from documents within this workspace
  const { data: docs } = await supabase
    .from("documents")
    .select("user_id, author")
    .eq("workspace_id", membership.workspace_id)
    .is("deleted_at", null);

  const contributionsByUserId: Record<string, number> = {};
  const contributionsByAuthor: Record<string, number> = {};
  for (const doc of docs ?? []) {
    if (doc.user_id) {
      contributionsByUserId[doc.user_id] = (contributionsByUserId[doc.user_id] ?? 0) + 1;
    } else if (doc.author) {
      contributionsByAuthor[doc.author] = (contributionsByAuthor[doc.author] ?? 0) + 1;
    }
  }

  const teamMembers: TeamMember[] = (members ?? []).map((m) => {
    const profile = m.user_id ? profilesByUserId.get(m.user_id) : null;
    const displayName = profile?.display_name ?? null;
    const email = profile?.email ?? m.invited_email ?? null;

    // Match contributions by user_id, display name or email
    const contributions =
      (m.user_id ? (contributionsByUserId[m.user_id] ?? 0) : 0) ||
      (displayName ? (contributionsByAuthor[displayName] ?? 0) : 0) ||
      (email ? (contributionsByAuthor[email] ?? 0) : 0) ||
      0;

    return {
      member_id: m.id,
      user_id: m.user_id,
      workspace_role: m.role,
      member_status: m.status,
      display_name: displayName,
      email,
      avatar_url: profile?.avatar_url ?? null,
      profile_role: m.profile_role ?? null,
      profile_status: (profile?.status ?? "active") as "active" | "vacation" | "departed",

      contributions,
    } satisfies TeamMember;
  });

  return NextResponse.json({
    members: teamMembers,
    current_user_id: user.id,
    current_user_role: membership.role,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);

  if (!membership || !canManageRole(membership.role as WorkspaceRole, "editor")) {
    return NextResponse.json(
      { error: "Only editors and above can invite members" },
      { status: 403 }
    );
  }

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  const { email, role, resend } = parsed.data;

  if (!canManageRole(membership.role as WorkspaceRole, role as WorkspaceRole)) {
    return NextResponse.json(
      { error: "You cannot invite members to a role higher than your own" },
      { status: 403 }
    );
  }

  const memberLimit = await getWorkspaceMemberLimit(membership.workspace_id);
  if (memberLimit !== null) {
    const currentMembers = await countActiveMembers(membership.workspace_id);
    if (currentMembers >= memberLimit) {
      return NextResponse.json(
        {
          error: `Your plan is limited to ${memberLimit} active members.`,
          code: "member_limit_reached",
          memberLimit,
        },
        { status: 402 }
      );
    }
  }

  // Check if a profile with that email exists
  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("user_id")
    .eq("email", email)
    .maybeSingle();

  const adminClient = createAdminClient();

  // Find any existing membership for this person in this workspace
  const existingByUserQuery = existingProfile?.user_id
    ? adminClient
        .from("workspace_members")
        .select("id, status")
        .eq("workspace_id", membership.workspace_id)
        .eq("user_id", existingProfile.user_id)
        .maybeSingle()
    : Promise.resolve({ data: null });

  const existingByEmailQuery = adminClient
    .from("workspace_members")
    .select("id, status")
    .eq("workspace_id", membership.workspace_id)
    .eq("invited_email", email)
    .is("user_id", null)
    .maybeSingle();

  const [{ data: byUser }, { data: byEmail }] = await Promise.all([
    existingByUserQuery,
    existingByEmailQuery,
  ]);
  const existing = byUser ?? byEmail;

  if (existing) {
    if (existing.status === "active") {
      return NextResponse.json(
        { error: "This user is already a member of the workspace" },
        { status: 409 }
      );
    }
    
    // If resend is NOT explicitly requested, return conflict
    if (!resend) {
      return NextResponse.json(
        { error: "An invite has already been sent to this email. If they didn't receive it, you can share the invite link below." },
        { status: 409 }
      );
    }
  }

  // Fetch info needed for email
  const [{ data: workspace }, { data: inviterProfile }] = await Promise.all([
    supabase
      .from("workspaces")
      .select("name")
      .eq("id", membership.workspace_id)
      .single(),
    supabase
      .from("profiles")
      .select("display_name, email")
      .eq("user_id", user.id)
      .single(),
  ]);

  const inviterName =
    inviterProfile?.display_name ?? inviterProfile?.email ?? "A teammate";
  const workspaceName = workspace?.name ?? "your workspace";

  // Send invite email FIRST. If it fails, we don't touch the DB.
  const emailResult = await sendInviteEmail({
    to: email,
    workspaceName,
    inviterName,
    role,
    joinUrl: `${process.env.NEXT_PUBLIC_APP_URL}/login`,
  });

  if (!emailResult.success) {
    return NextResponse.json(
      { error: `Failed to send invite email: ${emailResult.error ?? "Unknown error"}` },
      { status: 500 }
    );
  }

  let resultData: unknown;

  if (existing) {
    // Resend: reset created_at + role + status, back-fill user_id if known.
    const { data: updated, error: updateError } = await adminClient
      .from("workspace_members")
      .update({
        status: "invited",
        role,
        invited_email: email,
        user_id: existingProfile?.user_id ?? null,
        created_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (updateError) {
      console.error("[Bread] Failed to resend invite:", updateError.message);
      return NextResponse.json(
        { error: "Failed to resend invite" },
        { status: 500 }
      );
    }
    resultData = updated;
  } else {
    // Insert new membership
    const { data: inserted, error } = await adminClient
      .from("workspace_members")
      .insert({
        workspace_id: membership.workspace_id,
        role,
        status: "invited",
        user_id: existingProfile?.user_id ?? null,
        invited_email: email,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "This user is already a member of the workspace" },
          { status: 409 }
        );
      }
      console.error("[Bread] Failed to invite member:", error.message);
      return NextResponse.json(
        { error: "Failed to invite member" },
        { status: 500 }
      );
    }
    resultData = inserted;
  }

  return NextResponse.json(resultData, { status: 201 });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const userMembership = await getActiveWorkspace(supabase, user.id);

  if (!userMembership || !canManageRole(userMembership.role as WorkspaceRole, "editor")) {
    return NextResponse.json(
      { error: "Only editors and above can update member roles" },
      { status: 403 }
    );
  }

  const parsed = await safeJsonBody(request, putBodySchema);
  if (!parsed.ok) return parsed.response;
  const { member_id, role } = parsed.data;

  if (!canManageRole(userMembership.role as WorkspaceRole, role as WorkspaceRole)) {
    return NextResponse.json(
      { error: "Cannot assign a role higher than your own rank" },
      { status: 403 }
    );
  }

  const adminClient = createAdminClient();

  const { data: targetMember } = await adminClient
    .from("workspace_members")
    .select("role")
    .eq("id", member_id)
    .eq("workspace_id", userMembership.workspace_id)
    .single();

  if (!targetMember) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  if (!canManageRole(userMembership.role as WorkspaceRole, targetMember.role as WorkspaceRole)) {
    return NextResponse.json(
      { error: "You cannot modify a member who has a higher role than your own" },
      { status: 403 }
    );
  }

  // Handle ownership transfer
  if (role === "owner") {
    if (userMembership.role !== "owner") {
      return NextResponse.json({ error: "Only the workspace owner can transfer ownership" }, { status: 403 });
    }

    // Demote current owner to admin
    await adminClient
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("id", userMembership.id);
  }

  const { data, error } = await adminClient
    .from("workspace_members")
    .update({ role })
    .eq("id", member_id)
    .eq("workspace_id", userMembership.workspace_id)
    .select()
    .single();

  if (error) {
    console.error("[Bread] Failed to update member role:", error.message);
    return NextResponse.json(
      { error: "Failed to update member role" },
      { status: 500 }
    );
  }

  return NextResponse.json(data);
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const userMembership = await getActiveWorkspace(supabase, user.id);

  if (!userMembership || !canManageRole(userMembership.role as WorkspaceRole, "editor")) {
    return NextResponse.json(
      { error: "Only editors and above can remove members" },
      { status: 403 }
    );
  }

  const parsedQuery = safeSearchParams(request.nextUrl, deleteQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const { id: memberId } = parsedQuery.data;

  const adminClient = createAdminClient();

  // Prevent admins from removing themselves
  const { data: target } = await adminClient
    .from("workspace_members")
    .select("id, user_id, role")
    .eq("id", memberId)
    .eq("workspace_id", userMembership.workspace_id)
    .single();

  if (!target) {
    return NextResponse.json(
      { error: "Member not found" },
      { status: 404 }
    );
  }

  if (!canManageRole(userMembership.role as WorkspaceRole, target.role as WorkspaceRole)) {
    return NextResponse.json(
      { error: "You cannot remove a member holding a higher rank" },
      { status: 403 }
    );
  }

  if (target.user_id === user.id) {
    return NextResponse.json(
      { error: "You cannot remove yourself" },
      { status: 400 }
    );
  }

  const { error } = await adminClient
    .from("workspace_members")
    .delete()
    .eq("id", memberId)
    .eq("workspace_id", userMembership.workspace_id);

  if (error) {
    console.error("[Bread] Failed to remove member:", error.message);
    return NextResponse.json(
      { error: "Failed to remove member" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
