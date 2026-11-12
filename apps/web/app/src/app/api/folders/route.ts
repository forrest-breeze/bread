import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeJsonBody, slugSchema } from "@/lib/validation";
import type { FolderVisibility, WorkspaceMemberRole } from "@/lib/types";
import { requireRouteUser } from "@/lib/auth/route-auth";

export const dynamic = "force-dynamic";

const postBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    id: z.string().uuid().optional(),
    parent_folder_id: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v || null),
    visibility: z.enum(["workspace", "role"]).default("workspace"),
    required_role: z
      .enum(["owner", "admin", "editor", "viewer", "agent-only"])
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.visibility === "role" && !data.required_role) {
      ctx.addIssue({
        code: "custom",
        message: "required_role is required when visibility is 'role'",
        path: ["required_role"],
      });
    }
  });

function projectSlugFromRequest(request: Request): string | undefined {
  const raw = new URL(request.url).searchParams.get("project");
  if (!raw) return undefined;
  const parsed = slugSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid project slug");
  return parsed.data;
}

// ---------------------------------------------------------------------------
// GET /api/folders
// Returns all folders for the active workspace.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  let projectSlug: string | undefined;
  try {
    projectSlug = projectSlugFromRequest(request);
  } catch {
    return NextResponse.json({ error: "Invalid project slug" }, { status: 400 });
  }

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

  // folder_stats is a view — we read from it so document_count is available
  // for both topic folders (membership via document_topics) and user folders
  // (membership via documents.folder_id) without a client-side aggregation.
  let query = supabase
    .from("folder_stats")
    .select(
      "folder_id, name, display_name, kind, parent_folder_id, visibility, required_role, sort_order, icon, document_count, last_seen_at, created_at, updated_at",
    )
    .eq("workspace_id", workspace.workspace_id)
    .order("kind", { ascending: true })
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("last_seen_at", { ascending: false });

  if (projectSlug) {
    try {
      const [
        { getPublicVisibleFolderIds },
        { resolvePortalProjectContentScope },
      ] = await Promise.all([
        import("@/lib/public-kb"),
        import("@/lib/portal/experiences-write"),
      ]);
      const project = await resolvePortalProjectContentScope(
        workspace.workspace_id,
        projectSlug,
      );
      const visibleFolderIds = await getPublicVisibleFolderIds(
        workspace.workspace_id,
        project.scope,
      );
      if (visibleFolderIds.length === 0) {
        return NextResponse.json([]);
      }
      query = query.in("folder_id", visibleFolderIds);
    } catch (err) {
      console.error("[Bread] Failed to resolve folder project scope:", err);
      return NextResponse.json(
        { error: "Invalid project scope" },
        { status: 400 },
      );
    }
  }

  const { data, error } = await query;

  if (error) {
    console.error("[Bread] Failed to fetch folders:", error.message);
    return NextResponse.json(
      { error: "Failed to fetch folders" },
      { status: 500 },
    );
  }

  // Project folder_id → id for API stability with existing consumers.
  const folders = (data ?? []).map((row) => {
    const r = row as {
      folder_id: string;
      name: string;
      display_name: string | null;
      kind: string;
      parent_folder_id: string | null;
      visibility: FolderVisibility;
      required_role: WorkspaceMemberRole | null;
      sort_order?: number | null;
      icon?: string | null;
      document_count: number;
      last_seen_at: string;
      created_at: string;
      updated_at: string;
    };
    return {
      id: r.folder_id,
      name: r.name,
      // folders.display_name is nullable; fall back to name so clients can
      // always treat it as a string.
      display_name: r.display_name || r.name,
      kind: r.kind,
      parent_folder_id: r.parent_folder_id,
      visibility: r.visibility,
      required_role: r.required_role,
      sort_order: typeof r.sort_order === "number" ? r.sort_order : null,
      icon: r.icon ?? null,
      document_count: r.document_count,
      last_seen_at: r.last_seen_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });

  return NextResponse.json(folders);
}

// ---------------------------------------------------------------------------
// POST /api/folders
// Creates a new folder in the active workspace.
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

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const visibility: FolderVisibility = body.visibility;
  const requiredRole: WorkspaceMemberRole | null =
    visibility === "role" ? (body.required_role as WorkspaceMemberRole) : null;

  const { data, error } = await supabase
    .from("folders")
    .insert({
      id: body.id,
      name: body.name,
      display_name: body.name,
      kind: "user",
      parent_folder_id: body.parent_folder_id,
      workspace_id: workspace.workspace_id,
      visibility,
      required_role: requiredRole,
    })
    .select(
      "id, name, display_name, kind, parent_folder_id, visibility, required_role, sort_order, created_at, updated_at",
    )
    .single();

  if (error) {
    console.error("[Bread] Failed to create folder:", error.message);
    const status = error.code === "23505" ? 409 : 500;
    return NextResponse.json(
      { error: status === 409 ? "A folder with that name already exists" : "Failed to create folder" },
      { status },
    );
  }

  return NextResponse.json(data, { status: 201 });
}
