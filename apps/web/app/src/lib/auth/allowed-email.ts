// ---------------------------------------------------------------------------
// Breeze-only access.
//
// This build is a Breeze internal tool: only verified Breeze staff accounts may
// sign in or call the API. The list is a constant on purpose, not an env var,
// so a missing or mistyped deployment setting can never widen access.
//
// The same list is enforced in the database (see the
// `restrict_auth_users_to_breeze` migration), which blocks any other email from
// ever becoming an auth user. These app-side checks are defence in depth for
// sessions that already exist.
// ---------------------------------------------------------------------------

export const ALLOWED_EMAIL_DOMAINS = ["breeze.com", "breeze.cash"] as const;

/**
 * True only for `<local>@<allowed domain>` with an exact domain match, so
 * `x@breeze.com.evil.io` and `x@evilbreeze.com` are rejected.
 */
export function isAllowedEmail(email: unknown): email is string {
  if (typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at !== normalized.indexOf("@")) return false;
  const domain = normalized.slice(at + 1);
  return (ALLOWED_EMAIL_DOMAINS as readonly string[]).includes(domain);
}

export const DOMAIN_NOT_ALLOWED_MESSAGE =
  "Only Breeze accounts (@breeze.com or @breeze.cash) can sign in.";
