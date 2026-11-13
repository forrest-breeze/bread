import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeJsonBody } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

// Returning 404 rather than 400 on bad params is deliberate — it doesn't
// leak which conversation IDs exist.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// POST /api/conversations/:id/messages
// Batch-insert messages and touch conversation.updated_at.
// ---------------------------------------------------------------------------

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  parts: z.array(z.record(z.string(), z.unknown())).optional(),
});

const postBodySchema = z.object({
  messages: z.array(messageSchema).min(1),
});

export async function POST(
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

  // Verify ownership
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 },
    );
  }

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  // Stamp created_at explicitly, one millisecond apart. The column defaults to
  // now(), which is the TRANSACTION timestamp — every row of a batch insert
  // would share it, leaving a user/assistant exchange with no stable order and
  // readers falling back to a random uuid tiebreak. Ordering matters: the
  // portal builder's checkpoint restore truncates the thread by position.
  const batchStart = Date.now();
  const rows = parsed.data.messages.map((m, index) => ({
    conversation_id: id,
    role: m.role,
    content: m.content,
    parts: m.parts ?? null,
    created_at: new Date(batchStart + index).toISOString(),
  }));

  const { error: insertError } = await supabase
    .from("chat_messages")
    .insert(rows);

  if (insertError) {
    console.error("[Breezify] Failed to insert messages:", insertError.message);
    return NextResponse.json(
      { error: "Failed to save messages" },
      { status: 500 },
    );
  }

  // Touch updated_at so the conversation sorts to the top
  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true, count: rows.length }, { status: 201 });
}

// ---------------------------------------------------------------------------
// DELETE /api/conversations/:id/messages?keep=N
// Truncate a thread to its first N messages (ordered oldest-first), dropping
// everything after them. Used by the portal builder's checkpoint restore, which
// rolls the transcript back to the restored turn — without this the dropped
// turns would reappear on the next load.
//
// chat_messages has no DELETE policy (RLS grants members read + insert only),
// so the row removal runs on the admin client after ownership is verified with
// the caller's own client above.
// ---------------------------------------------------------------------------

export async function DELETE(
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

  // `keep` must be an explicit non-negative integer. Coercion alone would turn a
  // missing or empty param into 0 and silently wipe the whole thread.
  const rawKeep = new URL(request.url).searchParams.get("keep");
  const keep = /^\d+$/.test(rawKeep ?? "")
    ? z.coerce.number().int().min(0).safeParse(rawKeep)
    : null;

  if (!keep?.success) {
    return NextResponse.json({ error: "Invalid keep" }, { status: 400 });
  }

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 },
    );
  }

  const { data: messages, error: readError } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (readError) {
    console.error("[Breezify] Failed to read messages:", readError.message);
    return NextResponse.json(
      { error: "Failed to truncate messages" },
      { status: 500 },
    );
  }

  const doomed = (messages ?? []).slice(keep.data).map((m) => m.id as string);

  if (doomed.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0 });
  }

  const { error: deleteError } = await createAdminClient()
    .from("chat_messages")
    .delete()
    .eq("conversation_id", id)
    .in("id", doomed);

  if (deleteError) {
    console.error("[Breezify] Failed to delete messages:", deleteError.message);
    return NextResponse.json(
      { error: "Failed to truncate messages" },
      { status: 500 },
    );
  }

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true, deleted: doomed.length });
}
