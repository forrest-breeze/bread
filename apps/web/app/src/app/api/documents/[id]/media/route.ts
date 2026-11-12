import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { safeJsonBody, safeRouteParams, uuidParamSchema } from "@/lib/validation"
import {
  embeddableMediaKind,
  matchesMediaFileSignature,
  MEDIA_UPLOAD_PREPARES_PER_HOUR,
  maxUploadBytesFor,
} from "@/lib/storage/media-upload-policy"
import { buildMediaKey } from "@/lib/storage/blob-store"
import {
  deleteObject,
  getObjectPrefix,
  getSignedUploadUrl,
  headObject,
  isS3Configured,
} from "@/lib/storage/s3"
import { mediaApiUrl } from "@/lib/storage/media-refs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const HASH_RE = /^[a-f0-9]{64}$/
const BASE64_SHA256_RE = /^[A-Za-z0-9+/]{43}=$/

function checksumMatchesContentHash(
  contentHash: string,
  checksumSha256: string,
): boolean {
  return Buffer.from(checksumSha256, "base64").toString("hex") === contentHash
}

function isMediaStorageLimitError(error: {
  message?: string | null
  hint?: string | null
}): boolean {
  return (
    error.hint === "MEDIA_STORAGE_LIMIT" ||
    error.message?.startsWith("Workspace media storage limit reached") === true
  )
}

const mediaRequestSchema = z
  .object({
    action: z.enum(["prepare", "complete"]),
    fileName: z.string().trim().min(1).max(500),
    mime: z.string().trim().min(1).max(100),
    byteSize: z.number().int().positive(),
    contentHash: z.string().regex(HASH_RE),
    checksumSha256: z.string().regex(BASE64_SHA256_RE),
    width: z.number().int().positive().max(100_000).nullable(),
    height: z.number().int().positive().max(100_000).nullable(),
  })
  .strict()

interface MediaRow {
  id: string
  kind: "image" | "video"
  mime: string
  width: number | null
  height: number | null
}

interface StoredMediaRow extends MediaRow {
  storage_key: string
  byte_size: number
  verified_at: string | null
}

function mediaResponse(row: MediaRow): {
  id: string
  src: string
  kind: "image" | "video"
  mime: string
  width: number | null
  height: number | null
} {
  return {
    id: row.id,
    src: mediaApiUrl(row.id),
    kind: row.kind,
    mime: row.mime,
    width: row.width,
    height: row.height,
  }
}

async function discardRejectedUpload(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  contentHash: string,
  storageKey: string,
): Promise<void> {
  try {
    // Delete the object first. If that fails, retain the registry row so the
    // GC still knows which paid object must be retried later.
    await deleteObject(storageKey)
  } catch (error) {
    console.error("[Bread] Failed to delete rejected media object:", error)
    return
  }
  const { error } = await admin
    .from("media_objects")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("content_hash", contentHash)
  if (error) {
    console.error(
      "[Bread] Failed to release rejected media reservation:",
      error.message,
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  const workspace = await getActiveWorkspace(supabase, user.id)
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 })
  }
  if (!["owner", "admin", "editor"].includes(workspace.role)) {
    return NextResponse.json(
      { error: "You do not have permission to add document media" },
      { status: 403 },
    )
  }

  const parsedParams = safeRouteParams(await params, uuidParamSchema)
  if (!parsedParams.ok) return parsedParams.response

  const parsed = await safeJsonBody(request, mediaRequestSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  const kind = embeddableMediaKind(body.mime)
  if (!kind) {
    return NextResponse.json(
      {
        error:
          "Unsupported media type. Use PNG, JPEG, WebP, GIF, AVIF, MP4, WebM, or MOV.",
      },
      { status: 415 },
    )
  }
  if (body.byteSize > maxUploadBytesFor(kind)) {
    return NextResponse.json(
      { error: `${kind === "image" ? "Image" : "Video"} is too large.` },
      { status: 413 },
    )
  }
  // The hexadecimal object-key hash and the checksum enforced by S3 must be
  // two encodings of the same digest. Without this check a caller could point
  // arbitrary bytes at another content-addressed key.
  if (!checksumMatchesContentHash(body.contentHash, body.checksumSha256)) {
    return NextResponse.json(
      { error: "Media checksum did not match its content hash" },
      { status: 400 },
    )
  }
  if (!isS3Configured()) {
    return NextResponse.json(
      { error: "Media storage is not configured" },
      { status: 501 },
    )
  }

  // The document lookup is both an existence check and the workspace/authz
  // boundary. A media upload cannot be prepared against another workspace.
  const { data: document, error: documentError } = await supabase
    .from("documents")
    .select("id")
    .eq("id", parsedParams.data.id)
    .eq("workspace_id", workspace.workspace_id)
    .is("deleted_at", null)
    .maybeSingle()
  if (documentError || !document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 })
  }

  const admin = createAdminClient()
  const { data: existing, error: existingError } = await admin
    .from("media_objects")
    .select("id, kind, mime, width, height, storage_key, byte_size, verified_at")
    .eq("workspace_id", workspace.workspace_id)
    .eq("content_hash", body.contentHash)
    .maybeSingle()
  if (existingError) {
    console.error(
      "[Bread] Failed to check existing media object:",
      existingError.message,
    )
    return NextResponse.json(
      { error: "Could not verify existing media" },
      { status: 503 },
    )
  }

  if (existing && body.action === "prepare") {
    const stored = existing as StoredMediaRow
    if (stored.verified_at) {
      try {
        const object = await headObject(stored.storage_key)
        if (
          object.contentLength === stored.byte_size &&
          (!object.checksumSha256 ||
            object.checksumSha256 === body.checksumSha256)
        ) {
          return NextResponse.json({
            status: "ready",
            media: mediaResponse(stored),
          })
        }
        return NextResponse.json(
          { error: "Stored media could not be verified" },
          { status: 409 },
        )
      } catch (error) {
        console.error("[Bread] Failed to verify existing media:", error)
        return NextResponse.json(
          { error: "Could not verify existing media" },
          { status: 503 },
        )
      }
    }
    // A prior prepare registered a still-pending row. Re-issue the
    // deterministic upload URL below; never demote a verified row to pending.
  }

  const storageKey = buildMediaKey({
    workspaceId: workspace.workspace_id,
    hash: body.contentHash,
    mime: body.mime,
  })

  if (body.action === "prepare") {
    try {
      // Distributed, fail-closed issuance limit. It is checked after the
      // verified-dedupe path above, so opening an existing asset is free but
      // every new/retried bearer upload URL consumes a database-backed slot.
      const { data: uploadAllowed, error: rateLimitError } = await admin.rpc(
        "consume_media_upload_slot",
        { p_user_id: user.id },
      )
      if (rateLimitError) {
        console.error(
          "[Bread] Failed to enforce media upload rate limit:",
          rateLimitError.message,
        )
        return NextResponse.json(
          { error: "Could not verify the media upload limit" },
          { status: 503 },
        )
      }
      if (uploadAllowed !== true) {
        return NextResponse.json(
          {
            error: `Media upload limit reached (${MEDIA_UPLOAD_PREPARES_PER_HOUR} per hour). Try again later.`,
          },
          { status: 429, headers: { "Retry-After": "3600" } },
        )
      }

      // Register before issuing the browser PUT. If the browser disappears
      // after uploading (or never uploads), the existing grace-period GC can
      // still see and reap this row/key; an unregistered S3 object could not be
      // discovered by that collector.
      const { error: pendingError } = await admin.from("media_objects").upsert(
        {
          workspace_id: workspace.workspace_id,
          capture_id: null,
          storage_key: storageKey,
          kind,
          mime: body.mime,
          byte_size: body.byteSize,
          width: body.width,
          height: body.height,
          content_hash: body.contentHash,
          created_by: user.id,
          verified_at: null,
        },
        { onConflict: "workspace_id,content_hash" },
      )
      if (pendingError) {
        if (isMediaStorageLimitError(pendingError)) {
          return NextResponse.json(
            {
              error:
                "This workspace has reached its media storage limit. Delete unused media before uploading more.",
            },
            { status: 413 },
          )
        }
        console.error(
          "[Bread] Failed to register pending media upload:",
          pendingError.message,
        )
        return NextResponse.json(
          { error: "Could not prepare media upload" },
          { status: 500 },
        )
      }

      const uploadUrl = await getSignedUploadUrl({
        key: storageKey,
        contentType: body.mime,
        checksumSha256: body.checksumSha256,
        contentLength: body.byteSize,
      })
      return NextResponse.json({
        status: "upload_required",
        upload: {
          url: uploadUrl,
          headers: {
            "Content-Type": body.mime,
            "Cache-Control": "private, max-age=31536000, immutable",
            "x-amz-checksum-sha256": body.checksumSha256,
          },
        },
      })
    } catch (error) {
      console.error("[Bread] Failed to sign media upload:", error)
      return NextResponse.json(
        { error: "Could not prepare media upload" },
        { status: 503 },
      )
    }
  }

  try {
    const uploaded = await headObject(storageKey)
    if (uploaded.contentLength !== body.byteSize) {
      return NextResponse.json(
        { error: "Uploaded media size did not match the selected file" },
        { status: 409 },
      )
    }
    if (
      uploaded.contentType &&
      uploaded.contentType.toLowerCase() !== body.mime.toLowerCase()
    ) {
      return NextResponse.json(
        { error: "Uploaded media type did not match the selected file" },
        { status: 409 },
      )
    }
    if (
      uploaded.checksumSha256 &&
      uploaded.checksumSha256 !== body.checksumSha256
    ) {
      return NextResponse.json(
        { error: "Uploaded media checksum did not match the selected file" },
        { status: 409 },
      )
    }

    const prefix = await getObjectPrefix(storageKey)
    if (!matchesMediaFileSignature(prefix, body.mime)) {
      await discardRejectedUpload(
        admin,
        workspace.workspace_id,
        body.contentHash,
        storageKey,
      )
      return NextResponse.json(
        { error: "Uploaded bytes were not valid media of the selected type" },
        { status: 415 },
      )
    }
  } catch (error) {
    console.error("[Bread] Failed to verify media upload:", error)
    return NextResponse.json(
      { error: "The media upload was not found in S3" },
      { status: 409 },
    )
  }

  const { data: registered, error: registerError } = await admin
    .from("media_objects")
    .upsert(
      {
        workspace_id: workspace.workspace_id,
        capture_id: null,
        storage_key: storageKey,
        kind,
        mime: body.mime,
        byte_size: body.byteSize,
        width: body.width,
        height: body.height,
        content_hash: body.contentHash,
        created_by: user.id,
        verified_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,content_hash" },
    )
    .select("id, kind, mime, width, height")
    .single()

  if (registerError || !registered) {
    if (registerError && isMediaStorageLimitError(registerError)) {
      return NextResponse.json(
        {
          error:
            "This workspace has reached its media storage limit. Delete unused media before uploading more.",
        },
        { status: 413 },
      )
    }
    console.error(
      "[Bread] Failed to register document media:",
      registerError?.message,
    )
    return NextResponse.json(
      { error: "Could not register uploaded media" },
      { status: 500 },
    )
  }

  return NextResponse.json({
    status: "ready",
    media: mediaResponse(registered as MediaRow),
  })
}
