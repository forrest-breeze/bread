import { createImportedDocument } from "@/lib/import/create-imported-document";
import type { JobContext } from "@/lib/import/runner";
import { ConfluenceConfigSchema } from "@/lib/import/schemas";
import { storageToMarkdown } from "@/lib/import/confluence-converter";

// ---------------------------------------------------------------------------
// Confluence Cloud bulk importer.
//
// Auth: HTTP Basic with email + API token (Cloud convention).
// One-time migration. Bread becomes canonical post-import.
//
// Strategy:
//   1. If space_keys[] is provided, iterate each space; else search the
//      whole site (CQL: type=page).
//   2. For each page: GET /wiki/rest/api/content/:id?expand=body.storage
//      to fetch the page in Confluence storage format.
//   3. Convert storage XHTML → markdown via storageToMarkdown (best-effort).
//   4. Ingest via createImportedDocument().
//
// Confluence Server is NOT supported in v1 — different auth + slightly
// different REST shape. Tracked as M2.7.
// ---------------------------------------------------------------------------

const CONTENT_LIMIT = 100;

interface ConfluencePage {
  id: string;
  title: string;
  status?: string;
  _links: { webui?: string; base?: string };
  body?: { storage?: { value?: string; representation?: string } };
}

interface ConfluencePageList {
  results: ConfluencePage[];
  start: number;
  limit: number;
  size: number;
  _links?: { next?: string };
}

export async function runConfluenceImport(ctx: JobContext): Promise<void> {
  const cfg = ConfluenceConfigSchema.parse(ctx.sourceConfig);
  const baseUrl = cfg.base_url.replace(/\/$/, "");
  const fetcher = makeConfluenceFetcher(baseUrl, cfg.email, cfg.api_token);

  // 1. Gather page IDs.
  const pageIds = new Set<string>();

  if (cfg.space_keys?.length) {
    for (const key of cfg.space_keys) {
      let start = 0;
      while (true) {
        const res = await fetcher<ConfluencePageList>(
          `/wiki/rest/api/content?spaceKey=${encodeURIComponent(key)}&type=page&limit=${CONTENT_LIMIT}&start=${start}`,
        );
        for (const p of res.results) pageIds.add(p.id);
        if (!res._links?.next) break;
        start += res.limit;
      }
    }
  } else {
    let start = 0;
    while (true) {
      const res = await fetcher<ConfluencePageList>(
        `/wiki/rest/api/content?type=page&limit=${CONTENT_LIMIT}&start=${start}`,
      );
      for (const p of res.results) pageIds.add(p.id);
      if (!res._links?.next) break;
      start += res.limit;
    }
  }

  await ctx.setTotal(pageIds.size);

  for (const pageId of pageIds) {
    if (await ctx.isCancelled()) return;
    try {
      const page = await fetcher<ConfluencePage>(
        `/wiki/rest/api/content/${pageId}?expand=body.storage`,
      );
      const storage = page.body?.storage?.value ?? "";
      const md = storageToMarkdown(storage);
      const title = page.title || `Confluence page ${pageId}`;

      if (!md.trim()) {
        await ctx.recordItem({
          source_ref: pageId,
          title,
          status: "skipped",
          error: "empty page",
        });
        continue;
      }

      const documentId = await createImportedDocument({
        workspaceId: ctx.workspaceId,
        source: "confluence",
        content: md,
        title: title,
        authorName: "Confluence Import",
        authorUserId: ctx.startedBy ?? null,
      });

      const fullUrl = page._links.webui
        ? `${baseUrl}/wiki${page._links.webui}`
        : null;
      const { createAdminClient } = await import("@/lib/supabase/admin");
      await createAdminClient()
        .from("documents")
        .update({
          source_metadata: {
            source_ref: pageId,
            url: fullUrl,
            job_id: ctx.jobId,
          },
        })
        .eq("id", documentId);

      await ctx.recordItem({
        source_ref: pageId,
        title,
        status: "succeeded",
        document_id: documentId,
      });
    } catch (err) {
      await ctx.recordItem({
        source_ref: pageId,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function makeConfluenceFetcher(
  baseUrl: string,
  email: string,
  apiToken: string,
): <T>(path: string) => Promise<T> {
  const basic = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return async <T>(path: string): Promise<T> => {
    let attempt = 0;
    while (true) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/json",
        },
      });
      if (res.status === 429 && attempt < 4) {
        const wait = Number(res.headers.get("retry-after") ?? "2");
        await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
        attempt++;
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Confluence ${res.status} ${path}: ${body.slice(0, 300)}`,
        );
      }
      return (await res.json()) as T;
    }
  };
}
