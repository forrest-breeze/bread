import { SupabaseClient } from "@supabase/supabase-js";
import { generateEmbedding } from "@/lib/embeddings";
import { fireIngestFromText } from "@/rag/ingest";

export interface CreateWorkspaceDocumentParams {
  supabase: SupabaseClient;
  wsId: string;
  userId: string | null;
  author: string;
  title: string;
  content: string;
  folderId?: string | null;
  source?: string;
  id?: string;
}

export async function createWorkspaceDocument({
  supabase,
  wsId,
  userId,
  author,
  title,
  content,
  folderId,
  source = "Manual",
  id,
}: CreateWorkspaceDocumentParams) {
  // 1. Generate 768-dim embedding
  const embedding = await generateEmbedding(content, "RETRIEVAL_DOCUMENT");

  // 2. Insert into the documents table
  const { data, error } = await supabase
    .from("documents")
    .insert({
      ...(id ? { id } : {}),
      title,
      content,
      source,
      status: "Draft",
      author,
      user_id: userId,
      workspace_id: wsId,
      folder_id: folderId ?? null,
      embedding,
    })
    .select("id, title, content, source, status, author, folder_id, created_at, updated_at")
    .single();

  if (error) {
    throw new Error(`[Bread] Failed to create document: ${error.message}`);
  }

  fireIngestFromText(data.id as string, content);

  return data;
}

export interface UpdateWorkspaceDocumentParams {
  supabase: SupabaseClient;
  docId: string;
  wsId: string;
  title?: string;
  content?: string;
}

export async function updateWorkspaceDocument({
  supabase,
  docId,
  wsId,
  title,
  content,
}: UpdateWorkspaceDocumentParams) {
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (title !== undefined) updates.title = title;
  if (content !== undefined) {
    updates.content = content;
    // Regenerate embedding if content changed
    updates.embedding = await generateEmbedding(content, "RETRIEVAL_DOCUMENT");
  }

  const { data, error } = await supabase
    .from("documents")
    .update(updates)
    .eq("id", docId)
    .eq("workspace_id", wsId)
    .select("id, title, content, source, status, author, folder_id, created_at, updated_at")
    .single();

  if (error) {
    throw new Error(`[Bread] Failed to update document: ${error.message}`);
  }

  if (content !== undefined) {
    fireIngestFromText(docId, content);
  }

  return data;
}
