"use client"

import { useState } from "react"
import { ThumbsDown, ThumbsUp } from "lucide-react"
import { trackPortalEvent } from "@/lib/portal/track-client"
import { cn } from "@/lib/utils"

interface PortalPageFeedbackProps {
  /** Portal base path: "<workspace>" or "<workspace>/<project>". */
  slug: string
  /** The document the feedback is about (verified server-side on capture). */
  documentId: string
}

/**
 * "Was this page helpful?" — a one-shot Yes/No widget that records reader
 * feedback to the portal analytics pipeline (helpful / not_helpful events on
 * /api/public/track, surfaced on the Reporting page). Best-effort like every
 * other portal beacon; a failed send never surfaces to the reader. Once a vote
 * is cast the controls collapse to a thank-you note so it can't be spammed.
 */
export function PortalPageFeedback({
  slug,
  documentId,
}: PortalPageFeedbackProps): React.ReactElement {
  const [voted, setVoted] = useState<"yes" | "no" | null>(null)

  function vote(value: "yes" | "no"): void {
    if (voted) return
    setVoted(value)
    trackPortalEvent({
      portal: slug,
      type: value === "yes" ? "helpful" : "not_helpful",
      documentId,
      path:
        typeof window !== "undefined"
          ? window.location.pathname + window.location.search
          : undefined,
    })
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-4">
      <p className="text-sm font-medium text-foreground">
        {voted ? "Thanks for your feedback!" : "Was this page helpful?"}
      </p>
      {!voted && (
        <div className="flex items-center gap-2">
          <FeedbackButton onClick={() => vote("yes")} icon={ThumbsUp} label="Yes" />
          <FeedbackButton onClick={() => vote("no")} icon={ThumbsDown} label="No" />
        </div>
      )}
    </section>
  )
}

function FeedbackButton({
  onClick,
  icon: Icon,
  label,
}: {
  onClick: () => void
  icon: typeof ThumbsUp
  label: string
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition-colors",
        "hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
}
