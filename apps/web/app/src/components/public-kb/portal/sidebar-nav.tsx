"use client"

import { useEffect, useMemo, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { ChevronRight } from "lucide-react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import type { SidebarBlock, SidebarGroup } from "@/lib/portal/schema"
import { cn } from "@/lib/utils"
import { hasCustomFolderIcon } from "@/lib/portal/icon-name"
import { PortalIcon } from "./portal-icon"
import {
  useBulkRoutePrefetch,
  useIdleRoutePrefetch,
} from "@/hooks/use-idle-route-prefetch"
import { canPreload, prefetchRouteFull } from "@/lib/preload"
import {
  rememberOpenGroups,
  rememberedOpenGroups,
} from "@/lib/portal/nav-memory"

/** Docs preloaded when a reader opens a folder. */
const FOLDER_PRELOAD_COUNT = 3

/** Document links in reading order (a group's nested folders, then its docs). */
function docsInReadingOrder(
  groups: SidebarGroup[],
): Array<{ id: string; href: string }> {
  const out: Array<{ id: string; href: string }> = []
  const visit = (group: SidebarGroup): void => {
    for (const child of group.children ?? []) visit(child)
    for (const item of group.items) out.push({ id: item.id, href: item.href })
  }
  groups.forEach(visit)
  return out
}

/**
 * The pages a reader is most likely to open next: the two after the current
 * doc and the one before it, or the first two docs when no doc is active.
 */
function likelyNextHrefs(
  ordered: Array<{ id: string; href: string }>,
  pathname: string,
  activeDocumentId?: string,
): string[] {
  const index = ordered.findIndex((entry) =>
    activeDocumentId ? entry.id === activeDocumentId : entry.href === pathname,
  )
  const picks =
    index === -1
      ? ordered.slice(0, 2)
      : [ordered[index + 1], ordered[index + 2], ordered[index - 1]]
  return picks.filter((entry) => entry !== undefined).map((entry) => entry.href)
}

function activeGroupIdsForPath(groups: SidebarGroup[], pathname: string, activeDocumentId?: string): Set<string> {
  const ids = new Set<string>()

  function visit(group: SidebarGroup): boolean {
    const selfActive = group.href === pathname || group.items.some((item) => activeDocumentId ? item.id === activeDocumentId : item.href === pathname)
    const childActive = (group.children ?? []).some(visit)
    if (selfActive || childActive) ids.add(group.id)
    return selfActive || childActive
  }

  groups.forEach(visit)
  return ids
}

// Grouped left-rail navigation. Folder nodes may contain direct document links
// and nested folder nodes; each node controls its own disclosure.
export function SidebarNav({
  block,
  variant = "default",
  activeDocumentId,
  prefetch = true,
}: {
  block: SidebarBlock
  variant?: "default" | "docs"
  /**
   * False where the links are intercepted rather than followed (the builder's
   * editor frame), so prefetching their portal pages would be wasted renders.
   */
  prefetch?: boolean
  /** Resolved identity also matches slug aliases and rewritten public URLs. */
  activeDocumentId?: string
}): React.ReactElement {
  const pathname = usePathname()
  const router = useRouter()
  const isDocs = variant === "docs"
  // The builder preview serves draft pages that change on every edit; there
  // is nothing worth preloading there.
  const preloadEnabled = prefetch && !pathname.startsWith("/portal-preview")
  const readingOrder = useMemo(
    () => docsInReadingOrder(block.groups),
    [block.groups],
  )
  const nextHrefs = useMemo(
    () => likelyNextHrefs(readingOrder, pathname, activeDocumentId),
    [readingOrder, pathname, activeDocumentId],
  )
  // First the pages most likely to be opened next...
  useIdleRoutePrefetch(nextHrefs, preloadEnabled)
  // ...then the rest of the rail, nearest the current page first, so the whole
  // section behaves like one page that is already loaded.
  const { bulkHrefs, bulkKey } = useMemo(() => {
    const index = readingOrder.findIndex((entry) =>
      activeDocumentId ? entry.id === activeDocumentId : entry.href === pathname,
    )
    const start = index === -1 ? 0 : index + 1
    const nearestFirst = [
      ...readingOrder.slice(start),
      ...readingOrder.slice(0, Math.max(index, 0)).reverse(),
    ]
    return {
      bulkHrefs: nearestFirst.map((entry) => entry.href),
      bulkKey: readingOrder.map((entry) => entry.id).join(","),
    }
  }, [readingOrder, pathname, activeDocumentId])
  useBulkRoutePrefetch(bulkHrefs, bulkKey, preloadEnabled)
  // Explicit block setting wins; otherwise the docs rail is text-only and the
  // default/help rails carry their group glyphs.
  const showIcons = block.showIcons ?? !isDocs
  const activeGroupIds = useMemo(
    () => activeGroupIdsForPath(block.groups, pathname, activeDocumentId),
    [block.groups, pathname, activeDocumentId],
  )
  // Folders containing the current page start open, and stay open: without
  // recording them here a folder was only open *while* it held the current
  // page, so opening a document elsewhere collapsed the folder you came from.
  //
  // The portal renders this rail inside each document page, so it is rebuilt
  // on every navigation; the starting state therefore also restores what the
  // reader had open before the click (see lib/portal/nav-memory.ts). The
  // current page's folders are applied last so they always win.
  const [openOverrides, setOpenOverrides] = useState<Map<string, boolean>>(
    () =>
      new Map([
        ...rememberedOpenGroups(),
        ...[...activeGroupIds].map((id): [string, boolean] => [id, true]),
      ]),
  )
  useEffect(() => {
    rememberOpenGroups(openOverrides)
  }, [openOverrides])

  // The rail stays mounted across client navigations. On arriving at a page,
  // open the folders that contain it (overriding a manual collapse, so the
  // current page is always visible) and keep them open afterwards; every
  // other folder keeps whatever state it had.
  const currentPage = activeDocumentId ?? pathname
  const [lastPage, setLastPage] = useState(currentPage)
  if (lastPage !== currentPage) {
    setLastPage(currentPage)
    if ([...activeGroupIds].some((id) => openOverrides.get(id) !== true)) {
      const next = new Map(openOverrides)
      for (const id of activeGroupIds) next.set(id, true)
      setOpenOverrides(next)
    }
  }

  function toggleGroup(group: SidebarGroup, defaultOpen: boolean): void {
    const id = group.id
    const opening = !(openOverrides.get(id) ?? defaultOpen)
    // Opening a folder signals intent: preload its first few docs so the one
    // the reader picks is already there.
    if (opening && preloadEnabled && canPreload()) {
      for (const item of group.items.slice(0, FOLDER_PRELOAD_COUNT)) {
        prefetchRouteFull(router, item.href)
      }
    }
    setOpenOverrides((current) => {
      const next = new Map(current)
      next.set(id, !(next.get(id) ?? defaultOpen))
      return next
    })
  }

  function renderGroup(group: SidebarGroup, depth = 0): React.ReactElement {
    const children = group.children ?? []
    const hasItems = group.items.length > 0
    const hasChildren = children.length > 0
    const hasContent = hasItems || hasChildren
    const isRoot = depth === 0
    const defaultOpen = activeGroupIds.has(group.id)
    const isOpen = isRoot || (openOverrides.get(group.id) ?? defaultOpen)
    const isActive = group.href === pathname
    const contentClassName = isDocs
      ? isRoot
        ? "mt-2 space-y-1"
        : "mt-1 space-y-1 pl-4"
      : isRoot
        ? "mt-4 space-y-3 pl-8"
        : "mt-2 space-y-2 pl-7"

    return (
      <div key={group.id}>
        <div
          className={cn(
            "group flex items-center gap-2 outline-none transition-colors hover:text-foreground",
            isDocs ? "rounded-md" : "rounded-lg",
          )}
        >
          {hasContent && !isRoot ? (
            <button
              type="button"
              aria-label={isOpen ? `Collapse ${group.label}` : `Expand ${group.label}`}
              aria-expanded={isOpen}
              onClick={() => toggleGroup(group, defaultOpen)}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isDocs && "ml-1",
              )}
            >
              <ChevronRight
                className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
              />
            </button>
          ) : !isRoot ? (
            <span className="size-5 shrink-0" />
          ) : null}

          {group.href && !/\/folder\//.test(group.href) ? (
            <HoverPrefetchLink
              href={group.href}
              disableHoverPrefetch={!preloadEnabled}
              className={cn(
                "flex min-w-0 flex-1 items-center rounded outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                isDocs ? "px-2 py-1.5" : isRoot ? "gap-3" : "gap-2",
                isActive
                  ? isDocs
                    ? "font-semibold"
                    : "text-foreground"
                  : isDocs
                    ? "hover:bg-muted/60 hover:text-foreground"
                    : "hover:text-foreground",
              )}
              style={
                isDocs && isActive
                  ? {
                      backgroundColor: isRoot
                        ? undefined
                        : "color-mix(in srgb, var(--portal-accent) 10%, transparent)",
                      color: "var(--portal-accent)",
                    }
                  : undefined
              }
            >
              {isRoot && showIcons && hasCustomFolderIcon(group.icon) && (
                <PortalIcon
                  name={group.icon}
                  className={cn(
                    "shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground",
                    isDocs ? "mr-2 size-4" : "size-5",
                  )}
                />
              )}
              <span
                className={cn(
                  "truncate",
                  isDocs
                    ? isRoot
                      ? "text-[11px] font-bold uppercase tracking-[0.08em] text-foreground"
                      : "text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground"
                    : isRoot
                      ? "font-semibold text-foreground"
                      : "font-medium text-muted-foreground transition-colors group-hover:text-foreground",
                  isActive && !isDocs && "text-foreground",
                )}
              >
                {group.label}
              </span>
            </HoverPrefetchLink>
          ) : (
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center rounded",
                isDocs ? "px-2 py-1.5" : isRoot ? "gap-3" : "gap-2",
              )}
            >
              {isRoot && showIcons && hasCustomFolderIcon(group.icon) && (
                <PortalIcon
                  name={group.icon}
                  className={cn(
                    "shrink-0 text-muted-foreground/45",
                    isDocs ? "mr-2 size-4" : "size-5",
                  )}
                />
              )}
              <p
                className={cn(
                  "truncate",
                  isDocs
                    ? isRoot
                      ? "text-[11px] font-bold uppercase tracking-[0.08em] text-foreground"
                      : "text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground"
                    : isRoot
                      ? "font-semibold text-foreground"
                      : "font-medium text-muted-foreground transition-colors group-hover:text-foreground",
                )}
              >
                {group.label}
              </p>
            </div>
          )}
        </div>

        {hasContent && isOpen && (
          <div className={contentClassName}>
            {children.map((child) => renderGroup(child, depth + 1))}
            {hasItems && (
              <ul className={cn(isDocs ? "space-y-1" : "space-y-2")}>
                {group.items.map((item) => {
                  const itemActive = activeDocumentId
                    ? item.id === activeDocumentId
                    : item.href === pathname
                  return (
                    <li key={item.id}>
                      <HoverPrefetchLink
                        href={item.href}
                        disableHoverPrefetch={!preloadEnabled}
                        aria-current={itemActive ? "page" : undefined}
                        className={cn(
                          "block truncate rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                          isDocs && "px-2.5 py-1.5 text-[13px]",
                          itemActive
                            ? "bg-blue-500/10 font-medium text-blue-600 dark:bg-blue-400/15 dark:text-blue-400"
                            : isDocs
                              ? "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {item.label}
                      </HoverPrefetchLink>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <nav
      aria-label="Knowledge base sections"
      className={cn(isDocs ? "space-y-7 text-[13px]" : "space-y-8 text-sm")}
    >
      {block.groups.map((group) => renderGroup(group, 0))}
    </nav>
  )
}
