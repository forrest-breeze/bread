export const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024
export const MAX_VIDEO_UPLOAD_BYTES = 250 * 1024 * 1024

/** Exact, database-backed number of new signed upload URLs per user/hour. */
export const MEDIA_UPLOAD_PREPARES_PER_HOUR = 30

export const IMAGE_UPLOAD_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
] as const

export const VIDEO_UPLOAD_MIME_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const

const IMAGE_MIME_SET = new Set<string>(IMAGE_UPLOAD_MIME_TYPES)
const VIDEO_MIME_SET = new Set<string>(VIDEO_UPLOAD_MIME_TYPES)

export type EmbeddableMediaKind = "image" | "video"

export function embeddableMediaKind(
  mime: string,
): EmbeddableMediaKind | null {
  const normalized = mime.trim().toLowerCase()
  if (IMAGE_MIME_SET.has(normalized)) return "image"
  if (VIDEO_MIME_SET.has(normalized)) return "video"
  return null
}

export function maxUploadBytesFor(kind: EmbeddableMediaKind): number {
  return kind === "image" ? MAX_IMAGE_UPLOAD_BYTES : MAX_VIDEO_UPLOAD_BYTES
}

export function mediaUploadAccept(kind?: EmbeddableMediaKind): string {
  if (kind === "image") return IMAGE_UPLOAD_MIME_TYPES.join(",")
  if (kind === "video") return VIDEO_UPLOAD_MIME_TYPES.join(",")
  return [...IMAGE_UPLOAD_MIME_TYPES, ...VIDEO_UPLOAD_MIME_TYPES].join(",")
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length))
}

/**
 * Verify the file's magic bytes after upload. Browser-supplied MIME metadata
 * is not a security boundary, so completion rejects disguised HTML/binaries.
 */
export function matchesMediaFileSignature(
  bytes: Uint8Array,
  mime: string,
): boolean {
  const normalized = mime.trim().toLowerCase()
  if (normalized === "image/png") {
    return (
      bytes.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, index) => bytes[index] === value,
      )
    )
  }
  if (normalized === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  }
  if (normalized === "image/webp") {
    return bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP"
  }
  if (normalized === "image/gif") {
    const header = ascii(bytes, 0, 6)
    return bytes.length >= 6 && (header === "GIF87a" || header === "GIF89a")
  }
  if (normalized === "image/avif") {
    if (bytes.length < 12 || ascii(bytes, 4, 4) !== "ftyp") return false
    for (let offset = 8; offset + 4 <= bytes.length; offset += 4) {
      const brand = ascii(bytes, offset, 4)
      if (brand === "avif" || brand === "avis") return true
    }
    return false
  }
  if (normalized === "video/webm") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    )
  }
  if (normalized === "video/mp4" || normalized === "video/quicktime") {
    if (bytes.length < 8) return false
    // ISO BMFF normally begins with ftyp. Older QuickTime files may begin
    // with another well-known atom while remaining valid MOV/MP4 media.
    return ["ftyp", "moov", "mdat", "wide", "free"].includes(
      ascii(bytes, 4, 4),
    )
  }
  return false
}

export function formatMediaUploadLimit(kind: EmbeddableMediaKind): string {
  return kind === "image" ? "20 MiB" : "250 MiB"
}
