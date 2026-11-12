"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { PortalEditDocumentButton } from "@/components/public-kb/portal/portal-edit-document-button"
import { ChevronLeft, ChevronRight, FileCode2, List } from "lucide-react"
import { useDocumentHeadings } from "@/hooks/use-document-headings"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import { KbReadingToc } from "@/components/kb/kb-reading-toc"
import { PublicProse } from "@/components/public-kb/public-prose"
import { PortalFooter } from "@/components/public-kb/portal/portal-footer"
import { PortalSidebarRail } from "./portal-sidebar-rail"
import { PortalCopyPageButton } from "@/components/public-kb/portal/portal-copy-page-button"
import type {
  ApiHttpMethod,
  ApiReferenceSection,
} from "@/lib/portal/api-reference-model"
import type { FooterBlock } from "@/lib/portal/schema"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// API reference — one endpoint per page.
//
// The rail lists every endpoint in the reference and stays put; the main column
// renders the ONE endpoint the URL addresses. Each item is a real link to its
// own URL (built server-side, so the same component serves public portals and
// the builder's preview iframe), which keeps endpoints deep-linkable, indexable,
// and cheap to render — only the active endpoint's HTML crosses the wire.
// ---------------------------------------------------------------------------

/** Rail entry: everything needed to link and label one endpoint, minus its body. */
export interface ApiReferenceNavItem {
  id: string
  slug: string
  title: string
  groupLabel: string
  method: ApiHttpMethod | null
  path: string | null
  href: string
}

interface PortalApiReferenceContentProps {
  /** Page title — labels the rail, and stands in as the heading when empty. */
  title: string
  brandName: string
  items: ApiReferenceNavItem[]
  /** The endpoint this URL renders; null only when the page has no docs. */
  active: ApiReferenceSection | null
  /** True inside the builder preview, where hrefs are preview routes worth no prefetch. */
  disablePrefetch?: boolean
  updated?: string
  editable?: boolean
  footer: FooterBlock
  allowPoweredByRemoval: boolean
  brandLogoUrl: string | null
  brandDarkLogoUrl: string | null
  brandAccentColor: string
}

const OVERVIEW_HEADING_ID = "api-reference-overview"

const METHOD_STYLES: Record<ApiHttpMethod, string> = {
  GET: "border-emerald-500/25 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  POST: "border-blue-500/25 bg-blue-500/12 text-blue-600 dark:text-blue-400",
  PUT: "border-amber-500/25 bg-amber-500/12 text-amber-700 dark:text-amber-400",
  PATCH:
    "border-violet-500/25 bg-violet-500/12 text-violet-600 dark:text-violet-400",
  DELETE: "border-red-500/25 bg-red-500/12 text-red-600 dark:text-red-400",
  HEAD: "border-cyan-500/25 bg-cyan-500/12 text-cyan-600 dark:text-cyan-400",
  OPTIONS:
    "border-slate-500/25 bg-slate-500/12 text-slate-600 dark:text-slate-400",
}

function MethodBadge({
  method,
}: {
  method: ApiHttpMethod
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex min-w-11 shrink-0 items-center justify-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide",
        METHOD_STYLES[method],
      )}
    >
      {method}
    </span>
  )
}

function groupedItems(
  items: ApiReferenceNavItem[],
): Array<{ label: string; items: ApiReferenceNavItem[] }> {
  const groups = new Map<string, ApiReferenceNavItem[]>()
  for (const item of items) {
    const current = groups.get(item.groupLabel) ?? []
    current.push(item)
    groups.set(item.groupLabel, current)
  }
  return Array.from(groups, ([label, entries]) => ({ label, items: entries }))
}

export function PortalApiReferenceContent({
  title,
  brandName,
  items,
  active,
  disablePrefetch = false,
  editable = false,
  updated = "",
  footer,
  allowPoweredByRemoval,
  brandLogoUrl,
  brandDarkLogoUrl,
  brandAccentColor,
}: PortalApiReferenceContentProps): React.ReactElement {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  // The current endpoint's group is always open on arrival. Collapsing it by
  // hand lasts until the next navigation.
  const [activeCollapsed, setActiveCollapsed] = useState(false)
  const activeGroupLabel = active?.groupLabel ?? null
  const [lastActiveId, setLastActiveId] = useState(active?.id)
  if (lastActiveId !== active?.id) {
    setLastActiveId(active?.id)
    setActiveCollapsed(false)
  }
  // The reference can remount on endpoint navigation (including full iframe
  // navigations). Scope disclosure state to its root URL, not the active doc.
  const sidebarStateKey = `portal-api-sidebar:${items[0]?.href ?? title}`
  useEffect(() => {
    let saved: unknown = []
    try {
      saved = JSON.parse(sessionStorage.getItem(sidebarStateKey) ?? "[]")
    } catch {
      // Storage is optional; navigation must still work when it is unavailable.
    }
    if (Array.isArray(saved) && saved.every((label) => typeof label === "string")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate from storage after mount (SSR has none)
      setExpandedGroups(new Set(saved))
    }
  }, [sidebarStateKey])

  function isGroupOpen(label: string): boolean {
    if (label === activeGroupLabel) return !activeCollapsed
    return expandedGroups.has(label)
  }

  function toggleGroup(label: string): void {
    if (label === activeGroupLabel) {
      setActiveCollapsed(!activeCollapsed)
      return
    }
    const next = new Set(expandedGroups)
    if (next.has(label)) next.delete(label)
    else next.add(label)
    setExpandedGroups(next)
    try {
      sessionStorage.setItem(sidebarStateKey, JSON.stringify([...next]))
    } catch {
      // Keep the in-memory disclosure state when storage is unavailable.
    }
  }
  const contentRef = useRef<HTMLDivElement>(null)
  const { headings, activeId } = useDocumentHeadings(
    contentRef,
    active ? `${active.id}:${active.html}:${active.examplesHtml ?? ""}` : "",
  )
  const groups = useMemo(() => groupedItems(items), [items])

  // The endpoint's own title is the page h1, so it is a page marker rather than
  // a table-of-contents entry — both outlines list what is INSIDE the endpoint.
  const detailHeadings = useMemo(
    () =>
      headings.filter(
        (heading) => heading.id !== OVERVIEW_HEADING_ID && heading.level <= 3,
      ),
    [headings],
  )
  const activeIndex = active
    ? items.findIndex((item) => item.id === active.id)
    : -1
  const previous = activeIndex > 0 ? items[activeIndex - 1] : undefined
  const next =
    activeIndex >= 0 && activeIndex < items.length - 1
      ? items[activeIndex + 1]
      : undefined

  function scrollTo(id: string): void {
    contentRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className={cn("min-h-[calc(100vh-4rem)] w-full lg:grid lg:grid-cols-[264px_minmax(0,1fr)] lg:grid-rows-[1fr_auto]", !active?.examplesHtml && "xl:grid-cols-[264px_minmax(0,1fr)_240px]")}>
      <PortalSidebarRail className="bg-muted/10 py-9">
        <nav
          aria-label="API reference sections"
          className="pr-1"
        >
          <p className="mb-5 text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">
            {title}
          </p>

          <div className="space-y-7">
            {groups.map((group) => (
              <div key={group.label}>
                <button
                  type="button"
                  aria-expanded={isGroupOpen(group.label)}
                  onClick={() => toggleGroup(group.label)}
                  className="mb-2 flex w-full items-center gap-2 px-2 text-left text-[11px] font-bold uppercase tracking-[0.08em] text-foreground"
                >
                  <ChevronRight className={cn("size-3.5 transition-transform", isGroupOpen(group.label) && "rotate-90")} />
                  {group.label}
                </button>
                <ul hidden={!isGroupOpen(group.label)} className="space-y-1 border-l border-border/80 pl-3">
                  {group.items.map((item) => {
                    const current = item.id === active?.id
                    return (
                      <li key={item.id}>
                        <HoverPrefetchLink
                          href={item.href}
                          disableHoverPrefetch={disablePrefetch}
                          aria-current={current ? "page" : undefined}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-snug transition-colors",
                            current
                              ? "bg-blue-500/10 font-medium text-blue-600 dark:bg-blue-400/15 dark:text-blue-400"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                        >
                          {item.method ? (
                            <MethodBadge method={item.method} />
                          ) : null}
                          <span className="min-w-0 truncate">
                            {item.path ?? item.title}
                          </span>
                        </HoverPrefetchLink>

                        {/* Pages with examples omit the outline entirely. Other pages
                            keep the nested outline below xl and the right-hand TOC above it. */}
                        {current && !active?.examplesHtml && detailHeadings.length > 0 ? (
                          <ul className="mb-2 mt-1 space-y-0.5 border-l border-border/60 pl-3 xl:hidden">
                            {detailHeadings.map((heading) => (
                              <li key={heading.id}>
                                <button
                                  type="button"
                                  onClick={() => scrollTo(heading.id)}
                                  aria-current={
                                    activeId === heading.id
                                      ? "location"
                                      : undefined
                                  }
                                  className={cn(
                                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors",
                                    activeId === heading.id
                                      ? "font-medium text-foreground"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  <List className="size-3 shrink-0 opacity-70" />
                                  <span className="min-w-0 truncate">
                                    {heading.text}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>
      </PortalSidebarRail>

      <main className="min-w-0 px-6 py-12 sm:px-10 lg:px-12 xl:px-14">
        <div ref={contentRef} className={cn("mx-auto w-full", active?.examplesHtml ? "max-w-[1280px]" : "max-w-[840px]")}>
          <header className="mb-10 border-b border-border/70 pb-8">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="min-w-0">
                <p
                  className="mb-3 text-sm font-semibold"
                  style={{ color: "var(--portal-accent)" }}
                >
                  {active ? active.groupLabel : "Developer documentation"}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  {active?.method ? (
                    <MethodBadge method={active.method} />
                  ) : null}
                  <h1
                    id={OVERVIEW_HEADING_ID}
                    data-node-id={OVERVIEW_HEADING_ID}
                    className="break-words text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
                  >
                    {active ? active.title : title}
                  </h1>
                </div>
                {updated ? <p className="mt-3 text-xs text-muted-foreground">Updated {updated}</p> : null}
                {active?.path && !active.title.includes(active.path) ? (
                  <code className="mt-3 inline-flex max-w-full overflow-x-auto rounded-md border border-border bg-muted px-2 py-1 font-mono text-sm text-foreground">
                    {active.path}
                  </code>
                ) : null}
                {active ? null : (
                  <p className="mt-4 max-w-3xl text-base leading-7 text-muted-foreground">
                    Explore {brandName} endpoints, authentication, and
                    integration guides.
                  </p>
                )}
              </div>
              {/* The container holds the endpoint's own title, so no
                  separate heading is needed here. */}
              <div className="flex items-center gap-2">
                {editable && active ? (
                  <PortalEditDocumentButton
                    documentRef={active.id}
                    href={items[activeIndex]?.href}
                  />
                ) : null}
                {active ? <PortalCopyPageButton targetRef={contentRef} /> : null}
              </div>
            </div>
          </header>

          {active ? (
            <div className={cn(active.examplesHtml && "grid items-start gap-10 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]")}>
              <PublicProse html={active.html} className="min-w-0" />
              {active.examplesHtml ? (
                <aside aria-label="API examples" className="min-w-0 rounded-xl border border-border bg-muted/20 p-5 xl:sticky xl:top-24 xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto">
                  <PublicProse html={active.examplesHtml} />
                </aside>
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-muted/15 px-6 py-14 text-center">
              <FileCode2 className="mx-auto size-7 text-muted-foreground" />
              <h2 className="mt-4 text-lg font-semibold">
                No reference docs yet
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Add API documents to this page from the portal editor.
              </p>
            </div>
          )}

          {previous || next ? (
            <nav
              aria-label="Endpoint pagination"
              className="mt-14 grid gap-3 border-t border-border/70 pt-8 sm:grid-cols-2"
            >
              {previous ? (
                <HoverPrefetchLink
                  href={previous.href}
                  disableHoverPrefetch={disablePrefetch}
                  className="group flex flex-col rounded-lg border border-border px-4 py-3 transition-colors hover:bg-muted/50"
                >
                  <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <ChevronLeft className="size-3" />
                    Previous
                  </span>
                  <span className="mt-1 truncate text-sm font-medium text-foreground">
                    {previous.title}
                  </span>
                </HoverPrefetchLink>
              ) : (
                <span />
              )}
              {next ? (
                <HoverPrefetchLink
                  href={next.href}
                  disableHoverPrefetch={disablePrefetch}
                  className="group flex flex-col rounded-lg border border-border px-4 py-3 text-right transition-colors hover:bg-muted/50 sm:col-start-2"
                >
                  <span className="flex items-center justify-end gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Next
                    <ChevronRight className="size-3" />
                  </span>
                  <span className="mt-1 truncate text-sm font-medium text-foreground">
                    {next.title}
                  </span>
                </HoverPrefetchLink>
              ) : null}
            </nav>
          ) : null}

          <details className="mt-12 overflow-hidden rounded-lg border border-border bg-card lg:hidden">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-foreground">
              Browse API reference
            </summary>
            <div className="space-y-5 border-t border-border/70 px-4 py-4">
              {groups.map((group) => (
                <div key={group.label}>
                  <button
                    type="button"
                    aria-expanded={isGroupOpen(group.label)}
                    onClick={() => toggleGroup(group.label)}
                    className="mb-2 flex w-full items-center gap-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", isGroupOpen(group.label) && "rotate-90")} />
                    {group.label}
                  </button>
                  <div hidden={!isGroupOpen(group.label)}>
                  {group.items.map((item) => (
                    <HoverPrefetchLink
                      key={item.id}
                      href={item.href}
                      disableHoverPrefetch={disablePrefetch}
                      aria-current={item.id === active?.id ? "page" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                        item.id === active?.id
                          ? "bg-blue-500/10 font-medium text-blue-600 dark:bg-blue-400/15 dark:text-blue-400"
                          : "text-muted-foreground",
                      )}
                    >
                      {item.method ? <MethodBadge method={item.method} /> : null}
                      {item.title}
                    </HoverPrefetchLink>
                  ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      </main>

      {!active?.examplesHtml ? <PortalSidebarRail variant="toc" className="py-12">
        <KbReadingToc
          headings={detailHeadings}
          activeId={activeId}
          containerRef={contentRef}
          variant="docs"
        />
      </PortalSidebarRail> : null}

      <div className="lg:col-start-2">
        <PortalFooter
          footer={footer}
          allowPoweredByRemoval={allowPoweredByRemoval}
          brandName={brandName}
          brandLogoUrl={brandLogoUrl}
          brandDarkLogoUrl={brandDarkLogoUrl}
          brandAccentColor={brandAccentColor}
          variant="global"
        />
      </div>
    </div>
  )
}
