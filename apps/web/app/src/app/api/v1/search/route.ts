import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, callerRoleFromAuth } from "@/lib/api/authenticate-bearer";
import { handleCorsPreflight, withCors } from "@/lib/api/cors";
import { isWorkspaceOnPaidTier } from "@/lib/db/subscription";
import { retrieveForQuery, formatForLLM } from "@/rag/retrieve";
import { safeSearchParams } from "@/lib/validation";

const querySchema = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(20).default(8),
  document_id: z.string().uuid().optional(),
  budget_tokens: z.coerce.number().int().min(100).max(8000).default(1500),
});

// ---------------------------------------------------------------------------
// GET /api/v1/search?q=...&limit=8&document_id=...&budget_tokens=1500
// Paid-only sectioned semantic search over document_section_chunk with
// ancestor-heading breadcrumbs joined in server-side. Returns both the
// formatted text (for direct LLM consumption via the MCP tool) and structured
// results (for programmatic callers). Free workspaces can use /api/v1/grep.
// Authenticated via workspace API key.
// ---------------------------------------------------------------------------

export function OPTIONS(request: NextRequest): NextResponse {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateBearer(request);
  if (auth.error || !auth.data) {
    return withCors(request, auth.error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }
  const { workspaceId } = auth.data;
  const callerRole = callerRoleFromAuth(auth.data);

  if (!(await isWorkspaceOnPaidTier(workspaceId))) {
    return withCors(
      request,
      NextResponse.json(
        {
          error: "Semantic search is not enabled for this workspace. Use /api/v1/grep instead.",
          code: "payment_required",
        },
        { status: 402 },
      ),
    );
  }

  const parsedQuery = safeSearchParams(request.nextUrl, querySchema);
  if (!parsedQuery.ok) {
    return withCors(request, parsedQuery.response);
  }
  const {
    q: query,
    limit,
    document_id: documentId,
    budget_tokens: budgetTokens,
  } = parsedQuery.data;

  try {
    const results = await retrieveForQuery(query, workspaceId, {
      documentId,
      k: limit,
      callerRole,
    });
    const text = formatForLLM(results, budgetTokens);
    return withCors(request, NextResponse.json({ text, results }));
  } catch (err) {
    console.error("[Breezify] Sectioned search failed:", err);
    return withCors(request, NextResponse.json({ error: "Search failed" }, { status: 500 }));
  }
}
