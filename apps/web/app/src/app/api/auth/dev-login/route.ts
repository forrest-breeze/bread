import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isAllowedEmail } from "@/lib/auth/allowed-email";
import { isDevLoginBypassEnabled } from "@/lib/auth/dev-login-bypass";
import { sanitizePostLoginNext } from "@/lib/portal/login-return";

// TEMPORARY local-only login bypass. See lib/auth/dev-login-bypass.ts.
//
// Mints a magic-link token with the admin client and redeems it immediately
// on the server, so the session cookies are set without sending an email.

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().max(320),
  next: z.string().max(2048).optional(),
});

export async function POST(request: Request) {
  if (!isDevLoginBypassEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isAllowedEmail(parsed.data.email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  const { email } = parsed.data;

  const { data: link, error: linkError } = await createAdminClient().auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link.properties?.hashed_token) {
    console.error("[dev-login] generateLink failed:", linkError?.message);
    return NextResponse.json({ error: linkError?.message ?? "Could not create login" }, { status: 500 });
  }

  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (verifyError) {
    console.error("[dev-login] verifyOtp failed:", verifyError.message);
    return NextResponse.json({ error: verifyError.message }, { status: 500 });
  }

  const redirectTo = await sanitizePostLoginNext(parsed.data.next ?? null);
  return NextResponse.json({ redirectTo });
}
