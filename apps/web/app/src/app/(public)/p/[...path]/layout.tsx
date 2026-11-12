import type { Metadata } from "next"
import { cookies, headers } from "next/headers"
import "@/styles/portal-docs.css"
import { notFound } from "next/navigation"
import { requirePortal } from "@/lib/public-kb-route"
import { getPortalEntitlementsForWorkspace } from "@/lib/db/subscription"
import { portalPublicNextPath } from "@/lib/portal/login-return"
import { parsePortalPath } from "@/lib/portal/portal-path"
import { PortalShell } from "@/components/public-kb/portal/portal-shell"
import { publicPortalBasePath } from "@/lib/portal/public-base-path"
import {
  portalLlmsFilename,
  resolvePortalPublicUrl,
} from "@/lib/portal/llms-txt-request"
import { portalLanguageCookieName } from "@/lib/portal/language-preference"

export const dynamic = "force-dynamic"

const NOT_FOUND_META: Metadata = {
  title: "Knowledge Base",
  robots: { index: false, follow: false },
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ path: string[] }>
}): Promise<Metadata> {
  const { path } = await params
  const parsed = parsePortalPath(path)
  if (!parsed) return NOT_FOUND_META
  // Same cached resolution as the layout body below — gating (login redirect /
  // not-found) is shared, so a private portal never leaks branding here.
  const { workspace, base } = await requirePortal(
    parsed.workspaceSlug,
    parsed.projectSlug,
    await portalPublicNextPath(
      parsed.workspaceSlug,
      parsed.projectSlug,
      `/p/${path.join("/")}`,
    ),
  )
  const { branding, isPublic } = workspace
  // Machine-readable index, advertised so an agent that lands on any portal page
  // can find the whole KB in one fetch. Public portals only — a private portal's
  // llms.txt 404s, so pointing at it would be misleading.
  const llmsUrl = isPublic
    ? `${resolvePortalPublicUrl(await headers(), base)}/${portalLlmsFilename("index")}`
    : null
  const iconQuery = new URLSearchParams({ workspace: parsed.workspaceSlug })
  if (parsed.projectSlug) iconQuery.set("project", parsed.projectSlug)
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(
    /\/+$/,
    "",
  )
  return {
    title: { default: branding.name, template: `%s · ${branding.name}` },
    description: branding.tagline || `${branding.name} knowledge base`,
    icons: {
      icon: {
        url: `${appUrl}/api/public/portal-icon?${iconQuery.toString()}`,
      },
    },
    robots: isPublic ? undefined : { index: false, follow: false },
    ...(llmsUrl
      ? {
          alternates: {
            types: { "text/plain": [{ url: llmsUrl, title: "llms.txt" }] },
          },
        }
      : {}),
  }
}

export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ path: string[] }>
}): Promise<React.ReactElement> {
  const { path } = await params
  const parsed = parsePortalPath(path)
  if (!parsed) notFound()
  const {
    workspace,
    layout: published,
    base,
  } = await requirePortal(
    parsed.workspaceSlug,
    parsed.projectSlug,
    await portalPublicNextPath(
      parsed.workspaceSlug,
      parsed.projectSlug,
      `/p/${path.join("/")}`,
    ),
  )
  const requestHeaders = await headers()
  const requestCookies = await cookies()
  const hrefBase = publicPortalBasePath(
    base,
    requestHeaders.get("x-bread-base-path"),
  )
  const entitlements = await getPortalEntitlementsForWorkspace(workspace.id)
  const navigationPages = published?.pages ?? []
  // Ordinary document/folder routes belong to Home. Page routes retain their
  // parent tab even when viewing a nested API endpoint or changelog entry.
  const activePageSlug = parsed.view === "page" ? parsed.refId : null
  return (
    <PortalShell
      workspace={workspace}
      published={published}
      base={base}
      hrefBase={hrefBase}
      askAiEnabled={entitlements.portalAiBuilder}
      canRemoveBreadBranding={entitlements.portalBrandingRemoval}
      translationsEnabled={entitlements.portalTranslations}
      navigationPages={navigationPages}
      activePageSlug={activePageSlug}
      activePageDocRef={
        parsed.view === "page" ? parsed.pageDocRef : undefined
      }
      preferredLanguage={
        requestCookies.get(portalLanguageCookieName(base, false))?.value ?? null
      }
    >
      {children}
    </PortalShell>
  )
}
