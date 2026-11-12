import "server-only"

import { cache } from "react"
import { createAdminClient } from "@/lib/supabase/admin"
import { publicKbBaseDomain } from "@/lib/public-kb-handle"
import type { PublicWorkspace } from "@/lib/public-kb"
import {
  resolvePortalPublicUrl,
  type HeaderReader,
} from "@/lib/portal/llms-txt-request"
import {
  portalCanonicalBaseUrl,
  type PortalCanonicalProjectRoute,
} from "@/lib/portal/canonical-url"

const loadProjectRoute = cache(
  async (
    workspaceId: string,
    projectSlug: string,
  ): Promise<PortalCanonicalProjectRoute | null> => {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from("portal_domain_routes")
      .select("domain, path_prefix")
      .eq("workspace_id", workspaceId)
      .eq("project_slug", projectSlug)
      .maybeSingle()

    if (error || !data) return null
    return { domain: data.domain, pathPrefix: data.path_prefix }
  },
)

export async function resolvePortalCanonicalBaseUrl(input: {
  headers: HeaderReader
  workspace: PublicWorkspace
  internalBase: string
  projectSlug: string
}): Promise<string> {
  const { headers, workspace, internalBase, projectSlug } = input
  const projectRoute = await loadProjectRoute(workspace.id, projectSlug)
  const requestPublicBase = resolvePortalPublicUrl(headers, internalBase)

  return portalCanonicalBaseUrl({
    workspaceSlug: workspace.slug,
    projectSlug,
    workspaceDomain: workspace.customDomain,
    workspaceAddressScope: workspace.portalAddressScope,
    workspaceAddressMode: workspace.portalAddressMode,
    projectRoute,
    requestPublicBase,
    publicKbBaseDomain: publicKbBaseDomain(),
    appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "",
  })
}
