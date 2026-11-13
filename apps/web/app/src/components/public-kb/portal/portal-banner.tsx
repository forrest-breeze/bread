"use client"

import { useEffect, useState } from "react"
import { X } from "lucide-react"
import type { PortalBanner as PortalBannerConfig } from "@/lib/portal/schema"
import { cn } from "@/lib/utils"

const TONE_CLASSES: Record<NonNullable<PortalBannerConfig["tone"]>, string> = {
  brand: "text-white",
  info: "bg-sky-50 text-sky-950 dark:bg-sky-950 dark:text-sky-50",
  warning: "bg-amber-50 text-amber-950 dark:bg-amber-950 dark:text-amber-50",
  critical: "bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-50",
}

// Dismissal is remembered per banner text, so editing the announcement shows
// it again to visitors who closed the previous one.
function storageKey(scope: string, text: string): string {
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return `breezify:portal-banner:${scope}:${hash}`
}

/** Announcement bar shown above the portal header. */
export function PortalBanner({
  banner,
  scope,
  preview = false,
}: {
  banner: PortalBannerConfig
  /** Portal base, so dismissing one portal's banner leaves others alone. */
  scope: string
  /** The editor preview always shows the banner so it can be styled. */
  preview?: boolean
}): React.ReactElement | null {
  const key = storageKey(scope, banner.text)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (preview || !banner.dismissible) return
    try {
      // Read after mount: the server render cannot know the visitor's choice.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(window.localStorage.getItem(key) === "1")
    } catch {
      // Storage unavailable: keep showing the banner.
    }
  }, [banner.dismissible, key, preview])

  if (dismissed) return null
  const tone = banner.tone ?? "brand"

  return (
    <div
      role="region"
      aria-label="Announcement"
      data-portal-banner
      className={cn(
        "relative flex min-h-10 items-center justify-center gap-2 px-10 py-2 text-center text-sm",
        TONE_CLASSES[tone],
      )}
      style={tone === "brand" ? { backgroundColor: "var(--portal-accent)" } : undefined}
    >
      <span>
        {banner.text}
        {banner.linkHref && banner.linkLabel ? (
          <>
            {" "}
            <a href={banner.linkHref} className="font-semibold underline underline-offset-2">
              {banner.linkLabel}
            </a>
          </>
        ) : null}
      </span>
      {banner.dismissible ? (
        <button
          type="button"
          aria-label="Dismiss announcement"
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 opacity-70 transition-opacity hover:opacity-100"
          onClick={() => {
            setDismissed(true)
            if (preview) return
            try {
              window.localStorage.setItem(key, "1")
            } catch {
              // Storage unavailable: dismissal lasts for this page view.
            }
          }}
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  )
}
