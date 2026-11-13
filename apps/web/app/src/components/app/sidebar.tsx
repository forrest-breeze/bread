"use client"

import React, { useState, Suspense, useId } from "react"
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link"
import dynamic from "next/dynamic"
import { usePathname } from "next/navigation"
import Image from "next/image"
import {
  Building2,
  CircleUser,
  LogOut,
  Menu,
  SlidersHorizontal,
  UserPlus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelLeft,
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
import { useProfile, useWorkspace } from "@/hooks/swr"
import { signOutAndRedirect } from "@/lib/auth/sign-out"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
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

function ProfileAvatar({
  name,
  avatarUrl,
}: {
  name: string
  avatarUrl: string | null
}) {
  const [erroredUrl, setErroredUrl] = React.useState<string | null>(null)
  if (avatarUrl && erroredUrl !== avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- avatars come from arbitrary auth-provider hosts
      <img
        src={avatarUrl}
        alt=""
        className="size-7 shrink-0 rounded-full object-cover"
        onError={() => setErroredUrl(avatarUrl)}
      />
    )
  }
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
      <span className="text-xs font-semibold !text-primary-foreground">
        {name.charAt(0).toUpperCase()}
      </span>
    </div>
  )
}

/**
 * Account menu pinned to the bottom of the sidebar. Breezify hosts one workspace,
 * so this replaces the old workspace switcher: the workspace is shown as the
 * menu's header, followed by account and workspace shortcuts and sign-out.
 */
function ProfileMenu({ isMinimized }: { isMinimized?: boolean }) {
  const router = useRouter()
  const instanceId = useId()
  const { data: wsData, mutate, isLoading: wsLoading } = useWorkspace()
  const { data: profile, isLoading: profileLoading } = useProfile()
  const isAdmin = wsData?.user_role === "admin" || wsData?.user_role === "owner"
  const { start: startTour } = useProductTour()
  // The SWR cache is seeded synchronously from localStorage on the client, so
  // hold the server-shaped skeleton until hydration to avoid a mismatch.
  const hasHydrated = useHasHydrated()

  const workspace: WorkspaceInfo | null = wsData
    ? { id: wsData.id, name: wsData.name, icon_url: wsData.icon_url ?? null }
    : null

  // Keep the workspace name and icon fresh after settings saves or edits made
  // elsewhere (another tab, another admin).
  React.useEffect(() => {
    const refresh = () => void mutate()
    window.addEventListener("workspace-updated", refresh)
    const supabase = createClient()
    const channel = supabase
      .channel(`sidebar-workspace-${instanceId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "workspaces" },
        refresh,
      )
      .subscribe()
    return () => {
      window.removeEventListener("workspace-updated", refresh)
      supabase.removeChannel(channel)
    }
  }, [mutate, instanceId])

  const email = profile?.email ?? ""
  const displayName = profile?.display_name?.trim() || email || "Account"

  if (!hasHydrated || ((wsLoading && !wsData) || (profileLoading && !profile))) {
    return (
      <div className={cn(
        "flex w-full items-center rounded-lg p-2 gap-2.5",
        isMinimized && "justify-center gap-0"
      )}>
        <Skeleton className="size-7 shrink-0 rounded-full" />
        {!isMinimized && (
          <div className="flex-1 space-y-1.5 overflow-hidden text-left">
            <div className="h-3 w-24 skeleton-pulse rounded bg-muted" />
            <div className="h-2 w-16 skeleton-pulse rounded bg-muted/50" />
          </div>
        )}
      </div>
    )
  }

  const go = (href: string) => () => router.push(href)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "group/profile flex w-full items-center rounded-lg p-2 text-left outline-none transition-colors hover:bg-muted data-[popup-open]:bg-muted",
          isMinimized ? "justify-center gap-0" : "gap-2.5"
        )}
        title={isMinimized ? displayName : undefined}
        aria-label="Account menu"
      >
        <ProfileAvatar name={displayName} avatarUrl={profile?.avatar_url ?? null} />
        {!isMinimized && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium leading-tight">{displayName}</p>
            {email && email !== displayName ? (
              <p className="truncate text-[11px] leading-tight text-muted-foreground">{email}</p>
            ) : null}
          </div>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={isMinimized ? "right" : "top"}
        align={isMinimized ? "end" : "start"}
        sideOffset={8}
        className="w-60"
      >
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={go("/settings/workspace")} className="gap-2.5 py-2">
            <WorkspaceIcon workspace={workspace} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium leading-tight">
                {workspace?.name ?? "Workspace"}
              </p>
              {email ? (
                <p className="truncate text-[11px] leading-tight text-muted-foreground">{email}</p>
              ) : null}
            </div>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {isAdmin ? (
            <DropdownMenuItem onClick={go("/settings/workspace/members")}>
              <UserPlus className="size-4" />
              <span className="ml-2">Add teammates</span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={go("/settings/workspace")}>
            <Building2 className="size-4" />
            <span className="ml-2">Workspace settings</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={go("/settings/preferences")}>
            <SlidersHorizontal className="size-4" />
            <span className="ml-2">Preferences</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={go("/settings/profile")}>
            <CircleUser className="size-4" />
            <span className="ml-2">Profile</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={startTour}>
            <Compass className="size-4" />
            <span className="ml-2">Take the tour</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void signOutAndRedirect()}>
            <LogOut className="size-4" />
            <span className="ml-2">Log out</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
        <ProfileMenu isMinimized={isMinimized} />
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
            <SheetDescription>Navigate between Breezify sections.</SheetDescription>
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
