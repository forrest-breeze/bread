import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeJsonBody } from "@/lib/validation";
import type { TopicMergeResult } from "@/lib/types";
import { requireRouteUser } from "@/lib/auth/route-auth";

export const dynamic = "force-dynamic";

const mergeBodySchema = z
  .object({
    source_ids: z.array(z.string().uuid()).min(1).max(50),
    target_id: z.string().uuid(),
  })
  .superRefine((data, ctx) => {
    if (data.source_ids.includes(data.target_id)) {
      ctx.addIssue({
        code: "custom",
        message: "target_id cannot also be a source_id",
        path: ["target_id"],
      });
    }
  });

// ---------------------------------------------------------------------------
// POST /api/folders/merge
// Folds N source topic folders into a target via the atomic merge_topic_folders
// RPC. Workspace admins only. Queues target topic-page regeneration after the
// merge commits.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }

  if (!["owner", "admin"].includes(workspace.role)) {
    return NextResponse.json(
      { error: "Only workspace admins can merge topics" },
      { status: 403 },
    );
  }

  const parsed = await safeJsonBody(request, mergeBodySchema);
  if (!parsed.ok) return parsed.response;
  const { target_id } = parsed.data;
  const sourceIds = [...new Set(parsed.data.source_ids)].filter(
    (id) => id !== target_id,
  );

  if (sourceIds.length === 0) {
    return NextResponse.json(
      { error: "At least one distinct source topic is required" },
      { status: 400 },
    );
  }

  try {
    const admin = createAdminClient();

    // Defense in depth: confirm every id is a topic folder in this workspace
    // before invoking the RPC, so a bad id yields a clean 400 rather than a
    // 500 from the RPC's RAISE.
    const allIds = [...new Set([...sourceIds, target_id])];
    const { data: found, error: foundError } = await admin
      .from("folders")
      .select("id")
      .eq("workspace_id", workspace.workspace_id)
      .eq("kind", "topic")
      .in("id", allIds);
    if (foundError) {
      console.error("[Breezify] folders/merge: topic lookup failed:", foundError.message);
      return NextResponse.json({ error: "Failed to merge topics" }, { status: 500 });
    }
    if (!found || found.length !== allIds.length) {
      return NextResponse.json(
        { error: "All source and target folders must be topics in this workspace" },
        { status: 400 },
      );
    }

    const { data: result, error: mergeError } = await admin.rpc(
      "merge_topic_folders",
      {
        p_workspace_id: workspace.workspace_id,
        p_source_ids: sourceIds,
        p_target_id: target_id,
      },
    );
    if (mergeError) {
      console.error("[Breezify] folders/merge: rpc failed:", mergeError.message);
      return NextResponse.json({ error: "Failed to merge topics" }, { status: 500 });
    }

    return NextResponse.json(result as TopicMergeResult);
  } catch (err) {
    console.error("[Breezify] folders/merge:", err);
    return NextResponse.json({ error: "Failed to merge topics" }, { status: 500 });
  }
}
