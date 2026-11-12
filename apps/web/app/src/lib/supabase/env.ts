// Supabase connection settings.
//
// Supabase is retiring the legacy `anon` / `service_role` JWT keys (end of
// 2026) in favour of publishable (`sb_publishable_…`) and secret
// (`sb_secret_…`) keys. Read the new names first and fall back to the legacy
// ones so an older project still works.
//
// Each NEXT_PUBLIC_ variable must be referenced literally (not via a computed
// name): Next.js only inlines literal `process.env.NEXT_PUBLIC_*` reads into
// browser bundles.

/** Project URL. Browser-safe. */
export function supabaseUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || undefined;
}

/** Publishable key (formerly the anon key). Browser-safe; RLS applies. */
export function supabasePublishableKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    undefined
  );
}

/**
 * Secret key (formerly the service_role key). SERVER ONLY: it bypasses RLS,
 * and Supabase rejects secret keys sent from a browser.
 */
export function supabaseSecretKey(): string | undefined {
  return (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    undefined
  );
}
