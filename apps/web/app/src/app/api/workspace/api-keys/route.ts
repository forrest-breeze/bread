import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { type WorkspaceRole, ROLE_RANKS } from "@breezify/core";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/db/workspace";
import { safeSearchParams } from "@/lib/validation";
import { requireRouteUser } from "@/lib/auth/route-auth";
import { mintApiKey } from "@/lib/api/mint-api-key";

const postBodySchema = z.object({
  name: z.string().trim().min(1).max(120).default("API Key"),
  // Folder-visibility tier the key acts as. Excludes 'owner' — a machine key
  // must never hold the top role. Capped at the creator's role below.
  role: z
    .enum(["admin", "editor", "viewer", "agent-only"])
    .default("viewer"),
  // Action capability. Defaults to read-only; capture must be opted into.
  scopes: z
    .array(z.enum(["read", "capture", "admin"]))
    .nonempty()
    .default(["read"]),
  // null / omitted = never expires (preserves legacy behavior).
  ttl_days: z.number().int().min(1).max(365).nullable().default(null),
});

const idQuerySchema = z.object({
  id: z.string().uuid(),
});

const patchBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

// ---------------------------------------------------------------------------
// GET /api/workspace/api-keys
// Lists API keys for the active workspace. Requires admin/owner role.
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 });
  }

  if (!["owner", "admin"].includes(workspace.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .select(
      "id, name, role, scopes, expires_at, revoked_at, created_by, last_used_at, created_at, key_encrypted",
    )
    .eq("workspace_id", workspace.workspace_id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[Breezify] Failed to fetch API keys:", error.message);
    return NextResponse.json({ error: "Failed to fetch API keys" }, { status: 500 });
  }

  // The ciphertext itself never leaves the server — only whether a reveal is
  // possible. Keys minted before `key_encrypted` existed have no recoverable
  // plaintext, so the UI hides reveal for them rather than offering a dead
  // button.
  const keys = data.map(({ key_encrypted, ...key }) => ({
    ...key,
    revealable: Boolean(key_encrypted),
  }));

  return NextResponse.json({ keys });
}

// ---------------------------------------------------------------------------
// POST /api/workspace/api-keys
// Creates a new workspace-scoped API key. Requires admin/owner role.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 });
  }

  if (!["owner", "admin"].includes(workspace.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Empty / malformed body is acceptable here — the schema default supplies
  // a fallback name. Only structured-but-invalid bodies (wrong shape, name
  // too long) return 400.
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // empty body is fine
  }
  const parsedBody = postBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsedBody.error.flatten() },
      { status: 400 },
    );
  }
  const { name, role, scopes, ttl_days } = parsedBody.data;

  // A key can never grant a higher folder tier than its creator holds.
  if (ROLE_RANKS[role] > ROLE_RANKS[workspace.role as WorkspaceRole]) {
    return NextResponse.json(
      { error: `Cannot create a key with a role above your own (${workspace.role})` },
      { status: 403 },
    );
  }

  const { rawKey, keyHash, keyEncrypted } = mintApiKey();

  const expiresAt =
    ttl_days === null
      ? null
      : new Date(Date.now() + ttl_days * 86_400_000).toISOString();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .insert({
      workspace_id: workspace.workspace_id,
      name,
      key_hash: keyHash,
      created_by: user.id,
      role,
      scopes,
      expires_at: expiresAt,
      key_encrypted: keyEncrypted,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[Breezify] Failed to create API key:", error?.message);
    return NextResponse.json({ error: "Failed to create API key" }, { status: 500 });
  }

  return NextResponse.json({ key: rawKey, id: data.id }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH /api/workspace/api-keys?id=<id>
// Renames a key. Requires admin/owner role. Name is the only mutable field —
// role and scopes are fixed at creation so a key's authority can't be widened
// after the fact, and the secret changes only through rotation.
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 });
  }

  if (!["owner", "admin"].includes(workspace.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsedQuery = safeSearchParams(request.nextUrl, idQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;

  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // Falls through to the schema, which requires a name.
  }
  const parsedBody = patchBodySchema.safeParse(raw);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsedBody.error.flatten() },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_keys")
    .update({ name: parsedBody.data.name })
    .eq("id", parsedQuery.data.id)
    .eq("workspace_id", workspace.workspace_id)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[Breezify] Failed to rename API key:", error.message);
    return NextResponse.json({ error: "Failed to rename API key" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// DELETE /api/workspace/api-keys?id=<id>
// Revokes an API key. Requires admin/owner role.
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);

  if (!user) {
    return authResponse;
  }

  const workspace = await getActiveWorkspace(supabase, user.id);
  if (!workspace) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 });
  }

  if (!["owner", "admin"].includes(workspace.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsedQuery = safeSearchParams(request.nextUrl, idQuerySchema);
  if (!parsedQuery.ok) return parsedQuery.response;
  const { id } = parsedQuery.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from("api_keys")
    .delete()
    .eq("id", id)
    .eq("workspace_id", workspace.workspace_id);

  if (error) {
    console.error("[Breezify] Failed to revoke API key:", error.message);
    return NextResponse.json({ error: "Failed to revoke API key" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
