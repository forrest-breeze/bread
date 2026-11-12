"use client"

import { useState } from "react"
import { Globe, Copy, Check, ExternalLink, Settings2 } from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { Button } from "@/components/ui/button"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { useWorkspace } from "@/hooks/swr"
import { getKbPublic, getKbCustomDomain } from "@/lib/workspace-settings"
import { cn } from "@/lib/utils"
import type { WorkspaceRole } from "@bread/core"

/**
 * Shows the portal address at the top of the KB home — the same link configured
 * under Settings → Public Knowledge Base — so editors can copy or open exactly
 * what viewers see without leaving the editor.
 */
export function KbPortalBanner({
  className,
}: {
  className?: string
}): React.ReactElement | null {
  const { data: workspace } = useWorkspace()
  const hasHydrated = useHasHydrated()
  const [copied, setCopied] = useState(false)

  if (!hasHydrated || !workspace?.slug) return null

  const role = (workspace.user_role as WorkspaceRole | undefined) ?? "viewer"
  const isAdmin = role === "owner" || role === "admin"
  const isPublic = getKbPublic(workspace.settings)
  const customDomain = getKbCustomDomain(workspace.settings)
  const portalKey = workspace.slug

  // A configured custom domain overrides the address for visitors (published
  // portals only); otherwise the portal lives at the app-host base path
  // /p/<slug>. Mirrors Settings → Public Portal Address so the editor shows
  // exactly the URL viewers get (not the legacy <slug>.<base> subdomain form).
  const portalPath = `/p/${portalKey}`
  const useCustomDomain = isPublic && Boolean(customDomain)
  const portalHref = useCustomDomain ? `https://${customDomain}` : portalPath
  const portalUrl = useCustomDomain
    ? `https://${customDomain}`
    : `${window.location.origin}${portalPath}`

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(portalUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable (insecure context) — ignore silently.
    }
  }

  return (
    <div
      className={cn(
        "grid gap-2 rounded-lg border border-border/80 bg-card/80 px-3 py-2.5 shadow-sm",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          <Globe
            className={
              isPublic
                ? "size-4 shrink-0 text-primary"
                : "size-4 shrink-0 text-muted-foreground"
            }
          />
          {isPublic ? "Public portal" : "Private portal"}
        </div>
        <code
          title={portalUrl}
          className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border bg-muted/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
        >
          {portalUrl}
        </code>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {isAdmin && (
          <HoverPrefetchLink
            href="/kb"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium transition-colors hover:bg-muted"
          >
            <Settings2 className="size-3.5" />
            Customize
          </HoverPrefetchLink>
        )}
        <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <a
          href={portalHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium transition-colors hover:bg-muted"
        >
          <ExternalLink className="size-3.5" />
          Visit
        </a>
        {!isPublic && isAdmin && (
          <HoverPrefetchLink
            href="/settings/workspace"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[0.8rem] font-medium transition-colors hover:bg-muted"
          >
            <Settings2 className="size-3.5" />
            Publish
          </HoverPrefetchLink>
        )}
      </div>
    </div>
  )
}
