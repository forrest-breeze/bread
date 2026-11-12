import "server-only";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { getActiveWorkspace } from "@/lib/db/workspace";

export async function requireCloudflareWorkspace(options?: {
  admin?: boolean;
}): Promise<
  | { ok: true; workspaceId: string; userId: string; role: string }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const { user, response } = await requireRouteUser(supabase);
  if (!user) return { ok: false, response };
  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return {
      ok: false,
      response: NextResponse.json({ error: "No active workspace" }, { status: 400 }),
    };
  }
  if (
    options?.admin &&
    workspace.role !== "admin" &&
    workspace.role !== "owner"
  ) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Only workspace admins and owners can manage Cloudflare" },
        { status: 403 },
      ),
    };
  }
  return {
    ok: true,
    workspaceId: workspace.workspace_id,
    userId: user.id,
    role: workspace.role,
  };
}

