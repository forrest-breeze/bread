import { createBrowserClient } from "@supabase/ssr";
import { authCookieOptions } from "./cookie-options";
import { supabasePublishableKey, supabaseUrl } from "./env";

export function createClient() {
  return createBrowserClient(
    supabaseUrl()!,
    supabasePublishableKey()!,
    { ...authCookieOptions() }
  );
}
