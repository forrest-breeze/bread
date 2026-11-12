import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * True only if `userId` belongs to a Breeze account. Used where a credential
 * maps to a user without carrying their email (personal access tokens). Calls
 * public.user_is_breeze (service-role only; reads auth.users). Fails closed:
 * any error counts as "not Breeze".
 */
export async function isBreezeUserId(
  admin: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("user_is_breeze", { p_user_id: userId });
    if (error) {
      console.error("[Breeze] user_is_breeze check failed:", error.message);
      return false;
    }
    return data === true;
  } catch (err) {
    console.error("[Breeze] user_is_breeze check threw:", err);
    return false;
  }
}
