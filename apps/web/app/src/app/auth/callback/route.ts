import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sanitizePostLoginNext } from "@/lib/portal/login-return";
import { resolveLoginErrorReason } from "@/lib/auth/login-error";
import { isAllowedEmail } from "@/lib/auth/allowed-email";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Supabase rejects dead links (expired/consumed magic link, denied consent)
  // on its side and redirects here with these instead of a `code`.
  const providerError = searchParams.get("error");
  // Relative paths pass through; absolute URLs only when they resolve to a
  // configured portal custom domain (private portals return to their clean
  // public address after the app-origin login round-trip).
  const next = await sanitizePostLoginNext(searchParams.get("next"));
  const redirectUrl = new URL(next, origin);
  const supabase = await createClient();

  if (code) {
    const { data: exchanged, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Breeze internal tool. The database already refuses non-Breeze users;
      // this catches any account that existed before that rule.
      if (!isAllowedEmail(exchanged.user?.email)) {
        await supabase.auth.signOut();
        return NextResponse.redirect(`${origin}/login?error=domain`);
      }
      return NextResponse.redirect(redirectUrl);
    }

    // Local JWT verification (getClaims) instead of a network getUser() —
    // the auth server's /user endpoint is the saturation point and this is
    // the one moment a stall would block a login.
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

    if (claimsData?.claims?.sub) {
      console.warn(
        "[auth/callback] Code exchange failed but existing auth session was found:",
        error.message
      );
      return NextResponse.redirect(redirectUrl);
    }

    if (claimsError) {
      console.error("[auth/callback] Existing session lookup failed:", claimsError.message);
    }

    console.error("[auth/callback] Code exchange failed:", error.message);
  } else {
    const { data: claimsData, error } = await supabase.auth.getClaims();

    if (claimsData?.claims?.sub) {
      return NextResponse.redirect(redirectUrl);
    }

    if (error) {
      console.error("[auth/callback] Existing session lookup failed:", error.message);
    }

    if (providerError) {
      console.warn(
        "[auth/callback] Auth provider rejected the link:",
        searchParams.get("error_code") ?? providerError,
        searchParams.get("error_description") ?? ""
      );
    } else {
      console.warn("[auth/callback] No code parameter in callback URL");
    }
  }

  return NextResponse.redirect(
    `${origin}/login?error=${resolveLoginErrorReason(searchParams)}`
  );
}
