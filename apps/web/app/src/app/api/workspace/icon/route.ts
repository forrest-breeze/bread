import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { requireRouteUser } from "@/lib/auth/route-auth";

const MAX_SIZE = 2 * 1024 * 1024; // 2MB

const fileSchema = z
  .instanceof(File, { message: "No file provided" })
  .refine(
    (f) =>
      ["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(f.type),
    { message: "Invalid file type. Use PNG, JPEG, WebP, or SVG." },
  )
  .refine((f) => f.size <= MAX_SIZE, {
    message: "File too large. Maximum size is 2MB.",
  });

/** POST /api/workspace/icon — upload a workspace icon */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Only admins can update workspace icon" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const parsed = fileSchema.safeParse(formData.get("file"));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid file" },
      { status: 400 },
    );
  }
  const file = parsed.data;

  const ext = file.name.split(".").pop() ?? "png";
  const path = `workspaces/${membership.workspace_id}/icon.${ext}`;

  const admin = createAdminClient();

  const { error: uploadError } = await admin.storage
    .from("assets")
    .upload(path, file, { upsert: true, contentType: file.type });

  if (uploadError) {
    console.error("[Breezify] Failed to upload icon:", uploadError.message);
    return NextResponse.json({ error: "Failed to upload icon" }, { status: 500 });
  }

  const { data: urlData } = admin.storage
    .from("assets")
    .getPublicUrl(path);

  // Append cache-buster so browsers fetch the new file when replacing an existing icon
  const iconUrl = `${urlData.publicUrl}?v=${Date.now()}`;

  // Update the workspace record (admin client bypasses RLS)
  const { error: updateError } = await admin
    .from("workspaces")
    .update({ icon_url: iconUrl, updated_at: new Date().toISOString() })
    .eq("id", membership.workspace_id);

  if (updateError) {
    console.error("[Breezify] Failed to update workspace icon_url:", updateError.message);
    return NextResponse.json({ error: "Failed to save icon" }, { status: 500 });
  }

  return NextResponse.json({ icon_url: iconUrl });
}

/** DELETE /api/workspace/icon — remove workspace icon */
export async function DELETE(): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const membership = await getActiveWorkspace(supabase, user.id);
  if (!membership || (membership.role !== "admin" && membership.role !== "owner")) {
    return NextResponse.json({ error: "Only admins can update workspace icon" }, { status: 403 });
  }

  // Clear the icon_url
  const admin = createAdminClient();
  await admin
    .from("workspaces")
    .update({ icon_url: null, updated_at: new Date().toISOString() })
    .eq("id", membership.workspace_id);

  return NextResponse.json({ ok: true });
}
