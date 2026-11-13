import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getActiveWorkspace } from "@/lib/db/workspace"
import { requireRouteUser } from "@/lib/auth/route-auth"
import { isPortalEditorEnabledForWorkspace } from "@/lib/db/subscription"

// ---------------------------------------------------------------------------
// POST /api/portal/logo — upload a per-PROJECT portal logo asset.
//
// Distinct from /api/workspace/kb-brand/logo (which owns the single workspace
// brand logo at a fixed path): this writes a uniquely-named file under the
// workspace's portal-logos/ prefix so a project's custom logo never overwrites
// the workspace brand logo or another project's. Returns the public URL; the
// builder then stores it on the project's theme.logoUrl via the normal draft
// save. Leaving theme.logoUrl blank falls back to the workspace logo.
// ---------------------------------------------------------------------------

const MAX_SIZE = 2 * 1024 * 1024 // 2MB
const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
}

const fileSchema = z
  .instanceof(File, { message: "No file provided" })
  .refine((file) => Object.keys(MIME_EXTENSION).includes(file.type), {
    message: "Invalid file type. Use PNG, JPEG, WebP, or SVG.",
  })
  .refine((file) => file.size <= MAX_SIZE, {
    message: "File too large. Maximum size is 2MB.",
  })

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { user, response: authResponse } = await requireRouteUser(supabase)
  if (!user) return authResponse

  const membership = await getActiveWorkspace(supabase, user.id)
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json(
      { error: "Only workspace admins and owners can upload a portal logo" },
      { status: 403 },
    )
  }
  if (!(await isPortalEditorEnabledForWorkspace(membership.workspace_id))) {
    return NextResponse.json(
      {
        error: "The portal editor is not enabled for this workspace",
        message: "This workspace cannot upload portal logos.",
        code: "payment_required",
      },
      { status: 402 },
    )
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 })
  }

  const parsed = fileSchema.safeParse(formData.get("file"))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid file" },
      { status: 400 },
    )
  }

  const file = parsed.data
  const ext = MIME_EXTENSION[file.type] ?? "png"
  // Unique filename so each upload is its own asset (no cross-project clobber).
  const path = `workspaces/${membership.workspace_id}/portal-logos/${Date.now()}.${ext}`
  const admin = createAdminClient()

  const { error: uploadError } = await admin.storage
    .from("assets")
    .upload(path, file, { upsert: true, contentType: file.type })

  if (uploadError) {
    console.error("[Breezify] portal logo upload:", uploadError.message)
    return NextResponse.json({ error: "Failed to upload logo" }, { status: 500 })
  }

  const { data: urlData } = admin.storage.from("assets").getPublicUrl(path)
  return NextResponse.json({ logo_url: urlData.publicUrl })
}
