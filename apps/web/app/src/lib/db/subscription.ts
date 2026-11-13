import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolvePortalPlanEntitlements,
  type PortalPlanEntitlements,
} from "@/lib/billing/catalog";
import type { SubscriptionRow } from "@/lib/types";

// ---------------------------------------------------------------------------
// Workspace entitlements
//
// Breezify runs as an internal tool: there is no billing, no plans and no trials.
// Every workspace is entitled to the full feature set. The `subscriptions`
// table is still read for its period dates (usage reporting), but nothing is
// gated on it anymore. The gate helpers below are kept so the call sites stay
// readable and so a gate can be reintroduced in one place if ever needed.
// ---------------------------------------------------------------------------

/**
 * Read a workspace's subscription row, if any. Never writes: with billing
 * removed there is no reason to provision a row on read.
 */
export async function getWorkspaceSubscription(
  workspaceId: string,
): Promise<SubscriptionRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    console.error(
      `[Breezify] Failed to read subscription for workspace ${workspaceId}:`,
      error.message,
    );
    return null;
  }
  return data;
}

/** Internal tool: every workspace has full access. */
export async function isWorkspaceOnPaidTier(_workspaceId: string): Promise<boolean> {
  return true;
}

/** Internal tool: every workspace has full access. */
export async function isBusinessTierForWorkspace(_workspaceId: string): Promise<boolean> {
  return true;
}

export async function isAgentEnabledForWorkspace(workspaceId: string): Promise<boolean> {
  return isBusinessTierForWorkspace(workspaceId);
}

export async function isAutoIngestEnabledForWorkspace(workspaceId: string): Promise<boolean> {
  return isBusinessTierForWorkspace(workspaceId);
}

export async function getPortalEntitlementsForWorkspace(
  _workspaceId: string,
): Promise<PortalPlanEntitlements> {
  return resolvePortalPlanEntitlements(null);
}

export async function isPortalEditorEnabledForWorkspace(
  workspaceId: string,
): Promise<boolean> {
  return (await getPortalEntitlementsForWorkspace(workspaceId)).portalEditor;
}

export async function isPortalAiBuilderEnabledForWorkspace(
  workspaceId: string,
): Promise<boolean> {
  return (await getPortalEntitlementsForWorkspace(workspaceId)).portalAiBuilder;
}

export async function isPortalReportingEnabledForWorkspace(
  workspaceId: string,
): Promise<boolean> {
  return (await getPortalEntitlementsForWorkspace(workspaceId)).portalReporting;
}
