// ---------------------------------------------------------------------------
// TEMPORARY: local email-login bypass.
//
// Auth emails can't be delivered until the Resend sending domain is verified
// (see supabase/config.toml). Until then, local dev can sign in as a Breeze
// email without the inbox round-trip.
//
// Remove this file, app/api/auth/dev-login, and the branch in login-form.tsx
// once Resend is live.
//
// Hard-off in any production build and on any Vercel deployment, regardless
// of the flag, so a stray env var can never enable it outside a laptop.
// ---------------------------------------------------------------------------

export function isDevLoginBypassEnabled(): boolean {
  return (
    process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true" &&
    process.env.NODE_ENV !== "production" &&
    !process.env.VERCEL
  );
}
