import { createAdminClient } from "@/lib/supabase/admin";
import { generateEmbedding } from "@/lib/embeddings";
import { fireIngestFromText } from "@/rag/ingest";

/**
 * Write one imported page as a Draft document: title, embedding, insert, and
 * fire the section-chunk indexer so it is searchable. Returns the new
 * document id. Shared by the bulk importers (Notion, Confluence, Obsidian).
 */
export async function createImportedDocument(args: {
  workspaceId: string;
  content: string;
  /** Value stored in `documents.source`, e.g. "notion". */
  source: string;
  title?: string | null;
  authorName: string;
  authorUserId: string | null;
}): Promise<string> {
  if (!args.content.trim()) {
    throw new Error("[createImportedDocument] content is empty");
  }

  const admin = createAdminClient();
  const title = makeDocTitle(args.content, args.title);

  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(args.content, "RETRIEVAL_DOCUMENT");
  } catch (err) {
    console.error("[Bread] createImportedDocument: embedding failed:", err);
  }

  const { data, error } = await admin
    .from("documents")
    .insert({
      workspace_id: args.workspaceId,
      title,
      content: args.content,
      source: args.source,
      status: "Draft",
      author: args.authorName,
      user_id: args.authorUserId,
      ...(embedding ? { embedding } : {}),
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(
      `[createImportedDocument] document insert failed: ${error?.message ?? "unknown"}`,
    );
  }

  const documentId = (data as { id: string }).id;
  fireIngestFromText(documentId, args.content);
  return documentId;
}

function makeDocTitle(content: string, title?: string | null): string {
  if (typeof title === "string" && title.trim().length > 0) {
    return title.trim().slice(0, 200);
  }
  // First non-blank line, stripped of leading `#` markers.
  const firstLine =
    content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const stripped = firstLine.replace(/^#+\s*/, "").slice(0, 200);
  return stripped.length > 0 ? stripped : "Imported document";
}
