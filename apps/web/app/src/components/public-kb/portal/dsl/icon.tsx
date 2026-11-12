import type { LucideIcon } from "lucide-react"
import dynamicIconImports from "lucide-react/dynamicIconImports"
import { hasPortalGlyph, PortalGlyph } from "@/components/icons/portal-glyphs"
import { toLucideKey } from "@/lib/portal/icon-name"
import { cn } from "@/lib/utils"

// dynamicIconImports is typed as a 1,951-key literal; index it as a name->loader
// map so a runtime icon name can resolve (missing key → undefined → FileText).
const iconImports = dynamicIconImports as Record<
  string,
  (() => Promise<{ default: LucideIcon }>) | undefined
>

// ---------------------------------------------------------------------------
// Portal DSL — icon resolver.
//
// The DSL `Icon` primitive carries a FREE icon name (no allowlist) — this is
// the open icon set (1,951 lucide icons, kebab-case) that replaces the old
// 16-name enum. The name is resolved to a lucide component at render time via
// `lucide-react/dynamicIconImports` (the documented dynamic-import map), with a
// `FileText` fallback for unknown/failed names. Resolution is async, so this is
// a server component — fine, the portal render path is an RSC.
//
// lucide-react@0.577 has no `exports` map and no `DynamicIcon`; the root
// `dynamicIconImports` default export (Record<kebab, () => Promise<{default}>>)
// is the supported path.
// ---------------------------------------------------------------------------

const SIZE_CLASS = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
  xl: "h-8 w-8",
} as const

const TONE_CLASS = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  accent: "text-[var(--portal-accent)]",
} as const

export type DslIconSize = keyof typeof SIZE_CLASS
export type DslIconTone = keyof typeof TONE_CLASS

export async function DslIcon({
  name,
  size = "md",
  tone,
  className,
}: {
  name: string
  size?: DslIconSize
  tone?: DslIconTone
  className?: string
}): Promise<React.ReactElement> {
  const classes = cn(SIZE_CLASS[size] ?? SIZE_CLASS.md, tone && TONE_CLASS[tone], className)
  const key = toLucideKey(name)
  // Brand glyphs first — every icon the built-in initialization emits resolves
  // to the custom Bread set; the lucide dynamic map is only the long tail for
  // exotic agent-authored names.
  if (hasPortalGlyph(key)) {
    return <PortalGlyph name={key} className={classes} />
  }
  const importer = iconImports[key]
  if (!importer) {
    return <PortalGlyph name="file-text" className={classes} />
  }
  let Icon: LucideIcon
  try {
    Icon = (await importer()).default
  } catch {
    return <PortalGlyph name="file-text" className={classes} />
  }
  return <Icon className={classes} />
}
