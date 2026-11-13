"use client"

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import dynamic from "next/dynamic"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { preload, useSWRConfig } from "swr"
import {
  AlertCircle,
  Bot,
  Blocks,
  Building2,
  Check,
  ChevronDown as ChevronDownIcon,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Home,
  Languages,
  Link2,
  Lock,
  Loader2,
  Minus,
  Paintbrush,
  PanelBottom,
  PanelTop,
  Plus as PlusIcon,
  Wand2,
} from "lucide-react"
import { ScopeTreeSelector } from "@/components/portal-builder/scope-tree-selector"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { AppTooltip, InfoHint } from "@/components/ui/tooltip"
import { PortalBuilderSkeleton } from "./portal-builder-skeleton"
import { PortalVersionMenu } from "./portal-version-menu"
import { KnowledgeSubNav } from "@/components/app/knowledge-sub-nav"
import {
  PortalEditorFrameHeader,
  PortalEditorFrameSidebar,
} from "@/components/portal-builder/portal-editor-frame-header"
import { DocumentControlsSlotProvider } from "@/components/app/document-controls-slot"
import { PortalEditorExitProvider } from "./portal-editor-exit-context"
import { PortalEditorDocument } from "./portal-editor-document"
import { useSubSidebar } from "@/components/app/sub-sidebar-context"
import { useResizable } from "@/hooks/use-resizable"
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard"
import {
  isPermissionFetchError,
  useWorkspace,
  usePortalDraft,
  usePortalProjectDomainRoute,
  usePortalProjects,
  usePortalVersions,
  useDocuments,
  useFolders,
  type FolderResponse,
  type PortalDraftResponse,
  type WorkspaceWithRole,
} from "@/hooks/swr"
import {
  createPortalProject,
  clearPortalProjectDomainRoute,
  discardPortalDraft,
  generatePortalDraft,
  getPortalProjectDisplayVersion,
  publishPortalDraft,
  restorePortalEdit,
  savePortalDraft,
  updatePortalProjectDomainRoute,
  updatePortalProjectPath,
  updatePortalProjectScope,
  type PortalDomainRoute,
  type PortalDomainRouteMode,
  type PortalVersionSummary,
} from "@/lib/api/portal"
import { getCloudflareConnectorStatus } from "@/lib/api/cloudflare"
import {
  updateWorkspacePortalChrome,
  verifyPortalProjectAddress,
  type PortalConnectionResult,
} from "@/lib/api/workspace"
import {
  type DocumentNavSortMode,
  getStoredBuilderDocumentSortMode,
  setStoredBuilderDocumentSortMode,
} from "@/lib/document-nav-preferences"
import {
  portalPagePresentation,
  type PortalLayout,
  type PortalPage,
} from "@/lib/portal/schema"
import type { PortalScopeEntry } from "@/lib/public-kb"
import { setPages } from "@/lib/portal/builder-ops"
import {
  resolveScopeRootId,
  scopeKey,
  scopeForRoot,
  type ScopeTreeContext,
} from "@/lib/portal/scope-tree"
import { PORTAL_RESERVED_PROJECT_SLUGS } from "@/lib/portal/portal-path"
import { portalProjectUrl } from "@/lib/portal/project-url"
import { useHasHydrated } from "@/hooks/use-has-hydrated"
import {
  customDomainDnsRecord,
  customDomainErrorMessage,
  getKbCustomDomain,
  getKbPrimaryProject,
  getPortalAddressMode,
  getPortalAddressScope,
  getPortalChromeScope,
  validatePortalRouteDomain,
} from "@/lib/workspace-settings"
import type {
  PreviewAppearance,
  PreviewDevice,
} from "./portal-live-preview"
import { portalDocRefFromHref } from "./portal-live-preview"
import type { SidebarGroup } from "@/lib/portal/schema"
import {
  canOpenKnowledgeDocumentInPlace,
  openKnowledgeDocumentInPlace,
} from "@/lib/knowledge-route"

// Rail hrefs are relative; any fixed origin works for parsing them.
const PORTAL_REF_PARSE_ORIGIN = "http://portal.invalid"

async function portalDocumentFetcher(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  return res.json()
}
import {
  PortalConnectionBadge,
  type PortalConnectionStatus,
} from "@/components/portal-connection-badge"

// The builder contains several mutually-exclusive views and closed-by-default
// dialogs. Split those client graphs so opening /kb compiles the editor shell,
// not every customization surface at once.
const PortalLivePreview = dynamic(() =>
  import("./portal-live-preview").then((mod) => mod.PortalLivePreview),
)
const PortalAgentPanel = dynamic(() =>
  import("./portal-agent-panel").then((mod) => mod.PortalAgentPanel),
)
const PortalThemeControls = dynamic(() =>
  import("./portal-theme-controls").then((mod) => mod.PortalThemeControls),
)
const PortalFooterControls = dynamic(() =>
  import("./portal-footer-controls").then((mod) => mod.PortalFooterControls),
)
const PortalHeaderControls = dynamic(() =>
  import("./portal-header-controls").then((mod) => mod.PortalHeaderControls),
)
const PortalLanguageControls = dynamic(() =>
  import("./portal-language-controls").then((mod) => mod.PortalLanguageControls),
)
const PortalAiAssistantControls = dynamic(() =>
  import("./portal-ai-assistant-controls").then(
    (mod) => mod.PortalAiAssistantControls,
  ),
)
const PublishDialog = dynamic(() =>
  import("./publish-dialog").then((mod) => mod.PublishDialog),
)
const PortalVisibilityControls = dynamic(() =>
  import("./portal-visibility-controls").then(
    (mod) => mod.PortalVisibilityControls,
  ),
)
const PortalPagesControls = dynamic(() =>
  import("./portal-pages-controls").then((mod) => mod.PortalPagesControls),
)
const DocsPreviewThumb = dynamic(() =>
  import("./template-preview").then((mod) => mod.DocsPreviewThumb),
)
const PortalBuildLoader = dynamic(() =>
  import("./portal-build-loader").then((mod) => mod.PortalBuildLoader),
)
const CloudflareWorkerUpdateDialog = dynamic(() =>
  import("./cloudflare-worker-update-dialog").then(
    (mod) => mod.CloudflareWorkerUpdateDialog,
  ),
)
const PortalDnsInstructions = dynamic(() =>
  import("@/components/portal-dns-instructions").then(
    (mod) => mod.PortalDnsInstructions,
  ),
)
const PortalReverseProxyInstructions = dynamic(() =>
  import("@/components/portal-reverse-proxy-instructions").then(
    (mod) => mod.PortalReverseProxyInstructions,
  ),
)

// ---------------------------------------------------------------------------
// Portal editor — a single cohesive screen with two panes:
//   - Left rail: documents + chat-based app builder.
//   - Right pane: a LIVE preview rendered from the real public-portal components
//     (PortalLivePreview), or the active document/folder editor route.
//
// The draft layout is loaded via the `usePortalDraft` SWR hook, edited in a
// local buffer (all mutations go through the pure builder-ops), saved via PUT,
// and published (double-confirmed) to the public portal. Workspace-tied local
// state resets when the active workspace changes — reconciled during render
// (React's recommended alternative to setState-in-effect; the repo lint rule
// `react-hooks/set-state-in-effect` forbids the latter).
// ---------------------------------------------------------------------------

type SaveState = "idle" | "saving" | "saved" | "error"
type SidebarView = "documentation" | "visibility" | "customize" | "builder"

// Shelved for now. Keep the implementation so the AI builder can return later.
const AI_BUILDER_UI_ENABLED = false

// Keep customization controls responsive while coalescing rapid input changes
// (color pickers, footer fields, etc.) into a single draft write. Publishing is
// still explicit and is the only action that updates the public portal.
const PORTAL_AUTOSAVE_DELAY_MS = 500

// Customize is a drill-down menu: "menu" is the section list, the others are the
// individual sub-panels reached from it (each with a back affordance).
type CustomizeSection =
  | "menu"
  | "appearance"
  | "header"
  | "footer"
  | "assistant"
  | "languages"
  | "pages"
  | "path"
  | "scope"
type ScopeState = "idle" | "saving" | "error"
type ProjectAddressMode = "inherited" | PortalDomainRouteMode
const STORED_SIDEBAR_VIEW_KEY = "bread-kb-builder-sidebar-view"
const PORTAL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/

const DEFAULT_VIEWPORT_WIDTH = 1440
const MAX_BUILDER_RAIL_RATIO = 0.75

function getViewportWidthSnapshot(): number {
  if (typeof window === "undefined") return DEFAULT_VIEWPORT_WIDTH
  return window.innerWidth
}

function subscribeToViewportWidth(onStoreChange: () => void): () => void {
  window.addEventListener("resize", onStoreChange)
  return () => window.removeEventListener("resize", onStoreChange)
}

// "auto" means follow the visitor's OS theme on the live portal; the preview has
// to pick one, so default it to light.
function appearanceFromTheme(layout: PortalLayout): PreviewAppearance {
  return layout.theme.appearance === "dark" ? "dark" : "light"
}

function SidebarSectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
      {children}
    </p>
  )
}

function isPortalSlug(value: string | null): value is string {
  return !!value && PORTAL_SLUG_RE.test(value)
}

// Derive a URL slug from a project name: lowercase, non-alphanumerics → dashes,
// trimmed/collapsed, capped at the 50-char limit the slug regex enforces.
function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "")
}

// Shape consumed by the switcher + dialog. `icon` lands from the project API.
interface PortalProjectOption {
  id: string | null
  slug: string
  displayName: string
  icon: string
  isDefault: boolean
  scope: PortalScopeEntry[] | null
  draftVersion: number | null
  publishedVersion: number | null
}

interface CloudflareWorkerRoutePrompt {
  domain: string
  pathPrefix: string
  projectSlug: string
}

function cloudflareWorkerRouteForProject(
  workspace: WorkspaceWithRole,
  project: PortalProjectOption,
  projectRoute: PortalDomainRoute | null,
): CloudflareWorkerRoutePrompt | null {
  const addressScope = getPortalAddressScope(workspace.settings)
  if (addressScope === "workspace") {
    if (getPortalAddressMode(workspace.settings) !== "path") return null
    const domain = getKbCustomDomain(workspace.settings)
    return domain
      ? { domain, pathPrefix: `/${project.slug}`, projectSlug: project.slug }
      : null
  }
  return projectRoute?.mode === "path"
    ? {
        domain: projectRoute.domain,
        pathPrefix: projectRoute.pathPrefix,
        projectSlug: project.slug,
      }
    : null
}

// Scope entry helpers. An entry is a folder id, or { id, promote } when the
// folder is a promoted root (children surface as top-level sections).
function scopeEntryIdOf(entry: PortalScopeEntry): string {
  if (typeof entry === "string") return entry
  if (typeof entry === "object" && entry !== null && "id" in entry) return entry.id
  return ""
}

function scopePromotedIdsOf(scope: PortalScopeEntry[] | null | undefined): Set<string> {
  return new Set(
    (scope ?? [])
      .filter(
        (entry): entry is { id: string; promote?: boolean } =>
          typeof entry === "object" && entry !== null && "id" in entry && entry.promote === true,
      )
      .map((entry) => entry.id),
  )
}

function scopeRootOnlyIdsOf(scope: PortalScopeEntry[] | null | undefined): Set<string> {
  return new Set(
    (scope ?? [])
      .filter(
        (entry): entry is { id: string; promote?: boolean; rootOnly?: boolean } =>
          typeof entry === "object" && entry !== null && "id" in entry && entry.rootOnly === true,
      )
      .map((entry) => entry.id),
  )
}

function projectScopedApiPath(path: string, projectSlug: string | null): string {
  return projectSlug ? `${path}?project=${encodeURIComponent(projectSlug)}` : path
}

function publicScopeFolders(folders: FolderResponse[]): FolderResponse[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const depth = (folder: FolderResponse): number => {
    let current: FolderResponse | undefined = folder
    let count = 0
    while (current?.parent_folder_id && count < 8) {
      const parent = byId.get(current.parent_folder_id)
      if (!parent) break
      count += 1
      current = parent
    }
    return count
  }

  return folders
    .filter((folder) => folder.kind === "user" && folder.visibility === "workspace")
    .sort((a, b) => {
      if (a.parent_folder_id === b.parent_folder_id) {
        return a.display_name.localeCompare(b.display_name)
      }
      return depth(a) - depth(b) || a.display_name.localeCompare(b.display_name)
    })
}

/** Explicit snapshot of all currently reachable workspace content. */
function explicitWorkspacePortalScope(
  folders: FolderResponse[],
): PortalScopeEntry[] {
  const eligibleIds = new Set(folders.map((folder) => folder.id))
  const roots = folders.filter(
    (folder) =>
      folder.parent_folder_id === null ||
      !eligibleIds.has(folder.parent_folder_id),
  )
  return [
    ...roots.map((folder) => folder.id),
    { workspaceDocs: true },
  ]
}

interface PortalBuilderProps {
  children?: React.ReactNode
}

function getInitialSidebarView(): SidebarView {
  if (typeof window === "undefined") return "documentation"
  if (window.sessionStorage.getItem(STORED_SIDEBAR_VIEW_KEY) !== "customize") {
    return "documentation"
  }
  window.sessionStorage.removeItem(STORED_SIDEBAR_VIEW_KEY)
  return "customize"
}

function ManageButton({
  icon: Icon,
  label,
  active,
  onClick,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active?: boolean
  onClick?: () => void
  href?: string
}): React.ReactElement {
  const interactive = Boolean(href || onClick)
  const className = cn(
    "flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-sm transition-colors",
    active && "bg-muted text-foreground",
    !active && interactive && "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
    !active && !interactive && "text-muted-foreground/80",
  )
  const content = (
    <>
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </>
  )

  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    )
  }

  if (!onClick) {
    return <div className={className}>{content}</div>
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  )
}

// A row in the Customize drill-down menu: icon + label + trailing chevron,
// styled to match the reference KB customizer (grouped, tappable section rows).
function CustomizeMenuRow({
  icon: Icon,
  label,
  description,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  description?: string
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors",
        "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
        {description ? (
          <span className="truncate text-[11px] text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
    </button>
  )
}

// Detail view reached from a Customize menu row. The back affordance lives in
// the rail header; this just labels the panel so the user knows where they are.
function CustomizeSubPanel({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {children}
    </div>
  )
}

function PageSwitcher({
  pages,
  activeSlug,
  disabled,
  onChange,
}: {
  pages: PortalPage[]
  activeSlug: string | null
  disabled: boolean
  onChange: (slug: string | null) => void
}): React.ReactElement {
  const activePage = pages.find((page) => page.slug === activeSlug) ?? null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Switch portal page"
            disabled={disabled}
            className={cn(
              "flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-left text-sm transition-colors",
              "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              "data-[popup-open]:bg-muted disabled:cursor-wait disabled:opacity-60",
            )}
          >
            {activePage ? (
              <FileText className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Home className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">
              {activePage?.title ?? "Documents"}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Portal page</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={activePage?.slug ?? "__home__"}
            onValueChange={(value) =>
              onChange(value === "__home__" ? null : value)
            }
          >
            <DropdownMenuRadioItem value="__home__" className="gap-2">
              <Home className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Documents</span>
            </DropdownMenuRadioItem>
            {pages.map((page) => (
              <DropdownMenuRadioItem
                key={page.id}
                value={page.slug}
                className="gap-2"
              >
                <FileText className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// New-project dialog: name → derived slug (validated/uniqueness-checked inline),
// docs or AI-built start, and folder scope (reusing ProjectScopeControl). On success
// the parent switches to the created project and revalidates the SWR list.
function NewProjectDialog({
  open,
  existingSlugs,
  folders,
  onOpenChange,
  onCreate,
  onCustomStart,
  aiBuilderEnabled,
}: {
  open: boolean
  existingSlugs: string[]
  folders: FolderResponse[]
  onOpenChange: (open: boolean) => void
  onCreate: (input: {
    slug: string
    name: string
    scope: PortalScopeEntry[] | null
  }) => Promise<void>
  onCustomStart: () => void
  aiBuilderEnabled: boolean
}): React.ReactElement {
  const [name, setName] = useState("")
  const [selection, setSelection] = useState<"docs" | "custom">("docs")
  const [scope, setScope] = useState<PortalScopeEntry[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the buffer whenever the dialog opens so a prior attempt doesn't leak.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName("")
      setSelection("docs")
      setScope(null)
      setSubmitting(false)
      setError(null)
    }
  }

  const isCustom = selection === "custom"
  const slug = slugFromName(name)
  const taken = existingSlugs.includes(slug)
  const slugError =
    name.trim().length === 0
      ? null
      : !isPortalSlug(slug)
        ? "Name must contain letters or numbers."
        : taken
          ? `"${slug}" is already taken.`
          : null
  const canCreate = isPortalSlug(slug) && !taken && !submitting

  async function submit(): Promise<void> {
    // Custom is a launcher: hand off to the dedicated full-screen build view
    // (describe + scope live there, not in this dialog).
    if (isCustom) {
      onCustomStart()
      onOpenChange(false)
      return
    }
    if (!canCreate) return
    setSubmitting(true)
    setError(null)
    try {
      await onCreate({ slug, name: name.trim(), scope })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Set up your portal</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {aiBuilderEnabled ? (
            <div className="space-y-1.5">
              <Label>Start from</Label>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <button
                  type="button"
                  onClick={() => setSelection("docs")}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors",
                    selection === "docs"
                      ? "border-primary bg-muted/50"
                      : "border-border hover:bg-muted/40",
                  )}
                >
                  <DocsPreviewThumb />
                  <div className="px-0.5">
                    <p className="text-xs font-medium text-foreground">Docs</p>
                    <p className="text-[11px] text-muted-foreground">
                      Guides, API, and reference.
                    </p>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setSelection("custom")}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors",
                    isCustom
                      ? "border-primary bg-muted/50"
                      : "border-border hover:bg-muted/40",
                  )}
                >
                  <div className="flex aspect-[16/10] w-full items-center justify-center rounded-md border border-dashed border-border bg-gradient-to-br from-primary/10 to-muted">
                    <Wand2 className="size-5 text-primary" />
                  </div>
                  <div className="px-0.5">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      Custom
                      <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-primary">
                        Beta
                      </span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Describe it — AI builds it.
                    </p>
                  </div>
                </button>
              </div>
            </div>
          ) : null}

          {isCustom ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
              Continue to a focused view where you describe the portal, choose which
              folders it covers, and let AI build it from scratch.
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="new-project-name">Name</Label>
                <Input
                  id="new-project-name"
                  value={name}
                  placeholder="API reference"
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={Boolean(slugError)}
                />
                {slug && !slugError ? (
                  <p className="text-[11px] text-muted-foreground">
                    Path: <span className="font-mono">/{slug}</span>
                  </p>
                ) : null}
                {slugError ? (
                  <p className="text-[11px] text-destructive">{slugError}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label>Content scope</Label>
                <ProjectScopeControl
                  folders={folders}
                  scope={scope}
                  scopeState="idle"
                  onScopeChange={setScope}
                  listClassName="max-h-64"
                />
              </div>
            </>
          )}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <DialogFooter className="-mx-4 -mb-4">
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={isCustom ? false : !canCreate}>
              {isCustom
                ? "Continue"
                : submitting
                  ? "Creating..."
                  : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// Dedicated full-screen "build from scratch" view. Reached from the New Project
// dialog's Custom card. The user describes the portal AND picks the folder scope
// here (not in the cramped dialog), then `onBuild` creates the project + kicks
// off generation while a loader takes over.
function PortalCustomCreateView({
  existingSlugs,
  folders,
  onCancel,
  onBuild,
}: {
  existingSlugs: string[]
  folders: FolderResponse[]
  onCancel: () => void
  onBuild: (input: {
    slug: string
    name: string
    description: string
    scope: PortalScopeEntry[] | null
  }) => Promise<void>
}): React.ReactElement {
  const [description, setDescription] = useState("")
  const [name, setName] = useState("")
  const [scope, setScope] = useState<PortalScopeEntry[] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Default the name to the first words of the description so the user can just
  // describe and build without naming first.
  const effectiveName =
    name.trim().length === 0
      ? description.trim().split(/\s+/).slice(0, 5).join(" ")
      : name
  const slug = slugFromName(effectiveName)
  const taken = existingSlugs.includes(slug)
  const slugError =
    effectiveName.trim().length === 0
      ? null
      : !isPortalSlug(slug)
        ? "Name must contain letters or numbers."
        : taken
          ? `"${slug}" is already taken.`
          : null
  const canBuild =
    isPortalSlug(slug) && !taken && description.trim().length > 0 && !submitting

  async function build(): Promise<void> {
    if (!canBuild) return
    setSubmitting(true)
    setError(null)
    try {
      await onBuild({
        slug,
        name: effectiveName.trim(),
        description: description.trim(),
        scope,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the build")
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            onClick={onCancel}
            className="shrink-0 text-muted-foreground"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Wand2 className="size-5 text-primary" />
          <h1 className="text-lg font-medium text-foreground">
            Build a portal from scratch
          </h1>
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
            Beta
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Describe the portal you want and choose which folders it should cover.
          Bread designs and assembles it for you — refine it afterward in the builder.
        </p>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            void build()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="custom-portal-prompt">Describe your portal</Label>
            <Textarea
              id="custom-portal-prompt"
              autoFocus
              value={description}
              placeholder="A developer-docs portal for our API, with a dark hero, a quickstart, and a guides section grouped by topic."
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-32 resize-none"
              maxLength={4000}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-portal-name">Name</Label>
            <Input
              id="custom-portal-name"
              value={name}
              placeholder={
                effectiveName.trim()
                  ? `Name (default: ${effectiveName.trim()})`
                  : "Name"
              }
              onChange={(e) => setName(e.target.value)}
              aria-invalid={Boolean(slugError)}
            />
            {slug && !slugError ? (
              <p className="text-[11px] text-muted-foreground">
                Path: <span className="font-mono">/{slug}</span>
              </p>
            ) : null}
            {slugError ? (
              <p className="text-[11px] text-destructive">{slugError}</p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label>Content scope</Label>
            <ProjectScopeControl
              folders={folders}
              scope={scope}
              scopeState="idle"
              onScopeChange={setScope}
            />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canBuild} className="gap-1.5">
              <Wand2 className="size-4" />
              Build with AI
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}


function ProjectPathControl({
  workspace,
  project,
  projects,
  pathState,
  onPathChange,
}: {
  workspace: WorkspaceWithRole
  project: PortalProjectOption
  projects: PortalProjectOption[]
  pathState: ScopeState
  onPathChange: (slug: string) => Promise<void>
}): React.ReactElement {
  const hasHydrated = useHasHydrated()
  const projectAddressScope =
    getPortalAddressScope(workspace.settings) === "project"
  const {
    data: domainRouteData,
    isLoading: domainRouteLoading,
    mutate: mutateDomainRoute,
  } = usePortalProjectDomainRoute(project.slug, {
    workspaceId: workspace.id,
    enabled: projectAddressScope,
  })
  const [pathInput, setPathInput] = useState(project.isDefault ? "" : project.slug)
  const [inputProjectSlug, setInputProjectSlug] = useState(project.slug)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [idCopied, setIdCopied] = useState(false)
  const [addressMode, setAddressMode] = useState<ProjectAddressMode>("inherited")
  const [addressDomain, setAddressDomain] = useState("")
  const [addressStateKey, setAddressStateKey] = useState("")
  const [addressSaving, setAddressSaving] = useState(false)
  const [addressError, setAddressError] = useState<string | null>(null)
  const [addressStatus, setAddressStatus] = useState<string | null>(null)
  const [addressConnection, setAddressConnection] =
    useState<PortalConnectionResult | null>(null)
  const [addressConnectionCheck, setAddressConnectionCheck] = useState(0)
  const addressSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (addressSaveTimerRef.current !== null) {
        clearTimeout(addressSaveTimerRef.current)
      }
    },
    [project.slug],
  )

  if (project.slug !== inputProjectSlug) {
    setInputProjectSlug(project.slug)
    setPathInput(project.isDefault ? "" : project.slug)
    setError(null)
    setStatus(null)
    setCopied(false)
    setIdCopied(false)
    setAddressConnection(null)
  }

  const workspaceCustomDomain = getKbCustomDomain(workspace.settings)
  const workspaceAddressMode = getPortalAddressMode(workspace.settings)
  const activeWorkspaceDomain =
    !projectAddressScope && workspaceAddressMode !== "bread"
      ? workspaceCustomDomain
      : ""
  const domainRoute = domainRouteData?.route ?? null
  const domainRouteConnectionKey = domainRoute
    ? `${domainRoute.domain}:${domainRoute.pathPrefix}`
    : ""
  const savedAddressMode: ProjectAddressMode =
    domainRoute?.mode ?? "inherited"
  const nextAddressStateKey = domainRouteData
    ? `${project.slug}:${domainRoute?.domain ?? ""}:${savedAddressMode}`
    : ""
  if (nextAddressStateKey && nextAddressStateKey !== addressStateKey) {
    setAddressStateKey(nextAddressStateKey)
    setAddressMode(savedAddressMode)
    setAddressDomain(domainRoute?.domain ?? workspaceCustomDomain)
    setAddressError(null)
    setAddressStatus(null)
  }

  useEffect(() => {
    if (!projectAddressScope || !domainRouteConnectionKey) return
    const controller = new AbortController()
    void verifyPortalProjectAddress(project.slug, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setAddressConnection(result)
      },
    )
    return () => controller.abort()
  }, [
    project.slug,
    projectAddressScope,
    domainRouteConnectionKey,
    addressConnectionCheck,
  ])

  const portalKey = workspace.slug
  const origin = hasHydrated ? window.location.origin : ""
  const breadOrigin = (
    process.env.NEXT_PUBLIC_APP_URL ||
    origin
  ).replace(/\/+$/, "")
  const inheritedRoot = activeWorkspaceDomain
    ? `https://${activeWorkspaceDomain}`
    : `${origin}/p/${portalKey}`
  const inheritedUrl = portalProjectUrl({
    origin,
    workspaceSlug: portalKey,
    projectSlug: project.slug,
    isDefault: project.isDefault,
    workspaceDomain: activeWorkspaceDomain,
  })
  const savedUrl = portalProjectUrl({
    origin,
    workspaceSlug: portalKey,
    projectSlug: project.slug,
    isDefault: project.isDefault,
    workspaceDomain: activeWorkspaceDomain,
    projectRoute: domainRoute,
  })
  const rootDisplay = domainRoute
    ? `https://${domainRoute.domain}`
    : inheritedRoot

  const candidate = pathInput
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase()
  const pathError = project.isDefault
    ? candidate.length === 0
      ? null
      : !isPortalSlug(candidate)
        ? "Use lowercase letters, numbers, and hyphens only."
        : PORTAL_RESERVED_PROJECT_SLUGS.has(candidate)
          ? "That suffix is reserved."
          : candidate === workspace.slug
            ? "That suffix is reserved for the workspace root."
            : projects.some((p) => p.slug === candidate && p.slug !== project.slug)
              ? "That suffix is already used by another project."
              : null
    : candidate.length === 0
      ? "Enter a path suffix."
      : !isPortalSlug(candidate)
        ? "Use lowercase letters, numbers, and hyphens only."
        : PORTAL_RESERVED_PROJECT_SLUGS.has(candidate)
          ? "That suffix is reserved."
          : candidate === workspace.slug
            ? "That suffix is reserved for the workspace root."
            : projects.some((p) => p.slug === candidate && p.slug !== project.slug)
              ? "That suffix is already used by another project."
              : null
  const saving = pathState === "saving"
  const canSave =
    !saving &&
    candidate.length > 0 &&
    candidate !== project.slug &&
    pathError === null

  const addressValidation =
    addressMode === "inherited"
      ? { domain: "", error: null }
      : validatePortalRouteDomain(
          addressDomain,
          addressMode === "path",
          domainRoute?.domain,
        )
  const normalizedAddressDomain = addressValidation.domain
  const pathMountNeedsSuffix = addressMode === "path" && project.isDefault
  const addressPreview =
    addressMode === "inherited"
      ? inheritedUrl
      : normalizedAddressDomain
        ? `https://${normalizedAddressDomain}${
            addressMode === "path" ? `/${project.slug}` : ""
          }`
        : ""
  const addressDnsRecord =
    addressMode === "domain" && normalizedAddressDomain
      ? customDomainDnsRecord(normalizedAddressDomain)
      : null
  const addressDirty =
    addressMode !== savedAddressMode ||
    (addressMode !== "inherited" &&
      normalizedAddressDomain !== (domainRoute?.domain ?? ""))
  const addressConnectionStatus: PortalConnectionStatus =
    addressMode === "inherited"
      ? project.publishedVersion != null
        ? "connected"
        : "pending"
      : addressSaving || domainRouteLoading || addressDirty || !addressConnection
        ? "pending"
        : addressConnection.connected
          ? "connected"
          : "not_connected"

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(savedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard unavailable in insecure contexts.
    }
  }

  const copyId = async (): Promise<void> => {
    if (!project.id) return
    try {
      await navigator.clipboard.writeText(project.id)
      setIdCopied(true)
      setTimeout(() => setIdCopied(false), 1500)
    } catch {
      // Clipboard unavailable in insecure contexts.
    }
  }

  const onSave = async (): Promise<void> => {
    if (pathError) {
      setError(pathError)
      return
    }
    setError(null)
    setStatus(null)
    try {
      await onPathChange(candidate)
      setStatus("Path saved.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update path.")
    }
  }

  const persistProjectAddress = async (
    nextMode: ProjectAddressMode,
    rawDomain: string,
  ): Promise<void> => {
    const validation =
      nextMode === "inherited"
        ? { domain: "", error: null }
        : validatePortalRouteDomain(
            rawDomain,
            nextMode === "path",
            domainRoute?.domain,
          )
    if (validation.error || (nextMode !== "inherited" && !validation.domain)) {
      return
    }
    const dirty =
      nextMode !== savedAddressMode ||
      (nextMode !== "inherited" &&
        validation.domain !== (domainRoute?.domain ?? ""))
    if (!dirty) {
      setAddressStatus("Saved automatically.")
      return
    }
    setAddressSaving(true)
    setAddressConnection(null)
    setAddressError(null)
    setAddressStatus("Saving automatically…")
    try {
      const result =
        nextMode === "inherited"
          ? await clearPortalProjectDomainRoute(project.slug)
          : await updatePortalProjectDomainRoute(project.slug, {
              domain: validation.domain,
              mode: nextMode,
            })
      await mutateDomainRoute(result, false)
      setAddressStatus("Saved automatically.")
    } catch (err) {
      setAddressStatus(null)
      setAddressError(
        err instanceof Error ? err.message : "Could not update the project address.",
      )
    } finally {
      setAddressSaving(false)
    }
  }

  const scheduleProjectAddressSave = (
    nextMode: ProjectAddressMode,
    rawDomain: string,
    delay = 600,
  ): void => {
    if (addressSaveTimerRef.current !== null) {
      clearTimeout(addressSaveTimerRef.current)
      addressSaveTimerRef.current = null
    }
    setAddressError(null)
    setAddressStatus(null)
    setAddressConnection(null)
    if (nextMode === "path" && project.isDefault) {
      setAddressError(
        "Save a path suffix below before using a custom sub-folder.",
      )
      return
    }
    const validation =
      nextMode === "inherited"
        ? { domain: "", error: null }
        : validatePortalRouteDomain(
            rawDomain,
            nextMode === "path",
            domainRoute?.domain,
          )
    if (validation.error || (nextMode !== "inherited" && !validation.domain)) {
      return
    }
    setAddressStatus("Saving automatically…")
    addressSaveTimerRef.current = setTimeout(() => {
      addressSaveTimerRef.current = null
      void persistProjectAddress(nextMode, rawDomain)
    }, delay)
  }

  return (
    <section className="shrink-0 rounded-lg border border-border bg-muted/20 p-3">
      <div className="mb-3 min-w-0">
        <p className="truncate text-xs font-medium text-foreground">Project URL</p>
        <p className="text-[11px] text-muted-foreground">
          Workspace root: <span className="font-mono">{rootDisplay}</span>
        </p>
        {project.id ? (
          <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
            <span>Project ID:</span>
            <span className="font-mono bg-muted/50 px-1 py-0.5 rounded text-[10px] select-all truncate max-w-[180px]">{project.id}</span>
            <AppTooltip label={idCopied ? "Project ID copied" : "Copy project ID"}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-4 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => void copyId()}
                aria-label="Copy Project ID"
              >
                {idCopied ? (
                  <Check className="size-2.5 text-emerald-600" />
                ) : (
                  <Copy className="size-2.5" />
                )}
              </Button>
            </AppTooltip>
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground mt-1 italic">
            Project ID: <span className="text-amber-500 font-medium">Not initialized</span>
          </p>
        )}
      </div>

      {projectAddressScope ? (
      <div className="space-y-3 border-b border-border pb-3">
        <div className="space-y-2">
          <div>
            <p className="text-xs font-medium text-foreground">
              How do you want to publish?
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Choose an address for this project.
            </p>
          </div>
          <div
            role="radiogroup"
            aria-label="Project address type"
            className="space-y-2"
          >
            <ProjectAddressOption
              selected={addressMode === "path"}
              title="Custom sub-folder"
              description={`yourcompany.com/${project.slug}`}
              badge="Recommended"
              icon={<Folder className="size-4 text-orange-500" />}
              connectionStatus={
                addressMode === "path" && (Boolean(domainRoute) || addressSaving)
                  ? addressConnectionStatus
                  : undefined
              }
              disabled={domainRouteLoading || addressSaving}
              onSelect={() => {
                const nextDomain = addressDomain || workspaceCustomDomain
                setAddressMode("path")
                setAddressDomain(nextDomain)
                setAddressError(null)
                setAddressStatus(null)
                scheduleProjectAddressSave("path", nextDomain)
              }}
            />
            <ProjectAddressOption
              selected={addressMode === "domain"}
              title="Custom domain"
              description={`${project.slug}.yourcompany.com`}
              icon={<Globe className="size-4 text-sky-500" />}
              connectionStatus={
                addressMode === "domain" &&
                (Boolean(domainRoute) || addressSaving)
                  ? addressConnectionStatus
                  : undefined
              }
              disabled={domainRouteLoading || addressSaving}
              onSelect={() => {
                const nextDomain = addressDomain || workspaceCustomDomain
                setAddressMode("domain")
                setAddressDomain(nextDomain)
                setAddressError(null)
                setAddressStatus(null)
                scheduleProjectAddressSave("domain", nextDomain)
              }}
            />
            <ProjectAddressOption
              selected={addressMode === "inherited"}
              title="Bread URL"
              description={inheritedUrl.replace(/^https?:\/\//, "")}
              icon={<Link2 className="size-4 text-violet-500" />}
              disabled={domainRouteLoading || addressSaving}
              onSelect={() => {
                setAddressMode("inherited")
                setAddressError(null)
                setAddressStatus(null)
                scheduleProjectAddressSave("inherited", "", 0)
              }}
            />
          </div>
        </div>

        {addressMode === "inherited" ? (
          <p className="text-[11px] text-muted-foreground">
            Uses this project&apos;s built-in Bread URL. Workspace hosting is
            disabled while URL ownership is project-specific.
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="portal-project-domain" className="text-xs">
              Custom domain
            </Label>
            <Input
              id="portal-project-domain"
              value={addressDomain}
              placeholder={
                addressMode === "domain" ? "docs.customer.com" : "customer.com"
              }
              disabled={addressSaving}
              className="h-8 font-mono text-xs lowercase"
              onChange={(event) => {
                const nextDomain = event.target.value
                setAddressDomain(nextDomain)
                scheduleProjectAddressSave(addressMode, nextDomain)
              }}
            />
            {addressValidation.error ? (
              <p className="flex items-center gap-1 text-[11px] text-destructive">
                <AlertCircle className="size-3 shrink-0" />
                {customDomainErrorMessage(addressValidation.error)}
              </p>
            ) : null}
            {addressPreview ? (
              <code className="block overflow-x-auto whitespace-nowrap rounded-md border bg-background px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                {addressPreview}
              </code>
            ) : null}
            {addressMode === "path" ? (
              pathMountNeedsSuffix ? (
                <p className="text-[11px] text-muted-foreground">
                  Save a path suffix below before mounting this root project on
                  a shared domain.
                </p>
              ) : normalizedAddressDomain && breadOrigin ? (
                <PortalReverseProxyInstructions
                  domain={normalizedAddressDomain}
                  mountPath={`/${project.slug}`}
                  portalPath={`/p/${portalKey}/${project.slug}`}
                  breadOrigin={breadOrigin}
                  connectorReady={Boolean(domainRoute && !addressDirty)}
                  verifyWorkerActivation={async () =>
                    (await verifyPortalProjectAddress(project.slug)).connected
                  }
                  onWorkerConnected={() => {
                    setAddressConnection(null)
                    setAddressConnectionCheck((value) => value + 1)
                  }}
                />
              ) : null
            ) : addressDnsRecord ? (
              <PortalDnsInstructions
                domain={normalizedAddressDomain}
                record={addressDnsRecord}
              />
            ) : null}
            {domainRoute && !addressDirty ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 p-2.5">
                <PortalConnectionBadge status={addressConnectionStatus} />
                <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                  {addressConnectionStatus === "connected"
                    ? "This project is staying on its configured URL."
                    : addressConnection?.reason ?? "Checking the configured URL…"}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={addressConnectionStatus === "pending"}
                  onClick={() => {
                    setAddressConnection(null)
                    setAddressConnectionCheck((value) => value + 1)
                  }}
                >
                  Check connection
                </Button>
              </div>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {addressSaving || domainRouteLoading ? (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Saving automatically…
            </p>
          ) : addressStatus ? (
            <p className="flex items-center gap-1 text-[11px] text-primary">
              <Check className="size-3 shrink-0" />
              {addressStatus}
            </p>
          ) : null}
          {addressError ? (
            <p role="alert" className="text-[11px] text-destructive">
              {addressError}
            </p>
          ) : null}
        </div>
      </div>
      ) : null}

      <div className="space-y-2 pt-3">
        <Label htmlFor="portal-project-path" className="text-xs">
          Path suffix
        </Label>
        <div className="flex items-stretch">
          <span className="inline-flex shrink-0 items-center rounded-l-md border border-r-0 border-input bg-muted px-2.5 font-mono text-xs text-muted-foreground">
            /
          </span>
          <Input
            id="portal-project-path"
            value={pathInput}
            placeholder={project.isDefault ? "root" : undefined}
            disabled={saving}
            maxLength={50}
            className="h-8 rounded-l-none font-mono text-xs lowercase"
            onChange={(event) => {
              setPathInput(event.target.value)
              setError(null)
              setStatus(null)
            }}
          />
        </div>
        {project.isDefault && candidate.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            Leave empty to keep this project at the workspace root.
          </p>
        ) : null}
        {pathError ? (
          <p className="flex items-center gap-1 text-[11px] text-destructive">
            <AlertCircle className="size-3 shrink-0" />
            {pathError}
          </p>
        ) : null}
        <ProjectUrlRow url={savedUrl} href={savedUrl} copied={copied} onCopy={() => void copy()} />
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canSave}
            onClick={() => void onSave()}
          >
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Save path
          </Button>
          {status ? (
            <p className="flex items-center gap-1 text-[11px] text-primary">
              <Check className="size-3 shrink-0" />
              {status}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function ProjectAddressOption({
  selected,
  title,
  description,
  badge,
  icon,
  disabled,
  onSelect,
  connectionStatus,
}: {
  selected: boolean
  title: string
  description: string
  badge?: string
  icon: React.ReactNode
  disabled: boolean
  onSelect: () => void
  connectionStatus?: PortalConnectionStatus
}): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl border bg-background px-3 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        selected
          ? "border-primary/60 bg-primary/[0.04] ring-1 ring-primary/20"
          : "border-border hover:border-muted-foreground/40 hover:bg-muted/30",
      )}
    >
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {badge ? (
            <span className="rounded-full bg-lime-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-lime-700 dark:bg-lime-950 dark:text-lime-300">
              {badge}
            </span>
          ) : null}
          {connectionStatus ? (
            <PortalConnectionBadge status={connectionStatus} />
          ) : null}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/30 bg-background",
        )}
      >
        {selected ? <Check className="size-2.5" /> : null}
      </span>
    </button>
  )
}

function ProjectUrlRow({
  url,
  href,
  copied,
  onCopy,
}: {
  url: string
  href: string
  copied: boolean
  onCopy: () => void
}): React.ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code
        title={url}
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border bg-background px-2 py-1.5 font-mono text-[11px] text-muted-foreground"
      >
        {url}
      </code>
      <AppTooltip label={copied ? "Project URL copied" : "Copy project URL"}>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Copy project URL"
          onClick={onCopy}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </AppTooltip>
      <AppTooltip label="Open published portal" description="Opens the current URL in a new tab.">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open project URL"
          className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-background transition-colors hover:bg-muted"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </AppTooltip>
    </div>
  )
}

interface RootPickerFolderNodeProps {
  folder: FolderResponse
  childrenByParent: Map<string | null, FolderResponse[]>
  selectedId: string | null
  expandedIds: Set<string>
  onToggleExpand: (id: string) => void
  onSelect: (id: string) => void
  searchQuery: string
  depth: number
}

function RootPickerFolderNode({
  folder,
  childrenByParent,
  selectedId,
  expandedIds,
  onToggleExpand,
  onSelect,
  searchQuery,
  depth,
}: RootPickerFolderNodeProps) {
  const children = childrenByParent.get(folder.id) ?? []
  const isExpanded = expandedIds.has(folder.id) || (searchQuery.length > 0)
  const isSelected = selectedId === folder.id

  const normalizedQuery = searchQuery.toLowerCase()
  const folderMatches = folder.display_name.toLowerCase().includes(normalizedQuery)

  const hasMatchingDescendant = (f: FolderResponse): boolean => {
    const fChildren = childrenByParent.get(f.id) ?? []
    return fChildren.some((child) =>
      child.display_name.toLowerCase().includes(normalizedQuery) || hasMatchingDescendant(child)
    )
  }

  const descendantMatches = searchQuery ? hasMatchingDescendant(folder) : false
  const visible = !searchQuery || folderMatches || descendantMatches

  if (!visible) return null

  const matchingChildren = searchQuery
    ? children.filter(child => child.display_name.toLowerCase().includes(normalizedQuery) || hasMatchingDescendant(child))
    : children
  const hasChildren = matchingChildren.length > 0

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          "flex h-8 items-center gap-1 rounded-md px-2 hover:bg-accent hover:text-accent-foreground text-left text-xs transition-colors",
          isSelected && "bg-accent font-medium text-accent-foreground"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand(folder.id)
          }}
          disabled={!hasChildren}
          className={cn(
            "p-1 text-muted-foreground/60 hover:text-foreground rounded transition-opacity",
            !hasChildren && "opacity-0 pointer-events-none"
          )}
        >
          <ChevronRight
            className={cn("size-3 transition-transform", isExpanded && "rotate-90")}
          />
        </button>
        <button
          type="button"
          onClick={() => onSelect(folder.id)}
          className="flex flex-1 items-center gap-1.5 py-1 text-left min-w-0"
        >
          {isExpanded ? (
            <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate flex-1 min-w-0">{folder.display_name}</span>
        </button>
      </div>
      {hasChildren && isExpanded && (
        <div className="flex flex-col mt-0.5">
          {matchingChildren.map((child) => (
            <RootPickerFolderNode
              key={child.id}
              folder={child}
              childrenByParent={childrenByParent}
              selectedId={selectedId}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
              searchQuery={searchQuery}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// One document row in the scope tree (title-bearing subset of the docs API).
function ProjectScopeControl({
  folders,
  allFolders,
  scope,
  scopeState,
  onScopeChange,
  listClassName,
  isLoading = false,
  variant = "card",
  title = "Project content",
  description,
  rootFieldLabel = "Project root",
  targetLabel = "project",
  workspaceRootMode = "include-all",
}: {
  folders: FolderResponse[]
  allFolders?: FolderResponse[]
  scope: PortalScopeEntry[] | null
  scopeState: ScopeState
  onScopeChange: (scope: PortalScopeEntry[] | null) => void
  listClassName?: string
  isLoading?: boolean
  /**
   * "card" is a dialog's boxed field; "panel" is the sidebar's own section,
   * which drops the box so the tree uses the full width of the rail.
   */
  variant?: "card" | "panel"
  title?: string
  description?: string
  rootFieldLabel?: string
  /** Lowercase noun used in explanatory copy, such as "project" or "page". */
  targetLabel?: string
  /** Page scopes use the workspace as a boundary without inheriting all of it. */
  workspaceRootMode?: "include-all" | "custom"
}): React.ReactElement {
  const isPanel = variant === "panel"
  const sectionClassName = isPanel
    ? "flex min-w-0 flex-col"
    : "shrink-0 rounded-lg border border-border bg-muted/20 p-3"
  const scopedIds = new Set((scope ?? []).map(scopeEntryIdOf))
  const promotedIds = scopePromotedIdsOf(scope)
  const rootOnlyIds = scopeRootOnlyIdsOf(scope)
  const isAll = scope === null
  const saving = scopeState === "saving"
  const eligibleIds = new Set(folders.map((f) => f.id))
  const lookup = allFolders ?? folders
  const folderById = new Map(folders.map((folder) => [folder.id, folder]))

  // Index eligible folders once so the root picker can show full paths while
  // the inclusion list stays limited to that root's immediate children.
  const childrenByParent = new Map<string | null, FolderResponse[]>()
  for (const folder of folders) {
    const parentKey =
      folder.parent_folder_id && eligibleIds.has(folder.parent_folder_id)
        ? folder.parent_folder_id
        : null
    const siblings = childrenByParent.get(parentKey) ?? []
    siblings.push(folder)
    childrenByParent.set(parentKey, siblings)
  }
  childrenByParent.forEach((list) =>
    list.sort((a, b) => a.display_name.localeCompare(b.display_name)),
  )

  // The promoted/root marker in the stored scope determines where this tree
  // opens, whether the target is Home or a custom portal page.
  const selectedRootId = resolveScopeRootId(scope, folders)
  const selectedRoot = selectedRootId ? folderById.get(selectedRootId) ?? null : null

  const rootLabel = (folder: FolderResponse): string => {
    const names = [folder.display_name]
    let parentId = folder.parent_folder_id
    let hops = 0
    while (parentId && hops < 16) {
      const parent = folderById.get(parentId)
      if (!parent) break
      names.unshift(parent.display_name)
      parentId = parent.parent_folder_id
      hops += 1
    }
    return names.join(" / ")
  }

  const [rootPopoverOpen, setRootPopoverOpen] = useState(false)
  const [rootSearchQuery, setRootSearchQuery] = useState("")

  const [rootExpandedIds, setRootExpandedIds] = useState<Set<string>>(() => {
    const ids = new Set<string>()
    if (selectedRootId) {
      let currentId = selectedRootId
      while (currentId) {
        const folder = folderById.get(currentId)
        if (folder?.parent_folder_id) {
          ids.add(folder.parent_folder_id)
        }
        currentId = folder?.parent_folder_id ?? ""
      }
    }
    return ids
  })

  const toggleRootExpand = (id: string) => {
    setRootExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Public-eligible documents for the scope tree. The list API returns every
  // workspace doc; only source/page docs can be served publicly. Rows from a
  // stale SWR cache may lack document_type — treat those as eligible so the
  // tree degrades to showing docs rather than hiding them.
  const { data: allDocuments } = useDocuments()
  const publicDocs = useMemo(
    () =>
      (allDocuments ?? []).filter(
        (doc) =>
          doc.document_type == null ||
          doc.document_type === "source" ||
          doc.document_type === "page",
      ),
    [allDocuments],
  )
  const scopeTreeDocs = useMemo(
    () =>
      publicDocs.map((doc) => ({
        id: doc.id,
        title: doc.title,
        folder_id: doc.folder_id,
      })),
    [publicDocs],
  )
  // Cheap O(n) build — the React Compiler memoizes it; a manual useMemo on the
  // mutated-locals-derived selectedRootId would defeat its analysis.
  const scopeCtx: ScopeTreeContext = {
    folders: folders.map((folder) => ({
      id: folder.id,
      parent_folder_id: folder.parent_folder_id,
    })),
    docs: publicDocs.map((doc) => ({ id: doc.id, folder_id: doc.folder_id })),
    rootId: selectedRootId,
  }

  const selectRoot = (rootId: string | null): void => {
    if (rootId === null && workspaceRootMode === "custom") {
      onScopeChange([])
      return
    }
    onScopeChange(scopeForRoot(scopeCtx, rootId))
  }

  const explicitWorkspaceScope = explicitWorkspacePortalScope(folders)

  const ineligibleScoped = (scope ?? [])
    .map(scopeEntryIdOf)
    // "" = doc / workspaceDocs entries — they carry no folder id.
    .filter((id) => id !== "" && !eligibleIds.has(id))
    .map((id) => ({ id, folder: lookup.find((f) => f.id === id) ?? null }))

  const removeFolder = (folderId: string): void => {
    if (folderId === selectedRootId) {
      onScopeChange(null)
      return
    }
    const next = (scope ?? []).filter((entry) => scopeEntryIdOf(entry) !== folderId)
    onScopeChange(next.length > 0 ? next : null)
  }

  if (isLoading) {
    return (
      <section className={sectionClassName}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-foreground">{title}</p>
          <span className="text-[11px] text-muted-foreground animate-pulse">Loading...</span>
        </div>
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </section>
    )
  }

  const selectedRootLabel = selectedRoot
    ? rootLabel(selectedRoot)
    : selectedRootId
      ? `Unavailable folder (${selectedRootId.slice(0, 8)}...)`
      : "Entire workspace"

  const eligibleRoots = childrenByParent.get(null) ?? []

  const matchesSearch = (folder: FolderResponse, query: string): boolean => {
    if (!query) return true
    const normalizedQuery = query.toLowerCase()
    if (folder.display_name.toLowerCase().includes(normalizedQuery)) return true
    const children = childrenByParent.get(folder.id) ?? []
    return children.some((child) => matchesSearch(child, query))
  }

  const rootFoldersList = rootSearchQuery
    ? folders.filter((f) => matchesSearch(f, rootSearchQuery) && (f.parent_folder_id === null || !eligibleIds.has(f.parent_folder_id)))
    : eligibleRoots

  // Tree top level: the root's child folders (or top-level folders for the
  // workspace root), then the root's own documents, then — workspace root only —
  // the folderless-docs group.
  return (
    <section className={sectionClassName}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1 text-xs font-medium text-foreground">
            <span className="truncate">{title}</span>
            <InfoHint>
              Pick a content root, then check what to include. A checked
              folder includes everything inside it — now and in the future.
              Open a folder to include only some of its subfolders or specific
              documents. Role-restricted folders can&apos;t be added.
            </InfoHint>
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {isAll
              ? "Entire workspace"
              : selectedRoot
                ? selectedRoot.display_name
                : "Custom selection"}
          </p>
          {isPanel && description ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {saving ? (
          <span className="shrink-0 text-[11px] text-muted-foreground animate-pulse">Saving...</span>
        ) : null}
      </div>

      <div className="mb-3 space-y-1.5">
        <Label className="text-[11px]">{rootFieldLabel}</Label>
        <Popover open={rootPopoverOpen} onOpenChange={setRootPopoverOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                role="combobox"
                aria-expanded={rootPopoverOpen}
                disabled={saving}
                className="w-full justify-between h-8 text-xs font-normal bg-background px-3 hover:bg-background/80"
              />
            }
          >
            <span className="truncate flex items-center gap-1.5 min-w-0">
              {selectedRootId ? (
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Building2 className="size-3.5 shrink-0 text-primary" />
              )}
              <span className="truncate">{selectedRootLabel}</span>
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
          </PopoverTrigger>
          <PopoverContent className="w-[340px] p-2" align="start">
            <div className="flex flex-col gap-2">
              <Input
                placeholder="Search folders..."
                value={rootSearchQuery}
                onChange={(e) => setRootSearchQuery(e.target.value)}
                className="h-8 text-xs px-2"
              />
              <div className="max-h-[260px] overflow-y-auto space-y-1 pr-1 scrollbar-none">
                {/* The workspace is a different kind of choice than any folder —
                    give it its own iconography and description so it doesn't read
                    as just another row in the folder list. */}
                <button
                  type="button"
                  onClick={() => {
                    selectRoot(null)
                    setRootPopoverOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground",
                    !selectedRootId && "bg-accent text-accent-foreground"
                  )}
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <Building2 className="size-3.5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate font-medium">Entire workspace</span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {workspaceRootMode === "custom"
                        ? "Choose across all public content"
                        : "All public folders and documents"}
                    </span>
                  </span>
                  {!selectedRootId ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                </button>
                <div className="border-t border-border/50 my-1" />
                {rootFoldersList.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-muted-foreground text-center">
                    No folders found
                  </p>
                ) : (
                  rootFoldersList.map((folder) => (
                    <RootPickerFolderNode
                      key={folder.id}
                      folder={folder}
                      childrenByParent={childrenByParent}
                      selectedId={selectedRootId}
                      expandedIds={rootExpandedIds}
                      onToggleExpand={toggleRootExpand}
                      onSelect={(id) => {
                        selectRoot(id)
                        setRootPopoverOpen(false)
                      }}
                      searchQuery={rootSearchQuery}
                      depth={0}
                    />
                  ))
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {selectedRoot
            ? `Only content inside ${selectedRoot.display_name} can be included.`
            : `Choose a folder to limit this ${targetLabel} to one part of your workspace.`}
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-foreground">
          {selectedRoot ? `Content in ${selectedRoot.display_name}` : "Included content"}
        </p>
        <ScopeTreeSelector
          folders={folders}
          documents={scopeTreeDocs}
          rootId={selectedRootId}
          scope={scope}
          onScopeChange={(nextScope) =>
            onScopeChange(
              workspaceRootMode === "custom" && nextScope === null
                ? explicitWorkspaceScope
                : nextScope,
            )
          }
          disabled={saving}
          emptyLabel={
            selectedRoot
              ? "This root has no folders or documents yet. Content saved into it will appear here."
              : `No public content yet. Publish workspace-visible folders or documents to scope this ${targetLabel}.`
          }
          listClassName={listClassName}
        />
      </div>

      {ineligibleScoped.length > 0 ? (
        <div className="mt-2 space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-500">
            <AlertCircle className="size-3.5 shrink-0" />
            {ineligibleScoped.length} scoped folder
            {ineligibleScoped.length === 1 ? "" : "s"} no longer public
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Their visibility changed to restricted, so they&apos;re excluded from the
            portal and aren&apos;t served to visitors. Remove them to keep the scope tidy.
          </p>
          {ineligibleScoped.map(({ id, folder }) => (
            <div
              key={id}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground"
            >
              <Lock className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate line-through">
                {folder ? folder.display_name : "Unavailable folder"}
              </span>
              <button
                type="button"
                disabled={saving}
                onClick={() => removeFolder(id)}
                className="shrink-0 text-[11px] font-medium text-destructive hover:underline disabled:opacity-60"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {folders.length === 0 && ineligibleScoped.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          No public folders yet. Publish workspace-visible folders to scope this project.
        </p>
      ) : null}
      {scopeState === "error" ? (
        <p className="mt-2 text-[11px] text-destructive">Could not update scope.</p>
      ) : null}
    </section>
  )
}

function BuilderHeaderActions({
  savedStatusVisible,
  lastEditedAt,
  publishing,
  discarding,
  versions,
  versionsLoading,
  previewVersion,
  restoring,
  onSelectVersion,
  onRestoreVersion,
  documentControlsRef,
}: {
  savedStatusVisible: boolean
  lastEditedAt: string | null
  publishing: boolean
  discarding: boolean
  /** Saved edit history for the selector. */
  versions: PortalVersionSummary[]
  versionsLoading: boolean
  /** null = editing the draft; a number = previewing that version read-only. */
  previewVersion: number | null
  restoring: boolean
  onSelectVersion: (version: number | null) => void
  onRestoreVersion: (version: number) => void
  /**
   * Set while a document is open: its save status / version history button
   * renders here in place of the portal version menu.
   */
  documentControlsRef?: (element: HTMLDivElement | null) => void
}): React.ReactElement {
  // Browsing history is read-only: Publish and Revert act on the draft, which
  // is not what the preview is showing, so swap them for a way back.
  const browsingHistory = previewVersion !== null
  return (
    <div className="flex shrink-0 items-center gap-2">
      {documentControlsRef ? (
        <div ref={documentControlsRef} className="flex min-w-0 items-center" />
      ) : (
      <PortalVersionMenu
        savedStatusVisible={savedStatusVisible}
        lastEditedAt={lastEditedAt}
        versions={versions}
        loading={versionsLoading}
        selectedVersion={previewVersion}
        restoring={restoring}
        disabled={publishing || discarding}
        onSelect={onSelectVersion}
        onRestore={onRestoreVersion}
      />
      )}
      {browsingHistory ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSelectVersion(null)}
          disabled={restoring}
        >
          Back to editor
        </Button>
      ) : null}
    </div>
  )
}

export function PortalBuilder({
  children,
}: PortalBuilderProps = {}): React.ReactElement {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { mutate: mutateGlobal } = useSWRConfig()
  const { data: workspace, mutate: mutateWorkspace } = useWorkspace()
  const portalEditorEnabled = workspace?.portal_editor_enabled === true
  const portalAiBuilderEnabled =
    AI_BUILDER_UI_ENABLED && workspace?.portal_ai_builder_enabled === true
  const portalChromeScope = getPortalChromeScope(workspace?.settings)
  // Scope the portal SWR caches to the active workspace so a workspace switch
  // re-fetches cleanly instead of reusing the prior workspace's data (or its
  // stale 403, which otherwise flashes the "need admin access" screen).
  const workspaceId = workspace?.id
  const {
    data: projectData,
    error: projectsError,
    isLoading: projectsLoading,
    mutate: mutateProjects,
  } = usePortalProjects({ workspaceId, enabled: portalEditorEnabled })
  const requestedPageSlug = isPortalSlug(searchParams.get("page"))
    ? searchParams.get("page")
    : null
  const projects = projectData?.projects ?? []
  const projectLimit = workspace?.portal_project_limit
  const projectLimitReached =
    typeof projectLimit === "number" && projects.length >= projectLimit
  const canCreateProject = !projectLimitReached
  const projectLimitLabel =
    typeof projectLimit === "number"
      ? `Your plan includes ${projectLimit} portal project${projectLimit === 1 ? "" : "s"}.`
      : null
  const defaultProject = projects.find((project) => project.isDefault) ?? projects[0]
  const rootProjectSlug =
    getKbPrimaryProject(workspace?.settings) ?? defaultProject?.slug ?? null
  // One portal per workspace: the editor always works on the root project.
  // Extra projects from before this change keep serving but are not editable.
  const activeProject =
    projects.find((project) => project.slug === rootProjectSlug) ??
    defaultProject ??
    null
  const selectedProjectSlug = activeProject?.slug ?? null
  const {
    data: draft,
    error: draftError,
    isLoading,
    mutate,
  } = usePortalDraft(selectedProjectSlug ?? undefined, {
    enabled: portalEditorEnabled && Boolean(selectedProjectSlug),
    workspaceId,
  })
  const {
    data: versionData,
    isLoading: versionsLoading,
    mutate: mutateVersions,
  } = usePortalVersions(selectedProjectSlug ?? undefined, {
    enabled: portalEditorEnabled && Boolean(selectedProjectSlug),
    workspaceId,
  })
  const portalVersions = versionData?.versions ?? []
  const portalAddressScope = getPortalAddressScope(workspace?.settings)
  const {
    data: activeDomainRouteData,
    isLoading: activeDomainRouteLoading,
  } = usePortalProjectDomainRoute(selectedProjectSlug, {
    workspaceId,
    enabled:
      portalEditorEnabled &&
      Boolean(selectedProjectSlug) &&
      portalAddressScope === "project",
  })
  const {
    data: rawFolders,
    isLoading: foldersLoading,
    mutate: mutateFolders,
  } = useFolders({
    enabled: portalEditorEnabled,
    revalidateOnFocus: false,
  })

  // Hydration gate: the SWR draft cache is empty on the server but may be warm
  // on the client (persisted), so without this the server renders the skeleton
  // while the first client render shows the editor — a hydration mismatch.
  // `mounted` is false on the server and during hydration, true thereafter
  // (useSyncExternalStore is hydration-safe), so both initial renders agree.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )
  const viewportWidth = useSyncExternalStore(
    subscribeToViewportWidth,
    getViewportWidthSnapshot,
    () => DEFAULT_VIEWPORT_WIDTH,
  )

  const [layout, setLayout] = useState<PortalLayout | null>(null)
  const [dirty, setDirty] = useState(false)
  const [sharedHeaderDirty, setSharedHeaderDirty] = useState(false)
  const [sharedFooterDirty, setSharedFooterDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [savedStatusVisible, setSavedStatusVisible] = useState(false)
  const [scopeState, setScopeState] = useState<ScopeState>("idle")
  const [pathState, setPathState] = useState<ScopeState>("idle")
  const [actionError, setActionError] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  // Version history browsing: null = the working draft (the editor's normal
  // state); a number = the preview is showing that published version read-only.
  const [previewVersion, setPreviewVersion] = useState<number | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [cloudflareWorkerPrompt, setCloudflareWorkerPrompt] =
    useState<CloudflareWorkerRoutePrompt | null>(null)
  // Custom "describe it, AI builds it" flow: `building` holds the in-progress
  // project's display name (null = not building) so the full-screen loader can
  // label itself; `pendingCustomBuild` defers the generate call until the new
  // project's draft has loaded.
  const [building, setBuilding] = useState<string | null>(null)
  const [customCreateOpen, setCustomCreateOpen] = useState(false)
  const [pendingCustomBuild, setPendingCustomBuild] = useState<{
    slug: string
    description: string
  } | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [sidebarView, setSidebarView] = useState<SidebarView>(() =>
    getInitialSidebarView(),
  )
  const [customizeSection, setCustomizeSection] = useState<CustomizeSection>("menu")
  const [documentSearchQuery, setDocumentSearchQuery] = useState("")
  const [documentSortMode, setDocumentSortMode] = useState<DocumentNavSortMode>(() =>
    getStoredBuilderDocumentSortMode(),
  )
  const [appearance, setAppearance] = useState<PreviewAppearance>("light")
  const [device, setDevice] = useState<PreviewDevice>("desktop")
  const activePage =
    layout?.pages?.find((page) => page.slug === requestedPageSlug) ?? null
  const activePageSlug = activePage?.slug ?? null
  // Bumped after each successful save/publish to reload the preview iframe (it
  // renders the saved draft server-side, so it refreshes on a changing key).
  const [previewReloadKey, setPreviewReloadKey] = useState(0)
  const savedStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)
  const layoutRevisionRef = useRef(0)
  const savedLayoutRevisionRef = useRef(0)
  const latestLayoutRef = useRef<PortalLayout | null>(null)
  const {
    isOpen: railOpen,
    width: subSidebarWidth,
    setWidth: setSubSidebarWidth,
  } = useSubSidebar()
  const builderRailMaxWidth = Math.max(
    320,
    Math.floor(viewportWidth * MAX_BUILDER_RAIL_RATIO),
  )
  const builderRailWidth = Math.min(
    builderRailMaxWidth,
    Math.max(320, subSidebarWidth),
  )
  const railStyle = {
    "--kb-rail-width": `${builderRailWidth}px`,
  } as React.CSSProperties
  const { handleRef, isDragging } = useResizable({
    initialWidth: builderRailWidth,
    minWidth: 320,
    maxWidth: builderRailMaxWidth,
    onWidthChange: setSubSidebarWidth,
  })
  // Any Knowledge sub-route (document, folder, GitHub changes) replaces the
  // live preview in the main area.
  const hasSelectedContent = pathname.startsWith("/knowledge/")
  // A single document (not a folder or the GitHub changes review) is open.
  const hasOpenDocument =
    hasSelectedContent &&
    !pathname.startsWith("/knowledge/changes") &&
    !pathname.startsWith("/knowledge/folder/")
  // The open document's id, so the frame's nav rail can highlight it.
  const openDocumentId = hasOpenDocument
    ? decodeURIComponent(pathname.slice("/knowledge/".length).split("/")[0] ?? "")
    : undefined
  // Portal doc links (public slug or id) → document id, from the rail the
  // frame already renders, so opening one needs no lookup request.
  const documentIdByPortalRef = useMemo(() => {
    const map = new Map<string, string>()
    const visit = (group: SidebarGroup): void => {
      for (const child of group.children ?? []) visit(child)
      for (const item of group.items) {
        map.set(item.id, item.id)
        const ref = portalDocRefFromHref(item.href, PORTAL_REF_PARSE_ORIGIN)
        if (ref) map.set(ref, item.id)
      }
    }
    layout?.sidebar?.groups.forEach(visit)
    return map
  }, [layout?.sidebar])
  // Toolbar element the open document's controls (save status, version
  // history) portal into, in place of the portal version menu, so the editor
  // in the preview frame carries no toolbar of its own.
  const [documentControlsSlot, setDocumentControlsSlot] =
    useState<HTMLDivElement | null>(null)

  useEffect(() => {
    return () => {
      if (savedStatusTimeoutRef.current !== null) {
        clearTimeout(savedStatusTimeoutRef.current)
      }
      if (autosaveTimerRef.current !== null) {
        clearTimeout(autosaveTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!dirty) return

    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warnBeforeUnload)
    return () => window.removeEventListener("beforeunload", warnBeforeUnload)
  }, [dirty])

  // Seed/reset the buffer by reconciling during render. `syncKey` changes on
  // workspace switch OR when a new draft version loads (e.g. after publish/
  // rollback revalidates); `syncedKey` tracks which key the buffer reflects.
  // When they diverge we adopt the freshly-loaded draft, dropping in-flight
  // edits for the prior key — exactly the reset semantics we want on a switch.
  const activeDraft = draft?.projectSlug === selectedProjectSlug ? draft : null
  const draftVersion = activeDraft?.version ?? null
  const currentScope = activeDraft ? activeDraft.scope : activeProject?.scope ?? null
  const currentScopeKey = scopeKey(currentScope)
  const syncKey = `${workspaceId ?? ""}:${selectedProjectSlug ?? ""}:${draftVersion ?? ""}:${currentScopeKey}`
  const [syncedKey, setSyncedKey] = useState<string | null>(null)
  if (activeDraft?.spec && syncKey !== syncedKey) {
    layoutRevisionRef.current += 1
    savedLayoutRevisionRef.current = layoutRevisionRef.current
    latestLayoutRef.current = activeDraft.spec
    setSyncedKey(syncKey)
    setLayout(activeDraft.spec)
    setDirty(false)
    setSharedHeaderDirty(false)
    setSharedFooterDirty(false)
    setSaveState("idle")
    setSavedStatusVisible(false)
    setScopeState("idle")
    setPathState("idle")
    setActionError(null)
    setAppearance(appearanceFromTheme(activeDraft.spec))
  }
  // Editing while a historical version is previewed would show the old layout
  // over fresh edits, so the first edit snaps the preview back to the draft.
  if (previewVersion !== null && dirty) {
    setPreviewVersion(null)
  }

  // Version browsing is per project: switching projects (or workspaces) drops
  // back to that project's draft rather than carrying a version number that
  // belongs to a different history.
  const versionScopeKey = `${workspaceId ?? ""}:${selectedProjectSlug ?? ""}`
  const [versionScopedTo, setVersionScopedTo] = useState<string | null>(null)
  if (versionScopeKey !== versionScopedTo) {
    setVersionScopedTo(versionScopeKey)
    if (previewVersion !== null) setPreviewVersion(null)
  }

  const leaveGuard = useUnsavedChangesGuard({
    enabled: dirty,
    onSave: handleSave,
    onDiscard: discardUnsavedCustomizationChanges,
  })

  // Custom-flow generation: once the freshly-created project's draft has loaded,
  // generate the portal from the user's description, persist it, and apply it to
  // the buffer. The ref guarantees a single run per slug even as the effect
  // re-evaluates on draft revalidation; the full-screen loader stays up until
  // this finishes (success or error).
  const customBuildRef = useRef<string | null>(null)
  useEffect(() => {
    const pending = pendingCustomBuild
    if (!pending) return
    if (!activeDraft || activeDraft.projectSlug !== pending.slug) return
    if (customBuildRef.current === pending.slug) return

    customBuildRef.current = pending.slug
    const seedLayout = activeDraft.spec
    void (async () => {
      try {
        const result = await generatePortalDraft({
          layout: seedLayout,
          message: pending.description,
          projectSlug: pending.slug,
        })
        await savePortalDraft(result.layout, pending.slug)
        layoutRevisionRef.current += 1
        savedLayoutRevisionRef.current = layoutRevisionRef.current
        latestLayoutRef.current = result.layout
        setLayout(result.layout)
        setDirty(false)
        setSharedHeaderDirty(false)
        setSharedFooterDirty(false)
        setAppearance(appearanceFromTheme(result.layout))
        setPreviewReloadKey((key) => key + 1)
        await mutate()
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : "Could not generate the portal.",
        )
      } finally {
        customBuildRef.current = null
        setPendingCustomBuild(null)
        setBuilding(null)
      }
    })()
  }, [pendingCustomBuild, activeDraft, mutate])

  function clearSavedConfirmation(): void {
    if (savedStatusTimeoutRef.current !== null) {
      clearTimeout(savedStatusTimeoutRef.current)
      savedStatusTimeoutRef.current = null
    }
    setSavedStatusVisible(false)
  }

  function clearAutosaveTimer(): void {
    if (autosaveTimerRef.current === null) return
    clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = null
  }

  function showSavedConfirmation(): void {
    if (savedStatusTimeoutRef.current !== null) {
      clearTimeout(savedStatusTimeoutRef.current)
    }
    setSavedStatusVisible(true)
    savedStatusTimeoutRef.current = setTimeout(() => {
      savedStatusTimeoutRef.current = null
      setSavedStatusVisible(false)
    }, 3000)
  }

  // Core save: persist the draft and any workspace-wide header/footer edits,
  // then refresh the server-rendered preview. Saves are serialized so an older,
  // slower request can never land after a newer edit and overwrite it.
  async function persistLayout(
    next: PortalLayout,
    {
      adopt,
      revision,
      saveSharedHeader,
      saveSharedFooter,
    }: {
      adopt: boolean
      revision: number
      saveSharedHeader: boolean
      saveSharedFooter: boolean
    },
  ): Promise<boolean> {
    // A customization can arrive while a previous autosave is still in flight.
    // Wait for it before writing the newer full-layout snapshot.
    while (savePromiseRef.current) {
      await savePromiseRef.current
    }

    clearSavedConfirmation()
    setActionError(null)
    setSaveState("saving")

    const savePromise = (async (): Promise<boolean> => {
      try {
        const sharedChromeDirty = saveSharedHeader || saveSharedFooter
        const [result, sharedChromeResult] = await Promise.all([
          savePortalDraft(next, selectedProjectSlug ?? undefined),
          sharedChromeDirty
            ? updateWorkspacePortalChrome({
                ...(saveSharedHeader
                  ? {
                      header: {
                        search: next.header.search,
                        navLinks: next.theme.navLinks,
                        cta: next.theme.cta,
                        itemOrder: next.header.itemOrder,
                        languagePlacement: next.header.languagePlacement,
                      },
                    }
                  : {}),
                ...(saveSharedFooter
                  ? {
                      footer: {
                        columns: next.footer?.columns,
                        social: next.footer?.social,
                        note: next.footer?.note,
                      },
                    }
                  : {}),
              })
            : Promise.resolve(null),
        ])
        if (
          sharedChromeResult &&
          (!sharedChromeResult.ok || !sharedChromeResult.workspace)
        ) {
          throw new Error(
            sharedChromeResult.error || "Failed to save the shared header/footer",
          )
        }
        if (sharedChromeResult?.workspace) {
          await mutateWorkspace(sharedChromeResult.workspace, false)
        }

        savedLayoutRevisionRef.current = Math.max(
          savedLayoutRevisionRef.current,
          revision,
        )
        const savedLatestLayout = layoutRevisionRef.current === revision
        if (savedLatestLayout) {
          latestLayoutRef.current = result.spec
          if (adopt) setLayout(result.spec)
          setDirty(false)
          setSharedHeaderDirty(false)
          setSharedFooterDirty(false)
          setSaveState("saved")
          showSavedConfirmation()
        } else {
          // A newer edit arrived while this request was in flight. Keep the
          // buffer dirty; returning to idle schedules the next autosave.
          setSaveState("idle")
        }
        // Reload in the same batch that clears `dirty`, so the preview's
        // pending loader hands straight off to the reload skeleton with no
        // frame of stale content in between.
        setPreviewReloadKey((k) => k + 1)
        // Keep Publish/Revert state in sync immediately instead of briefly
        // hiding Publish while the follow-up GET revalidates.
        await mutate(result as PortalDraftResponse, { revalidate: false })
        await Promise.all([mutate(), mutateProjects(), mutateVersions()])
        return true
      } catch (err) {
        setDirty(true)
        // If the failed request is already stale, immediately let the newer
        // buffered layout retry through the autosave effect. Otherwise retain
        // an actionable error state until the user edits again or retries.
        setSaveState(layoutRevisionRef.current === revision ? "error" : "idle")
        setActionError(err instanceof Error ? err.message : "Failed to save draft")
        return false
      }
    })()

    savePromiseRef.current = savePromise
    try {
      return await savePromise
    } finally {
      if (savePromiseRef.current === savePromise) {
        savePromiseRef.current = null
      }
    }
  }

  function stageLayoutEdit(next: PortalLayout): number {
    layoutRevisionRef.current += 1
    latestLayoutRef.current = next
    setLayout(next)
    setDirty(true)
    // Do not mask an in-flight save. Its completion will either mark this
    // revision saved or return to idle and queue the newer snapshot.
    setSaveState((current) => (current === "saving" ? current : "idle"))
    setActionError(null)
    clearSavedConfirmation()
    return layoutRevisionRef.current
  }

  // Manual customization edits update the local buffer immediately. The
  // autosave effect below persists them after a short quiet period.
  function applyLayout(next: PortalLayout): void {
    if (layout?.theme.appearance !== next.theme.appearance) {
      setAppearance(appearanceFromTheme(next))
    }
    stageLayoutEdit(next)
  }

  function applySharedHeaderLayout(next: PortalLayout): void {
    stageLayoutEdit(next)
    setSharedHeaderDirty(true)
  }

  function applySharedFooterLayout(next: PortalLayout): void {
    stageLayoutEdit(next)
    setSharedFooterDirty(true)
  }

  // Agent ("builder") edits are discrete, so save immediately and adopt the
  // normalized result. The live preview is a server-rendered iframe of the SAVED
  // draft, so this is what makes an agent change appear without a manual save.
  // Works on the default project too (an undefined slug saves its draft).
  async function applyLayoutFromAgent(next: PortalLayout): Promise<void> {
    if (layout?.theme.appearance !== next.theme.appearance) {
      setAppearance(appearanceFromTheme(next))
    }
    const revision = stageLayoutEdit(next)
    await persistLayout(next, {
      adopt: true,
      revision,
      saveSharedHeader: sharedHeaderDirty,
      saveSharedFooter: sharedFooterDirty,
    })
  }

  // The preview route renders the saved draft, so each successful autosave
  // bumps its iframe key. Rapid keystrokes are coalesced to avoid a network
  // request and full preview reload for every character.
  useEffect(() => {
    if (!dirty || !layout || saveState !== "idle" || discarding) return

    const revision = layoutRevisionRef.current
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null
      void persistLayout(layout, {
        adopt: true,
        revision,
        saveSharedHeader: sharedHeaderDirty,
        saveSharedFooter: sharedFooterDirty,
      })
    }, PORTAL_AUTOSAVE_DELAY_MS)

    return () => {
      if (autosaveTimerRef.current !== null) {
        clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
    }
    // persistLayout intentionally uses this render's project/cache scope and
    // the exact layout + shared-chrome flags captured by the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dirty,
    layout,
    saveState,
    sharedHeaderDirty,
    sharedFooterDirty,
    discarding,
  ])

  function openDocumentation(): void {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(STORED_SIDEBAR_VIEW_KEY)
    }
    setSidebarView("documentation")
  }

  function openCustomize(): void {
    setSidebarView("customize")
    setCustomizeSection("menu")
    if (!hasSelectedContent) return
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(STORED_SIDEBAR_VIEW_KEY, "customize")
    }
    router.replace(knowledgePath(activePageSlug), {
      scroll: false,
    })
  }

  function openVisibility(): void {
    setSidebarView("visibility")
    if (!hasSelectedContent) return
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(STORED_SIDEBAR_VIEW_KEY, "customize")
    }
    router.replace(knowledgePath(activePageSlug), {
      scroll: false,
    })
  }

  // Back affordance for the rail header. Inside a Customize sub-panel it returns
  // to the section menu; anywhere else it returns to the documentation root.
  function handleSidebarBack(): void {
    if (sidebarView === "customize" && customizeSection !== "menu") {
      setCustomizeSection("menu")
      return
    }
    openDocumentation()
  }

  function openBuilder(): void {
    if (!portalAiBuilderEnabled) {
      setActionError("AI portal building is disabled in this build.")
      return
    }
    setSidebarView("builder")
    if (!hasSelectedContent) return
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(STORED_SIDEBAR_VIEW_KEY, "customize")
    }
    router.replace(knowledgePath(activePageSlug), {
      scroll: false,
    })
  }

  function knowledgePath(pageSlug: string | null = null): string {
    return pageSlug
      ? `/knowledge?${new URLSearchParams({ page: pageSlug }).toString()}`
      : "/knowledge"
  }

  async function handlePageChange(pageSlug: string | null): Promise<void> {
    if (pageSlug === activePageSlug && !hasSelectedContent) return
    if (dirty || saveState === "saving") {
      const saved = await handleSave()
      if (!saved) return
    }
    setActionError(null)
    clearSavedConfirmation()
    setDocumentSearchQuery("")
    router.replace(knowledgePath(pageSlug), {
      scroll: false,
    })
  }

  // The preview navigates its own page nav, so mirror where it landed into the
  // editor URL. Unlike `handlePageChange` this never saves or blocks: the frame
  // has already moved, and `activePageSlug` only drives which page the sidebar
  // rail and the Pages panel describe.
  function handlePreviewPageChange(pageSlug: string | null): void {
    if (pageSlug === activePageSlug) return
    const known =
      pageSlug === null ||
      (layout?.pages ?? []).some((page) => page.slug === pageSlug)
    if (!known) return
    setDocumentSearchQuery("")
    router.replace(knowledgePath(pageSlug), { scroll: false })
  }

  // A doc clicked inside the rendered portal opens editable in the same frame.
  // Portal links carry the doc's public slug, so map it back to the document;
  // if that fails the click is simply ignored rather than leaving the preview.
  //
  // The rail's entries already carry their document ids, so the common case
  // resolves locally and opens in place: no resolve request and no server
  // navigation, just the document fetch (which the outlet hides behind the
  // current document). Only a link the rail doesn't know falls back to the
  // resolve endpoint.
  async function resolvePortalDocumentRef(ref: string): Promise<string | null> {
    const local = documentIdByPortalRef.get(ref)
    if (local) return local
    try {
      const response = await fetch(
        `/api/documents/resolve?${new URLSearchParams({ ref }).toString()}`,
      )
      if (!response.ok) return null
      const { id } = (await response.json()) as { id?: string }
      return id ?? null
    } catch {
      // Network failure: stay on the preview.
      return null
    }
  }

  async function handlePreviewOpenDocument(ref: string): Promise<void> {
    const id = await resolvePortalDocumentRef(ref)
    if (!id) return
    const query = activePageSlug ? `?${new URLSearchParams({ page: activePageSlug })}` : ""
    if (canOpenKnowledgeDocumentInPlace(pathname, id)) {
      openKnowledgeDocumentInPlace(id, query)
      return
    }
    router.push(`/knowledge/${encodeURIComponent(id)}${query}`)
  }

  // Hovering a rail entry warms that document so the click swaps instantly.
  function handlePreviewHoverDocument(ref: string): void {
    const id = documentIdByPortalRef.get(ref)
    if (!id) return
    void Promise.resolve(
      preload(`/api/documents/${id}`, portalDocumentFetcher),
    ).catch(() => {})
  }

  async function handleCreateProject(input: {
    slug: string
    name: string
    scope: PortalScopeEntry[] | null
  }): Promise<void> {
    if (!canCreateProject) {
      throw new Error(
        projectLimitLabel
          ? projectLimitLabel
          : "This workspace cannot create more portal projects.",
      )
    }
    const created = await createPortalProject({
      slug: input.slug,
      name: input.name,
      scope: input.scope ?? undefined,
    })
    setActionError(null)
    setSidebarView("customize")
    await mutateProjects()
    router.replace(knowledgePath(), { scroll: false })
  }

  // Custom flow: create a project scoped to the chosen folders, then defer
  // generation to the pending-build effect below (which waits for the new
  // project's draft to load so it can hand the seeded layout to the generator).
  // The full-screen loader shows from here until that effect finishes. Throws on
  // create failure so the build view keeps itself open and surfaces the error.
  async function handleCustomCreate(input: {
    slug: string
    name: string
    description: string
    scope: PortalScopeEntry[] | null
  }): Promise<void> {
    if (!portalAiBuilderEnabled) {
      throw new Error("AI portal building is disabled in this build.")
    }
    if (!canCreateProject) {
      throw new Error(
        projectLimitLabel
          ? projectLimitLabel
          : "This workspace cannot create more portal projects.",
      )
    }
    setActionError(null)
    setBuilding(input.name)
    try {
      const created = await createPortalProject({
        slug: input.slug,
        name: input.name,
        scope: input.scope ?? undefined,
      })
      setPendingCustomBuild({ slug: created.slug, description: input.description })
      setSidebarView("builder")
      setCustomCreateOpen(false)
      await mutateProjects()
      router.replace(knowledgePath(), { scroll: false })
    } catch (err) {
      setBuilding(null)
      throw err
    }
  }



  function handleDocumentSortModeChange(mode: DocumentNavSortMode): void {
    setDocumentSortMode(mode)
    setStoredBuilderDocumentSortMode(mode)
  }

  async function handleProjectPathChange(nextSlug: string): Promise<void> {
    if (!selectedProjectSlug || !activeProject) return
    if (nextSlug === selectedProjectSlug) return
    if (dirty || saveState === "saving") {
      const saved = await handleSave()
      if (!saved) return
    }

    setPathState("saving")
    setActionError(null)
    clearSavedConfirmation()
    try {
      const result = await updatePortalProjectPath(selectedProjectSlug, nextSlug)
      setSaveState("saved")
      setPathState("idle")
      setPreviewReloadKey((k) => k + 1)
      // The workspace settings name the root project by slug; refresh both so
      // the editor keeps following the renamed portal.
      await Promise.all([mutateProjects(), mutateWorkspace()])
      if (result.slug !== selectedProjectSlug) {
        router.replace(knowledgePath(activePageSlug), { scroll: false })
      }
    } catch (err) {
      setPathState("error")
      const message = err instanceof Error ? err.message : "Failed to update path"
      setActionError(message)
      throw new Error(message)
    }
  }

  function handlePageScopeChange(
    pageId: string,
    nextScope: PortalScopeEntry[] | null,
  ): void {
    if (!layout) return
    const pages = layout.pages ?? []
    const page = pages.find((candidate) => candidate.id === pageId)
    if (!page || scopeKey(page.scope) === scopeKey(nextScope)) return
    applyLayout(
      setPages(
        layout,
        pages.map((candidate) =>
          candidate.id === pageId
            ? { ...candidate, scope: nextScope }
            : candidate,
        ),
      ),
    )
  }

  async function handleScopeChange(nextScope: PortalScopeEntry[] | null): Promise<void> {
    if (!selectedProjectSlug) return
    if (scopeKey(nextScope) === currentScopeKey) return
    if (dirty || saveState === "saving") {
      const saved = await handleSave()
      if (!saved) return
    }

    setScopeState("saving")
    setActionError(null)
    clearSavedConfirmation()
    try {
      await updatePortalProjectScope(selectedProjectSlug, nextScope)
      setSaveState("saved")
      setScopeState("idle")
      setPreviewReloadKey((k) => k + 1)
      await Promise.all([
        mutate(),
        mutateProjects(),
        mutateGlobal(projectScopedApiPath("/api/documents", selectedProjectSlug)),
        mutateGlobal(projectScopedApiPath("/api/folders", selectedProjectSlug)),
      ])
    } catch (err) {
      setScopeState("error")
      setActionError(err instanceof Error ? err.message : "Failed to update scope")
    }
  }

  // Flush the latest autosave buffer. This is used by navigation safety and by
  // the error-state retry; routine editing never requires an explicit save.
  async function handleSave(): Promise<boolean> {
    clearAutosaveTimer()
    if (savePromiseRef.current) {
      await savePromiseRef.current
    }

    const next = latestLayoutRef.current
    const revision = layoutRevisionRef.current
    if (!next) return false
    if (savedLayoutRevisionRef.current >= revision) return true

    return persistLayout(next, {
      adopt: true,
      revision,
      saveSharedHeader: sharedHeaderDirty,
      saveSharedFooter: sharedFooterDirty,
    })
  }

  function discardUnsavedCustomizationChanges(): void {
    if (!activeDraft?.spec) return
    clearAutosaveTimer()
    layoutRevisionRef.current += 1
    savedLayoutRevisionRef.current = layoutRevisionRef.current
    latestLayoutRef.current = activeDraft.spec
    setLayout(activeDraft.spec)
    setDirty(false)
    setSharedHeaderDirty(false)
    setSharedFooterDirty(false)
    setSaveState("idle")
    setActionError(null)
    clearSavedConfirmation()
    setAppearance(appearanceFromTheme(activeDraft.spec))
  }

  async function handleDiscard(): Promise<void> {
    if (!selectedProjectSlug) return
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Discard this draft and revert to the published version? Unpublished edits will be lost.",
      )
    ) {
      return
    }
    clearAutosaveTimer()
    setDiscarding(true)
    setActionError(null)
    setSaveState("idle")
    clearSavedConfirmation()
    try {
      const result = await discardPortalDraft(selectedProjectSlug)
      layoutRevisionRef.current += 1
      savedLayoutRevisionRef.current = layoutRevisionRef.current
      latestLayoutRef.current = result.spec
      setLayout(result.spec)
      setDirty(false)
      setSharedHeaderDirty(false)
      setSharedFooterDirty(false)
      setAppearance(appearanceFromTheme(result.spec))
      setPreviewReloadKey((k) => k + 1)
      // Seed the draft cache with the reverted row so `divergedFromPublished`
      // (and thus the Revert button's visibility) updates immediately, without
      // waiting for the revalidating GET to land.
      await Promise.all([
        mutate(result as PortalDraftResponse, { revalidate: false }),
        mutateProjects(),
        mutateGlobal(projectScopedApiPath("/api/documents", selectedProjectSlug)),
        mutateGlobal(projectScopedApiPath("/api/folders", selectedProjectSlug)),
      ])
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to discard draft")
    } finally {
      setDiscarding(false)
    }
  }

  // Restore a saved edit into the editor; publishing remains a separate action.
  async function handleRestoreVersion(version: number): Promise<void> {
    if (!selectedProjectSlug) return
    clearAutosaveTimer()
    setRestoring(true)
    setActionError(null)
    clearSavedConfirmation()
    try {
      if (savePromiseRef.current) await savePromiseRef.current
      await restorePortalEdit(version, selectedProjectSlug)
      setPreviewVersion(null)
      setPreviewReloadKey((k) => k + 1)
      setDirty(false)
      setSharedHeaderDirty(false)
      setSharedFooterDirty(false)
      setSaveState("idle")
      // Refresh the restored editor and its new saved-history entry.
      await Promise.all([mutate(), mutateProjects(), mutateVersions()])
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to restore saved edit",
      )
    } finally {
      setRestoring(false)
    }
  }

  async function handlePublish(): Promise<boolean> {
    if (!layout || !selectedProjectSlug) return false
    if (dirty || saveState === "saving") {
      setActionError("Wait for the latest changes to finish saving before publishing.")
      return false
    }
    setPublishing(true)
    clearSavedConfirmation()
    setActionError(null)
    const workerRoute =
      workspace && activeProject
        ? cloudflareWorkerRouteForProject(
            workspace,
            activeProject,
            activeDomainRouteData?.route ?? null,
          )
        : null
    try {
      await publishPortalDraft(selectedProjectSlug)
      setSaveState("saved")
      setPreviewReloadKey((k) => k + 1)
      // Re-fetch the draft (a fresh one is seeded from the now-published spec on
      // next GET, so reflect that) plus the version list this publish extended.
      await Promise.all([mutate(), mutateProjects(), mutateVersions()])
      if (workerRoute) {
        void getCloudflareConnectorStatus(workerRoute.domain).then((status) => {
          if (
            status?.connected &&
            status.deployment?.status === "connected" &&
            status.deployment.needsDeploy
          ) {
            setCloudflareWorkerPrompt(workerRoute)
          }
        })
      }
      return true
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to publish")
      return false
    } finally {
      setPublishing(false)
    }
  }

  if (draftError || projectsError) {
    // Only a definitive 401/403 means the member lacks access. Anything else
    // (503 from the auth-timeout path, network blips) is transient — don't
    // accuse the user of missing permissions, just ask for a refresh.
    if (
      isPermissionFetchError(draftError) ||
      isPermissionFetchError(projectsError)
    ) {
      return (
        <div className="mx-auto w-full max-w-5xl px-6 py-10">
          <p className="text-sm text-destructive">
            Could not load the portal builder. You may need admin or owner access on
            this workspace.
          </p>
        </div>
      )
    }
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 px-6 py-16 text-center">
        <p className="text-sm font-medium">The portal builder didn&apos;t load</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          This is usually a brief connection hiccup. Refreshing the page normally
          fixes it.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.location.reload()}
        >
          Refresh page
        </Button>
      </div>
    )
  }

  // Custom flow in progress: a full-screen branded loader covers the builder
  // (and the transient skeleton while the new project's draft loads) until the
  // generation effect completes. Hooks above still run, so the draft loads and
  // the effect fires beneath this overlay.
  if (building !== null) {
    return <PortalBuildLoader name={building} />
  }

  // Dedicated "build from scratch" view (Custom flow). Rendered above the builder
  // chrome; it only needs the folder list + existing slugs, not a loaded draft.
  if (customCreateOpen && portalAiBuilderEnabled) {
    return (
      <PortalCustomCreateView
        existingSlugs={projects.map((project) => project.slug)}
        folders={publicScopeFolders(rawFolders ?? [])}
        onCancel={() => setCustomCreateOpen(false)}
        onBuild={handleCustomCreate}
      />
    )
  }

  // No portal yet (fresh workspace). Knowledge stays fully usable; the rail
  // offers to set up the workspace's one portal. The draft GET is never fired
  // here, so nothing auto-creates a project behind the scenes. Gated on a known
  // workspace id: while it resolves (or a switch is in flight) the projects key
  // is null, so fall through to the skeleton rather than flashing this state.
  if (mounted && workspaceId && !projectsLoading && projects.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-visible">
        <aside className="flex w-full shrink-0 flex-col overflow-hidden border-b border-border bg-background lg:w-80 lg:border-b-0 lg:border-r">
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 scrollbar-none">
            <section className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  Publish your knowledge as docs
                </p>
                <p className="text-xs text-muted-foreground">
                  Set up your workspace&apos;s portal to choose what&apos;s
                  public, customize it, and preview it here.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => setNewProjectOpen(true)}
                disabled={!canCreateProject}
                title={!canCreateProject && projectLimitLabel ? projectLimitLabel : undefined}
              >
                <PlusIcon className="size-4" />
                Set up portal
              </Button>
            </section>
            <KnowledgeSubNav className="mt-6" navProps={{ chrome: "builder" }} />
          </div>
        </aside>
        <div className="flex min-h-[calc(100svh-3.5rem)] min-w-0 flex-1 flex-col lg:min-h-0">
          {children}
        </div>
        <NewProjectDialog
          open={newProjectOpen}
          existingSlugs={[]}
          folders={publicScopeFolders(rawFolders ?? [])}
          onOpenChange={setNewProjectOpen}
          onCreate={handleCreateProject}
          onCustomStart={() => setCustomCreateOpen(true)}
          aiBuilderEnabled={portalAiBuilderEnabled}
        />
      </div>
    )
  }

  if (
    !mounted ||
    projectsLoading ||
    isLoading ||
    !layout ||
    !activeProject ||
    !activeDraft
  ) {
    return <PortalBuilderSkeleton />
  }

  // Portal base path (model B): the default project lives at the workspace root
  // (/p/<workspace>), a named project under /p/<workspace>/<project>.
  const previewSlug =
    !activeProject.isDefault && workspace?.slug
      ? `${workspace.slug}/${activeProject.slug}`
      : workspace?.slug ?? activeProject.slug ?? "preview"
  const workspaceDomain =
    portalAddressScope === "workspace" &&
    getPortalAddressMode(workspace?.settings) !== "bread"
      ? getKbCustomDomain(workspace?.settings)
      : ""
  const publicPortalHref =
    portalAddressScope === "project" && activeDomainRouteLoading
      ? undefined
      : portalProjectUrl({
          origin: typeof window === "undefined" ? "" : window.location.origin,
          workspaceSlug: workspace?.slug ?? activeProject.slug,
          projectSlug: activeProject.slug,
          isDefault: activeProject.isDefault,
          workspaceDomain,
          projectRoute: activeDomainRouteData?.route,
        })
  const scopeFolders = publicScopeFolders(rawFolders ?? [])
  const selectedScope = activeDraft.scope
  const inheritedPageStartingScope =
    selectedScope ?? explicitWorkspacePortalScope(scopeFolders)
  // Portal publishing is derived exclusively from this project's draft. A
  // document's standalone Publish action does not participate in this state.
  // An unpublished project has an initial portal draft to publish; afterwards,
  // Publish only reappears for local or saved portal-specific changes.
  const hasPortalChanges =
    dirty ||
    activeDraft.divergedFromPublished ||
    !activeProject.publishedVersion
  const canDiscardPortalChanges =
    Boolean(activeProject.publishedVersion) &&
    (dirty || activeDraft.divergedFromPublished)

  // Rail header: the workspace has one portal, shown as plain "Knowledge".
  const switcherNode = (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-sm font-medium">Knowledge</span>
      {dirty ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-amber-500"
          aria-label="Unsaved portal changes"
        />
      ) : null}
    </div>
  )
  // Autosave runs on every keystroke, so a spinner here spun almost constantly
  // and read as the editor being busy rather than as a save being routine. The
  // in-progress state is now silent; only its two OUTCOMES surface — a failure
  // (which needs the retry affordance, since nothing else recovers the edit)
  // and a brief "Saved" confirmation.
  const autosaveStatusNode = saveState === "error" && dirty ? (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={() => void handleSave()}
      className="shrink-0 text-destructive"
    >
      <AlertCircle className="size-3.5" />
      Retry autosave
    </Button>
  ) : null

  return (
    <DocumentControlsSlotProvider value={documentControlsSlot}>
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-visible">
      {/* Knowledge Base rail */}
      <aside
        className={cn(
          "relative flex w-full shrink-0 flex-col overflow-hidden border-border bg-background",
          !isDragging && "transition-[height,width] duration-300",
          railOpen
            ? "h-[min(72vh,720px)] border-b lg:h-auto lg:w-[var(--kb-rail-width)] lg:border-b-0 lg:border-r"
            : "h-0 border-b-0 lg:h-auto lg:w-0 lg:border-r-0",
        )}
        style={railStyle}
      >
        {railOpen ? (
          <>
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
              {sidebarView !== "documentation" ? (
                <>
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Back"
                      onClick={handleSidebarBack}
                      className="shrink-0 text-muted-foreground"
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    <div className="min-w-0 flex-1">{switcherNode}</div>
                  </div>
                  {autosaveStatusNode}
                </>
              ) : (
                <div className="min-w-0 flex-1">{switcherNode}</div>
              )}
              {previewVersion === null && hasPortalChanges ? (
                <PublishDialog
                  brandName={layout.theme.brandName}
                  dirty={dirty}
                  publishing={publishing}
                  onConfirm={handlePublish}
                  disabled={!hasPortalChanges || dirty || saveState === "saving" || discarding}
                  className="shrink-0 px-3"
                />
              ) : null}
            </div>

            {sidebarView === "documentation" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 scrollbar-none">
                <section className="space-y-4">
                  <SidebarSectionLabel>Manage</SidebarSectionLabel>
                  <div className="space-y-1">
                    <ManageButton
                      icon={ExternalLink}
                      label="Open"
                      href={publicPortalHref}
                    />
                    <ManageButton
                      icon={Eye}
                      label="Visibility"
                      onClick={openVisibility}
                    />
                    <ManageButton
                      icon={Paintbrush}
                      label="Customize"
                      onClick={openCustomize}
                    />
                    {portalAiBuilderEnabled ? (
                      <ManageButton
                        icon={Blocks}
                        label="Builder"
                        onClick={openBuilder}
                      />
                    ) : null}
                  </div>
                </section>

                <KnowledgeSubNav
                  className="mt-8"
                  navProps={{
                    chrome: "builder",
                    searchQuery: documentSearchQuery,
                    onSearchQueryChange: setDocumentSearchQuery,
                    sortMode: documentSortMode,
                    onSortModeChange: handleDocumentSortModeChange,
                    onFoldersReordered: () => {
                      void mutateFolders()
                      setPreviewReloadKey((k) => k + 1)
                    },
                  }}
                />
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {actionError ? (
                  <p className="mx-4 mt-4 shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {actionError}
                  </p>
                ) : null}

                {sidebarView === "visibility" ? (
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 scrollbar-none">
                    {workspace && activeProject ? (
                      <PortalVisibilityControls
                        workspace={workspace}
                        projectSlug={activeProject.slug}
                        visibility={activeProject.visibility}
                        onVisibilityChanged={mutateProjects}
                        brandName={layout.theme.brandName}
                        isPublished={Boolean(activeProject.publishedVersion)}
                        hasPublishableChanges={hasPortalChanges}
                        canDiscard={canDiscardPortalChanges}
                        publishing={publishing}
                        discarding={discarding}
                        dirty={dirty}
                        saving={saveState === "saving"}
                        onPublish={handlePublish}
                        onDiscard={() => void handleDiscard()}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Select a project to manage its visibility.
                      </p>
                    )}
                  </div>
                ) : sidebarView === "customize" ? (
                  <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 scrollbar-none">
                    {customizeSection === "menu" ? (
                      <>
                        <SidebarSectionLabel>Appearance</SidebarSectionLabel>
                        <div className="mb-4 mt-1 space-y-0.5">
                          <CustomizeMenuRow
                            icon={Paintbrush}
                            label="Branding & theme"
                            description="Logo, colors, font, credit"
                            onClick={() => setCustomizeSection("appearance")}
                          />
                          <CustomizeMenuRow
                            icon={PanelTop}
                            label="Header"
                            description="Search, links, and action button"
                            onClick={() => setCustomizeSection("header")}
                          />
                          <CustomizeMenuRow
                            icon={PanelBottom}
                            label="Footer"
                            description="Columns, social links, import"
                            onClick={() => setCustomizeSection("footer")}
                          />
                        </div>

                        <SidebarSectionLabel>Features</SidebarSectionLabel>
                        <div className="mb-4 mt-1 space-y-0.5">
                          <CustomizeMenuRow
                            icon={Bot}
                            label="AI assistant"
                            description="Header or corner popout"
                            onClick={() => setCustomizeSection("assistant")}
                          />
                          <CustomizeMenuRow
                            icon={Languages}
                            label="Languages"
                            description={
                              workspace?.portal_translations_enabled === true
                                ? "Translation and selector position"
                                : "Available on Business"
                            }
                            onClick={() => setCustomizeSection("languages")}
                          />
                        </div>

                        <SidebarSectionLabel>Content</SidebarSectionLabel>
                        <div className="mb-4 mt-1 space-y-0.5">
                          <CustomizeMenuRow
                            icon={FileText}
                            label="Pages"
                            description="Create and configure portal pages"
                            onClick={() => setCustomizeSection("pages")}
                          />
                          {workspace && activeProject ? (
                            <CustomizeMenuRow
                              icon={Link2}
                              label="Project URL"
                              description="Domain and path"
                              onClick={() => setCustomizeSection("path")}
                            />
                          ) : null}
                          <CustomizeMenuRow
                            icon={Folder}
                            label="Included docs"
                            description="Choose content for documents and pages"
                            onClick={() => setCustomizeSection("scope")}
                          />
                        </div>

                      </>
                    ) : customizeSection === "appearance" ? (
                      <CustomizeSubPanel title="Branding & theme">
                        <PortalThemeControls
                          layout={layout}
                          onLayoutChange={applyLayout}
                          workspaceLogoUrl={
                            workspace?.settings?.kb_brand_logo_url ||
                            workspace?.icon_url ||
                            undefined
                          }
                          canRemoveBreadBranding={
                            workspace?.portal_branding_removal_enabled === true
                          }
                        />
                      </CustomizeSubPanel>
                    ) : customizeSection === "footer" ? (
                      <CustomizeSubPanel title="Footer">
                        <PortalFooterControls
                          key={`${activeProject?.id ?? "default"}:${portalChromeScope}`}
                          layout={layout}
                          onLayoutChange={applyLayout}
                          onSharedLayoutChange={applySharedFooterLayout}
                          chromeScope={portalChromeScope}
                        />
                      </CustomizeSubPanel>
                    ) : customizeSection === "header" ? (
                      <CustomizeSubPanel title="Header">
                        <PortalHeaderControls
                          key={`${activeProject?.id ?? "default"}:${portalChromeScope}`}
                          layout={layout}
                          onLayoutChange={applyLayout}
                          onSharedLayoutChange={applySharedHeaderLayout}
                          chromeScope={portalChromeScope}
                        />
                      </CustomizeSubPanel>
                    ) : customizeSection === "assistant" ? (
                      <CustomizeSubPanel title="AI assistant">
                        <PortalAiAssistantControls
                          key={activeProject?.id ?? "default"}
                          layout={layout}
                          onLayoutChange={applyLayout}
                          canUseAi={workspace?.portal_ai_builder_enabled === true}
                        />
                      </CustomizeSubPanel>
                    ) : customizeSection === "languages" ? (
                      <CustomizeSubPanel title="Languages">
                        <PortalLanguageControls
                          key={`${activeProject?.id ?? "default"}:${portalChromeScope}`}
                          layout={layout}
                          onLayoutChange={applyLayout}
                          onSharedLayoutChange={applySharedHeaderLayout}
                          chromeScope={portalChromeScope}
                          canUseTranslations={
                            workspace?.portal_translations_enabled === true
                          }
                        />
                      </CustomizeSubPanel>
                    ) : customizeSection === "path" ? (
                      <CustomizeSubPanel title="Project URL">
                        {workspace && activeProject ? (
                          <ProjectPathControl
                            workspace={workspace}
                            project={activeProject}
                            projects={projects}
                            pathState={pathState}
                            onPathChange={handleProjectPathChange}
                          />
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            Select a project to edit its URL path.
                          </p>
                        )}
                      </CustomizeSubPanel>
                    ) : customizeSection === "pages" ? (
                      <CustomizeSubPanel title="Pages">
                        <PortalPagesControls
                          key={activeProject?.id ?? "default"}
                          layout={layout}
                          activePageSlug={activePageSlug}
                          onLayoutChange={applyLayout}
                          onActivePageChange={(slug) =>
                            void handlePageChange(slug)
                          }
                        />
                      </CustomizeSubPanel>
                    ) : customizeSection === "scope" ? (
                      <CustomizeSubPanel title="Included docs">
                        <div className="space-y-4">
                          <div className="space-y-1.5 border-b border-border pb-4">
                            <Label className="text-[11px]">Portal page</Label>
                            <PageSwitcher
                              pages={layout.pages ?? []}
                              activeSlug={activePageSlug}
                              disabled={
                                saveState === "saving" || scopeState === "saving"
                              }
                              onChange={(slug) => void handlePageChange(slug)}
                            />
                            <p className="text-[11px] leading-relaxed text-muted-foreground">
                              Select Documents or a page, then choose the content it
                              includes.
                            </p>
                          </div>
                          {activePage?.scope === null ? (
                            <div className="rounded-lg border border-border bg-muted/20 p-3">
                              <div className="flex items-start gap-2">
                                <Home className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-medium text-foreground">
                                    {activePage.title} follows Documents
                                  </p>
                                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                                    Changes to Documents&apos; included docs apply to
                                    this page automatically.
                                  </p>
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-3 w-full"
                                disabled={saveState === "saving"}
                                onClick={() =>
                                  handlePageScopeChange(
                                    activePage.id,
                                    inheritedPageStartingScope,
                                  )
                                }
                              >
                                Choose different docs
                              </Button>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {activePage ? (
                                <button
                                  type="button"
                                  disabled={saveState === "saving"}
                                  onClick={() =>
                                    handlePageScopeChange(activePage.id, null)
                                  }
                                  className="text-[11px] font-medium text-primary hover:underline disabled:opacity-60"
                                >
                                  Use the same docs as Documents
                                </button>
                              ) : null}
                              <ProjectScopeControl
                                key={activePage?.id ?? "__home__"}
                                folders={scopeFolders}
                                allFolders={rawFolders ?? []}
                                scope={activePage ? activePage.scope : selectedScope}
                                scopeState={
                                  activePage
                                    ? saveState === "saving"
                                      ? "saving"
                                      : saveState === "error"
                                        ? "error"
                                        : "idle"
                                    : scopeState
                                }
                                onScopeChange={(nextScope) => {
                                  if (activePage) {
                                    handlePageScopeChange(activePage.id, nextScope)
                                  } else {
                                    void handleScopeChange(nextScope)
                                  }
                                }}
                                isLoading={foldersLoading}
                                variant="panel"
                                title={
                                  activePage
                                    ? `${activePage.title} content`
                                    : "Documents"
                                }
                                description={
                                  activePage
                                    ? "This selection only affects this page and can include public content that is outside the main document collection."
                                    : "This selection controls the folders and documents available in the main document collection."
                                }
                                rootFieldLabel={
                                  activePage ? "Page root" : "Document root"
                                }
                                targetLabel={activePage ? "page" : "document collection"}
                                workspaceRootMode={
                                  activePage ? "custom" : "include-all"
                                }
                                // The rail already scrolls; an inner scroller would
                                // squeeze the tree into a sliver of the room it has.
                                listClassName="max-h-none"
                              />
                            </div>
                          )}
                        </div>
                      </CustomizeSubPanel>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-4">
                    <PortalAgentPanel
                      layout={layout}
                      onLayoutChange={(next) => void applyLayoutFromAgent(next)}
                      onRestoreCheckpoint={(next) => void applyLayoutFromAgent(next)}
                      projectSlug={selectedProjectSlug}
                      workspaceId={workspaceId}
                      className="min-h-0 flex-1"
                    />
                  </div>
                )}
              </div>
            )}

            <div
              ref={handleRef}
              className={cn(
                "absolute right-0 top-0 z-10 hidden h-full w-1 cursor-col-resize lg:block",
                "before:absolute before:inset-y-0 before:-left-2 before:-right-2 before:content-['']",
                isDragging && "bg-primary/30",
              )}
            />
          </>
        ) : null}
      </aside>

      <div className="flex min-h-[calc(100svh-3.5rem)] min-w-0 flex-1 flex-col lg:min-h-0">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Documents, folders and GitHub changes open INSIDE the preview
              frame (in place of the rendered portal) rather than replacing
              it, so the toolbar, Publish and device switch never go away. */}
          <PortalLivePreview
              content={hasOpenDocument ? (
                <PortalEditorExitProvider
                  value={() => void handlePageChange(activePageSlug)}
                >
                  <PortalEditorDocument
                    layout={layout}
                    appearance={appearance}
                    mobile={device === "mobile"}
                    allowPoweredByRemoval={workspace?.portal_branding_removal_enabled === true}
                  >
                    {children}
                  </PortalEditorDocument>
                </PortalEditorExitProvider>
              ) : hasSelectedContent ? children : undefined}
              contentHeader={
                hasSelectedContent ? (
                  <PortalEditorFrameHeader
                    layout={layout}
                    previewSlug={previewSlug}
                    appearance={appearance}
                    onAppearanceChange={setAppearance}
                    onOpenDocument={(ref) => void handlePreviewOpenDocument(ref)}
                    onOpenPage={(slug) => void handlePageChange(slug)}
                    mobile={device === "mobile"}
                  />
                ) : undefined
              }
              // The live portal hides its nav rail on phones (it becomes a
              // drawer), so the mobile editor frame leaves it out too. The
              // inline editor can't rely on the rail's own `lg:` breakpoint:
              // that follows the builder window, not the phone frame.
              contentSidebar={
                hasOpenDocument && device !== "mobile" ? (
                  <PortalEditorFrameSidebar
                    layout={layout}
                    appearance={appearance}
                    activeDocumentId={openDocumentId}
                    onHoverDocument={handlePreviewHoverDocument}
                    onOpenDocument={(ref) => void handlePreviewOpenDocument(ref)}
                    onOpenPage={(slug) => void handlePageChange(slug)}
                  />
                ) : undefined
              }
              previewSlug={previewSlug}
              projectSlug={selectedProjectSlug}
              pageSlug={activePageSlug}
              version={previewVersion}
              surface={
                activePage && portalPagePresentation(activePage) === "changelog"
                  ? "changelog"
                  : "default"
              }
              appearance={appearance}
              device={device}
              reloadKey={previewReloadKey}
              // The iframe renders the SAVED draft, so it is stale from the
              // first edit until the autosave lands. Show the loader for that
              // whole window (not after a failed save, which surfaces Retry).
              dirty={saveState !== "error" && (dirty || saveState === "saving")}
              onAppearanceChange={setAppearance}
              onDeviceChange={setDevice}
              onPageChange={handlePreviewPageChange}
              onOpenDocument={(ref) => void handlePreviewOpenDocument(ref)}
              actions={
                <BuilderHeaderActions
                  savedStatusVisible={savedStatusVisible}
                  lastEditedAt={activeProject.updatedAt}
                  publishing={publishing}
                  discarding={discarding}
                  versions={portalVersions}
                  versionsLoading={versionsLoading}
                  previewVersion={previewVersion}
                  restoring={restoring}
                  onSelectVersion={setPreviewVersion}
                  onRestoreVersion={(version) =>
                    void handleRestoreVersion(version)
                  }
                  documentControlsRef={
                    hasOpenDocument ? setDocumentControlsSlot : undefined
                  }
                />
              }
              className="h-full"
            />
        </div>
      </div>

      <CloudflareWorkerUpdateDialog
        open={cloudflareWorkerPrompt !== null}
        domain={cloudflareWorkerPrompt?.domain ?? ""}
        pathPrefix={cloudflareWorkerPrompt?.pathPrefix ?? ""}
        projectSlug={cloudflareWorkerPrompt?.projectSlug ?? ""}
        onOpenChange={(open) => {
          if (!open) setCloudflareWorkerPrompt(null)
        }}
        onUpdated={() => setCloudflareWorkerPrompt(null)}
      />

      <AlertDialog
        open={leaveGuard.promptOpen}
        onOpenChange={(open) => {
          if (!open) leaveGuard.cancelLeave()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finish saving before leaving?</AlertDialogTitle>
            <AlertDialogDescription>
              Your latest portal changes have not finished autosaving yet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={leaveGuard.cancelLeave}>
              Stay here
            </AlertDialogCancel>
            <Button
              variant="outline"
              onClick={leaveGuard.discardLeave}
              disabled={saveState === "saving"}
            >
              Discard &amp; leave
            </Button>
            <AlertDialogAction onClick={() => void leaveGuard.confirmLeave()}>
              Finish saving &amp; leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </DocumentControlsSlotProvider>
  )
}
