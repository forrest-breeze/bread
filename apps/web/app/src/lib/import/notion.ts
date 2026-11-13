import { createImportedDocument } from "@/lib/import/create-imported-document";
import type { JobContext } from "@/lib/import/runner";
import { NotionConfigSchema } from "@/lib/import/schemas";

// ---------------------------------------------------------------------------
// Notion bulk importer — REST against api.notion.com (no SDK dep).
// One-time migration. Breezify becomes canonical post-import.
//
// Strategy:
//   1. If page_ids[] is set, import those exactly.
//      Else if database_ids[] is set, query each DB for all pages.
//      Else search the workspace ("filter=page") for all pages the
//      integration token can see.
//   2. For each page: fetch blocks recursively, render to markdown.
//   3. Ingest with createImportedDocument().
//   4. Idempotent within a job — recordItem upserts on (job_id, source_ref)
//      so a re-run skips already-succeeded pages.
// ---------------------------------------------------------------------------

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const PAGE_LIMIT = 100;

interface NotionListResponse<T> {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

interface NotionPage {
  id: string;
  url: string;
  archived?: boolean;
  parent: { type: string; database_id?: string; page_id?: string };
  properties: Record<string, unknown>;
  object: "page";
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

export async function runNotionImport(ctx: JobContext): Promise<void> {
  const cfg = NotionConfigSchema.parse(ctx.sourceConfig);

  const fetchJSON = makeFetcher(cfg.access_token);
  const pageIds = new Set<string>();

  if (cfg.page_ids?.length) {
    for (const id of cfg.page_ids) pageIds.add(id);
  } else if (cfg.database_ids?.length) {
    for (const dbId of cfg.database_ids) {
      let cursor: string | undefined;
      do {
        const res = await fetchJSON<NotionListResponse<NotionPage>>(
          `/databases/${dbId}/query`,
          {
            method: "POST",
            body: { start_cursor: cursor, page_size: PAGE_LIMIT },
          },
        );
        for (const p of res.results) pageIds.add(p.id);
        cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
      } while (cursor);
    }
  } else {
    let cursor: string | undefined;
    do {
      const res = await fetchJSON<NotionListResponse<NotionPage>>(`/search`, {
        method: "POST",
        body: {
          filter: { value: "page", property: "object" },
          start_cursor: cursor,
          page_size: PAGE_LIMIT,
        },
      });
      for (const p of res.results) pageIds.add(p.id);
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);
  }

  await ctx.setTotal(pageIds.size);

  for (const pageId of pageIds) {
    if (await ctx.isCancelled()) return;
    try {
      const page = await fetchJSON<NotionPage>(`/pages/${pageId}`);
      if (page.archived) {
        await ctx.recordItem({
          source_ref: pageId,
          title: extractPageTitle(page),
          status: "skipped",
          error: "archived",
        });
        continue;
      }
      const title = extractPageTitle(page) || `Notion page ${pageId.slice(0, 8)}`;
      const blocks = await fetchBlockTree(fetchJSON, pageId, cfg.include_subpages);
      const body = renderBlocksToMarkdown(blocks);
      if (!body.trim()) {
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
        source: "notion",
        content: body,
        title: title,
        authorName: "Notion Import",
        authorUserId: ctx.startedBy ?? null,
      });

      // Stamp source_metadata for back-link.
      const { createAdminClient } = await import("@/lib/supabase/admin");
      await createAdminClient()
        .from("documents")
        .update({
          source_metadata: {
            source_ref: pageId,
            url: page.url,
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

// ---------------------------------------------------------------------------

interface FetchOpts {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}

type Fetcher = <T>(path: string, opts?: FetchOpts) => Promise<T>;

function makeFetcher(accessToken: string): Fetcher {
  return async <T>(path: string, opts?: FetchOpts): Promise<T> => {
    const method = opts?.method ?? "GET";
    let attempt = 0;
    while (true) {
      const res = await fetch(`${NOTION_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 429 && attempt < 4) {
        const wait = Number(res.headers.get("retry-after") ?? "1");
        await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
        attempt++;
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Notion ${res.status} ${path}: ${body.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    }
  };
}

async function fetchBlockTree(
  fetchJSON: Fetcher,
  blockId: string,
  recurseChildren: boolean,
): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const qs = cursor
      ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=${PAGE_LIMIT}`
      : `?page_size=${PAGE_LIMIT}`;
    const page = await fetchJSON<NotionListResponse<NotionBlock>>(
      `/blocks/${blockId}/children${qs}`,
    );
    for (const block of page.results) {
      out.push(block);
      if (recurseChildren && block.has_children && block.type !== "child_page") {
        const children = await fetchBlockTree(fetchJSON, block.id, recurseChildren);
        (block as { _children?: NotionBlock[] })._children = children;
      }
    }
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return out;
}

function extractPageTitle(page: NotionPage): string {
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key] as { type?: string; title?: unknown[] } | undefined;
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map(richTextPlain).join("").trim();
    }
  }
  return "";
}

function richTextPlain(rt: unknown): string {
  const r = rt as { plain_text?: string };
  return r?.plain_text ?? "";
}

function richTextArray(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr.map(richTextPlain).join("");
}

// ---------------------------------------------------------------------------
// Block → markdown. Covers ~95% of common Notion page content. Unknown
// blocks render as a placeholder so the conversion never crashes.
// ---------------------------------------------------------------------------

export function renderBlocksToMarkdown(blocks: NotionBlock[], depth = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const block of blocks) {
    const md = renderBlock(block, depth);
    if (md) lines.push(indent + md.replace(/\n/g, `\n${indent}`));

    const children = (block as { _children?: NotionBlock[] })._children;
    if (children?.length) {
      const childMd = renderBlocksToMarkdown(children, depth + 1);
      if (childMd) lines.push(childMd);
    }
  }
  return lines.join("\n\n");
}

function renderBlock(block: NotionBlock, depth: number): string {
  const t = block.type;
  const data = (block as Record<string, unknown>)[t] as
    | Record<string, unknown>
    | undefined;
  if (!data) return "";

  const rich = (data["rich_text"] ?? data["text"]) as unknown;

  switch (t) {
    case "paragraph":
      return richTextArray(rich);
    case "heading_1":
      return `# ${richTextArray(rich)}`;
    case "heading_2":
      return `## ${richTextArray(rich)}`;
    case "heading_3":
      return `### ${richTextArray(rich)}`;
    case "bulleted_list_item":
      return `- ${richTextArray(rich)}`;
    case "numbered_list_item":
      return `1. ${richTextArray(rich)}`;
    case "to_do": {
      const checked = data["checked"] === true ? "x" : " ";
      return `- [${checked}] ${richTextArray(rich)}`;
    }
    case "quote":
      return `> ${richTextArray(rich).replace(/\n/g, "\n> ")}`;
    case "callout":
      return `> ${richTextArray(rich)}`;
    case "code": {
      const lang = (data["language"] as string) ?? "";
      return "```" + lang + "\n" + richTextArray(rich) + "\n```";
    }
    case "divider":
      return "---";
    case "child_page":
      return `**↳ Sub-page:** ${(data["title"] as string) ?? "(untitled)"}`;
    case "toggle":
      return `<details><summary>${richTextArray(rich)}</summary></details>`;
    case "bookmark":
    case "embed":
    case "link_preview":
      return `[link](${(data["url"] as string) ?? ""})`;
    case "image":
    case "video":
    case "file":
    case "pdf": {
      const file = data["file"] as { url?: string } | undefined;
      const ext = data["external"] as { url?: string } | undefined;
      const url = file?.url ?? ext?.url ?? "";
      return url ? `![${t}](${url})` : `*[${t} attachment]*`;
    }
    default:
      // Unknown block type — never crash; leave a marker.
      void depth;
      return `*[${t}]*`;
  }
}
