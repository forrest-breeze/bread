import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireRouteUser } from "@/lib/auth/route-auth";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { generateEmbedding, isEmbeddingQuotaError } from "@/lib/embeddings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { safeJsonBody } from "@/lib/validation";
import {
  ingestDocument,
  textToProseMirrorDoc,
} from "@/rag/ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Keep each request comfortably below the serverless deadline. The settings
// client advances the cursor until every document in the workspace is done.
const BATCH_SIZE = 5;

const postBodySchema = z.object({
  after: z.string().uuid().nullable().default(null),
});

interface DocumentRow {
  id: string;
  content: string | null;
  status: string | null;
}

export interface ReindexEmbeddingsResponse {
  attempted: number;
  updated: number;
  errors: Array<{ id: string; error: string }>;
  nextCursor: string | null;
  done: boolean;
  remainingAtStart: number;
}

/**
 * Rebuild document-level and published section-chunk embeddings for the active
 * workspace. This is deliberately separate from the global CLI backfill: it
 * uses the signed-in user, requires an admin role, and always scopes admin
 * client reads/writes to the active workspace.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }
  if (workspace.role !== "owner" && workspace.role !== "admin") {
    return NextResponse.json(
      { error: "Only workspace admins can rebuild embeddings" },
      { status: 403 },
    );
  }

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;

  const admin = createAdminClient();
  let query = admin
    .from("documents")
    .select("id, content, status", { count: "exact" })
    .eq("workspace_id", workspace.workspace_id)
    .is("deleted_at", null)
    // Match GET /api/documents: unfiled GitHub repository sources are indexed
    // and retried from GitHub settings, but intentionally hidden from the
    // human Documents tree. Filed/promoted GitHub docs remain in scope.
    .or("folder_id.not.is.null,source.is.null,source.not.ilike.github")
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);
  if (parsed.data.after) query = query.gt("id", parsed.data.after);

  const { data, error, count } = await query;
  if (error) {
    console.error("[Breezify] reindex-embeddings load failed:", error.message);
    return NextResponse.json(
      { error: "Failed to load workspace documents" },
      { status: 500 },
    );
  }

  const docs = (data ?? []) as DocumentRow[];
  const errors: Array<{ id: string; error: string }> = [];
  let updated = 0;

  for (const doc of docs) {
    try {
      const content = doc.content ?? "";
      const embedding = await generateEmbedding(content, "RETRIEVAL_DOCUMENT");
      const { error: updateError } = await admin
        .from("documents")
        .update({ embedding })
        .eq("id", doc.id)
        .eq("workspace_id", workspace.workspace_id);
      if (updateError) {
        throw new Error(`document embedding update: ${updateError.message}`);
      }

      // Published documents power hierarchical semantic search. Force the
      // chunk embedder even when content hashes match, which makes this a true
      // re-index rather than a missing-vector-only backfill.
      if (doc.status === "Published" && content.trim().length > 0) {
        await ingestDocument(doc.id, textToProseMirrorDoc(content), {
          supabase: admin,
          forceReembed: true,
        });
      }
      updated += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Breezify] reindex-embeddings document failed:", doc.id, message);
      errors.push({ id: doc.id, error: message });
      // Advancing through the rest of the workspace cannot succeed while all
      // keys are cooling down. Stop immediately instead of flooding the route
      // with hundreds of guaranteed failures.
      if (isEmbeddingQuotaError(err)) {
        return NextResponse.json(
          {
            error:
              "Embedding quota is temporarily exhausted. Wait a minute, then try again.",
          },
          { status: 429 },
        );
      }
    }
  }

  const attempted = docs.length;
  const done = attempted < BATCH_SIZE;
  const nextCursor = done ? null : docs.at(-1)?.id ?? null;

  return NextResponse.json({
    attempted,
    updated,
    errors,
    nextCursor,
    done,
    remainingAtStart: count ?? attempted,
  });
}
