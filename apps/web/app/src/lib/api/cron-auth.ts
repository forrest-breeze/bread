import { timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Constant-time bearer check for cron/sync-all endpoints authenticated by a
// shared secret. Plain `===` short-circuits on the first mismatched byte and
// leaks the secret's length + prefix to a timing oracle; this compares in
// constant time. Mirrors the timingSafeEqual pattern used in the GitHub App
// callback and Slack webhook signature checks.
// ---------------------------------------------------------------------------

/**
 * True when the `Authorization` header is exactly `Bearer <secret>`, compared
 * in constant time. Returns false (never throws) on a length mismatch.
 */
export function verifyCronBearer(
  authHeader: string | null,
  secret: string,
): boolean {
  const provided = Buffer.from(authHeader ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
