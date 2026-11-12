/**
 * The Bread workspace id is read from `NEXT_PUBLIC_BREAD_WORKSPACE_ID` so
 * first-party behavior can be toggled without a code change. The var must be
 * `NEXT_PUBLIC_*` — these checks also run in the browser.
 */
const BREAD_WORKSPACE_ID = process.env.NEXT_PUBLIC_BREAD_WORKSPACE_ID ?? ""

/**
 * Whether `workspaceId` is the first-party Bread workspace. Used to keep
 * Bread's own marketing chrome (e.g. the portal header's Home/Pricing/Contact
 * links) on its dogfood portal while customer portals render blank. Fails closed
 * — returns false when NEXT_PUBLIC_BREAD_WORKSPACE_ID is unset — so the safe
 * direction is "no Bread branding leaks into a customer portal".
 */
export function isBreadWorkspace(
  workspaceId: string | null | undefined,
): boolean {
  return BREAD_WORKSPACE_ID.length > 0 && workspaceId === BREAD_WORKSPACE_ID
}

/**
 * Whether a portal should inherit Bread's default marketing chrome. Official
 * docs/help projects are named projects now, so URL position alone cannot
 * distinguish them from customer-branded projects in the dogfood workspace.
 */
export function isBreadBrandedPortal(
  workspaceId: string | null | undefined,
  brandName: string | null | undefined,
): boolean {
  return (
    isBreadWorkspace(workspaceId) &&
    typeof brandName === "string" &&
    /^bread(?:\s|$)/i.test(brandName.trim())
  )
}
