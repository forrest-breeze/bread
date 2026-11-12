// ---------------------------------------------------------------------------
// Embeddings: disabled.
//
// The Breeze internal build sends no content to any AI provider, so nothing is
// embedded. These functions keep their call sites working and return `null`:
// documents and chunks are stored without a vector, and search runs on the
// keyword paths only (title match, grep_documents, and the full-text lane of
// match_document_section_chunks_hybrid, which skips its vector lane when the
// query embedding is null).
//
// To bring semantic search back, implement these against a Breeze-approved
// provider and re-embed (POST /api/workspace/reindex-embeddings).
// ---------------------------------------------------------------------------

export type TaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING";

/** A stored embedding. Always null in this build. */
export type Embedding = number[] | null;

export const EMBEDDINGS_ENABLED = false as const;

export async function generateEmbedding(
  _text: string,
  _taskType: TaskType = "RETRIEVAL_DOCUMENT",
): Promise<Embedding> {
  return null;
}

export async function generateEmbeddings(
  texts: string[],
  _taskType: TaskType = "RETRIEVAL_DOCUMENT",
): Promise<Embedding[]> {
  return texts.map(() => null);
}

/** Kept for callers that pause on provider quota; there is no provider. */
export function isEmbeddingQuotaError(_err: unknown): boolean {
  return false;
}
