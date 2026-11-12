import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getLoginAccessCode,
  LOGIN_ACCESS_COOKIE,
  loginAccessCodeMatches,
  loginAccessCookieValue,
} from "@/lib/auth/login-access";

const requestSchema = z.object({ code: z.string() });

export async function POST(request: Request): Promise<NextResponse> {
  const expected = getLoginAccessCode();
  if (!expected) {
    return NextResponse.json(
      { error: "The login access gate is not configured." },
      { status: 503 }
    );
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid access code." }, { status: 400 });
  }

  const body = requestSchema.safeParse(input);

  if (!body.success || !loginAccessCodeMatches(body.data.code, expected)) {
    return NextResponse.json({ error: "Invalid access code." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(LOGIN_ACCESS_COOKIE, loginAccessCookieValue(expected), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/login",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
