import "server-only";

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const LOGIN_ACCESS_COOKIE = "breezify-login-access";

const LOGIN_ACCESS_COOKIE_MESSAGE = "breezify-login-access:v1";

export function getLoginAccessCode(): string | null {
  const code =
    process.env.LOGIN_ACCESS_CODE?.trim() ||
    process.env.NEXT_PUBLIC_ACCESS_CODE?.trim() ||
    "";

  return code || null;
}

export function loginAccessCookieValue(code: string): string {
  return createHmac("sha256", code)
    .update(LOGIN_ACCESS_COOKIE_MESSAGE)
    .digest("base64url");
}

export function loginAccessCodeMatches(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function hasValidLoginAccessCookie(
  cookieValue: string | undefined,
  accessCode: string
): boolean {
  if (!cookieValue) return false;

  const provided = Buffer.from(cookieValue);
  const expected = Buffer.from(loginAccessCookieValue(accessCode));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
