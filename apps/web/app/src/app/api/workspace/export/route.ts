import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { normalizeWorkspaceSettings } from "@/lib/workspace-settings";
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportedDocument,
  type ExportedFolder,
  type WorkspaceExport,
} from "@/lib/workspace-export/format";
import { safeSearchParams } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

const querySchema = z.object({
  folder_id: z.string().uuid().optional(),
});

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /api/workspace/export
//
// Streams a strict Breezify-format workspace backup as JSON. Only user-kind
// folders are included; auto-generated topic folders are regenerated on
// ingest so they don't need to live in the backup.
//
// Query params:
//   folder_id (optional) — scope to a single folder + its documents
// ---------------------------------------------------------------------------

interface FolderRow {
  id: string;
  name: string;
  display_name: string | null;
  parent_folder_id: string | null;
  visibility: "workspace" | "role";
  required_role: string | null;
  created_at: string;
}

interface DocumentRow {
  id: string;
  folder_id: string | null;
  title: string;
  content: string;
  source: string | null;
  author: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceRow {
  name: string;
  slug: string | null;
  settings: Record<string, unknown> | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
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

  const parsedQuery = safeSearchParams(request.nextUrl, querySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const scopeFolderId = parsedQuery.data.folder_id ?? null;

  try {
    const wsRes = await supabase
      .from("workspaces")
      .select("name, slug, settings")
      .eq("id", workspace.workspace_id)
      .single();

    if (wsRes.error || !wsRes.data) {
      console.error("[Breezify] export: workspace fetch failed:", wsRes.error?.message);
      return NextResponse.json(
        { error: "Failed to load workspace" },
        { status: 500 },
      );
    }

    const ws = wsRes.data as WorkspaceRow;

    // Only export user-kind folders. Topic folders are derived and regenerated
    // by the ingest pipeline.
    let folderQuery = supabase
      .from("folders")
      .select(
        "id, name, display_name, parent_folder_id, visibility, required_role, created_at, kind",
      )
      .eq("workspace_id", workspace.workspace_id)
      .eq("kind", "user");

    if (scopeFolderId) {
      folderQuery = folderQuery.eq("id", scopeFolderId);
    }

    const folderRes = await folderQuery;
    if (folderRes.error) {
      console.error("[Breezify] export: folders fetch failed:", folderRes.error.message);
      return NextResponse.json(
        { error: "Failed to load folders" },
        { status: 500 },
      );
    }

    const folders: ExportedFolder[] = (folderRes.data ?? []).map((row) => {
      const r = row as FolderRow;
      return {
        id: r.id,
        name: r.name,
        display_name: r.display_name ?? r.name,
        parent_folder_id: r.parent_folder_id,
        visibility: r.visibility,
        required_role: r.required_role,
        created_at: r.created_at,
      };
    });

    let docQuery = supabase
      .from("documents")
      .select(
        "id, folder_id, title, content, source, author, status, created_at, updated_at",
      )
      .eq("workspace_id", workspace.workspace_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (scopeFolderId) {
      docQuery = docQuery.eq("folder_id", scopeFolderId);
    }

    const docRes = await docQuery;
    if (docRes.error) {
      console.error("[Breezify] export: documents fetch failed:", docRes.error.message);
      return NextResponse.json(
        { error: "Failed to load documents" },
        { status: 500 },
      );
    }

    const documents: ExportedDocument[] = (docRes.data ?? []).map((row) => {
      const r = row as DocumentRow;
      return {
        id: r.id,
        folder_id: r.folder_id,
        title: r.title,
        content: r.content,
        source: r.source,
        author: r.author,
        status: r.status,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });

    const payload: WorkspaceExport = {
      format: EXPORT_FORMAT,
      format_version: EXPORT_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      source: {
        workspace_id: workspace.workspace_id,
        workspace_slug: ws.slug,
        workspace_name: ws.name,
      },
      scope: scopeFolderId ? "folder" : "workspace",
      scope_folder_id: scopeFolderId,
      workspace: {
        name: ws.name,
        settings: normalizeWorkspaceSettings(ws.settings),
      },
      folders,
      documents,
      counts: {
        folders: folders.length,
        documents: documents.length,
      },
    };

    const body = JSON.stringify(payload, null, 2);
    const today = new Date().toISOString().slice(0, 10);
    const slugPart = ws.slug ?? workspace.workspace_id.slice(0, 8);
    const scopePart = scopeFolderId ? "-folder" : "";
    const filename = `breezify-export-${slugPart}${scopePart}-${today}.json`;

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[Breezify] export failed:", err);
    return NextResponse.json(
      { error: "Failed to export workspace" },
      { status: 500 },
    );
  }
}
