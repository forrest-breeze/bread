import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { safeJsonBody } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";

// Returning 404 rather than 400 on a bad conversation id is deliberate — it
// doesn't leak which conversation IDs exist.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keep in sync with the message_feedback.reason check constraint.
const reasonSchema = z.enum([
  "inaccurate",
  "not_from_sources",
  "incomplete",
  "wrong_tone",
  "other",
]);

// reason/comment are tri-state: omitted (undefined) = preserve stored value;
// explicit null = clear it; a value = set it.
const postBodySchema = z.object({
  message_id: z.string().uuid(),
  rating: z.enum(["up", "down"]),
  reason: reasonSchema.nullable().optional(),
  comment: z.string().trim().max(2000).nullable().optional(),
});

const deleteBodySchema = z.object({
  message_id: z.string().uuid(),
});

// Resolve the conversation for the current user and confirm the rated message
// belongs to it and is an assistant reply. Returns the workspace_id needed to
// scope the feedback row, or a NextResponse to short-circuit with.
async function resolveTarget(
  supabase: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  messageId: string,
  userId: string,
): Promise<{ workspaceId: string } | { error: NextResponse }> {
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, workspace_id")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .single();

  if (!conversation) {
    return {
      error: NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 },
      ),
    };
  }

  const { data: message } = await supabase
    .from("chat_messages")
    .select("id")
    .eq("id", messageId)
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .single();

  if (!message) {
    return {
      error: NextResponse.json(
        { error: "Message not found" },
        { status: 404 },
      ),
    };
  }

  return { workspaceId: conversation.workspace_id as string };
}

// ---------------------------------------------------------------------------
// POST /api/conversations/:id/feedback
// Upsert the current user's thumbs up/down on an assistant reply. Re-rating the
// same message overwrites the prior rating (one row per message+user).
// ---------------------------------------------------------------------------
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = await safeJsonBody(request, postBodySchema);
  if (!parsed.ok) return parsed.response;
  const { message_id, rating, reason, comment } = parsed.data;

  try {
    const target = await resolveTarget(supabase, id, message_id, user.id);
    if ("error" in target) return target.error;

    // The thumbs-down flow writes twice: a bare `down` when the popover opens,
    // then `down` + reason/comment on "Done". Those can land out of order, and a
    // re-click after a reload sends a bare `down` again. So the columns are only
    // included when the caller has something to say about them, and PostgREST's
    // `ON CONFLICT DO UPDATE` only touches the columns it's given:
    //   - omitted (undefined) → left out of payload → stored value preserved
    //     (the bare-open downvote case).
    //   - explicit null → written as null → cleared (the "Done" case where the
    //     user removed the reason / emptied the comment).
    //   - a value → written.
    // A thumbs-up has no reason, so it always clears both.
    const row: Record<string, unknown> = {
      message_id,
      conversation_id: id,
      workspace_id: target.workspaceId,
      user_id: user.id,
      rating,
      updated_at: new Date().toISOString(),
    };
    if (rating === "up") {
      row.reason = null;
      row.comment = null;
    } else {
      if (reason !== undefined) row.reason = reason;
      if (comment !== undefined) row.comment = comment;
    }

    const { data, error } = await supabase
      .from("message_feedback")
      .upsert(row, { onConflict: "message_id,user_id" })
      .select("id, rating, reason, comment")
      .single();

    if (error) {
      console.error("[Breezify] message feedback upsert:", error.message);
      return NextResponse.json(
        { error: "Failed to save feedback" },
        { status: 500 },
      );
    }

    return NextResponse.json({ feedback: data }, { status: 200 });
  } catch (err) {
    console.error("[Breezify] message feedback POST:", err);
    return NextResponse.json(
      { error: "Failed to save feedback" },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/conversations/:id/feedback
// Clear the current user's rating on an assistant reply (toggle off).
// ---------------------------------------------------------------------------
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supabase = await createClient();

  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = await safeJsonBody(request, deleteBodySchema);
  if (!parsed.ok) return parsed.response;
  const { message_id } = parsed.data;

  try {
    const { error } = await supabase
      .from("message_feedback")
      .delete()
      .eq("message_id", message_id)
      .eq("user_id", user.id);

    if (error) {
      console.error("[Breezify] message feedback delete:", error.message);
      return NextResponse.json(
        { error: "Failed to clear feedback" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("[Breezify] message feedback DELETE:", err);
    return NextResponse.json(
      { error: "Failed to clear feedback" },
      { status: 500 },
    );
  }
}
