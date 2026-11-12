import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeRouteParams, uuidParamSchema } from "@/lib/validation";
import type {
  DocumentLinkEntry,
  DocumentLinkStrength,
  DocumentLinksResponse,
} from "@/lib/types";
import { requireRouteUser } from "@/lib/auth/route-auth";

// ---------------------------------------------------------------------------
// GET /api/documents/[id]/links
//
// Returns the sweep-created cross-links for a document, split by direction:
//   - outbound: this document is the source (related / supersedes / duplicate)
//   - inbound:  another document points at this one ("referenced by")
//
// `document_links` is workspace-scoped at the RLS layer, but the *linked*
// documents are gated by folder visibility (`can_access_folder`). We therefore
// resolve the referenced documents through the user-scoped server client so
// links pointing at documents the caller cannot see are dropped automatically.
// ---------------------------------------------------------------------------

const VALID_STRENGTHS: ReadonlySet<DocumentLinkStrength> = new Set([
  "related",
  "supersedes",
  "duplicate_of",
]);

interface LinkedDocRow {
  id: string;
  title: string;
  source: string | null;
  document_type: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No workspace found" }, { status: 404 });
  }

  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  try {
    // Confirm the base document is visible to the caller before exposing its
    // link graph. RLS (workspace + can_access_folder) gates this read.
    const { data: base } = await supabase
      .from("documents")
      .select("id")
      .eq("id", id)
      .eq("workspace_id", workspace.workspace_id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!base) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const [outboundRes, inboundRes] = await Promise.all([
      supabase
        .from("document_links")
        .select("target_document_id, strength")
        .eq("workspace_id", workspace.workspace_id)
        .eq("source_document_id", id),
      supabase
        .from("document_links")
        .select("source_document_id, strength")
        .eq("workspace_id", workspace.workspace_id)
        .eq("target_document_id", id),
    ]);

    if (outboundRes.error || inboundRes.error) {
      console.error(
        "[Bread] Failed to load document links:",
        outboundRes.error?.message ?? inboundRes.error?.message,
      );
      return NextResponse.json(
        { error: "Failed to load document links" },
        { status: 500 },
      );
    }

    const outboundRows = (outboundRes.data ?? []) as Array<{
      target_document_id: string;
      strength: string;
    }>;
    const inboundRows = (inboundRes.data ?? []) as Array<{
      source_document_id: string;
      strength: string;
    }>;

    // Resolve every referenced document in a single round-trip. RLS drops any
    // the caller cannot access; deleted documents are excluded.
    const referencedIds = Array.from(
      new Set([
        ...outboundRows.map((r) => r.target_document_id),
        ...inboundRows.map((r) => r.source_document_id),
      ]),
    );

    const docsById = new Map<string, LinkedDocRow>();
    if (referencedIds.length > 0) {
      const { data: docs, error: docsErr } = await supabase
        .from("documents")
        .select("id, title, source, document_type")
        .eq("workspace_id", workspace.workspace_id)
        .is("deleted_at", null)
        .in("id", referencedIds);

      if (docsErr) {
        console.error("[Bread] Failed to resolve linked documents:", docsErr.message);
        return NextResponse.json(
          { error: "Failed to load document links" },
          { status: 500 },
        );
      }

      for (const doc of (docs ?? []) as LinkedDocRow[]) {
        docsById.set(doc.id, doc);
      }
    }

    const toEntry = (
      docId: string,
      strength: string,
    ): DocumentLinkEntry | null => {
      const doc = docsById.get(docId);
      if (!doc) return null;
      const normalizedStrength: DocumentLinkStrength = VALID_STRENGTHS.has(
        strength as DocumentLinkStrength,
      )
        ? (strength as DocumentLinkStrength)
        : "related";
      return {
        id: doc.id,
        title: doc.title,
        source: doc.source,
        document_type: doc.document_type,
        strength: normalizedStrength,
      };
    };

    const outbound = outboundRows
      .map((r) => toEntry(r.target_document_id, r.strength))
      .filter((e): e is DocumentLinkEntry => e !== null);
    const inbound = inboundRows
      .map((r) => toEntry(r.source_document_id, r.strength))
      .filter((e): e is DocumentLinkEntry => e !== null);

    const payload: DocumentLinksResponse = { outbound, inbound };
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[Bread] Failed to load document links:", err);
    return NextResponse.json(
      { error: "Failed to load document links" },
      { status: 500 },
    );
  }
}
