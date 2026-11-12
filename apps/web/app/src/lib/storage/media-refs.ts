// ---------------------------------------------------------------------------
// Media references — the bridge between one pure document body and its two
// render surfaces.
//
// Document bodies (`documents.content`) are sanitized HTML. S3-backed images
// and videos are referenced — never embedded — by relative tags whose src
// points at the media read endpoint:
//
//     <img src="/api/media/<id>" alt="...">
//     <video src="/api/media/<id>" controls></video>
//
// The relative "/api/media/..." path deliberately survives the body sanitizer
// (sanitize-dom.ts `isSafeUrl` allows "/"-rooted URLs), so no special-casing in
// the sanitizer is needed. From that single body we derive two surfaces:
//
//   - AI / crawl / embeddings: image *nodes* are already dropped by the RAG
//     ProseMirror walk (nodeToText returns "" for them). For the HTML→text
//     fallback path, stripMediaTagsToText() removes binary media tags while
//     keeping useful labels, so vectors never ingest a media URL.
//   - Human portal:
//       * authenticated app → the /api/media/<id> src works as-is (RLS-gated).
//       * public SSR portal → an anonymous visitor can't hit the RLS-gated
//         endpoint, so rewriteMediaForPublic() swaps the src to the public
//         portal-scope-gated endpoint (/api/public/media/<id>), which serves a
//         CDN or signed URL.
//
// All transforms are pure string ops — no I/O, trivially testable.
// ---------------------------------------------------------------------------

/** App route that resolves a media id to its bytes (authenticated, RLS-gated). */
export const MEDIA_API_PATH = "/api/media/";

/** Public route for media referenced by a public portal document. */
export const PUBLIC_MEDIA_API_PATH = "/api/public/media/";

// Media ids are uuids / url-safe slugs. Keep the class tight so a match never
// runs past the id into surrounding markup.
const MEDIA_SRC_RE = /\/api\/media\/([A-Za-z0-9._-]+)/g;
const ANY_MEDIA_REF_RE = /\/api\/(?:public\/)?media\/([A-Za-z0-9._-]+)/g;
const IMG_TAG_RE = /<img\b[^>]*>/gi;
const VIDEO_TAG_RE =
  /<video\b[^>]*>[\s\S]*?<\/video\s*>|<video\b[^>]*\/?>/gi;
const ALT_ATTR_RE = /\balt\s*=\s*"([^"]*)"/i;
const TITLE_ATTR_RE = /\btitle\s*=\s*"([^"]*)"/i;

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Canonical media URL for a body/render (authenticated app surface). */
export function mediaApiUrl(id: string): string {
  return `${MEDIA_API_PATH}${id}`;
}

/** Public, portal-scope-gated media URL (anonymous portal surface). */
export function publicMediaApiUrl(id: string): string {
  return `${PUBLIC_MEDIA_API_PATH}${id}`;
}

/**
 * Canonical <img> for a stored body. Use when inserting an S3 asset into a
 * document (editor image support / capture→doc linking). alt is escaped.
 */
export function mediaImgHtml(id: string, alt = ""): string {
  return `<img src="${mediaApiUrl(id)}" alt="${escapeHtmlAttr(alt)}">`;
}

/** Canonical playable <video> for a stored document body. */
export function mediaVideoHtml(id: string, title = ""): string {
  const titleAttr = title
    ? ` title="${escapeHtmlAttr(title)}"`
    : "";
  return `<video src="${mediaApiUrl(id)}"${titleAttr} controls playsinline preload="metadata"></video>`;
}

/**
 * Public render surface: rewrite authenticated media srcs to the public,
 * portal-gated endpoint so anonymous SSR visitors can load the asset. Pure
 * string swap of /api/media/<id> → /api/public/media/<id> (already-public refs
 * are left untouched — the negative-lookbehind-free regex only matches the
 * authenticated path).
 */
export function rewriteMediaForPublic(html: string): string {
  return html.replace(
    MEDIA_SRC_RE,
    (_match, id: string) => `${PUBLIC_MEDIA_API_PATH}${id}`,
  );
}

/**
 * AI / HTML-text-fallback surface: strip <img> tags, keeping alt text as a
 * `[image: alt]` marker (or nothing when alt is empty). Keeps embedded text
 * free of media URLs while preserving the descriptive signal.
 */
export function stripImgTagsToText(text: string): string {
  return text.replace(IMG_TAG_RE, (tag) => {
    const alt = ALT_ATTR_RE.exec(tag)?.[1]?.trim() ?? "";
    return alt ? `[image: ${alt}]` : "";
  });
}

/**
 * Remove images and videos from embedding text while preserving their labels.
 * stripImgTagsToText remains exported for image-only compatibility.
 */
export function stripMediaTagsToText(text: string): string {
  return stripImgTagsToText(text).replace(VIDEO_TAG_RE, (tag) => {
    const title = TITLE_ATTR_RE.exec(tag)?.[1]?.trim() ?? "";
    return title ? `[video: ${title}]` : "";
  });
}

/**
 * Every media id referenced by a body (deduped, first-seen order). Matches both
 * the authenticated and public endpoints. Used by GC to find which assets are
 * still referenced.
 */
export function extractMediaIds(body: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(ANY_MEDIA_REF_RE)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
