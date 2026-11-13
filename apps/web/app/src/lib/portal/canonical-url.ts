import type {
  PortalAddressMode,
  PortalAddressScope,
} from "@/lib/workspace-settings"

export interface PortalCanonicalProjectRoute {
  domain: string
  pathPrefix: string
}

export interface PortalCanonicalBaseInput {
  workspaceSlug: string
  projectSlug: string
  workspaceDomain?: string | null
  workspaceAddressScope?: PortalAddressScope
  workspaceAddressMode?: PortalAddressMode
  projectRoute?: PortalCanonicalProjectRoute | null
  requestPublicBase?: string | null
  publicKbBaseDomain?: string | null
  appUrl: string
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

function isExternalPublicMount(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    return !new URL(value).pathname.startsWith("/p/")
  } catch {
    return false
  }
}

/**
 * Choose one stable public root for a portal project. Saved project/workspace
 * hosting wins over the incoming request so the Worker mount, wildcard host,
 * and always-on /p alias all emit the same canonical.
 */
export function portalCanonicalBaseUrl(
  input: PortalCanonicalBaseInput,
): string {
  const {
    workspaceSlug,
    projectSlug,
    workspaceDomain,
    workspaceAddressScope,
    workspaceAddressMode,
    projectRoute,
    requestPublicBase,
    publicKbBaseDomain,
    appUrl,
  } = input

  if (projectRoute) {
    return `https://${projectRoute.domain}${
      projectRoute.pathPrefix === "/"
        ? ""
        : withoutTrailingSlash(projectRoute.pathPrefix)
    }`
  }

  if (
    workspaceAddressScope === "workspace" &&
    workspaceDomain &&
    workspaceAddressMode !== "breezify"
  ) {
    const root = `https://${workspaceDomain}`
    if (workspaceAddressMode === "path") return `${root}/${projectSlug}`
    return projectSlug === workspaceSlug ? root : `${root}/${projectSlug}`
  }

  // A trusted proxy/custom-host mount that is not represented in stored
  // configuration is still a better public address than its /p origin.
  if (isExternalPublicMount(requestPublicBase)) {
    return withoutTrailingSlash(requestPublicBase)
  }

  if (publicKbBaseDomain) {
    const root = `https://${workspaceSlug}.${publicKbBaseDomain}`
    return projectSlug === workspaceSlug ? root : `${root}/${projectSlug}`
  }

  const root = `${withoutTrailingSlash(appUrl)}/p/${workspaceSlug}`
  return projectSlug === workspaceSlug ? root : `${root}/${projectSlug}`
}

function encodePortalRef(ref: string): string {
  return ref
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")
}

/** Build the canonical for one home, document, folder, or project-page view. */
export function portalCanonicalPageUrl(
  baseUrl: string,
  view: "home" | "doc" | "folder" | "page",
  ref?: string | null,
): string {
  const base = withoutTrailingSlash(baseUrl)
  if (view === "home") return base
  const encoded = encodePortalRef(ref ?? "")
  return encoded ? `${base}/${view}/${encoded}` : base
}
