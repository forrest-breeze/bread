"use client"

import React, { useState, useEffect, useTransition, Suspense, useId } from "react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import dynamic from "next/dynamic"
import { usePathname } from "next/navigation"
import Image from "next/image"
import {
  ChevronsUpDown,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelLeft,
  Check,
  ChevronRight,
  ChevronLeft,
  Search,
  Lock,
  FileText,
  Compass,
} from "lucide-react"
// Primary navigation icons use Phosphor (duotone) to give the app a
// distinct identity from the default lucide set every shadcn app ships with.
import {
  IconContext,
  GearSix,
  ChartLineUp,
  Plugs,
} from "@phosphor-icons/react"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { useSWRConfig } from "swr"
import { useWorkspace, useWorkspaces } from "@/hooks/swr"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import {
  AppTooltip,
  TooltipProvider,
} from "@/components/ui/tooltip"
import { SubSidebarProvider, useSubSidebar } from "@/components/app/sub-sidebar-context"
import { SubSidebar, MobileSubSidebar } from "@/components/app/sub-sidebar"
import { RemoteIcon } from "@/components/ui/remote-icon"
import { SearchPopout } from "@/components/app/search-popout"
import { ProductTourProvider, useProductTour } from "@/components/app/product-tour"
import { WorkspaceRealtimeSync } from "@/components/app/workspace-realtime-sync"
import { WorkspaceSwitchProvider, useWorkspaceSwitch } from "@/components/app/workspace-switch-context"
import { useKnowledgeBuilderActive } from "@/components/app/knowledge-portal-access"
import { WorkspaceChangesProvider } from "@/components/app/workspace-changes-context"

// Each sub-navigation owns a substantial, route-specific client graph. Keep
// inactive sections out of every authenticated route's initial graph; Next
// loads the matching section when it is actually rendered.
const SettingsSubNav = dynamic(() =>
  import("@/components/app/settings-sub-nav").then((mod) => mod.SettingsSubNav),
)
const KnowledgeSubNav = dynamic(() =>
  import("@/components/app/knowledge-sub-nav").then(
    (mod) => mod.KnowledgeSubNav,
  ),
)

interface NavItem {
  label: string
  /** Section root, used for active-state matching. */
  href: string
  /**
   * Where the link actually navigates, when the section root only redirects
   * (e.g. /settings → /settings/profile). Linking straight to the destination
   * saves a server redirect round-trip on every click.
   */
  linkHref?: string
  icon: React.ComponentType<{ className?: string }>
  subSidebarSection?: "settings" | "knowledge"
  activePrefixes?: string[]
  inactivePrefixes?: string[]
  /** Spotlight anchor for the product tour (data-tour). */
  tourId?: string
}

interface NavSection {
  label: string
  items: NavItem[]
}

const navigationSections: NavSection[] = [
  {
    label: "Knowledge base",
    items: [
      {
        label: "Knowledge",
        href: "/knowledge",
        icon: FileText,
        subSidebarSection: "knowledge",
        tourId: "knowledge",
      },
      {
        label: "Analytics",
        href: "/reporting",
        icon: ChartLineUp,
        tourId: "analytics",
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        label: "Integrations",
        href: "/settings/integrations",
        linkHref: "/settings/integrations/openapi",
        icon: Plugs,
        tourId: "integrations",
      },
      {
        label: "Settings",
        href: "/settings",
        linkHref: "/settings/profile",
        icon: GearSix,
        subSidebarSection: "settings",
        tourId: "settings",
        inactivePrefixes: ["/settings/integrations"],
      },
    ],
  },
]


function Logo({ size = "default", isMinimized }: { size?: "default" | "sm", isMinimized?: boolean }) {
  const boxSize = size === "sm" ? "size-6" : "size-7"
  const rounding = size === "sm" ? "rounded-md" : "rounded-lg"

  return (
    <HoverPrefetchLink href="/knowledge" className={cn("flex items-center outline-none transition-opacity hover:opacity-80", isMinimized && "justify-center")}>
      <div
        className={cn(
          "flex shrink-0 items-center justify-center",
          boxSize,
          rounding
        )}
      >
        <Image src="/breeze-mark.png" alt="Breeze" width={20} height={20} className="object-contain" />
      </div>
    </HoverPrefetchLink>
  )
}

function NavLinks({ onNavigate, isMinimized }: { onNavigate?: () => void, isMinimized?: boolean }) {
  const pathname = usePathname()
  const { toggle, isOpen, activeSection } = useSubSidebar()
  const { data: currentWorkspace } = useWorkspace()
  const hasHydrated = useHasHydrated()

  // Reporting remains plan-gated. Gate on hydration so lock icons never differ
  // between SSR and first paint.
  const isItemLocked = (item: NavItem) => {
    if (!hasHydrated) return false
    return (
      (item.href === "/reporting" &&
        currentWorkspace?.portal_reporting_enabled === false)
    )
  }

  const visibleNavigationSections = navigationSections

  return (
    <IconContext.Provider value={{ weight: "duotone" }}>
    <nav className={cn("flex-1 overflow-x-hidden px-2", isMinimized ? "space-y-1.5" : "space-y-4")}>
      {visibleNavigationSections.map((section) => (
        <div key={section.label} className="space-y-0.5">
          {!isMinimized && (
            <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground/70">
              {section.label}
            </p>
          )}

          {section.items.map((item) => {
            const isRouteExcluded = item.inactivePrefixes?.some(
              (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
            ) === true
            const isRouteActive =
              !isRouteExcluded &&
              (pathname === item.href || pathname.startsWith(item.href + "/"))
            const isActive =
              isRouteActive ||
              item.activePrefixes?.some(
                (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
              ) === true

            const isLocked = isItemLocked(item)
            const hasSubSidebar = item.subSidebarSection !== undefined && !isLocked
            const hasActiveSubSidebar =
              hasSubSidebar && activeSection === item.subSidebarSection

            const handleClick = (e: React.MouseEvent) => {
              // If clicking an already-active link that has a sub-sidebar, toggle it
              if (isRouteActive && hasActiveSubSidebar) {
                e.preventDefault()
                toggle()
                return
              }
              onNavigate?.()
            }

            const link = (
              <HoverPrefetchLink
                key={item.href}
                href={item.linkHref ?? item.href}
                // Only a handful of top-level links, and their server payloads
                // are thin (pages fetch through SWR), so warm them on idle.
                keepViewportPrefetch
                onClick={handleClick}
                data-tour={item.tourId}
                className={cn(
                  "relative flex items-center rounded-lg transition-colors overflow-hidden",
                  isMinimized ? "justify-center p-2" : "gap-2.5 px-2.5 py-1.5",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                )}
              >
                <item.icon className="size-4 shrink-0" />
                {!isMinimized && <span className="flex-1 truncate text-[13px] font-medium">{item.label}</span>}
                {!isMinimized && isLocked && (
                  <Lock className="size-3.5 shrink-0 text-muted-foreground/60" />
                )}
                {isMinimized && isLocked && (
                  <Lock className="absolute right-1 top-1 size-2.5 text-muted-foreground/60" />
                )}
                {!isMinimized && isActive && hasActiveSubSidebar && (
                  isOpen ? (
                    <ChevronLeft className="size-3.5 shrink-0 text-muted-foreground opacity-70" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-70" />
                  )
                )}
              </HoverPrefetchLink>
            )

            if (isMinimized) {
              return (
                <AppTooltip
                  key={item.href}
                  label={item.label}
                  description={isLocked ? "This area is not enabled for this workspace." : undefined}
                  side="right"
                  sideOffset={16}
                >
                  {link}
                </AppTooltip>
              )
            }

            return link
          })}
        </div>
      ))}
    </nav>
    </IconContext.Provider>
  )
}


interface WorkspaceInfo {
  id: string
  name: string
  icon_url: string | null
}

function WorkspaceIconSkeleton({ size = "md" }: { size?: "sm" | "md" }) {
  const s = size === "sm" ? "size-6" : "size-7"
  const rounded = size === "sm" ? "rounded-sm" : "rounded-md"

  return <Skeleton className={cn(s, rounded, "shrink-0")} />
}

function WorkspaceIcon({ workspace, size = "md" }: { workspace: WorkspaceInfo | null; size?: "sm" | "md" }) {
  const [loadedIconUrl, setLoadedIconUrl] = React.useState<string | null>(null)
  const [erroredIconUrl, setErroredIconUrl] = React.useState<string | null>(null)
  const iconUrl = workspace?.icon_url ?? null
  const imageLoaded = Boolean(iconUrl && loadedIconUrl === iconUrl)
  const imageErrored = Boolean(iconUrl && erroredIconUrl === iconUrl)
  const s = size === "sm" ? "size-6" : "size-7"
  const rounded = size === "sm" ? "rounded-sm" : "rounded-md"
  const textSize = "text-xs"

  if (iconUrl && !imageErrored) {
    return (
      <div className={cn("relative shrink-0 overflow-hidden", s, rounded)}>
        {!imageLoaded && (
          <Skeleton className="absolute inset-0 h-full w-full rounded-[inherit]" />
        )}
        <RemoteIcon
          src={iconUrl}
          alt=""
          size={size === "sm" ? 24 : 28}
          className={cn(
            "h-full w-full object-cover transition-opacity",
            imageLoaded ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoadedIconUrl(iconUrl)}
          onError={() => setErroredIconUrl(iconUrl)}
        />
      </div>
    )
  }

  return (
    <div className={cn("flex shrink-0 items-center justify-center bg-primary text-primary-foreground", s, rounded)}>
      <span className={cn(textSize, "font-semibold", "!text-primary-foreground")}>
        {(workspace?.name ?? "W").charAt(0)}
      </span>
    </div>
  )
}

function switchWorkspace(id: string) {
  document.cookie = `bread-workspace=${id}; path=/; max-age=31536000; samesite=lax`
}

function WorkspaceMenu({ isMinimized }: { isMinimized?: boolean }) {
  const router = useRouter()
  const instanceId = useId()
  const { mutate: globalMutate } = useSWRConfig()
  const { setSwitching } = useWorkspaceSwitch()
  const [revalidating, setRevalidating] = useState(false)
  const [isRefreshPending, startRefreshTransition] = useTransition()
  const { data: wsData, mutate, isLoading: wsLoading } = useWorkspace()
  const {
    data: allWorkspaces,
    mutate: mutateList,
    isLoading: listLoading,
    error: listError,
  } = useWorkspaces()
  const isAdmin = wsData?.user_role === "admin" || wsData?.user_role === "owner"
  const { start: startTour } = useProductTour()
  // The SWR cache is synchronously seeded from localStorage (see swr-provider),
  // so on the client's first render `wsData` may already be populated while the
  // server (no localStorage) rendered the skeleton. Branching the DOM structure
  // (skeleton <div> vs trigger <button>) on that state mismatches hydration, so
  // hold the server-shaped skeleton until hydration completes, then flip to live
  // state. useHasHydrated() reads false during SSR + the first client render
  // (no setState-in-effect), keeping that render identical to the server.
  const hasHydrated = useHasHydrated()

  const workspace: WorkspaceInfo | null = wsData
    ? { id: wsData.id, name: wsData.name, icon_url: wsData.icon_url ?? null }
    : null

  // Re-validate when workspace settings are saved or when a workspace/membership
  // row the user can see changes. RLS on the replication stream scopes events
  // to this user, so we don't need a client-side filter. The channel is keyed
  // on instanceId (stable for the mount) rather than wsData.id so it survives
  // workspace switches — a per-workspace channel would drop events fired in
  // the window between unsubscribe and resubscribe. Listening to
  // workspace_members is required because /api/workspaces is derived from
  // memberships: invites, joins, and removals all fire on that table and
  // leave the workspaces row untouched.
  React.useEffect(() => {
    const refresh = () => {
      void mutate()
      void mutateList()
    }
    window.addEventListener("workspace-updated", refresh)

    const supabase = createClient()
    const channel = supabase
      .channel(`sidebar-workspaces-${instanceId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "workspaces" },
        refresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "workspace_members" },
        refresh,
      )
      .subscribe()

    return () => {
      window.removeEventListener("workspace-updated", refresh)
      supabase.removeChannel(channel)
    }
  }, [mutate, mutateList, instanceId])

  // Surface the switch as a global reload indicator. `revalidating` covers the
  // SWR refetch phase; `isRefreshPending` covers the server-component refresh
  // that follows. The indicator stays up until both settle.
  useEffect(() => {
    setSwitching(revalidating || isRefreshPending)
  }, [revalidating, isRefreshPending, setSwitching])

  // Revalidate all SWR caches so workspace-scoped data refetches.
  // `revalidate: true` forces network requests even within the dedupingInterval
  // window; `populateCache: false` keeps the current data visible (no flash to
  // empty skeletons) until each fresh response lands.
  const revalidateAll = async () => {
    await globalMutate(() => true, undefined, { revalidate: true, populateCache: false })
  }

  const handleSwitch = async (id: string) => {
    if (id === workspace?.id) return
    const target = (allWorkspaces ?? []).find((ws) => ws.id === id)
    switchWorkspace(id)
    setRevalidating(true)
    try {
      // Optimistically flip the sidebar header to the target workspace using
      // the row we already have from the list, so the switch registers
      // instantly with no skeleton flash. Optional flags fill in on
      // revalidation.
      if (target) {
        await mutate(target, { revalidate: false, populateCache: true })
      }
      // Revalidate every workspace-scoped cache in place; the dimmed main area
      // and top progress bar signal that the rest of the app is reloading.
      await revalidateAll()
    } finally {
      setRevalidating(false)
    }
    // Re-render server components for the new workspace; isRefreshPending keeps
    // the indicator up until the server render lands.
    startRefreshTransition(() => router.refresh())
  }

  const displayName = workspace?.name ?? "Workspace"

  if (!hasHydrated || (wsLoading && !wsData)) {
    return (
      <div className={cn(
        "flex w-full items-center rounded-lg p-2 gap-2.5",
        isMinimized && "justify-center gap-0"
      )}>
        <WorkspaceIconSkeleton />
        {!isMinimized && (
          <div className="flex-1 space-y-1.5 overflow-hidden text-left">
            <div className="h-3 w-24 skeleton-pulse rounded bg-muted" />
            <div className="h-2 w-16 skeleton-pulse rounded bg-muted/50" />
          </div>
        )}
      </div>
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "group/wsbtn flex w-full items-center p-2 text-left outline-none",
            isMinimized
              ? "justify-center gap-0 rounded-lg transition-colors hover:bg-muted"
              : "gap-2.5"
          )}
          title={isMinimized ? "Workspaces" : undefined}
        >
          <WorkspaceIcon workspace={workspace} />
          {!isMinimized && (
            <div className="flex flex-1 items-center gap-2.5 overflow-hidden rounded-md px-2 py-1 -my-1 transition-colors group-hover/wsbtn:bg-muted">
              <div className="flex-1 overflow-hidden">
                <p className="truncate text-sm font-medium leading-tight">{displayName}</p>
              </div>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </div>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={isMinimized ? "right" : "bottom"}
          align={isMinimized ? "end" : "start"}
          sideOffset={isMinimized ? 16 : 8}
          className="w-56"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {listLoading && !allWorkspaces ? (
              <div className="space-y-1 px-2 py-1.5">
                {Array.from({ length: 2 }).map((_, index) => (
                  <div key={index} className="flex h-8 items-center">
                    <WorkspaceIconSkeleton size="sm" />
                    <Skeleton className="ml-2 h-3 w-28" />
                  </div>
                ))}
              </div>
            ) : listError ? (
              <div className="px-2 py-1.5 text-xs text-destructive">
                Failed to load workspaces.{" "}
                <button
                  onClick={() => void mutateList()}
                  className="underline underline-offset-2 hover:text-destructive/80"
                >
                  Retry
                </button>
              </div>
            ) : (allWorkspaces ?? []).length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                No workspaces
              </div>
            ) : (
              (allWorkspaces ?? []).map((ws) => (
                <DropdownMenuItem
                  key={ws.id}
                  onClick={() => handleSwitch(ws.id)}
                >
                  <WorkspaceIcon
                    workspace={{ id: ws.id, name: ws.name, icon_url: ws.icon_url ?? null }}
                    size="sm"
                  />
                  <span className="ml-2 truncate">{ws.name}</span>
                  {ws.id === workspace?.id && (
                    <Check className="ml-auto size-4" />
                  )}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuGroup>
          {/* Breeze internal tool: one workspace, so no create/join entries. */}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={startTour}>
            <Compass className="size-4" />
            <span className="ml-2">Take the tour</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

    </>
  )
}

function SidebarSearch({ isMinimized }: { isMinimized?: boolean }) {
  const [searchOpen, setSearchOpen] = useState(false)

  // Note: \u2318K is owned by CommandPaletteProvider. The click affordance below
  // opens the SearchPopout (KB/settings search) as
  // a separate surface from the command palette.

  if (isMinimized) {
    return (
      <>
        <div className="px-2">
          <AppTooltip label="Search" side="right" sideOffset={16}>
            <button
              onClick={() => setSearchOpen(true)}
              data-tour="search"
              aria-label="Search"
              className="flex w-full items-center justify-center rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <Search className="size-4" />
            </button>
          </AppTooltip>
        </div>
        <SearchPopout open={searchOpen} onClose={() => setSearchOpen(false)} />
      </>
    )
  }

  return (
    <>
      <div className="mb-1 px-2">
        <button
          onClick={() => setSearchOpen(true)}
          data-tour="search"
          className="flex w-full items-center gap-2.5 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[13px] text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground"
        >
          <Search className="size-3.5 shrink-0" />
          <span className="flex-1 text-left">Search...</span>
        </button>
      </div>
      <SearchPopout open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  )
}

function SidebarInner({ onNavigate, isMinimized, onToggleMinimize }: { onNavigate?: () => void, isMinimized?: boolean, onToggleMinimize?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex shrink-0 h-10 items-center", isMinimized ? "justify-center" : "px-4 justify-between")}>
        {!isMinimized && <Logo size="default" isMinimized={false} />}
        {onToggleMinimize && (
          <AppTooltip
            label={isMinimized ? "Expand sidebar" : "Collapse sidebar"}
            side="right"
            sideOffset={16}
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleMinimize}
              aria-label={isMinimized ? "Expand sidebar" : "Collapse sidebar"}
              className={cn("hidden size-8 shrink-0 text-muted-foreground lg:flex hover:bg-muted/50", isMinimized ? "" : "-mr-2")}
            >
              {isMinimized ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </Button>
          </AppTooltip>
        )}
      </div>
      <SidebarSearch isMinimized={isMinimized} />
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <NavLinks onNavigate={onNavigate} isMinimized={isMinimized} />
      </div>

      <div className="border-t border-border p-2 space-y-1">
        <WorkspaceMenu isMinimized={isMinimized} />
      </div>
    </div>
  )
}

function SubSidebarContent() {
  const { activeSection } = useSubSidebar()
  const pathname = usePathname()
  const knowledgeBuilderActive = useKnowledgeBuilderActive(pathname)

  if (activeSection === "settings") {
    return (
      <SubSidebar title="Settings">
        <SettingsSubNav />
      </SubSidebar>
    )
  }


  if (activeSection === "knowledge") {
    if (knowledgeBuilderActive) return null

    return (
      <SubSidebar title="Knowledge" scrollContent={false}>
        <Suspense>
          <KnowledgeSubNav />
        </Suspense>
      </SubSidebar>
    )
  }

  return null
}

function MobileHeader({
  mobileOpen,
  setMobileOpen,
  setMobileSubOpen,
}: {
  mobileOpen: boolean
  setMobileOpen: (open: boolean) => void
  setMobileSubOpen: (open: boolean) => void
}) {
  const { activeSection } = useSubSidebar()
  const pathname = usePathname()
  const knowledgeBuilderActive = useKnowledgeBuilderActive(pathname)
  const showMobileSubSidebar =
    activeSection !== null && !knowledgeBuilderActive

  return (
    <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center border-b border-border bg-background px-4 lg:hidden">
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger render={<Button variant="ghost" size="icon-sm" />}>
          <Menu className="size-4" />
          <span className="sr-only">Toggle menu</span>
        </SheetTrigger>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[240px] p-0"
        >
          <div className="sr-only">
            <SheetTitle>Main navigation</SheetTitle>
            <SheetDescription>Navigate between Bread sections.</SheetDescription>
          </div>
          <SidebarInner onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex-1" />

      {showMobileSubSidebar && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setMobileSubOpen(true)}
        >
          <PanelLeft className="size-4" />
          <span className="sr-only">Toggle sub-navigation</span>
        </Button>
      )}
    </header>
  )
}

function MobileSubSidebarContent({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { activeSection } = useSubSidebar()
  const pathname = usePathname()
  const knowledgeBuilderActive = useKnowledgeBuilderActive(pathname)

  if (activeSection === "settings") {
    return (
      <MobileSubSidebar title="Settings" open={open} onOpenChange={onOpenChange}>
        <SettingsSubNav />
      </MobileSubSidebar>
    )
  }


  if (activeSection === "knowledge") {
    if (knowledgeBuilderActive) return null

    return (
      <MobileSubSidebar
        title="Knowledge"
        scrollContent={false}
        open={open}
        onOpenChange={onOpenChange}
      >
        <Suspense>
          <KnowledgeSubNav />
        </Suspense>
      </MobileSubSidebar>
    )
  }

  return null
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceSwitchProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </WorkspaceSwitchProvider>
  )
}

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [mobileSubOpen, setMobileSubOpen] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const { isSwitching } = useWorkspaceSwitch()

  return (
    <TooltipProvider delay={300}>
      <SubSidebarProvider>
        <WorkspaceChangesProvider>
          <ProductTourProvider>
          <WorkspaceRealtimeSync />
          <div className="flex h-screen bg-background text-foreground">
            <aside
              className={cn(
                "hidden shrink-0 border-r border-border transition-all duration-300 lg:flex lg:flex-col",
                isMinimized ? "w-[68px]" : "w-[240px]",
              )}
            >
              <SidebarInner
                isMinimized={isMinimized}
                onToggleMinimize={() => setIsMinimized(!isMinimized)}
              />
            </aside>

            {/* Right of the main rail: the sub-sidebar + content row.
                min-w-0 at each flex level lets the content shrink to fit instead
                of overflowing to the right (which clipped right-aligned UI). */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-w-0 flex-1 overflow-hidden">
                <SubSidebarContent />

                <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
                  {isSwitching && (
                    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 h-0.5 overflow-hidden">
                      <div className="workspace-switch-indeterminate h-full w-full bg-primary" />
                    </div>
                  )}
                  <MobileHeader
                    mobileOpen={mobileOpen}
                    setMobileOpen={setMobileOpen}
                    setMobileSubOpen={setMobileSubOpen}
                  />
                  <MobileSubSidebarContent
                    open={mobileSubOpen}
                    onOpenChange={setMobileSubOpen}
                  />

                  <main
                    className={cn(
                      "flex-1 overflow-y-auto transition-opacity duration-200",
                      isSwitching && "pointer-events-none opacity-50",
                    )}
                  >
                    {children}
                  </main>
                </div>
              </div>
            </div>
          </div>
          </ProductTourProvider>
        </WorkspaceChangesProvider>
      </SubSidebarProvider>
    </TooltipProvider>
  )
}
