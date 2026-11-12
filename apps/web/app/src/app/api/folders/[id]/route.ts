import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { generateEmbedding } from "@/lib/embeddings";
import { safeJsonBody, safeRouteParams, slugSchema, uuidParamSchema } from "@/lib/validation";
import type {
  FolderDetailResponse,
  FolderVisibility,
  TopicMergeResult,
  WorkspaceMemberRole,
} from "@/lib/types";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { PUBLIC_KB_CACHE_TAG } from "@/lib/public-kb";

const patchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    parent_folder_id: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v || null),
    visibility: z.enum(["workspace", "role"]).optional(),
    required_role: z
      .enum(["owner", "admin", "editor", "viewer", "agent-only"])
      .nullable()
      .optional(),
    // Kebab-case portal icon name (brand glyph or lucide); null clears back to
    // the automatic name-based icon.
    icon: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.visibility === "role" && !data.required_role) {
      ctx.addIssue({
        code: "custom",
        message: "required_role is required when visibility is 'role'",
        path: ["required_role"],
      });
    }
  });

// ---------------------------------------------------------------------------
// GET /api/folders/[id]
// Returns a single folder with its immediate children and documents.
// Used by the Confluence-style folder page.
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let projectSlug: string | undefined;
  try {
    const rawProject = new URL(request.url).searchParams.get("project");
    if (rawProject) {
      const parsedProject = slugSchema.safeParse(rawProject);
      if (!parsedProject.success) throw new Error("Invalid project slug");
      projectSlug = parsedProject.data;
    }
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
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const { data: folder, error: folderErr } = await supabase
    .from("folders")
    .select(
      "id, name, display_name, kind, parent_folder_id, visibility, required_role, content, sort_order, icon, last_seen_at, created_at, updated_at",
    )
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id)
    .maybeSingle();

  if (folderErr) {
    console.error("[Bread] Failed to fetch folder detail:", folderErr.message);
    return NextResponse.json(
      { error: "Failed to fetch folder" },
      { status: 500 },
    );
  }

  if (!folder) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  let allowedFolderIds: Set<string> | null = null;
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
      allowedFolderIds = new Set(
        await getPublicVisibleFolderIds(workspace.workspace_id, project.scope),
      );
      if (!allowedFolderIds.has(id)) {
        return NextResponse.json({ error: "Folder not found" }, { status: 404 });
      }
    } catch (err) {
      console.error("[Bread] Failed to resolve folder detail project scope:", err);
      return NextResponse.json(
        { error: "Invalid project scope" },
        { status: 400 },
      );
    }
  }

  let childrenQuery = supabase
      .from("folder_stats")
      .select(
        "folder_id, name, display_name, kind, parent_folder_id, visibility, required_role, sort_order, icon, document_count, last_seen_at, updated_at",
      )
      .eq("workspace_id", workspace.workspace_id)
      .eq("parent_folder_id", id)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true });

  if (allowedFolderIds) {
    const ids = Array.from(allowedFolderIds);
    childrenQuery =
      ids.length > 0
        ? childrenQuery.in("folder_id", ids)
        : childrenQuery.in("folder_id", ["00000000-0000-0000-0000-000000000000"]);
  }

  const [childrenRes, docsRes, ancestorsRes] = await Promise.all([
    childrenQuery,
    supabase
      .from("documents")
      .select("id, title, source, author, updated_at")
      .eq("workspace_id", workspace.workspace_id)
      .eq("folder_id", id)
      .is("deleted_at", null)
      .in("document_type", ["source", "page"])
      .order("updated_at", { ascending: false }),
    loadAncestors(supabase, workspace.workspace_id, (folder as { parent_folder_id: string | null }).parent_folder_id),
  ]);

  if (childrenRes.error) {
    console.error("[Bread] Failed to fetch folder children:", childrenRes.error.message);
    return NextResponse.json(
      { error: "Failed to fetch folder children" },
      { status: 500 },
    );
  }

  if (docsRes.error) {
    console.error("[Bread] Failed to fetch folder documents:", docsRes.error.message);
    return NextResponse.json(
      { error: "Failed to fetch folder documents" },
      { status: 500 },
    );
  }

  const children = (childrenRes.data ?? []).map((row) => {
    const r = row as {
      folder_id: string;
      name: string;
      display_name: string;
      kind: string;
      parent_folder_id: string | null;
      visibility: FolderVisibility;
      required_role: WorkspaceMemberRole | null;
      sort_order?: number | null;
      icon?: string | null;
      document_count: number;
      last_seen_at: string;
      updated_at: string;
    };
    return {
      id: r.folder_id,
      name: r.name,
      display_name: r.display_name || r.name,
      kind: r.kind as "user" | "topic" | "system",
      parent_folder_id: r.parent_folder_id,
      visibility: r.visibility,
      required_role: r.required_role,
      sort_order: typeof r.sort_order === "number" ? r.sort_order : null,
      icon: r.icon ?? null,
      document_count: r.document_count,
      last_seen_at: r.last_seen_at,
      updated_at: r.updated_at,
    };
  });

  const payload: FolderDetailResponse = {
    folder: {
      ...folder,
      display_name: folder.display_name || folder.name,
    } as FolderDetailResponse["folder"],
    children,
    documents: (docsRes.data ?? []) as FolderDetailResponse["documents"],
    ancestors: allowedFolderIds
      ? ancestorsRes.filter((ancestor) => allowedFolderIds.has(ancestor.id))
      : ancestorsRes,
  };

  return NextResponse.json(payload);
}

async function loadAncestors(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string,
  startParentId: string | null,
): Promise<FolderDetailResponse["ancestors"]> {
  const chain: FolderDetailResponse["ancestors"] = [];
  let cursor: string | null = startParentId;
  let guard = 0;
  while (cursor && guard < 64) {
    const { data } = await supabase
      .from("folders")
      .select("id, name, display_name, parent_folder_id")
      .eq("id", cursor)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!data) break;
    const row = data as {
      id: string;
      name: string;
      display_name: string;
      parent_folder_id: string | null;
    };
    chain.unshift({ id: row.id, name: row.name, display_name: row.display_name || row.name });
    cursor = row.parent_folder_id;
    guard += 1;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// PATCH /api/folders/[id]
// Updates a folder (name, parent_folder_id, or touch updated_at).
// ---------------------------------------------------------------------------

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
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

  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const parsed = await safeJsonBody(request, patchBodySchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (body.parent_folder_id && body.parent_folder_id === id) {
    return NextResponse.json(
      { error: "A folder cannot be its own parent" },
      { status: 400 },
    );
  }

  // Topic folders are admin-managed (rename + merge); user folders keep the
  // open member-editable behavior below. Load kind to branch.
  const { data: folderRow, error: folderError } = await supabase
    .from("folders")
    .select("id, kind, name")
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id)
    .maybeSingle();
  if (folderError || !folderRow) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }
  const folder = folderRow as { id: string; kind: string; name: string };

  if (folder.kind === "topic") {
    if (!["owner", "admin"].includes(workspace.role)) {
      return NextResponse.json(
        { error: "Only workspace admins can manage topics" },
        { status: 403 },
      );
    }
    const newDisplay = body.name?.trim();
    if (!newDisplay) {
      return NextResponse.json(
        { error: "A new name is required to rename a topic" },
        { status: 400 },
      );
    }
    return renameOrMergeTopic({
      folderId: folder.id,
      currentName: folder.name,
      newDisplay,
      workspaceId: workspace.workspace_id,
    });
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (body.name !== undefined) {
    updates.name = body.name;
    updates.display_name = body.name;
  }
  if (body.parent_folder_id !== undefined) {
    updates.parent_folder_id = body.parent_folder_id;
  }
  if (body.visibility !== undefined) {
    if (body.visibility === "role") {
      updates.visibility = "role";
      updates.required_role = body.required_role as WorkspaceMemberRole;
    } else {
      updates.visibility = "workspace";
      updates.required_role = null;
    }
  }
  if (body.icon !== undefined) updates.icon = body.icon;

  const { data, error } = await supabase
    .from("folders")
    .update(updates)
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id)
    .select(
      "id, name, parent_folder_id, visibility, required_role, content, sort_order, icon, created_at, updated_at",
    )
    .single();

  if (error || !data) {
    console.error("[Bread] Failed to update folder:", error?.message);
    return NextResponse.json(
      { error: "Failed to update folder" },
      { status: 500 },
    );
  }

  // The icon renders on the published portal (sidebar + category grid) via the
  // cached public taxonomy — expire it so the change shows without waiting out
  // the revalidate window.
  if (body.icon !== undefined) {
    revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 });
  }

  return NextResponse.json(data);
}

// ---------------------------------------------------------------------------
// Topic rename / merge (admin-gated by the PATCH caller). A rename whose new
// normalized name collides with an existing topic is treated as a merge into
// that topic. A plain rename records the old name in topic_aliases — so a later
// sweep that re-emits it resolves back to this folder instead of minting a
// duplicate — and refreshes the embedding for future dedup. Uses the
// service-role client because topic curation writes topic_aliases and invokes
// the service-role merge RPC.
// ---------------------------------------------------------------------------
async function renameOrMergeTopic(args: {
  folderId: string;
  currentName: string;
  newDisplay: string;
  workspaceId: string;
}): Promise<NextResponse> {
  const { folderId, currentName, newDisplay, workspaceId } = args;
  const newName = newDisplay.toLowerCase();
  const admin = createAdminClient();

  // Collision with another topic's name → merge this folder into it.
  if (newName !== currentName) {
    const { data: collision } = await admin
      .from("folders")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "topic")
      .eq("name", newName)
      .neq("id", folderId)
      .maybeSingle();

    if (collision) {
      const targetId = (collision as { id: string }).id;
      const { data: result, error: mergeError } = await admin.rpc(
        "merge_topic_folders",
        {
          p_workspace_id: workspaceId,
          p_source_ids: [folderId],
          p_target_id: targetId,
        },
      );
      if (mergeError) {
        console.error("[Bread] folders PATCH: rename-merge failed:", mergeError.message);
        return NextResponse.json({ error: "Failed to rename topic" }, { status: 500 });
      }
      return NextResponse.json({ merged: true, ...(result as TopicMergeResult) });
    }
  }

  // Plain rename.
  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(newDisplay, "RETRIEVAL_DOCUMENT");
  } catch (err) {
    console.error("[Bread] folders PATCH: topic embedding failed:", err);
  }

  const { data: updated, error: updateError } = await admin
    .from("folders")
    .update({
      name: newName,
      display_name: newDisplay,
      ...(embedding ? { embedding } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", folderId)
    .eq("workspace_id", workspaceId)
    .select(
      "id, name, display_name, kind, parent_folder_id, visibility, required_role, sort_order, created_at, updated_at",
    )
    .single();
  if (updateError || !updated) {
    console.error("[Bread] folders PATCH: topic rename failed:", updateError?.message);
    const status = updateError?.code === "23505" ? 409 : 500;
    return NextResponse.json(
      {
        error:
          status === 409
            ? "A topic with that name already exists"
            : "Failed to rename topic",
      },
      { status },
    );
  }

  // Record the retired name as an alias → this folder (skip a display-only
  // case edit where the normalized name is unchanged).
  if (newName !== currentName && currentName) {
    const { error: aliasError } = await admin.from("topic_aliases").upsert(
      {
        workspace_id: workspaceId,
        alias_name: currentName,
        canonical_folder_id: folderId,
      },
      { onConflict: "workspace_id,alias_name" },
    );
    if (aliasError) {
      console.error("[Bread] folders PATCH: alias write failed:", aliasError.message);
    }
  }

  return NextResponse.json(updated);
}

// ---------------------------------------------------------------------------
// DELETE /api/folders/[id]
// Deletes a folder and its entire subtree. Documents inside the subtree are
// moved to trash (soft delete) so they stay restorable. Topic folders keep
// their flat unfile-and-delete behavior (topics cannot nest).
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
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

  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  // Topic folders are admin-managed; deleting one is a topic-management action.
  const { data: target } = await supabase
    .from("folders")
    .select("kind")
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id)
    .maybeSingle();
  if (
    target &&
    (target as { kind: string }).kind === "topic" &&
    !["owner", "admin"].includes(workspace.role)
  ) {
    return NextResponse.json(
      { error: "Only workspace admins can delete topics" },
      { status: 403 },
    );
  }

  if (target && (target as { kind: string }).kind === "topic") {
    const admin = createAdminClient();
    try {
      const { error: pageDeleteError } = await admin
        .from("documents")
        .delete()
        .eq("workspace_id", workspace.workspace_id)
        .eq("folder_id", id)
        .eq("document_type", "topic_page");

      if (pageDeleteError) {
        console.error("[Bread] Failed to delete topic page:", pageDeleteError.message);
        return NextResponse.json(
          { error: "Failed to delete topic" },
          { status: 500 },
        );
      }

      const { error: unfileError } = await admin
        .from("documents")
        .update({ folder_id: null })
        .eq("workspace_id", workspace.workspace_id)
        .eq("folder_id", id)
        .is("deleted_at", null);

      if (unfileError) {
        console.error("[Bread] Failed to unfile topic documents:", unfileError.message);
        return NextResponse.json(
          { error: "Failed to delete topic" },
          { status: 500 },
        );
      }

      const { error } = await admin
        .from("folders")
        .delete()
        .eq("id", id)
        .eq("workspace_id", workspace.workspace_id)
        .eq("kind", "topic");

      if (error) {
        console.error("[Bread] Failed to delete topic:", error.message);
        return NextResponse.json(
          { error: "Failed to delete topic" },
          { status: 500 },
        );
      }

      revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 });
      return NextResponse.json({ success: true });
    } catch (err) {
      console.error("[Bread] Failed to delete topic:", err);
      return NextResponse.json(
        { error: "Failed to delete topic" },
        { status: 500 },
      );
    }
  }

  try {
    // Collect the full descendant subtree. The parent_folder_id FK is
    // ON DELETE SET NULL, so deleting only the target row would re-root its
    // children instead of removing them. Depth guard mirrors the DB trigger's
    // 64-level cap.
    const subtreeIds: string[] = [id];
    const seen = new Set<string>(subtreeIds);
    let frontier: string[] = [id];
    let depth = 0;
    while (frontier.length > 0 && depth < 64) {
      const { data: childRows, error: childError } = await supabase
        .from("folders")
        .select("id")
        .eq("workspace_id", workspace.workspace_id)
        .in("parent_folder_id", frontier);
      if (childError) {
        console.error("[Bread] Failed to load folder subtree:", childError.message);
        return NextResponse.json(
          { error: "Failed to delete folder" },
          { status: 500 },
        );
      }
      frontier = ((childRows ?? []) as { id: string }[])
        .map((row) => row.id)
        .filter((childId) => !seen.has(childId));
      for (const childId of frontier) {
        seen.add(childId);
        subtreeIds.push(childId);
      }
      depth += 1;
    }

    // Move every document in the subtree to trash (restorable). When the
    // folder rows go away the documents.folder_id FK nulls out, so a later
    // restore lands the document at the root level.
    const deletedAt = new Date().toISOString();
    const { error: docsError } = await supabase
      .from("documents")
      .update({ deleted_at: deletedAt, updated_at: deletedAt })
      .in("folder_id", subtreeIds)
      .eq("workspace_id", workspace.workspace_id)
      .is("deleted_at", null);

    if (docsError) {
      console.error(
        "[Bread] Failed to trash documents in folder subtree:",
        docsError.message,
      );
      return NextResponse.json(
        { error: "Failed to delete folder" },
        { status: 500 },
      );
    }

    const { error } = await supabase
      .from("folders")
      .delete()
      .in("id", subtreeIds)
      .eq("workspace_id", workspace.workspace_id);

    if (error) {
      console.error("[Bread] Failed to delete folder:", error.message);
      return NextResponse.json(
        { error: "Failed to delete folder" },
        { status: 500 },
      );
    }

    // The database trigger prunes every deleted subtree id from all portal
    // project versions. Expire both project-scope and taxonomy/document caches
    // so the preview and published portal reflect that atomic cleanup now.
    revalidateTag(PUBLIC_KB_CACHE_TAG, { expire: 0 });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[Bread] Failed to delete folder:", err);
    return NextResponse.json(
      { error: "Failed to delete folder" },
      { status: 500 },
    );
  }
}
