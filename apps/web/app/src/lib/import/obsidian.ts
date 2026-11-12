import JSZip from "jszip";
import { createImportedDocument } from "@/lib/import/create-imported-document";
import { createAdminClient } from "@/lib/supabase/admin";
import type { JobContext } from "@/lib/import/runner";
import { ObsidianConfigSchema } from "@/lib/import/schemas";

// ---------------------------------------------------------------------------
// Obsidian vault bulk importer.
//
// Inputs: zip file uploaded to Supabase Storage bucket "import-uploads".
// Strategy:
//   1. Download zip from storage (key = upload_id).
//   2. Walk all *.md entries; skip .obsidian/, .trash/, and anything inside
//      a dotfile directory.
//   3. First pass: ingest each note as a doc; record source_ref = vault path.
//      Rewrite [[wikilinks]] to placeholders so we can resolve them after the
//      whole vault is in.
//   4. Second pass: replace placeholder links with real document URLs. If
//      multiple notes share a filename, pick the first match and warn (M2.6
//      tracks path-aware resolution).
// ---------------------------------------------------------------------------

const WIKILINK_RE = /\[\[([^\]|]+)(\|([^\]]+))?\]\]/g;
const PLACEHOLDER_PREFIX = "bread-wikilink:";

interface NoteRecord {
  /** Vault-relative path (e.g. "Engineering/Runbooks/Postgres.md"). */
  path: string;
  basename: string;
  title: string;
  body: string;
  documentId: string | null;
}

export async function runObsidianImport(ctx: JobContext): Promise<void> {
  const cfg = ObsidianConfigSchema.parse(ctx.sourceConfig);
  const admin = createAdminClient();

  // 1. Download the upload.
  const { data: blob, error: dlErr } = await admin.storage
    .from("import-uploads")
    .download(cfg.upload_id);
  if (dlErr || !blob) {
    throw new Error(`Failed to download upload ${cfg.upload_id}: ${dlErr?.message}`);
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  const zip = await JSZip.loadAsync(buf);

  // 2. Collect markdown entries.
  const notes: NoteRecord[] = [];
  const seenBasenames = new Map<string, string[]>();
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (shouldSkip(path)) continue;
    if (!path.toLowerCase().endsWith(".md")) continue;
    const raw = await entry.async("string");
    if (!raw.trim()) continue;
    const basename = basenameNoExt(path);
    const title = basename || path;
    const body = rewriteWikilinks(raw);
    notes.push({ path, basename, title, body, documentId: null });
    const list = seenBasenames.get(basename.toLowerCase()) ?? [];
    list.push(path);
    seenBasenames.set(basename.toLowerCase(), list);
  }

  await ctx.setTotal(notes.length);

  // 3. First pass: ingest.
  for (const note of notes) {
    if (await ctx.isCancelled()) return;
    try {
      const documentId = await createImportedDocument({
        workspaceId: ctx.workspaceId,
        source: "obsidian",
        content: note.body,
        title: note.title,
        authorName: "Obsidian Import",
        authorUserId: ctx.startedBy ?? null,
      });
      note.documentId = documentId;
      await admin
        .from("documents")
        .update({
          source_metadata: {
            source_ref: note.path,
            url: null,
            job_id: ctx.jobId,
          },
        })
        .eq("id", documentId);
      await ctx.recordItem({
        source_ref: note.path,
        title: note.title,
        status: "succeeded",
        document_id: documentId,
      });
    } catch (err) {
      await ctx.recordItem({
        source_ref: note.path,
        title: note.title,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Second pass: resolve wikilinks.
  await resolveWikilinks(notes, seenBasenames);

  // 5. Clean up the upload — single-use, no point keeping it around.
  await admin.storage.from("import-uploads").remove([cfg.upload_id]);
}

function shouldSkip(path: string): boolean {
  const segs = path.split("/");
  for (const seg of segs) {
    if (!seg) continue;
    if (seg === ".obsidian" || seg === ".trash") return true;
    if (seg.startsWith(".") && seg.length > 1) return true;
  }
  return false;
}

function basenameNoExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export function rewriteWikilinks(body: string): string {
  return body.replace(WIKILINK_RE, (_m, target: string, _alias?: string, aliasText?: string) => {
    const label = aliasText ?? target;
    const slug = target.trim().toLowerCase();
    return `[${label}](${PLACEHOLDER_PREFIX}${encodeURIComponent(slug)})`;
  });
}

async function resolveWikilinks(
  notes: NoteRecord[],
  basenameIndex: Map<string, string[]>,
): Promise<void> {
  const admin = createAdminClient();
  const byPath = new Map<string, NoteRecord>();
  for (const n of notes) byPath.set(n.path, n);

  for (const note of notes) {
    if (!note.documentId) continue;
    if (!note.body.includes(PLACEHOLDER_PREFIX)) continue;
    let dirty = false;
    const next = note.body.replace(
      new RegExp(`\\(${PLACEHOLDER_PREFIX}([^)]+)\\)`, "g"),
      (_m, encodedSlug: string) => {
        const slug = decodeURIComponent(encodedSlug);
        const paths = basenameIndex.get(slug);
        if (!paths || paths.length === 0) return "(#)";
        if (paths.length > 1) {
          console.warn(
            `[Bread] obsidian wikilink collision for "${slug}":`,
            paths,
          );
        }
        const target = byPath.get(paths[0]);
        if (!target?.documentId) return "(#)";
        dirty = true;
        return `(/documents/${target.documentId})`;
      },
    );
    if (dirty) {
      await admin
        .from("documents")
        .update({ content: next })
        .eq("id", note.documentId);
    }
  }
}
