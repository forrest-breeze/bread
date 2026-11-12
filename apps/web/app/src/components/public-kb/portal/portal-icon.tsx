"use client"

import { hasPortalGlyph, PortalGlyph } from "@/components/icons/portal-glyphs"
import {
  DynamicLucideIcon,
  hasLucideIcon,
} from "@/components/icons/dynamic-lucide-icon"
import { toLucideKey } from "@/lib/portal/icon-name"

/**
 * Whether a name resolves to a real icon (brand glyph or lucide) instead of
 * PortalIcon's file-text fallback. Chrome that has its own better fallback
 * (e.g. the KB tree's generic folder marks) gates on this.
 */
export function isRenderablePortalIconName(name: string): boolean {
  const key = toLucideKey(name)
  return hasPortalGlyph(key) || hasLucideIcon(key)
}

// Resolves a portal icon name with the same precedence as the server-side
// dsl/icon.tsx: Bread brand glyphs (components/icons/portal-glyphs.tsx)
// first, then the open lucide set (code-split per icon via
// dynamic-lucide-icon.tsx), with the file-text mark as the universal fallback
// for unknown names. This is a client boundary because the open lucide catalog
// and its React.lazy imports live in dynamic-lucide-icon.tsx. Server-rendered
// portal blocks can render this component, but must not execute hasLucideIcon.
export function PortalIcon({
  name,
  className,
}: {
  name?: string
  className?: string
}): React.ReactElement {
  const key = name ? toLucideKey(name) : ""
  if (!key || hasPortalGlyph(key)) {
    return <PortalGlyph name={key || undefined} className={className} />
  }
  if (hasLucideIcon(key)) {
    return <DynamicLucideIcon name={key} className={className} />
  }
  return <PortalGlyph name="file-text" className={className} />
}
