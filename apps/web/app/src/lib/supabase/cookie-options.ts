// Shared auth-cookie scoping for every Supabase client (browser, server,
// middleware). When NEXT_PUBLIC_AUTH_COOKIE_DOMAIN is set (e.g. ".example.com"),
// the session cookie is scoped to that domain instead of the app host, so a
// signed-in member is also authenticated on portal mounts served from sibling
// hosts (example.com/docs, <handle>.example.com) — the private-portal gate then
// recognizes them without a login round-trip. Unset (the default, and local
// dev) keeps host-only cookies.
export function authCookieOptions(): {
  cookieOptions?: { domain: string }
} {
  const domain = (process.env.NEXT_PUBLIC_AUTH_COOKIE_DOMAIN ?? "").trim()
  return domain ? { cookieOptions: { domain } } : {}
}
