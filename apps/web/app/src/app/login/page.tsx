import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { sanitizePostLoginNext } from "@/lib/portal/login-return";
import { isPrivatePortalLogin } from "@/lib/portal/private-portal-login";
import { loginErrorMessage } from "@/lib/auth/login-error";
import {
  getLoginAccessCode,
  hasValidLoginAccessCookie,
  LOGIN_ACCESS_COOKIE,
} from "@/lib/auth/login-access";
import { LoginForm } from "./login-form";

// Reads auth cookies and search params — never static.
export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Server shell around the client login form. Sanitizes `next` (relative app
// paths pass through; absolute URLs only when they resolve to a configured
// portal custom domain) and bounces already-authenticated visitors straight to
// it — no login-screen flash for a signed-in member landing on a private
// portal. Token-in-URL flows (?code=, magic-link hashes) have no server-visible
// session yet; the client form still handles those after mount.
export default async function LoginPage({
  searchParams,
}: LoginPageProps): Promise<React.ReactElement> {
  const sp = await searchParams;
  const rawNext = typeof sp.next === "string" ? sp.next : null;
  const rawContext = typeof sp.context === "string" ? sp.context : null;
  const rawError = typeof sp.error === "string" ? sp.error : null;
  const next = await sanitizePostLoginNext(rawNext);

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims?.sub) redirect(next);

  const accessCode = getLoginAccessCode();
  const loginCookies = await cookies();
  const accessRequired = Boolean(
    accessCode &&
      !hasValidLoginAccessCookie(
        loginCookies.get(LOGIN_ACCESS_COOKIE)?.value,
        accessCode
      )
  );

  return (
    <LoginForm
      next={next}
      privatePortalLogin={isPrivatePortalLogin(rawContext, next)}
      authError={loginErrorMessage(rawError)}
      accessRequired={accessRequired}
    />
  );
}
