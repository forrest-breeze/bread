import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isS3Configured, publicUrlFor, getSignedReadUrl } from "@/lib/storage/s3";
import {
  isDocInScope,
  type PublicKbScope,
} from "@/lib/public-kb";
import { portalContentScope } from "@/lib/portal/project-scope";
import { validatePortalLayout } from "@/lib/portal/schema";
import { safeRouteParams, uuidParamSchema } from "@/lib/validation";

// ---------------------------------------------------------------------------
// GET /api/public/media/[id] — portal-scoped anonymous media read.
//
// The authenticated sibling (/api/media/[id]) is RLS-gated and only works for
// logged-in workspace members. The PUBLIC SSR portal serves anonymous visitors
// who can't pass RLS, so the public render path rewrites media srcs to this
// endpoint (see rewriteMediaForPublic / public-kb-render.ts).
//
// Because anonymous callers can't satisfy RLS, this uses the service-role admin
// client and enforces the portal gate manually. The asset must be referenced by
// a portal-visible document inside at least one public project (or the legacy
// workspace-wide public portal). Signed-in workspace members retain access for
// private-project previews through the authenticated fallback.
// ---------------------------------------------------------------------------

interface ReferencingDocument {
  id: string;
  folder_id: string | null;
}

const PUBLIC_MEDIA_REFERENCE_PAGE_SIZE = 100;

export async function publiclyReferencesMedia(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  mediaId: string,
  legacyWorkspacePublic: boolean,
): Promise<boolean> {
  // The stable media id is part of the stored document body. Restrict the
  // candidate set to live public document types before applying folder/project
  // scope below; a media row by itself never makes an object public.
  let publicProjects: Array<{ scope: unknown; spec: unknown }> | null = null;

  for (let from = 0; ; from += PUBLIC_MEDIA_REFERENCE_PAGE_SIZE) {
    const { data: candidates, error: candidateError } = await admin
      .from("documents")
      .select("id, folder_id")
      .eq("workspace_id", workspaceId)
      .is("deleted_at", null)
      .in("document_type", ["source", "page"])
      .like("content", `%/api/media/${mediaId}%`)
      .order("id", { ascending: true })
      .range(from, from + PUBLIC_MEDIA_REFERENCE_PAGE_SIZE - 1);
    if (candidateError) return false;

    const rows = (candidates ?? []) as ReferencingDocument[];
    const folderIds = Array.from(
      new Set(
        rows
          .map((row) => row.folder_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const visibleFolderIds = new Set<string>();
    if (folderIds.length > 0) {
      const { data: folders, error: folderError } = await admin
        .from("folders")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("visibility", "workspace")
        .neq("kind", "topic")
        .in("id", folderIds);
      if (folderError) return false;
      for (const folder of folders ?? []) {
        visibleFolderIds.add((folder as { id: string }).id);
      }
    }

    const visibleDocuments = rows.filter(
      (row) => row.folder_id === null || visibleFolderIds.has(row.folder_id),
    );
    if (visibleDocuments.length > 0) {
      if (legacyWorkspacePublic) return true;

      if (publicProjects === null) {
        const { data: projects, error: projectsError } = await admin
          .from("workspace_experiences")
          .select("scope, spec")
          .eq("workspace_id", workspaceId)
          .eq("kind", "kb")
          .eq("audience", "public")
          .eq("status", "published")
          .eq("visibility", "public");
        if (projectsError || !projects?.length) return false;
        publicProjects = projects as Array<{ scope: unknown; spec: unknown }>;
      }

      for (const project of publicProjects) {
        const scope = (project.scope as PublicKbScope) ?? null;
        const layout = validatePortalLayout(project.spec);
        const contentScope = portalContentScope(
          scope,
          layout.ok ? layout.data : null,
        );
        for (const document of visibleDocuments) {
          if (await isDocInScope(workspaceId, document, contentScope)) return true;
        }
      }
    }

    if (rows.length < PUBLIC_MEDIA_REFERENCE_PAGE_SIZE) return false;
  }
}

async function memberCanReadMedia(mediaId: string): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;

    // RLS limits this row to active workspace members.
    const { data } = await supabase
      .from("media_objects")
      .select("id")
      .eq("id", mediaId)
      .maybeSingle();
    return Boolean(data);
  } catch {
    return false;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const parsedParams = safeRouteParams(await params, uuidParamSchema);
  if (!parsedParams.ok) return parsedParams.response;
  const { id } = parsedParams.data;

  const admin = createAdminClient();

  // Admin client bypasses RLS — the workspace publish check below is the gate.
  const { data: media, error } = await admin
    .from("media_objects")
    .select("storage_key, workspace_id")
    .eq("id", id)
    .not("verified_at", "is", null)
    .single();

  if (error || !media) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { storage_key: key, workspace_id: workspaceId } = media as {
    storage_key: string;
    workspace_id: string;
  };

  // The legacy workspace flag remains a valid portal gate, while current
  // portals derive anonymous access from each published project's visibility
  // and scope.
  const { data: workspace, error: wsError } = await admin
    .from("workspaces")
    .select("settings")
    .eq("id", workspaceId)
    .single();

  const settings = (workspace?.settings ?? null) as Record<
    string,
    unknown
  > | null;
  if (wsError || !workspace) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const publiclyReadable = await publiclyReferencesMedia(
    admin,
    workspaceId,
    id,
    settings?.kb_public === true,
  );
  const memberReadable =
    publiclyReadable ? false : await memberCanReadMedia(id);
  if (!publiclyReadable && !memberReadable) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!isS3Configured()) {
    return NextResponse.json(
      { error: "Media storage is not configured" },
      { status: 501 },
    );
  }

  // Prefer a public CDN URL (cacheable); fall back to a short-lived signed URL
  // (must not be cached as if permanent).
  const publicUrl = publicUrlFor(key);
  const url = publicUrl ?? (await getSignedReadUrl(key));

  const res = NextResponse.redirect(url, 302);
  res.headers.set(
    "Cache-Control",
    publiclyReadable && publicUrl
      ? "public, max-age=300"
      : "private, no-store",
  );
  return res;
}
