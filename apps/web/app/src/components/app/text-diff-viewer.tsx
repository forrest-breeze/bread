"use client"

import { buildDiffStat, buildTextDiff } from "@/lib/text-diff"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

interface TextDiffViewerProps {
  previousText: string
  nextText: string
  emptyMessage?: string
  className?: string
}

function normalizeForDiff(value: string): string {
  if (!value.trim()) {
    return ""
  }

  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(value)
  if (!looksLikeHtml || typeof DOMParser === "undefined") {
    return value
  }

  const parsed = new DOMParser().parseFromString(value, "text/html")
  const blockSelectors = [
    "p",
    "li",
    "h1",
    "h2",
    "h3",
    "blockquote",
    "pre",
    "code",
  ]
  const blockNodes = Array.from(parsed.body.querySelectorAll(blockSelectors.join(",")))
  if (blockNodes.length === 0) {
    return parsed.body.textContent ?? value
  }

  return blockNodes
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
}

export function TextDiffViewer({
  previousText,
  nextText,
  emptyMessage = "No changes.",
  className,
}: TextDiffViewerProps): React.ReactElement {
  const diffLines = buildTextDiff(
    normalizeForDiff(previousText),
    normalizeForDiff(nextText),
  )

  if (diffLines.length === 0) {
    return (
      <div className={cn("rounded border bg-muted/20 px-3 py-2 text-xs text-muted-foreground", className)}>
        {emptyMessage}
      </div>
    )
  }

  return (
    <ScrollArea className={cn("h-56 rounded border bg-muted/20", className)}>
      <div className="font-mono text-xs">
        {diffLines.map((line, index) => {
          if (line.type === "skipped") {
            return (
              <div
                key={`skip-${index}`}
                className="border-y border-border/60 bg-background/80 px-3 py-1 text-[11px] text-muted-foreground"
              >
                …
              </div>
            )
          }

          const prefix = line.type === "added" ? "+" : line.type === "removed" ? "-" : " "

          return (
            <div
              key={`${line.type}-${index}-${line.value}`}
              className={cn(
                // `anywhere` rather than break-word: frontmatter UUIDs and long
                // URLs have no break opportunity, so without it one line sets
                // the width of the whole pane.
                "whitespace-pre-wrap px-3 py-1 leading-relaxed [overflow-wrap:anywhere]",
                line.type === "added" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                line.type === "removed" && "bg-red-500/10 text-red-700 dark:text-red-300",
                line.type === "context" && "text-muted-foreground",
              )}
            >
              <span className="mr-2 inline-block w-3 select-none text-center opacity-70">
                {prefix}
              </span>
              {line.value || " "}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}

/**
 * Git-style `+N −N` summary for a pair of texts. Applies the same HTML→text
 * normalization the viewer does, so the counts match the lines rendered
 * beneath them rather than counting raw markup.
 */
export function DiffStat({
  previousText,
  nextText,
  className,
}: {
  previousText: string
  nextText: string
  className?: string
}): React.ReactElement | null {
  const { added, removed } = buildDiffStat(
    normalizeForDiff(previousText),
    normalizeForDiff(nextText),
  )
  if (added === 0 && removed === 0) return null

  return (
    <span
      className={cn("shrink-0 font-mono text-[11px] tabular-nums", className)}
      aria-label={`${added} lines added, ${removed} lines removed`}
    >
      {added > 0 && (
        <span className="text-emerald-700 dark:text-emerald-300">+{added}</span>
      )}
      {added > 0 && removed > 0 && <span className="text-muted-foreground"> </span>}
      {removed > 0 && (
        <span className="text-red-700 dark:text-red-300">−{removed}</span>
      )}
    </span>
  )
}
