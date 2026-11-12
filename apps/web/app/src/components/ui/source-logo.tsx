import { FileText, Monitor, Terminal } from "lucide-react"
import { cn } from "@/lib/utils"

interface SourceLogoProps {
  source?: string | null
  size?: number
  className?: string
}

function SlackLogo({
  size,
  className,
}: {
  size: number
  className?: string
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("shrink-0", className)}
    >
      <path
        d="M5.04 15.18a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52ZM6.3 15.18a2.52 2.52 0 1 1 5.04 0v6.3a2.52 2.52 0 1 1-5.04 0v-6.3Z"
        fill="#E01E5A"
      />
      <path
        d="M8.82 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.82ZM8.82 6.3a2.52 2.52 0 1 1 0 5.04h-6.3a2.52 2.52 0 1 1 0-5.04h6.3Z"
        fill="#36C5F0"
      />
      <path
        d="M18.96 8.82a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.82ZM17.7 8.82a2.52 2.52 0 1 1-5.04 0v-6.3a2.52 2.52 0 1 1 5.04 0v6.3Z"
        fill="#2EB67D"
      />
      <path
        d="M15.18 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52ZM15.18 17.7a2.52 2.52 0 1 1 0-5.04h6.3a2.52 2.52 0 1 1 0 5.04h-6.3Z"
        fill="#ECB22E"
      />
    </svg>
  )
}

function GitHubLogo({
  size,
  className,
}: {
  size: number
  className?: string
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("shrink-0 text-foreground", className)}
    >
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2Z" />
    </svg>
  )
}

export function SourceLogo({
  source,
  size = 16,
  className,
}: SourceLogoProps) {
  // Historical DB rows and current integrations do not use consistent casing.
  // Normalize once before selecting a label or icon.
  const key = source?.toLowerCase() ?? ""

  if (key === "slack") {
    return <SlackLogo size={size} className={className} />
  }

  if (key === "github") {
    return <GitHubLogo size={size} className={className} />
  }

  if (key === "waterfall") {
    // Legacy desktop captures. Generic icon: the old app's mark was removed.
    return <Monitor size={size} className={cn("shrink-0", className)} aria-hidden="true" />
  }

  const Icon = key === "mcp" ? Terminal : FileText

  return (
    <Icon
      aria-hidden="true"
      className={cn("shrink-0 text-muted-foreground", className)}
      style={{ width: size, height: size }}
    />
  )
}

/**
 * Human-readable label for a `captures.source_kind` value. Used by inbox
 * cards to render the source badge text next to the logo.
 */
export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "Unknown"
  const key = source.toLowerCase()
  switch (key) {
    case "slack":
      return "Slack"
    case "github":
      return "GitHub"
    case "cli":
      return "Legacy capture"
    case "mcp":
      return "MCP"
    case "waterfall":
      return "Legacy desktop"
    case "web_manual":
      return "Web"
    case "import":
      return "Import"
    default:
      return source
  }
}
