import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, callerRoleFromAuth } from "@/lib/api/authenticate-bearer";
import { handleCorsPreflight, withCors } from "@/lib/api/cors";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeSearchParams } from "@/lib/validation";

// ---------------------------------------------------------------------------
// GET /api/v1/grep?q=...&regex=false&limit=50&max_per_doc=5
//
// The literal/regex retrieval lane. Complements /api/v1/search (semantic) by
// surfacing exact identifier hits (env-var names, function names, stack
// fragments) that vector search routinely misses.
// ---------------------------------------------------------------------------

const querySchema = z.object({
  q: z.string().trim().min(1).max(500),
  regex: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  max_per_doc: z.coerce.number().int().min(1).max(50).default(5),
});

interface GrepRow {
  document_id: string;
  title: string;
  line_number: number;
  line_text: string;
}

/**
 * Render grep rows as ripgrep-shaped text so an LLM client can parse it the
 * same way it parses local-ripgrep output: `<title> (<id>):<line>:<text>`.
 * Truncate each line to keep one runaway document from blowing the budget.
 */
export function formatGrepForLLM(rows: GrepRow[], maxLineChars = 240): string {
  if (rows.length === 0) return "No matches found.";
  return rows
    .map((r) => {
      const text = r.line_text.length > maxLineChars
        ? `${r.line_text.slice(0, maxLineChars)}…`
        : r.line_text;
      return `${r.title} (${r.document_id}):${r.line_number}: ${text}`;
    })
    .join("\n");
}

export function OPTIONS(request: NextRequest): NextResponse {
  return handleCorsPreflight(request);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authenticateBearer(request);
  if (auth.error || !auth.data) {
    return withCors(
      request,
      auth.error ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );
  }
  const { workspaceId } = auth.data;
  const callerRole = callerRoleFromAuth(auth.data);

  const parsedQuery = safeSearchParams(request.nextUrl, querySchema);
  if (!parsedQuery.ok) {
    return withCors(request, parsedQuery.response);
  }
  const { q, regex, limit, max_per_doc } = parsedQuery.data;

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("grep_documents", {
      p_workspace_id: workspaceId,
      p_pattern: q,
      p_is_regex: regex,
      p_max_results: limit,
      p_max_per_doc: max_per_doc,
      p_caller_role: callerRole,
    });

    if (error) {
      console.error("[Bread] grep_documents rpc failed:", error);
      return withCors(
        request,
        NextResponse.json({ error: "Grep failed" }, { status: 500 }),
      );
    }

    const rows = (data ?? []) as GrepRow[];
    const text = formatGrepForLLM(rows);
    return withCors(request, NextResponse.json({ text, results: rows }));
  } catch (err) {
    console.error("[Bread] grep route error:", err);
    return withCors(
      request,
      NextResponse.json({ error: "Grep failed" }, { status: 500 }),
    );
  }
}
