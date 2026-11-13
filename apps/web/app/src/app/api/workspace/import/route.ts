import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { parseWorkspaceExport } from "@/lib/workspace-export/format";
import { safeJsonBody } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

export const dynamic = "force-dynamic";

// Cap the payload so a runaway import can't wedge the serverless function.
// At ~5kB average per doc this fits ~10k documents; larger workspaces can
// be split into per-folder exports.
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

// Envelope check: body must be an object. Full structural validation is
// delegated to parseWorkspaceExport, which has the export schema's full type
// model.
const postBodySchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// POST /api/workspace/import
//
// Accepts strictly the Breezify workspace-export format. Inserts folders + docs
// into the active workspace without embeddings; the client follows up with
// /api/workspace/import/process to backfill sections + embeddings in chunks.
// Admin or owner role required.
// ---------------------------------------------------------------------------

interface ExistingFolderRow {
  id: string;
  name: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  if (workspace.role !== "owner" && workspace.role !== "admin") {
    return NextResponse.json(
      { error: "Only workspace admins can import data" },
      { status: 403 },
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_IMPORT_BYTES) {
    return NextResponse.json(
      { error: `Import file too large (max ${MAX_IMPORT_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const envelope = await safeJsonBody(request, postBodySchema);
  if (!envelope.ok) return envelope.response;

  let parsed;
  try {
    parsed = parseWorkspaceExport(envelope.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid export file";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const admin = createAdminClient();
  const wsId = workspace.workspace_id;

  try {
    // -- Folder reconciliation ------------------------------------------------
    // Match existing folders by exact `name`. When one exists, reuse it so
    // re-importing into the same workspace doesn't produce duplicates.
    const existingFoldersRes = await admin
      .from("folders")
      .select("id, name")
      .eq("workspace_id", wsId)
      .eq("kind", "user");

    if (existingFoldersRes.error) {
      throw new Error(`load existing folders: ${existingFoldersRes.error.message}`);
    }

    const existingByName = new Map<string, string>();
    for (const row of (existingFoldersRes.data ?? []) as ExistingFolderRow[]) {
      existingByName.set(row.name, row.id);
    }

    const oldToNewFolderId = new Map<string, string>();
    const foldersToInsert: Array<{
      id: string;
      workspace_id: string;
      name: string;
      display_name: string;
      kind: string;
      parent_folder_id: string | null;
      visibility: "workspace" | "role";
      required_role: string | null;
    }> = [];

    for (const folder of parsed.folders) {
      const existing = existingByName.get(folder.name);
      if (existing) {
        oldToNewFolderId.set(folder.id, existing);
        continue;
      }
      const newId = randomUUID();
      oldToNewFolderId.set(folder.id, newId);
      foldersToInsert.push({
        id: newId,
        workspace_id: wsId,
        name: folder.name,
        display_name: folder.display_name,
        kind: "user",
        parent_folder_id: null,
        visibility: folder.visibility,
        required_role: folder.required_role,
      });
    }

    // Resolve parent_folder_id now that the new ids are known.
    for (const row of foldersToInsert) {
      const source = parsed.folders.find((f) => oldToNewFolderId.get(f.id) === row.id);
      if (source?.parent_folder_id) {
        row.parent_folder_id = oldToNewFolderId.get(source.parent_folder_id) ?? null;
      }
    }

    if (foldersToInsert.length > 0) {
      const insertFoldersRes = await admin
        .from("folders")
        .insert(foldersToInsert);
      if (insertFoldersRes.error) {
        throw new Error(`insert folders: ${insertFoldersRes.error.message}`);
      }
    }

    // -- Document insertion ---------------------------------------------------
    // New uuids — never reuse the source workspace's ids. Preserve created_at
    // so "recent" ordering survives the round-trip.
    const docsToInsert = parsed.documents.map((doc) => ({
      id: randomUUID(),
      workspace_id: wsId,
      user_id: user.id,
      folder_id: doc.folder_id ? oldToNewFolderId.get(doc.folder_id) ?? null : null,
      title: doc.title,
      content: doc.content,
      source: doc.source ?? "Import",
      author: doc.author ?? user.email ?? "Imported",
      status: doc.status ?? "Draft",
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    }));

    const insertedIds: string[] = [];
    if (docsToInsert.length > 0) {
      // Insert in batches to keep individual statements under Postgres limits.
      const BATCH = 200;
      for (let i = 0; i < docsToInsert.length; i += BATCH) {
        const slice = docsToInsert.slice(i, i + BATCH);
        const res = await admin.from("documents").insert(slice).select("id");
        if (res.error) {
          throw new Error(`insert documents: ${res.error.message}`);
        }
        for (const row of res.data ?? []) {
          insertedIds.push((row as { id: string }).id);
        }
      }
    }

    return NextResponse.json({
      folderCount: foldersToInsert.length,
      foldersReused: parsed.folders.length - foldersToInsert.length,
      documentCount: insertedIds.length,
      documentIds: insertedIds,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Breezify] import failed:", message);
    // Generic 500 — internal Postgres / PostgREST error messages can leak
    // column names, constraint names, or partial row data.
    return NextResponse.json(
      { error: "Failed to import workspace" },
      { status: 500 },
    );
  }
}
