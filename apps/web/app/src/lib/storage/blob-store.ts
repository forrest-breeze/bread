// ---------------------------------------------------------------------------
// Blob store — backend-agnostic policy layer over the S3 object store.
//
// Decides WHAT goes to object storage and under WHICH key. The S3 client
// (./s3) is the transport; this module owns the rules:
//   - Binary media (images, video) always offloads to S3 — these never belong
//     in a Postgres `text` column.
//   - Oversized text bodies offload once they cross OFFLOAD_THRESHOLD_BYTES,
//     so small docs stay inline (cheap reads, no extra round-trip) while large
//     ones stop bloating the row.
//
// Keys are deterministic and workspace-prefixed so a bucket is self-describing
// and a workspace's blobs can be listed/lifecycled by prefix.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/**
 * Text bodies at or above this size offload to S3 instead of living inline.
 * Env-overridable without a deploy. Default 256 KiB — comfortably above a
 * typical runbook, well below the 2 MB document write cap, so only genuinely
 * large docs migrate out of the row.
 */
export function offloadThresholdBytes(): number {
  const raw = process.env.S3_OFFLOAD_THRESHOLD_BYTES;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 256 * 1024;
}

/** True when a UTF-8 text body is large enough to warrant S3 offload. */
export function shouldOffloadText(content: string): boolean {
  return Buffer.byteLength(content, "utf8") >= offloadThresholdBytes();
}

/** Whether a mime type is a binary asset that must never be stored inline. */
export function isBinaryMedia(mime: string): boolean {
  return /^(image|video|audio)\//i.test(mime.trim());
}

// Mime → file extension for object keys. Falls back to a sanitized subtype so
// an unknown but valid mime (e.g. "image/avif") still produces a sane key.
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "application/pdf": "pdf",
  "text/markdown": "md",
  "text/plain": "txt",
};

export function extForMime(mime: string): string {
  const normalized = mime.trim().toLowerCase();
  if (MIME_EXT[normalized]) return MIME_EXT[normalized];
  const subtype = normalized.split("/")[1] ?? "bin";
  // Strip parameters and structured-syntax suffixes ("svg+xml" -> "xml").
  const cleaned = subtype.split(";")[0].split("+").pop() ?? "bin";
  return cleaned.replace(/[^a-z0-9]/g, "") || "bin";
}

/** SHA-256 of bytes, hex. Content-addressed keys dedupe identical uploads. */
export function contentHash(body: Buffer | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface MediaKeyInput {
  workspaceId: string;
  /** SHA-256 hex of the body — call contentHash() if you don't have it. */
  hash: string;
  mime: string;
}

/**
 * Object key for a workspace media asset:
 *   media/<workspaceId>/<hash>.<ext>
 * Content-addressed: re-uploading identical bytes overwrites the same key
 * (idempotent), and the workspace prefix scopes lifecycle + listing.
 */
export function buildMediaKey({ workspaceId, hash, mime }: MediaKeyInput): string {
  return `media/${workspaceId}/${hash}.${extForMime(mime)}`;
}

/**
 * Object key for an offloaded text document body:
 *   docs/<workspaceId>/<documentId>/<hash>.md
 * The documentId segment keeps versions of one doc grouped; the hash makes
 * each version immutable so a rewrite never clobbers history mid-read.
 */
export function buildDocBodyKey(input: {
  workspaceId: string;
  documentId: string;
  hash: string;
}): string {
  return `docs/${input.workspaceId}/${input.documentId}/${input.hash}.md`;
}
