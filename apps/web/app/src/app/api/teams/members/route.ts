import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeJsonBody, safeSearchParams } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

const getQuerySchema = z.object({ team_id: z.string().uuid() });
const postBodySchema = z.object({
  team_id: z.string().uuid(),
  workspace_member_id: z.string().uuid(),
});
const deleteQuerySchema = z.object({ id: z.string().uuid() });

/** GET /api/teams/members?team_id=... — list members of a team */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }

  const parsedQuery = safeSearchParams(request.nextUrl, getQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const { team_id: teamId } = parsedQuery.data;

  // Get team_members join rows
  const { data: teamMembers, error } = await supabase
    .from("team_members")
    .select("id, workspace_member_id, created_at")
    .eq("team_id", teamId);

  if (error) {
    console.error("[Bread] Failed to fetch team members:", error.message);
    return NextResponse.json({ error: "Failed to fetch team members" }, { status: 500 });
  }

  if (!teamMembers || teamMembers.length === 0) {
    return NextResponse.json({ members: [] });
  }

  // Resolve workspace_member_ids to user details
  const wmIds = teamMembers.map((tm) => tm.workspace_member_id);
  const { data: wsMembers } = await supabase
    .from("workspace_members")
    .select("id, user_id, role")
    .in("id", wmIds);

  const userIds = (wsMembers ?? [])
    .map((wm) => wm.user_id)
    .filter((id): id is string => id !== null);

  const { data: profiles } = userIds.length > 0
    ? await supabase
        .from("profiles")
        .select("user_id, display_name, email, avatar_url")
        .in("user_id", userIds)
    : { data: [] };

  const profileMap = new Map(
    (profiles ?? []).map((p) => [p.user_id, p])
  );
  const wsMemberMap = new Map(
    (wsMembers ?? []).map((wm) => [wm.id, wm])
  );

  const members = teamMembers.map((tm) => {
    const wm = wsMemberMap.get(tm.workspace_member_id);
    const profile = wm?.user_id ? profileMap.get(wm.user_id) : null;
    return {
      team_member_id: tm.id,
      workspace_member_id: tm.workspace_member_id,
      user_id: wm?.user_id ?? null,
      workspace_role: wm?.role ?? null,
      display_name: profile?.display_name ?? null,
      email: profile?.email ?? null,
      avatar_url: profile?.avatar_url ?? null,
    };
  });

  return NextResponse.json({ members });
}

/** POST /api/teams/members — add a workspace member to a team (admin only) */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Only admins can manage team members" }, { status: 403 });
  }

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  const { team_id, workspace_member_id } = parsed.data;

  const { data, error } = await supabase
    .from("team_members")
    .insert({ team_id, workspace_member_id })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "This member is already on the team" },
        { status: 409 }
      );
    }
    console.error("[Bread] Failed to add team member:", error.message);
    return NextResponse.json({ error: "Failed to add team member" }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

/** DELETE /api/teams/members — remove a member from a team (admin only) */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Only admins can manage team members" }, { status: 403 });
  }

  const parsedQuery = safeSearchParams(request.nextUrl, deleteQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const { id: teamMemberId } = parsedQuery.data;

  const { error } = await supabase
    .from("team_members")
    .delete()
    .eq("id", teamMemberId);

  if (error) {
    console.error("[Bread] Failed to remove team member:", error.message);
    return NextResponse.json({ error: "Failed to remove team member" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
