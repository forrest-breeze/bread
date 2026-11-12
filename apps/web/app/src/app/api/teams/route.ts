import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeJsonBody, safeSearchParams } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

const postBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});

const deleteQuerySchema = z.object({
  id: z.string().uuid(),
});

/** GET /api/teams — list all teams in the user's workspace, with member counts */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }

  const { data: teams, error } = await supabase
    .from("teams")
    .select("id, name, slug, description, created_at")
    .eq("workspace_id", membership.workspace_id)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[Bread] Failed to fetch teams:", error.message);
    return NextResponse.json({ error: "Failed to fetch teams" }, { status: 500 });
  }

  // Fetch member counts per team
  const teamIds = (teams ?? []).map((t) => t.id);
  let memberCounts: Record<string, number> = {};

  if (teamIds.length > 0) {
    const { data: tmRows } = await supabase
      .from("team_members")
      .select("team_id")
      .in("team_id", teamIds);

    for (const row of tmRows ?? []) {
      memberCounts[row.team_id] = (memberCounts[row.team_id] ?? 0) + 1;
    }
  }

  const result = (teams ?? []).map((t) => ({
    ...t,
    member_count: memberCounts[t.id] ?? 0,
  }));

  return NextResponse.json({
    teams: result,
    current_member_id: membership.id,
    is_admin: membership.role === "admin" || membership.role === "owner",
  });
}

/** POST /api/teams — create a new team (admin only) */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Only admins can create teams" }, { status: 403 });
  }

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  const { name, description } = parsed.data;

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  const { data: team, error } = await supabase
    .from("teams")
    .insert({
      workspace_id: membership.workspace_id,
      name,
      slug,
      description: description || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "A team with that name already exists" },
        { status: 409 }
      );
    }
    console.error("[Bread] Failed to create team:", error.message);
    return NextResponse.json({ error: "Failed to create team" }, { status: 500 });
  }

  // Auto-add the creator to the team
  await supabase
    .from("team_members")
    .insert({ team_id: team.id, workspace_member_id: membership.id });

  return NextResponse.json(team, { status: 201 });
}

/** DELETE /api/teams — delete a team (admin only) */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Only admins can delete teams" }, { status: 403 });
  }

  const parsedQuery = safeSearchParams(request.nextUrl, deleteQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const { id: teamId } = parsedQuery.data;

  const { error } = await supabase
    .from("teams")
    .delete()
    .eq("id", teamId)
    .eq("workspace_id", membership.workspace_id);

  if (error) {
    console.error("[Bread] Failed to delete team:", error.message);
    return NextResponse.json({ error: "Failed to delete team" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
