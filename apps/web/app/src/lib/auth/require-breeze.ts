import "server-only";

import { redirect } from "next/navigation";
import type { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAuthUser, type AuthUser } from "./get-auth-user";
import { requireRouteUser } from "./route-auth";

// Route-level Breeze checks for surfaces that used to be public (portals and
// /api/public/*). The proxy already blocks these without a Breeze session;
// this is the second, independent check so a proxy/matcher mistake can never
// expose them.

/** For route handlers: null when the caller is a Breeze user, else 401/403/503. */
export async function breezeOnlyResponse(): Promise<NextResponse<{ error: string }> | null> {
  const supabase = await createClient();
  const { user, response } = await requireRouteUser(supabase);
  return user ? null : response;
}

/** For pages/layouts: the Breeze user, or a redirect to /login. */
export async function requireBreezeViewer(): Promise<AuthUser> {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  return user;
}
