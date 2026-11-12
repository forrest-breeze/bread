import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { isWorkspaceOnPaidTier } from "@/lib/db/subscription";
import { generateEmbedding } from "@/lib/embeddings";
import { searchSettingsHybrid } from "@/lib/settings-search-server";
import { safeSearchParams } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

const querySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  // 0.65 matches SETTINGS_SEMANTIC_THRESHOLD — off-topic queries that don't
  // appear in any doc should return nothing, not a loose semantic match.
  threshold: z.coerce.number().min(0).max(1).default(0.65),
});

// ---------------------------------------------------------------------------
// GET /api/search?q=...&limit=5&threshold=0.65
//
// Combined knowledge + settings response for the command palette:
//   - knowledge (all tiers): title substring matches first, so a short query
//     like "quick" always finds "Quick Start".
//   - paid knowledge: + pgvector cosine (skipped when embedding / vector
//     lookup fails) + keyword grep over content.
//   - free knowledge: + keyword grep over content, with no embedding
//     generation.
//   - settings: in-process hybrid (keyword + cosine) over SETTINGS_CATALOG,
//     reusing the query embedding already generated for pgvector.
//
// Always 200 once auth + input validation pass — both top-level fields are
// non-null arrays and consumers can render whatever's available.
// ---------------------------------------------------------------------------

/**
 * Shape of one row returned by the `match_documents` RPC. Fields beyond
 * `id` and `title` are optional because `match_documents` is the only
 * caller and may evolve its return columns; consumers should be tolerant.
 */
export interface KnowledgeResult {
  id: string;
  title: string;
  content?: string;
  source?: string | null;
  author?: string | null;
  updated_at?: string;
  similarity?: number;
}

interface GrepDocumentRow {
  document_id: string;
  title: string;
  line_number: number;
  line_text: string;
}

interface SearchResponse {
  knowledge: KnowledgeResult[];
  settings: SettingsResponseEntry[];
}

interface SettingsResponseEntry {
  id: string;
  label: string;
  href: string;
  description: string;
  score: number;
  matchedKeyword?: string;
  highlight?: { field: "label" | "description"; span: [number, number] };
  breadcrumb?: string[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const parsedQuery = safeSearchParams(request.nextUrl, querySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const { q: trimmed, limit, threshold } = parsedQuery.data;

  // Resolve workspace lazily — settings work without one.
  const workspace = await getActiveWorkspace(supabase, user.id);
  const paidWorkspace = workspace
    ? await isWorkspaceOnPaidTier(workspace.workspace_id)
    : false;

  // 1) Generate query embedding once. Reused for pgvector AND for settings
  //    semantic ranking. Failure here downgrades knowledge to [] and falls
  //    back to keyword-only settings.
  let queryEmbedding: number[] | null = null;
  if (workspace && paidWorkspace) {
    try {
      queryEmbedding = await generateEmbedding(trimmed, "RETRIEVAL_QUERY");
    } catch (err) {
      console.error("[Bread] Query embedding failed:", err);
      queryEmbedding = null;
    }
  }

  // 2) Knowledge. Three sources, merged in priority order and deduped by id:
  //    a) title substring match — always, for every tier. Vector similarity
  //       of a short query ("quick") against a whole-document embedding
  //       rarely clears the threshold, and grep_documents only emits rows for
  //       matching *content* lines, so without this a doc titled
  //       "Quick Start" was unreachable by searching "quick".
  //    b) paid: pgvector semantic matches.
  //    c) content keyword matches via grep_documents (free: the only content
  //       path; paid: catches exact terms the vector pass misses).
  let knowledge: KnowledgeResult[] = [];
  if (workspace) {
    const titlePromise = searchTitles(supabase, workspace.workspace_id, trimmed, limit);
    const grepPromise = grepContent(supabase, workspace, trimmed, limit);
    let vector: KnowledgeResult[] = [];
    if (paidWorkspace && queryEmbedding) {
      const { data, error } = await supabase.rpc("match_documents", {
        query_embedding: queryEmbedding,
        match_threshold: threshold,
        match_count: limit,
        workspace_id: workspace.workspace_id,
      });
      if (error) {
        console.error("[Bread] Vector search failed:", error.message);
      } else if (Array.isArray(data)) {
        vector = data as KnowledgeResult[];
      }
    }
    const [titles, grep] = await Promise.all([titlePromise, grepPromise]);
    knowledge = mergeKnowledge([titles, vector, grep], limit);
  }

  // 3) Settings — always computed. Hybrid scoring uses the query embedding
  //    when available, degrades to keyword-only when not.
  const settingsMatches = searchSettingsHybrid(trimmed, queryEmbedding);
  const settings: SettingsResponseEntry[] = settingsMatches.map((m) => ({
    id: m.entry.id,
    label: m.entry.label,
    href: m.entry.href,
    description: m.entry.description,
    score: m.score,
    matchedKeyword: m.matchedKeyword,
    highlight: m.highlight,
    breadcrumb: m.entry.breadcrumb,
  }));

  const body: SearchResponse = { knowledge, settings };
  return NextResponse.json(body);
}

type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

/** Escape LIKE/ILIKE wildcards so user input is matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Case-insensitive title substring match. Uses the caller's RLS-scoped
 * client, so folder visibility is enforced by the documents read policy.
 */
async function searchTitles(
  supabase: ServerSupabase,
  workspaceId: string,
  q: string,
  limit: number,
): Promise<KnowledgeResult[]> {
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, updated_at")
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .ilike("title", `%${escapeLike(q)}%`)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[Bread] Title search failed:", error.message);
    return [];
  }
  const rows = (data ?? []) as KnowledgeResult[];
  // Titles that start with the query rank above mid-title matches.
  const lower = q.toLowerCase();
  return [...rows].sort(
    (a, b) =>
      Number(!a.title.toLowerCase().startsWith(lower)) -
      Number(!b.title.toLowerCase().startsWith(lower)),
  );
}

async function grepContent(
  supabase: ServerSupabase,
  workspace: { workspace_id: string; role: string },
  q: string,
  limit: number,
): Promise<KnowledgeResult[]> {
  const { data, error } = await supabase.rpc("grep_documents", {
    p_workspace_id: workspace.workspace_id,
    p_pattern: q,
    p_is_regex: false,
    p_max_results: limit,
    p_max_per_doc: 1,
    p_caller_role: workspace.role,
  });
  if (error) {
    console.error("[Bread] Keyword search failed:", error.message);
    return [];
  }
  if (!Array.isArray(data)) return [];
  return (data as GrepDocumentRow[]).map((row) => ({
    id: row.document_id,
    title: row.title,
    content: row.line_text,
  }));
}

function mergeKnowledge(
  sources: KnowledgeResult[][],
  limit: number,
): KnowledgeResult[] {
  const seen = new Set<string>();
  const out: KnowledgeResult[] = [];
  for (const source of sources) {
    for (const row of source) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
