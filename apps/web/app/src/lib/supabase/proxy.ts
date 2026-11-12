import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isTransientAuthFailure } from "@/lib/auth/transient-failure";
import { isAllowedEmail } from "@/lib/auth/allowed-email";
import { isAnonymousPath } from "@/lib/auth/anonymous-paths";
import { withTimeout } from "@/lib/utils";
import { sanitizePostLoginNext } from "@/lib/portal/login-next";
import { authCookieOptions } from "./cookie-options";
import { fetchWithTimeout } from "./fetch-with-timeout";
import { createSessionRefreshLock, sessionLockKey } from "./process-lock";
import { supabasePublishableKey, supabaseUrl } from "./env";

// The middleware runs on every request, so its auth check must fail fast: a
// slow/saturated auth backend would otherwise block the whole page. Mirrors the
// 3s budget in route-auth.ts / get-auth-user.ts. The 15s socket abort in
// fetch-with-timeout.ts is only a backstop against a permanently wedged lock —
// without this race a single request could wait ~30s (15s fetch, possibly
// queued behind the 20s process-lock HOLD_CAP).
const AUTH_TIMEOUT_MS = 3000;

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const url = supabaseUrl();
  const publishableKey = supabasePublishableKey();

  if (!url || !publishableKey) {
    return supabaseResponse;
  }

  const supabase = createServerClient(
    url,
    publishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
      // Serialize this session's token refreshes across concurrent requests in
      // this process so they don't 409 each other. See process-lock.ts.
      auth: {
        lock: createSessionRefreshLock(sessionLockKey(request.cookies.getAll())),
      },
      // Abort any auth/REST call at the socket after 15s so a black-holed
      // request can never hold the session lock forever. See
      // fetch-with-timeout.ts for the full failure mode.
      global: {
        fetch: fetchWithTimeout,
      },
      ...authCookieOptions(),
    }
  );

  // getClaims() verifies the session JWT locally (and still refreshes an
  // expired token via getSession), so the middleware pass costs no /user
  // round-trip to the auth server. The refresh path does hit the network, so
  // race it against AUTH_TIMEOUT_MS: a saturated auth backend resolves to
  // `user = null` here instead of hanging the request. That is the same outcome
  // the slow path already produces (the aborted fetch surfaces as no claims) —
  // protected routes return a retryable 503 instead of redirecting to login. The
  // abandoned getClaims settles in the background; it does not block the page.
  // Fast path: a request with no Supabase auth cookie has no session to verify,
  // so there is nothing for getClaims() to do — skip it. This keeps anonymous
  // traffic (every logged-out /login hit and public page) entirely off the auth
  // backend, so a slow/saturated auth server can never make those requests pay
  // the AUTH_TIMEOUT_MS budget. Supabase auth cookies are named
  // `sb-<project-ref>-auth-token` (optionally chunked `.0`, `.1`).
  const hasAuthCookie = request.cookies
    .getAll()
    .some((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"));

  let user: { id: string } | null = null;
  let authUnavailable = false;
  let disallowedAccount = false;
  if (hasAuthCookie) {
    try {
      const { data: claimsData, error } = await withTimeout(
        supabase.auth.getClaims(),
        AUTH_TIMEOUT_MS,
      );
      if (error && isTransientAuthFailure(error)) authUnavailable = true;
      user = !error && claimsData?.claims?.sub ? { id: claimsData.claims.sub } : null;
      // Breeze internal tool: a session for a non-Breeze email is treated as
      // signed out and its cookies are cleared below.
      if (user && !isAllowedEmail(claimsData?.claims?.email)) {
        user = null;
        disallowedAccount = true;
      }
    } catch (err) {
      authUnavailable = isTransientAuthFailure(err);
      console.warn(
        "[Bread] proxy auth check unavailable:",
        err,
      );
    }
  }

  const path = request.nextUrl.pathname;

  // 1. Exclude auth callback entirely from middleware checks
  if (path.startsWith("/auth/callback")) {
    return supabaseResponse;
  }

  // 2. Breeze internal tool: everything requires a Breeze session except the
  //    short, justified allowlist in lib/auth/anonymous-paths.ts. Portals
  //    (/p/*) and the public portal APIs are NOT anonymous any more.
  const isPublicPath = isAnonymousPath(path);
  const isApi = path.startsWith("/api/");

  // Fail closed without turning a temporary outage into a login redirect.
  if (authUnavailable && !isPublicPath) {
    return new NextResponse("Sign-in check temporarily unavailable. Please retry.", {
      status: 503,
      headers: { "Retry-After": "2", "Cache-Control": "no-store" },
    });
  }

  // 2b. Non-Breeze session: clear the Supabase auth cookies and explain why on
  //     the login page. API routes reject these sessions on their own (403).
  if (disallowedAccount && !path.startsWith("/api")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "?error=domain";
    const redirectResponse = NextResponse.redirect(url);
    request.cookies
      .getAll()
      .filter((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"))
      .forEach((c) => {
        redirectResponse.cookies.set(c.name, "", { path: "/", ...authCookieOptions().cookieOptions, maxAge: 0 });
      });
    return redirectResponse;
  }

  // 3a. Unauthenticated API call to a protected route -> 401 (no redirect).
  if (!user && !isPublicPath && isApi) {
    const unauthorized = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      unauthorized.cookies.set(cookie.name, cookie.value, cookie);
    });
    return unauthorized;
  }

  // 3b. Unauthenticated access to a protected page -> Send to Login
  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path); // Optional: remembers where they wanted to go

    const redirectResponse = NextResponse.redirect(url);

    // CRITICAL: Carry over cookies (like cleared stale tokens) to the new response
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie.name, cookie.value, cookie);
    });

    return redirectResponse;
  }

  // 4. Authenticated user trying to access the login page -> honor the
  //    requested destination. `next` is sanitized: relative app paths pass,
  //    absolute URLs only for a validated portal custom domain that shares the
  //    auth cookie (a private portal's post-login return address). Anything
  //    else falls back to the dashboard.
  if (user && path === "/login") {
    const target = await sanitizePostLoginNext(
      request.nextUrl.searchParams.get("next"),
    );
    const redirectResponse = NextResponse.redirect(
      target.startsWith("https://") ? target : new URL(target, request.url),
    );
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie.name, cookie.value, cookie);
    });

    return redirectResponse;
  }

  // 5. Normal page load, return the response as is
  return supabaseResponse;
}
