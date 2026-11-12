// ---------------------------------------------------------------------------
// Login failure reasons shared between /auth/callback (producer) and the login
// form (consumer).
//
// Supabase bounces a dead magic link back to the callback with its own
// `error` / `error_code` params and no `code`, so the callback can only fail
// the visitor back to /login. Carrying a coarse reason on that redirect is
// what lets the form say "your link expired" instead of dropping the visitor
// on a blank form with no explanation.
// ---------------------------------------------------------------------------

export type LoginErrorReason = "link_expired" | "access_denied" | "domain" | "auth";

const LOGIN_ERROR_MESSAGES: Record<LoginErrorReason, string> = {
  link_expired:
    "That sign-in link has expired. Links are single-use and only last a few minutes — enter your email for a fresh one.",
  access_denied:
    "That sign-in was cancelled before it finished. Pick a provider or enter your email to try again.",
  domain: "Only Breeze accounts (@breeze.com or @breeze.cash) can sign in. Use your Breeze Google account or Breeze email.",
  auth: "We couldn't finish signing you in. Enter your email below for a new link.",
};

function isLoginErrorReason(value: string): value is LoginErrorReason {
  return value in LOGIN_ERROR_MESSAGES;
}

/**
 * Maps Supabase's callback error params to the reason we forward to /login.
 * Unrecognized codes fall back to the generic reason rather than leaking the
 * raw provider string into the UI.
 */
export function resolveLoginErrorReason(params: URLSearchParams): LoginErrorReason {
  const code = params.get("error_code");
  const error = params.get("error");

  if (code === "otp_expired") return "link_expired";
  // Raised by the before_user_created hook / auth.users trigger.
  if (/breeze accounts/i.test(params.get("error_description") ?? "")) return "domain";
  if (code === "access_denied" || error === "access_denied") return "access_denied";
  return "auth";
}

/** Friendly copy for a `?error=` value on /login, or null when there is none. */
export function loginErrorMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return LOGIN_ERROR_MESSAGES[isLoginErrorReason(raw) ? raw : "auth"];
}
