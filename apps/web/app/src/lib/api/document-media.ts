import {
  embeddableMediaKind,
  formatMediaUploadLimit,
  maxUploadBytesFor,
  type EmbeddableMediaKind,
} from "@/lib/storage/media-upload-policy"

export interface UploadedDocumentMedia {
  id: string
  src: string
  kind: EmbeddableMediaKind
  mime: string
  width: number | null
  height: number | null
}

interface FileDigest {
  hex: string
  base64: string
}

interface MediaDimensions {
  width: number | null
  height: number | null
}

interface ReadyResponse {
  status: "ready"
  media: UploadedDocumentMedia
}

interface UploadRequiredResponse {
  status: "upload_required"
  upload: {
    url: string
    headers: Record<string, string>
  }
}

type PrepareResponse = ReadyResponse | UploadRequiredResponse

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function digestFile(file: File): Promise<FileDigest> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  const bytes = new Uint8Array(digest)
  return { hex: bytesToHex(bytes), base64: bytesToBase64(bytes) }
}

async function imageDimensions(file: File): Promise<MediaDimensions> {
  if (typeof createImageBitmap !== "function") {
    return { width: null, height: null }
  }
  try {
    const bitmap = await createImageBitmap(file)
    const dimensions = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return dimensions
  } catch {
    return { width: null, height: null }
  }
}

async function videoDimensions(file: File): Promise<MediaDimensions> {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return { width: null, height: null }
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    return await new Promise<MediaDimensions>((resolve) => {
      const video = document.createElement("video")
      let settled = false
      const timeout = window.setTimeout(
        () => finish({ width: null, height: null }),
        5_000,
      )
      const finish = (dimensions: MediaDimensions): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        video.removeAttribute("src")
        video.load()
        resolve(dimensions)
      }
      video.preload = "metadata"
      video.onloadedmetadata = () =>
        finish({
          width: video.videoWidth || null,
          height: video.videoHeight || null,
        })
      video.onerror = () => finish({ width: null, height: null })
      video.src = objectUrl
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function readMediaDimensions(
  file: File,
  kind: EmbeddableMediaKind,
): Promise<MediaDimensions> {
  return kind === "image" ? imageDimensions(file) : videoDimensions(file)
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const body = (await response.json().catch(() => null)) as
    | { error?: string; message?: string }
    | null
  return new Error(body?.message || body?.error || fallback)
}

/**
 * Uploads editor media directly from the browser to S3 using a short-lived
 * signed PUT, then registers the S3 key in `media_objects`. The bytes never
 * pass through a Supabase Storage bucket or a Postgres column.
 */
export async function uploadDocumentMedia(
  documentId: string,
  file: File,
): Promise<UploadedDocumentMedia> {
  const mime = file.type.trim().toLowerCase()
  const kind = embeddableMediaKind(mime)
  if (!kind) {
    throw new Error("Use a PNG, JPEG, WebP, GIF, AVIF, MP4, WebM, or MOV file.")
  }
  if (file.size <= 0) {
    throw new Error("The selected file is empty.")
  }
  if (file.size > maxUploadBytesFor(kind)) {
    throw new Error(
      `${kind === "image" ? "Images" : "Videos"} must be ${formatMediaUploadLimit(kind)} or smaller.`,
    )
  }

  const [digest, dimensions] = await Promise.all([
    digestFile(file),
    readMediaDimensions(file, kind),
  ])
  const payload = {
    fileName: file.name,
    mime,
    byteSize: file.size,
    contentHash: digest.hex,
    checksumSha256: digest.base64,
    width: dimensions.width,
    height: dimensions.height,
  }
  const endpoint = `/api/documents/${documentId}/media`

  const prepareResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "prepare", ...payload }),
  })
  if (!prepareResponse.ok) {
    throw await responseError(prepareResponse, "Could not prepare the upload.")
  }

  const prepared = (await prepareResponse.json()) as PrepareResponse
  if (prepared.status === "ready") return prepared.media

  let uploadResponse: Response
  try {
    uploadResponse = await fetch(prepared.upload.url, {
      method: "PUT",
      headers: prepared.upload.headers,
      body: file,
    })
  } catch {
    throw new Error(
      "The upload could not reach S3. Check that the bucket allows browser PUT requests from this app.",
    )
  }
  if (!uploadResponse.ok) {
    throw new Error(`S3 rejected the upload (${uploadResponse.status}).`)
  }

  const completeResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "complete", ...payload }),
  })
  if (!completeResponse.ok) {
    throw await responseError(completeResponse, "Could not finish the upload.")
  }

  const completed = (await completeResponse.json()) as ReadyResponse
  return completed.media
}
