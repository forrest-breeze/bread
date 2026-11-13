import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";

const SURFACES = ["agent", "portal_builder"] as const;
// Portal-builder threads are keyed by their project slug; keep the pattern in
// step with the portal path slug rules (lowercase, hyphenated, <= 50 chars).
const PROJECT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

const postBodySchema = z.object({
  title: z.string().trim().max(200).optional(),
  surface: z.enum(SURFACES).optional(),
  projectSlug: z.string().regex(PROJECT_SLUG_RE).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/conversations
// Returns all conversations for the authenticated user's active workspace.
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);

  if (!workspace) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 },
    );
  }

  // Default to the agent surface so the existing @agent history list is
  // unaffected; the builder passes ?surface=portal_builder&project=<slug> to
  // fetch (the single) thread for the project it's editing.
  const { searchParams } = new URL(request.url);
  const surfaceParam = searchParams.get("surface");
  const surface = SURFACES.includes(surfaceParam as (typeof SURFACES)[number])
    ? (surfaceParam as (typeof SURFACES)[number])
    : "agent";
  const projectParam = searchParams.get("project");

  let query = supabase
    .from("conversations")
    .select("id, title, surface, project_slug, created_at, updated_at")
    .eq("workspace_id", workspace.workspace_id)
    .eq("user_id", user.id)
    .eq("surface", surface)
    .order("updated_at", { ascending: false });

  if (surface === "portal_builder" && projectParam && PROJECT_SLUG_RE.test(projectParam)) {
    query = query.eq("project_slug", projectParam);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[Breezify] Failed to fetch conversations:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch conversations" },
      { status: 500 },
    );
  }

  return NextResponse.json(data);
}

// ---------------------------------------------------------------------------
// POST /api/conversations
// Creates a new conversation in the active workspace.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);

  if (!workspace) {
    return NextResponse.json(
      { error: "No workspace found" },
      { status: 404 },
    );
  }

  // Empty / malformed body is acceptable — title is optional. Only structured-
  // but-invalid bodies (wrong shape, title over 200 chars) return 400.
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
  const title = parsedBody.data.title?.length ? parsedBody.data.title : null;
  const surface = parsedBody.data.surface ?? "agent";
  const projectSlug =
    surface === "portal_builder" ? (parsedBody.data.projectSlug ?? null) : null;

  const { data, error } = await supabase
    .from("conversations")
    .insert({
      workspace_id: workspace.workspace_id,
      user_id: user.id,
      title,
      surface,
      project_slug: projectSlug,
    })
    .select("id, title, surface, project_slug, created_at, updated_at")
    .single();

  if (error) {
    console.error("[Breezify] Failed to create conversation:", error.message);
    return NextResponse.json(
      { error: "Failed to create conversation" },
      { status: 500 },
    );
  }

  return NextResponse.json(data, { status: 201 });
}
