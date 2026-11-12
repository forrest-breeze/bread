"use client"

import { useState, type RefObject } from "react"
import { Check, Clipboard } from "lucide-react"
import { cn } from "@/lib/utils"

// "Copy page" — hands a reader the whole article as plain text, which is what
// people paste into an LLM. Reading the RENDERED text rather than the stored
// body keeps it correct for every storage format (markdown, authored HTML) and
// matches what the reader actually sees, including server-rendered code blocks.
interface PortalCopyPageButtonProps {
  /** Container whose rendered text is copied. */
  targetRef: RefObject<HTMLElement | null>
  /** Prepended to the copy — the title when it sits outside the container. */
  heading?: string
  className?: string
}

export function PortalCopyPageButton({
  targetRef,
  heading,
  className,
}: PortalCopyPageButtonProps): React.ReactElement {
  const [copied, setCopied] = useState(false)

  async function copy(): Promise<void> {
    const body = targetRef.current?.innerText.trim()
    if (!body) return
    const text = heading?.trim() ? `${heading.trim()}\n\n${body}` : body
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied (permissions, insecure origin). Leave the
      // button in its resting state rather than claiming a copy that never was.
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {copied ? (
        <Check className="size-4" />
      ) : (
        <Clipboard className="size-4" />
      )}
      {copied ? "Copied" : "Copy page"}
    </button>
  )
}
