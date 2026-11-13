import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { generateEmbedding } from "@/lib/embeddings";
import { ingestDocument, textToProseMirrorDoc } from "@/rag/ingest";
import { safeJsonBody } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// POST /api/workspace/import/process
//
// Chunked follow-up to /api/workspace/import. Accepts up to MAX_PER_CALL
// document ids, generates the document-level embedding + section/chunk rows
// for each one, and returns per-id status so the client can loop until done.
//
// Keeping the per-call work bounded avoids Netlify function timeouts on
// large imports. The client is responsible for calling this repeatedly with
// the remaining ids it received from the initial import.
// ---------------------------------------------------------------------------

const MAX_PER_CALL = 10;

const postBodySchema = z.object({
  documentIds: z.array(z.string().uuid()).max(MAX_PER_CALL).default([]),
});

interface DocRow {
  id: string;
  content: string;
  workspace_id: string;
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
      { error: "Only workspace admins can process imports" },
      { status: 403 },
    );
  }

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  const ids = parsed.data.documentIds;

  if (ids.length === 0) {
    return NextResponse.json({ processed: [], errors: [] });
  }

  const admin = createAdminClient();

  const docsRes = await admin
    .from("documents")
    .select("id, content, workspace_id")
    .in("id", ids)
    .eq("workspace_id", workspace.workspace_id);

  if (docsRes.error) {
    console.error("[Breezify] import/process: load docs failed:", docsRes.error.message);
    return NextResponse.json(
      { error: "Failed to load documents" },
      { status: 500 },
    );
  }

  const docs = (docsRes.data ?? []) as DocRow[];
  const processed: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];

  for (const doc of docs) {
    try {
      const content = doc.content ?? "";
      if (content.trim().length === 0) {
        processed.push(doc.id);
        continue;
      }

      const embedding = await generateEmbedding(content, "RETRIEVAL_DOCUMENT");
      const { error: updateError } = await admin
        .from("documents")
        .update({ embedding })
        .eq("id", doc.id);
      if (updateError) {
        throw new Error(`document embedding update: ${updateError.message}`);
      }

      await ingestDocument(doc.id, textToProseMirrorDoc(content));
      processed.push(doc.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Breezify] import/process doc failed:", doc.id, message);
      errors.push({ id: doc.id, error: message });
    }
  }

  return NextResponse.json({ processed, errors });
}
