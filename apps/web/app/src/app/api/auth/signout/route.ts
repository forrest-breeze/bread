import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-authoritative sign-out. The client-side `signOut({ scope: "local" })`
 * clears cookies via `document.cookie`, but an in-flight token refresh (a Next
 * prefetch or SWR revalidation that the proxy/server client services with a
 * fresh `Set-Cookie`) can land *after* that clear and resurrect the auth cookie
 * — leaving the user effectively still signed in. Clearing on the navigation's
 * own response makes the deletion the last word for this request, so it cannot
 * be raced.
 *
 * No `requireRouteUser()` gate here by design (cf. `/auth/callback`): signing
 * out must work regardless of session validity. `scope: "local"` is deliberate
 * — the project avoids GoTrue's `/logout` revoke endpoint, which is the known
 * saturation point (see `get-auth-user.ts`).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { origin } = new URL(request.url);
  const redirectResponse = NextResponse.redirect(new URL("/login", origin));

  const supabase = await createClient();
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Local clear must not hinge on the network — fall through to the
    // belt-and-suspenders cookie expiry below regardless.
  }

  // Defensively expire every Supabase auth cookie (incl. chunked `.0`/`.1`)
  // directly on the redirect response, so the cookie is gone even if the
  // supabase-js clear above no-op'd for any reason.
  for (const cookie of request.headers.get("cookie")?.split("; ") ?? []) {
    const name = cookie.split("=")[0];
    if (name.startsWith("sb-") && name.includes("auth-token")) {
      redirectResponse.cookies.set(name, "", { path: "/", maxAge: 0 });
    }
  }

  return redirectResponse;
}
