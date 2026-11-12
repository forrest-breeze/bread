"use client"

import { lazy, Suspense, type ComponentType } from "react"
import type { LucideIcon } from "lucide-react"
import dynamicIconImports from "lucide-react/dynamicIconImports"

// Client twin of the server resolver in dsl/icon.tsx: the open lucide set
// (1,951 icons, kebab-case) loaded on demand as per-icon chunks. Client
// surfaces (portal sidebar, KB tree, icon picker) can't use the async server
// component, so this wraps each importer in a cached React.lazy.
const iconImports = dynamicIconImports as Record<
  string,
  (() => Promise<{ default: LucideIcon }>) | undefined
>

/** Every lucide icon name (kebab-case), for picker catalogs. */
export const LUCIDE_ICON_NAMES: readonly string[] = Object.keys(dynamicIconImports)

/** Whether a kebab-case name resolves to a lucide icon. */
export function hasLucideIcon(name: string): boolean {
  return Boolean(iconImports[name])
}

// lazy() must return a stable reference per name — recreating it on each
// render would remount (and refetch) the icon.
const lazyIcons = new Map<string, ComponentType<{ className?: string }>>()

function getLazyIcon(
  name: string,
): ComponentType<{ className?: string }> | null {
  const importer = iconImports[name]
  if (!importer) return null
  let Icon = lazyIcons.get(name)
  if (!Icon) {
    Icon = lazy(importer)
    lazyIcons.set(name, Icon)
  }
  return Icon
}

/**
 * A lucide icon by kebab-case name, code-split per icon. Renders nothing for
 * unknown names (callers decide their own fallback) and an empty placeholder
 * of the same footprint while the chunk loads.
 */
export function DynamicLucideIcon({
  name,
  className,
}: {
  name: string
  className?: string
}): React.ReactElement | null {
  const Icon = getLazyIcon(name)
  if (!Icon) return null
  return (
    <Suspense fallback={<span aria-hidden className={className} />}>
      {/* eslint-disable-next-line react-hooks/static-components -- the
          module-level cache makes the lazy reference stable per name */}
      <Icon className={className} />
    </Suspense>
  )
}
