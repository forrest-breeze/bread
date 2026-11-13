import { createAdminClient } from "@/lib/supabase/admin";
import { fireIngestFromText } from "@/rag/ingest";
import { crawlWebsite } from "@/lib/import/website-crawl";
import { WebsiteConfigSchema } from "@/lib/import/schemas";
import {
  crawledPagesToDocuments,
  type WebsiteSynthesisDocument,
} from "@/lib/import/website-synthesis";
import {
  ensureCategoryBreadth,
  safePortalCategoryName,
} from "@/lib/portal/category-icons";
import type { JobContext } from "@/lib/import/runner";

// ---------------------------------------------------------------------------
// Website importer — crawl a company's site and import each page verbatim (no AI) as a set
// of starter knowledge-base documents grounded in the real page content.
//
// Used by onboarding ("Create knowledge base" with a website). Runs as a
// background import job so the crawl never blocks the serverless request
// window. Best-effort: if the crawl finds nothing readable,
// the job completes with zero docs and onboarding falls back to starter docs.
//
// This is the SAME initialization the outbound (cold-lead) portal builder
// performs: imported docs are organized into per-category root folders
// (which become the portal's sidebar sections + category cards, each with a
// relevant icon), and the crawled brand logo/accent color are persisted so the
// portal renders in the company's own branding from the first paint.
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function slugifyFolderName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "guides"
  );
}

// Persist everything useful the crawl learned about the brand onto the
// workspace settings: the homepage footer (settings.kb_footer, feeds the rich
// portal footer), and — when the admin hasn't already configured them — the
// brand logo and accent color. Best-effort: merges into existing settings and
// never throws into the import run.
async function persistCrawledBranding(
  workspaceId: string,
  crawl: {
    footer: { columns: unknown[]; social: unknown[]; note?: string } | null;
    logoUrl: string | null;
    accentColor: string | null;
  },
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("workspaces")
      .select("settings")
      .eq("id", workspaceId)
      .maybeSingle();
    const settings = (data?.settings as Record<string, unknown> | null) ?? {};

    const next: Record<string, unknown> = { ...settings };
    if (crawl.footer) next.kb_footer = crawl.footer;
    if (crawl.logoUrl && !settings.kb_brand_logo_url) {
      next.kb_brand_logo_url = crawl.logoUrl;
    }
    if (
      crawl.accentColor &&
      HEX_COLOR_RE.test(crawl.accentColor) &&
      !settings.kb_brand_accent
    ) {
      next.kb_brand_accent = crawl.accentColor;
    }

    await admin
      .from("workspaces")
      .update({ settings: next })
      .eq("id", workspaceId);
  } catch (err) {
    console.error("[Breezify] persistCrawledBranding:", err);
  }
}

// Find-or-create the root portal section folder for a synthesized category.
// visibility 'workspace' + kind 'user' is the public-portal contract
// (lib/public-kb.ts): root folders become the sidebar groups and the home
// category grid. Returns the folder id, or null when the write failed (the doc
// then lands at workspace root — degraded but never lost).
async function ensureCategoryFolder(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    workspaceId: string;
    category: string;
    companyName: string;
    sortOrder: number;
  },
): Promise<string | null> {
  const name = `website-${slugifyFolderName(input.category)}`;
  try {
    const { data: existing } = await admin
      .from("folders")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .eq("kind", "user")
      .eq("name", name)
      .maybeSingle();
    if (existing) return (existing as { id: string }).id;

    const { data: inserted, error } = await admin
      .from("folders")
      .insert({
        workspace_id: input.workspaceId,
        name,
        display_name: input.category,
        kind: "user",
        visibility: "workspace",
        content: `${input.category} for ${input.companyName || "your product"}, generated from the website.`,
        sort_order: input.sortOrder,
      })
      .select("id")
      .single();
    if (error || !inserted) {
      console.error("[Breezify] website import folder create:", error?.message);
      return null;
    }
    return (inserted as { id: string }).id;
  } catch (err) {
    console.error("[Breezify] website import folder:", err);
    return null;
  }
}

export async function runWebsiteImport(ctx: JobContext): Promise<void> {
  const cfg = WebsiteConfigSchema.parse(ctx.sourceConfig);

  const crawl = await crawlWebsite(cfg.url);
  const { pages } = crawl;
  if (await ctx.isCancelled()) return;

  // Save the branding regardless of synthesis outcome — it's useful even if
  // the doc synthesis later fails or the site yields no readable pages.
  await persistCrawledBranding(ctx.workspaceId, crawl);

  if (pages.length === 0) {
    // Nothing to synthesize from — record a skip so the run is auditable.
    await ctx.setTotal(1);
    await ctx.recordItem({
      source_ref: cfg.url,
      title: "Website crawl",
      status: "skipped",
      error: "No readable pages found at the provided URL.",
    });
    return;
  }

  const companyName = cfg.company_name?.trim() ?? "";

  // No AI: each crawled page is imported verbatim (see website-synthesis.ts).
  let docs: WebsiteSynthesisDocument[] = crawledPagesToDocuments({ pages });
  if (docs.length === 0) {
    await ctx.setTotal(1);
    await ctx.recordItem({
      source_ref: cfg.url,
      title: "Website crawl",
      status: "skipped",
      error: "No readable pages found at the provided URL.",
    });
    return;
  }

  // Same category shaping as the outbound builder: widen a mono-category set,
  // then map each doc to a root section folder. Category names that collide
  // with the taxonomy's wrapper-folder heuristic are re-labeled so the section
  // can't silently vanish from the portal.
  docs = ensureCategoryBreadth(docs);
  const categoryNames: string[] = [];
  for (const doc of docs) {
    const category = safePortalCategoryName(doc.category);
    if (!categoryNames.includes(category)) categoryNames.push(category);
  }

  await ctx.setTotal(docs.length);

  const admin = createAdminClient();
  const folderIdByCategory = new Map<string, string | null>();
  for (let index = 0; index < categoryNames.length; index += 1) {
    const category = categoryNames[index]!;
    folderIdByCategory.set(
      category,
      await ensureCategoryFolder(admin, {
        workspaceId: ctx.workspaceId,
        category,
        companyName,
        sortOrder: index,
      }),
    );
  }

  const author = companyName || "Website import";

  for (let i = 0; i < docs.length; i++) {
    if (await ctx.isCancelled()) return;
    const doc = docs[i]!;
    const sourceRef = `website:${cfg.url}#${i}`;
    const folderId =
      folderIdByCategory.get(safePortalCategoryName(doc.category)) ?? null;
    try {
      const { data, error } = await admin
        .from("documents")
        .insert({
          title: doc.title.trim(),
          content: doc.content.trim(),
          source: "Website import",
          status: "Published",
          author,
          workspace_id: ctx.workspaceId,
          folder_id: folderId,
          document_type: "source",
          source_metadata: {
            website_import: true,
            url: cfg.url,
            source_urls: doc.sourceUrls,
            job_id: ctx.jobId,
            summary: doc.summary.trim(),
          },
        })
        .select("id")
        .single();

      if (error || !data) {
        await ctx.recordItem({
          source_ref: sourceRef,
          title: doc.title,
          status: "failed",
          error: error?.message ?? "Insert returned no row",
        });
        continue;
      }

      const documentId = (data as { id: string }).id;
      fireIngestFromText(documentId, doc.content);

      await ctx.recordItem({
        source_ref: sourceRef,
        title: doc.title,
        status: "succeeded",
        document_id: documentId,
      });
    } catch (err) {
      await ctx.recordItem({
        source_ref: sourceRef,
        title: doc.title,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
