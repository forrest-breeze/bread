// ---------------------------------------------------------------------------
// The ONLY paths reachable without a Breeze session.
//
// Breeze internal tool: every other page and API route requires a signed-in
// @breeze.com / @breeze.cash user (enforced by src/proxy.ts via
// lib/supabase/proxy.ts, and again inside the routes). Each entry below is
// either part of signing in, or authenticates a machine caller another way
// (shared cron secret, webhook signature, bearer token checked in the route).
// Keep this list short and exact; add to it only with that justification.
//
// Exception: published portals. /p/* and /api/public/* skip the Breeze-session
// requirement and gate on each portal's own visibility setting instead (public
// → anyone; private → signed-in workspace members, see gatePortalVisibility in
// lib/public-kb.ts). The rest of the app stays Breeze-only.
// ---------------------------------------------------------------------------

const EXACT = new Set<string>([
  "/login",
  "/robots.txt",
  "/api/auth/login-access", // pre-login access-code gate (no data)
  "/api/auth/signout",
  // TEMPORARY: local-only login bypass; the route 404s in prod/Vercel and
  // unless NEXT_PUBLIC_AUTH_DEV_BYPASS=true (lib/auth/dev-login-bypass.ts).
  "/api/auth/dev-login",
  "/api/health", // liveness only
  "/api/health/github", // config diagnostics, no secrets
  "/api/github/webhook", // GitHub HMAC signature verified in the route
  "/api/github/sweep", // CRON_SECRET bearer verified in the route
  "/api/user/workspaces", // bearer/session checked in the route (Breeze-only)
]);

const PREFIXES = [
  "/auth/callback", // Supabase redirects here to finish sign-in
  "/api/cron/", // CRON_SECRET bearer verified in each route
  "/api/v1/", // PAT / workspace API key verified in each route (Breeze-only)
  "/p/", // published portals: gated on the portal's visibility setting
  "/api/public/", // portal data routes: same visibility gate in each route
];

export function isAnonymousPath(pathname: string): boolean {
  if (EXACT.has(pathname)) return true;
  return PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
