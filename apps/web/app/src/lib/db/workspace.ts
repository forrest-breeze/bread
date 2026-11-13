import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Workspace membership resolved from the active workspace cookie.
// ---------------------------------------------------------------------------

export interface ActiveWorkspace {
  id: string;
  workspace_id: string;
  role: string;
}

/**
 * Resolves the user's active workspace by checking the `breezify-workspace`
 * cookie first, then falling back to their first membership.
 *
 * Returns `null` ONLY when the user genuinely has no membership. A query
 * failure (timeout, connection error) THROWS — it must never be silently
 * coerced to `null`, or a transient DB blip masquerades as "no workspace" and
 * callers wrongly redirect the user to onboarding. Uses `.maybeSingle()` so the
 * legitimate zero-row case stays a clean `null` (no PGRST116 error).
 */
export async function getActiveWorkspace(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<ActiveWorkspace | null> {
  // Bound the entire lookup, including PostgREST retries and fallback queries.
  const signal = AbortSignal.timeout(8000);
  const cookieStore = await cookies();
  const preferredId = cookieStore.get("breezify-workspace")?.value;

  if (preferredId) {
    const { data: membership, error } = await supabase
      .from("workspace_members")
      .select("id, workspace_id, role")
      .eq("user_id", userId)
      .eq("workspace_id", preferredId)
      .abortSignal(signal)
      .maybeSingle();

    if (error) throw new Error(`workspace lookup failed: ${error.message}`, { cause: error });
    if (membership) return membership;
  }

  // Fall back to first membership
  const { data: membership, error } = await supabase
    .from("workspace_members")
    .select("id, workspace_id, role")
    .eq("user_id", userId)
    .limit(1)
    .abortSignal(signal)
    .maybeSingle();

  if (error) throw new Error(`workspace lookup failed: ${error.message}`, { cause: error });
  return membership;
}

/**
 * Service-role variant for server-rendered pages that already verified the
 * caller with `getAuthUser()`. This avoids the Supabase SSR client's internal
 * `getSession()` call on hot render paths while preserving explicit user_id
 * scoping.
 */
export async function getActiveWorkspaceForUser(
  userId: string,
  admin = createAdminClient(),
): Promise<ActiveWorkspace | null> {
  // Bound the entire lookup, including PostgREST retries and fallback queries.
  const signal = AbortSignal.timeout(8000);
  const cookieStore = await cookies();
  const preferredId = cookieStore.get("breezify-workspace")?.value;

  if (preferredId) {
    const { data: membership, error } = await admin
      .from("workspace_members")
      .select("id, workspace_id, role")
      .eq("user_id", userId)
      .eq("workspace_id", preferredId)
      .eq("status", "active")
      .abortSignal(signal)
      .maybeSingle();

    if (error) throw new Error(`workspace lookup failed: ${error.message}`, { cause: error });
    if (membership) return membership;
  }

  const { data: membership, error } = await admin
    .from("workspace_members")
    .select("id, workspace_id, role")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1)
    .abortSignal(signal)
    .maybeSingle();

  if (error) throw new Error(`workspace lookup failed: ${error.message}`, { cause: error });
  return membership;
}

/**
 * Counts active workspace members. Only `status = 'active'` rows count —
 * `invited` and `expired` rows are not yet members. Used for the member-cap
 * gate on free/basic plans and for the usage dashboard.
 *
 * Returns 0 for an empty workspace. Do not feed this value directly to a
 * Stripe `quantity` field — Stripe rejects 0. Breezify now hardcodes
 * `quantity: 1` on checkout, so this is no longer a concern for current
 * callers, but new callers should be aware.
 */
export async function countActiveMembers(workspaceId: string): Promise<number> {
  const admin = createAdminClient();
  const { count, error } = await admin
    .from("workspace_members")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "active");

  if (error) {
    console.error("[Breezify] countActiveMembers:", error.message);
    throw new Error(`Failed to count active members: ${error.message}`);
  }

  return count ?? 0;
}
