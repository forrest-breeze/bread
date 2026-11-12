interface PortalProjectDomainRoute {
  domain: string
  pathPrefix: string
}

/** Build the public address for a portal project from its effective host route. */
export function portalProjectUrl({
  origin,
  workspaceSlug,
  projectSlug,
  isDefault,
  workspaceDomain,
  projectRoute,
}: {
  origin: string
  workspaceSlug: string
  projectSlug: string
  isDefault: boolean
  workspaceDomain?: string
  projectRoute?: PortalProjectDomainRoute | null
}): string {
  if (projectRoute) {
    return `https://${projectRoute.domain}${
      projectRoute.pathPrefix === "/" ? "" : projectRoute.pathPrefix
    }`
  }

  const root = workspaceDomain
    ? `https://${workspaceDomain}`
    : `${origin.replace(/\/+$/, "")}/p/${workspaceSlug}`
  return `${root}${isDefault ? "" : `/${projectSlug}`}`
}
