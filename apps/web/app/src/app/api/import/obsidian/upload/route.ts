import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";

// POST /api/import/obsidian/upload — multipart form-data with field "file".
// Admin only. Accepts a .zip up to 100 MB. Returns { upload_id } which the
// caller passes to POST /api/import/jobs as source_config.upload_id.

const MAX_BYTES = 100 * 1024 * 1024;

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;
  const ws = await getActiveWorkspace(supabase, user.id);
  if (!ws) return NextResponse.json({ error: "No workspace" }, { status: 401 });
  if (ws.role !== "admin" && ws.role !== "owner") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  // Validate the file slot via Zod so the route-validation guard is satisfied
  // and we get a single, consistent shape regardless of how the multipart was
  // produced.
  const FileSchema = z
    .custom<File>((v) => v instanceof File, { message: "Missing file" })
    .refine((f) => f.size > 0, { message: "Empty file" })
    .refine((f) => f.size <= MAX_BYTES, {
      message: `File exceeds ${MAX_BYTES / 1024 / 1024} MB limit`,
    })
    .refine((f) => f.name.toLowerCase().endsWith(".zip"), {
      message: "Only .zip uploads supported",
    });
  const parsed = FileSchema.safeParse(formData.get("file"));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid file" },
      { status: 400 },
    );
  }
  const file = parsed.data;

  const uploadId = `${ws.workspace_id}/${randomUUID()}.zip`;
  const buf = Buffer.from(await file.arrayBuffer());

  const admin = createAdminClient();
  const { error } = await admin.storage
    .from("import-uploads")
    .upload(uploadId, buf, {
      contentType: "application/zip",
      upsert: false,
    });

  if (error) {
    console.error("[Bread] obsidian upload failed:", error.message);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, upload_id: uploadId });
}
