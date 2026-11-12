import "server-only";

import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceRole } from "@bread/core";
import { normalizeWorkspaceSettings } from "@/lib/workspace-settings";

// ---------------------------------------------------------------------------
// The single Breeze workspace.
//
// This internal tool has exactly one workspace. There is no setup flow:
// the first time a (Breeze-only, see auth/allowed-email.ts) user reaches the
// app, they are added to it. The very first user creates it and becomes its
// owner; everyone after joins as an editor. Owners/admins can change roles in
// Settings -> Members as usual.
// ---------------------------------------------------------------------------

export const BREEZE_WORKSPACE_SLUG = "breeze";
export const BREEZE_WORKSPACE_NAME = "Breeze";
export const DEFAULT_MEMBER_ROLE: WorkspaceRole = "editor";

interface WorkspaceRow {
  id: string;
  created_at: string;
}

function inviteCode(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function findBreezeWorkspace(admin: SupabaseClient): Promise<WorkspaceRow | null> {
  const { data, error } = await admin
    .from("workspaces")
    .select("id, created_at")
    .eq("slug", BREEZE_WORKSPACE_SLUG)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`[breeze-workspace] lookup: ${error.message}`);
  return (data?.[0] as WorkspaceRow | undefined) ?? null;
}

async function createBreezeWorkspace(admin: SupabaseClient): Promise<WorkspaceRow> {
  const { data: created, error } = await admin
    .from("workspaces")
    .insert({
      name: BREEZE_WORKSPACE_NAME,
      slug: BREEZE_WORKSPACE_SLUG,
      settings: normalizeWorkspaceSettings({ invite_code: inviteCode(8) }),
    })
    .select("id, created_at")
    .single();
  if (error || !created) {
    // A concurrent first sign-in may have won (if slug is unique, this insert
    // fails); either way the oldest row is the workspace.
    const existing = await findBreezeWorkspace(admin);
    if (existing) return existing;
    throw new Error(`[breeze-workspace] create: ${error?.message ?? "no row"}`);
  }

  // Two simultaneous first sign-ins could each create one if slug is not
  // unique. Keep the oldest and drop ours if we lost.
  const winner = await findBreezeWorkspace(admin);
  if (winner && winner.id !== created.id) {
    await admin.from("workspaces").delete().eq("id", created.id);
    return winner;
  }

  await admin
    .from("subscriptions")
    // Internal tool: no billing, so the workspace gets full (enterprise)
    // entitlements. The DB plan-limit triggers read this row.
    .insert({
      workspace_id: created.id,
      plan_id: "enterprise",
      tier: "enterprise",
      status: "active",
    });
  return created as WorkspaceRow;
}

/**
 * Make sure `userId` is an active member of the Breeze workspace, creating the
 * workspace on first use. Idempotent; safe to call on every page load (it is a
 * single indexed read when the user is already a member).
 */
export async function ensureBreezeWorkspaceMember(
  admin: SupabaseClient,
  userId: string,
): Promise<{ workspaceId: string; joined: boolean }> {
  let workspace = await findBreezeWorkspace(admin);

  if (workspace) {
    const { data: member, error } = await admin
      .from("workspace_members")
      .select("id, status")
      .eq("workspace_id", workspace.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`[breeze-workspace] membership: ${error.message}`);
    if (member?.status === "active") return { workspaceId: workspace.id, joined: false };
    if (member) {
      const { error: activateError } = await admin
        .from("workspace_members")
        .update({ status: "active" })
        .eq("id", member.id);
      if (activateError) throw new Error(`[breeze-workspace] activate: ${activateError.message}`);
      return { workspaceId: workspace.id, joined: true };
    }
  }

  const isFirstUser = !workspace;
  workspace ??= await createBreezeWorkspace(admin);

  const { count: memberCount } = await admin
    .from("workspace_members")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id);

  const { error: insertError } = await admin.from("workspace_members").insert({
    workspace_id: workspace.id,
    user_id: userId,
    role: isFirstUser || (memberCount ?? 0) === 0 ? "owner" : DEFAULT_MEMBER_ROLE,
    status: "active",
  });
  // 23505: a concurrent request already added this user. That is fine.
  if (insertError && insertError.code !== "23505") {
    throw new Error(`[breeze-workspace] join: ${insertError.message}`);
  }

  return { workspaceId: workspace.id, joined: true };
}

// profiles.onboarding_completed_at is left null on join: it now means "has
// finished or skipped the first-visit tutorial" (components/app/product-tour).
