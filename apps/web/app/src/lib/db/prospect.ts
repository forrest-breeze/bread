import "server-only"

import { createAdminClient } from "@/lib/supabase/admin"

// ---------------------------------------------------------------------------
// Prospect workspaces.
//
// The outbound portal builder (scripts/publish-outbound-portal.ts) publishes
// each cold-lead portal into a DEDICATED workspace, marked by a
// `settings.prospect` object. Such workspaces are headless — no membership
// rows — so they never appear in any member-driven UI surface. They're
// managed from /ops/prospects, and they "convert" the moment a real person
// joins: the join flow stamps `converted_at`, graduating the workspace into a
// normal customer workspace (and out of any future purge policy).
// ---------------------------------------------------------------------------

export interface ProspectWorkspaceMeta {
  /** Outbound prospect id (stable key from the lead pipeline). */
  id?: string
  /** Buyer's name. */
  name?: string
  company?: string
  company_url?: string
  evidence_urls?: string[]
  /** Last time the outbound builder (re)published this portal. */
  published_at?: string
  /** Set when a member joined — the workspace is now a real customer's. */
  converted_at?: string
}

/** Parse the prospect marker out of a workspace settings blob, if present. */
export function prospectMetaFromSettings(
  settings: unknown,
): ProspectWorkspaceMeta | null {
  if (typeof settings !== "object" || settings === null) return null
  const prospect = (settings as { prospect?: unknown }).prospect
  if (typeof prospect !== "object" || prospect === null) return null
  return prospect as ProspectWorkspaceMeta
}

/** How long an unconverted prospect portal stays publicly served. */
export const PROSPECT_PORTAL_TTL_DAYS = 30

const PROSPECT_PORTAL_TTL_MS = PROSPECT_PORTAL_TTL_DAYS * 24 * 60 * 60 * 1000

/**
 * When this prospect portal stops being publicly served, or null when it never
 * expires: converted workspaces are a real customer's, and a workspace with no
 * (or an unparsable) publish stamp has nothing to measure the TTL from.
 * Republishing refreshes `published_at`, so it resets the clock.
 */
export function prospectPortalExpiresAt(
  meta: ProspectWorkspaceMeta,
): string | null {
  if (typeof meta.converted_at === "string" && meta.converted_at) return null
  if (typeof meta.published_at !== "string") return null
  const published = Date.parse(meta.published_at)
  if (Number.isNaN(published)) return null
  return new Date(published + PROSPECT_PORTAL_TTL_MS).toISOString()
}

/**
 * True when a workspace settings blob marks an unconverted prospect portal
 * whose TTL has lapsed. Non-prospect workspaces never expire.
 */
export function isProspectPortalExpired(
  settings: unknown,
  now: Date = new Date(),
): boolean {
  const meta = prospectMetaFromSettings(settings)
  if (!meta) return false
  const expiresAt = prospectPortalExpiresAt(meta)
  return expiresAt !== null && now.getTime() >= Date.parse(expiresAt)
}

/**
 * Stamp `settings.prospect.converted_at` on a prospect workspace after a
 * member joins. Best-effort and idempotent: non-prospect workspaces and
 * already-converted ones are untouched, and failures only log — a join must
 * never fail because the graduation marker couldn't be written.
 */
export async function markProspectWorkspaceConverted(
  workspaceId: string,
): Promise<void> {
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from("workspaces")
      .select("settings")
      .eq("id", workspaceId)
      .maybeSingle()
    const settings = (data?.settings as Record<string, unknown> | null) ?? null
    const prospect = prospectMetaFromSettings(settings)
    if (!prospect || prospect.converted_at) return

    await admin
      .from("workspaces")
      .update({
        settings: {
          ...settings,
          prospect: { ...prospect, converted_at: new Date().toISOString() },
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", workspaceId)
  } catch (err) {
    console.error("[Bread] markProspectWorkspaceConverted:", err)
  }
}
