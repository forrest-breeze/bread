import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { safeJsonBody } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

// Returning 404 rather than 400 on bad params is deliberate — it doesn't
// leak which conversation IDs exist.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
});

// ---------------------------------------------------------------------------
// GET /api/conversations/:id
// Returns a conversation with its messages.
// ---------------------------------------------------------------------------

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("id, title, workspace_id, user_id, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (convError || !conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 },
    );
  }

  // `id` is a deterministic tiebreak, not decoration: rows written before the
  // POST route stamped per-row timestamps share one `now()` across a batch, so
  // `created_at` alone leaves an exchange's user/assistant pair in arbitrary
  // order. The truncate DELETE orders identically — the portal builder's
  // checkpoint restore cuts the thread by position, so a read order that
  // disagrees with the delete order drops the wrong rows.
  const { data: messages, error: msgError } = await supabase
    .from("chat_messages")
    .select("id, role, content, parts, created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (msgError) {
    console.error("[Bread] Failed to fetch messages:", msgError.message);
    return NextResponse.json(
      { error: "Failed to fetch messages" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ...conversation, messages: messages ?? [] });
}

// ---------------------------------------------------------------------------
// PATCH /api/conversations/:id
// Update conversation title.
// ---------------------------------------------------------------------------

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = await safeJsonBody(request, patchBodySchema);
  if (!parsed.ok) return parsed.response;
  const { title } = parsed.data;

  const { data, error } = await supabase
    .from("conversations")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, title, updated_at")
    .single();

  if (error) {
    console.error("[Bread] Failed to update conversation:", error.message);
    return NextResponse.json(
      { error: "Failed to update conversation" },
      { status: 500 },
    );
  }

  return NextResponse.json(data);
}

// ---------------------------------------------------------------------------
// DELETE /api/conversations/:id
// ---------------------------------------------------------------------------

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    console.error("[Bread] Failed to delete conversation:", error.message);
    return NextResponse.json(
      { error: "Failed to delete conversation" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
