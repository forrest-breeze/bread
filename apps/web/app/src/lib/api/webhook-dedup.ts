import { createAdminClient } from "@/lib/supabase/admin";
import type { WebhookSource } from "@breezify/core";

const KNOWN_SOURCES: ReadonlySet<WebhookSource> = new Set([
  "github",
  "slack",
  "instagram",
]);

export interface DedupOutcome {
  isNew: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// recordWebhookDelivery — idempotency gate for inbound webhooks.
//
// Uses INSERT ... ON CONFLICT DO NOTHING against webhook_deliveries
// (primary key (source, event_id)). First caller for a given (source,
// event_id) gets isNew=true; retries all receive isNew=false.
//
// Fail-open semantics: on unexpected DB errors we return isNew=true with
// an `error` field set. The tradeoff is that a transient DB blip may
// cause a single event to be processed twice (downstream handlers must
// be idempotent in the unhappy case) rather than permanently drop events.
// ---------------------------------------------------------------------------
export async function recordWebhookDelivery(
  source: WebhookSource,
  eventId: string,
): Promise<DedupOutcome> {
  if (!KNOWN_SOURCES.has(source)) {
    return { isNew: true, error: `Unknown webhook source: ${source}` };
  }
  if (!eventId) {
    return { isNew: true, error: "Missing event_id" };
  }

  const admin = createAdminClient();
  const { count, error } = await admin
    .from("webhook_deliveries")
    .insert({ source, event_id: eventId }, { count: "exact" });

  if (error) {
    // Unique-violation is the expected "already seen" case.
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      return { isNew: false };
    }
    // Anything else is unexpected — fail open + surface the error to the
    // caller so it can be logged. Handler still processes the event.
    return {
      isNew: true,
      error: (error as { message?: string }).message ?? String(error),
    };
  }

  // count === 0 means ON CONFLICT DO NOTHING silently dropped the row.
  // In practice Supabase returns count === null in this case on some
  // server versions; treat both as "already recorded".
  return { isNew: count === 1 };
}
