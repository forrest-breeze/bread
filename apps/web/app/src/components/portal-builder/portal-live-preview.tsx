"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Monitor, Smartphone } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingBar } from "@/components/ui/loading-bar"
import { PreviewMeshBackground } from "@/components/portal-builder/preview-mesh-background"
import {
  createPortalPreviewThemeMessage,
  isPortalPreviewThemeMessage,
  isPortalPreviewThemeReadyMessage,
} from "@/lib/portal/preview-theme-message"
import { isPortalPreviewPageMessage } from "@/lib/portal/preview-page-message"

// ---------------------------------------------------------------------------
// Live portal preview.
//
// Embeds the server-rendered `/portal-preview` route (the active workspace's
// DRAFT layout) in a same-origin iframe, so the preview is the REAL public
// portal output — including the callout/rich-text/shiki blocks that render via
// the server-only `public-kb-render` and therefore cannot be rendered in a
// client component. The editor bumps `reloadKey` after each draft save to
// refresh the frame, so the preview reflects the saved draft.
//
// `appearance` and `device` are presentational state owned by the editor.
// Appearance is forwarded to the preview route; device changes the iframe's
// actual viewport so the production responsive breakpoints—not preview-only
// conditionals—decide which navigation and layout are visible.
// ---------------------------------------------------------------------------

export type PreviewAppearance = "light" | "dark"
export type PreviewDevice = "desktop" | "mobile"
export type PreviewSurface = "default" | "changelog"

const PREVIEW_FRAMES: Record<
  PreviewDevice,
  { width: number; height: number }
> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 430, height: 844 },
}

/** Bezel thickness (px, unscaled) around the mobile preview screen. */
const PHONE_BEZEL = 10

interface PortalLivePreviewProps {
  /** Slug used for in-portal hrefs (search action, brand link). Cosmetic in preview. */
  previewSlug: string
  /** Project slug whose saved draft should be rendered by /portal-preview. */
  projectSlug: string | null
  /** Project-local page rendered in the iframe; null renders Home. */
  pageSlug: string | null
  /**
   * Historical published version to render instead of the draft. null (the
   * default) previews the working draft — the editor's normal state.
   */
  version?: number | null
  /** Content shape used while the server-rendered iframe is loading. */
  surface: PreviewSurface
  appearance: PreviewAppearance
  device: PreviewDevice
  /** Bumped by the editor after each successful draft save to reload the iframe. */
  reloadKey: number
  /** True when the buffer has unsaved edits the preview doesn't yet reflect. */
  dirty: boolean
  onAppearanceChange: (appearance: PreviewAppearance) => void
  onDeviceChange: (device: PreviewDevice) => void
  /** Fired when the preview navigates its own page nav; null is the portal home. */
  onPageChange?: (pageSlug: string | null) => void
  actions?: React.ReactNode
  /**
   * An in-app editor (document, folder, changes) to show inside the preview
   * frame instead of the rendered portal. The frame, floating actions and
   * device switch stay put so editing never feels like leaving the preview.
   */
  content?: React.ReactNode
  /** Portal chrome drawn above `content` inside the frame. */
  contentHeader?: React.ReactNode
  /** Portal nav rail drawn beside `content` inside the frame. */
  contentSidebar?: React.ReactNode
  /**
   * A document link was clicked inside the rendered portal. `ref` is the
   * link's last path segment (the doc's public slug, or its id). When set, the
   * click opens the doc for editing instead of navigating the frame to the
   * read-only public page.
   */
  onOpenDocument?: (ref: string) => void
  className?: string
}

/** The doc ref from a portal doc link (`…/doc/<ref>`), or null. */
export function portalDocRefFromHref(href: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  const match = /\/doc\/([^/]+)\/?$/.exec(url.pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

function PortalPreviewSkeleton({
  appearance,
  device,
  surface,
}: {
  appearance: PreviewAppearance
  device: PreviewDevice
  surface: PreviewSurface
}): React.ReactElement {
  const mobile = device === "mobile"
  const changelog = surface === "changelog"

  return (
    <div
      role="status"
      aria-label={changelog ? "Loading changelog preview" : "Loading portal preview"}
      data-preview-surface={surface}
      className={cn(
        appearance,
        "pointer-events-none absolute inset-0 z-10 flex flex-col bg-background text-foreground",
      )}
    >
      <span className="sr-only">Loading portal preview</span>

      <div
        className={cn(
          "flex shrink-0 items-center gap-3 border-b border-border/70",
          mobile ? "h-14 px-4" : "h-16 px-6",
        )}
      >
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className={cn("h-3.5", mobile ? "w-20" : "w-28")} />
        {!mobile && (
          <div className="ml-auto flex items-center gap-5">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12" />
          </div>
        )}
        <Skeleton className={cn("ml-auto h-7 rounded-md", mobile ? "w-16" : "w-20")} />
      </div>

      {changelog ? (
        <main className={cn("min-h-0 flex-1 overflow-hidden", mobile ? "px-5 py-8" : "px-10 py-12")}>
          <div className="mx-auto w-full max-w-5xl">
            <Skeleton className={cn("h-8", mobile ? "w-4/5" : "w-2/5")} />
            <Skeleton className="mt-4 h-3.5 w-full max-w-2xl" />
            <Skeleton className="mt-2 h-3.5 w-4/5 max-w-xl" />

            <div className={cn("mt-10 border-t border-border/70", !mobile && "mt-14")}>
              {(mobile ? [0, 1, 2] : [0, 1, 2, 3]).map((index) => (
                <div
                  key={index}
                  className={cn(
                    "grid gap-3 border-b border-border/70 py-5",
                    !mobile && "grid-cols-[6rem_minmax(0,1fr)] gap-8 py-7",
                  )}
                >
                  <Skeleton className="h-3 w-14" />
                  <div>
                    <Skeleton className={cn("h-5", mobile ? "w-5/6" : "w-3/5")} />
                    <Skeleton className="mt-3 h-3 w-full max-w-2xl" />
                    <Skeleton className="mt-2 h-3 w-4/5 max-w-xl" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!mobile && (
            <aside className="w-[22%] shrink-0 space-y-3 border-r border-border/70 px-5 py-7">
              <Skeleton className="mb-5 h-3 w-2/3" />
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-2/3" />
            </aside>
          )}

          <main className={cn("min-w-0 flex-1", mobile ? "px-5 py-8" : "px-8 py-10")}>
            <div className="mx-auto w-full max-w-3xl">
              <Skeleton className={cn("h-7", mobile ? "w-4/5" : "w-1/2")} />
              <Skeleton className="mt-4 h-3.5 w-full max-w-xl" />
              <Skeleton className="mt-2 h-3.5 w-4/5 max-w-lg" />
              <div
                className={cn(
                  "mt-8 grid gap-3",
                  mobile ? "grid-cols-1" : "grid-cols-2 lg:grid-cols-3",
                )}
              >
                {(mobile ? [0, 1, 2] : [0, 1, 2, 3, 4, 5]).map((index) => (
                  <div
                    key={index}
                    className="space-y-3 rounded-lg border border-border/60 p-4"
                  >
                    <Skeleton className="size-6 rounded-md" />
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                ))}
              </div>
            </div>
          </main>
        </div>
      )}
    </div>
  )
}

export function PortalLivePreview({
  previewSlug,
  projectSlug,
  pageSlug,
  version = null,
  surface,
  appearance,
  device,
  reloadKey,
  dirty,
  onAppearanceChange,
  onDeviceChange,
  onPageChange,
  actions,
  content,
  contentHeader,
  contentSidebar,
  onOpenDocument,
  className,
}: PortalLivePreviewProps): React.ReactElement {
  const editing = content !== undefined && content !== null
  const fitAreaRef = useRef<HTMLDivElement>(null)
  const [fitArea, setFitArea] = useState({ width: 0, height: 0 })
  const frame = PREVIEW_FRAMES[device]
  const isPhone = device === "mobile"
  // The phone bezel sits outside the scaled screen, so reserve its thickness
  // (both sides) before fitting the viewport into the panel.
  const bezelInset = isPhone ? PHONE_BEZEL * 2 : 0
  const scale =
    fitArea.width > 0 && fitArea.height > 0
      ? Math.min(
          (fitArea.width - bezelInset) / frame.width,
          (fitArea.height - bezelInset) / frame.height,
          1,
        )
      : 1
  const scaledWidth = Math.round(frame.width * scale)
  const scaledHeight = Math.round(frame.height * scale)
  // The iframe is a same-origin server render that's expensive to reload, so the
  // light/dark swap must NOT remount it. We bake the theme into the src only when
  // the frame genuinely (re)mounts — device switch or post-save reload — and
  // otherwise flip the `.dark` class on the loaded preview's root imperatively.
  // `frameKey` deliberately excludes `appearance` so a theme toggle keeps the
  // same committed src and the iframe stays put.
  //
  // Page navigation is bidirectional: the editor can request a page, and the
  // preview's own page nav can change it from inside the frame. `pageNav.page`
  // records which page the frame is on and `pageNav.epoch` — the only page
  // input to `frameKey` — bumps solely when the EDITOR asks for a different
  // one. A page reported by the frame updates `page` without a bump, so
  // mirroring that navigation back into the editor URL doesn't reload the frame
  // that just navigated. `prop` is the last `pageSlug` we reconciled, so a frame
  // report (which lands before the editor's URL catches up) can't be mistaken
  // for an editor request.
  const [pageNav, setPageNav] = useState<{
    page: string | null
    prop: string | null
    epoch: number
  }>(() => ({ page: pageSlug, prop: pageSlug, epoch: 0 }))
  if (pageNav.prop !== pageSlug) {
    setPageNav((current) =>
      current.prop === pageSlug
        ? current
        : {
            page: pageSlug,
            prop: pageSlug,
            epoch: current.page === pageSlug ? current.epoch : current.epoch + 1,
          },
    )
  }
  const buildSrc = (themeMode: PreviewAppearance): string =>
    `/portal-preview?theme=${themeMode}` +
    `&slug=${encodeURIComponent(previewSlug)}` +
    `${projectSlug ? `&project=${encodeURIComponent(projectSlug)}` : ""}` +
    `${pageNav.page ? `&page=${encodeURIComponent(pageNav.page)}` : ""}` +
    `${version !== null ? `&version=${version}` : ""}` +
    `&v=${reloadKey}`
  const frameKey = `${device}|${reloadKey}|${previewSlug}|${projectSlug ?? ""}|${version ?? ""}|${pageNav.epoch}`
  const [committedFrame, setCommittedFrame] = useState<{
    key: string
    src: string
  }>(() => ({ key: frameKey, src: buildSrc(appearance) }))
  const [loadedFrameKey, setLoadedFrameKey] = useState<string | null>(null)
  if (committedFrame.key !== frameKey) {
    setCommittedFrame({ key: frameKey, src: buildSrc(appearance) })
  }
  // The iframe unmounts while an editor fills the frame; forget its load so
  // the skeleton covers the remount when the editor closes.
  if (editing && loadedFrameKey !== null) setLoadedFrameKey(null)
  // Unsaved edits mean the frame shows an outdated render: cover it with the
  // loader right away rather than leaving stale content up until the save.
  const previewLoading =
    !editing && (dirty || loadedFrameKey !== committedFrame.key)
  // The frame element survives reloads (it is keyed by device only), and the
  // browser keeps painting the previous render until the next one is ready. So
  // once this frame has painted anything, a reload needs no skeleton: the
  // header, nav rail and page stay on screen and only a thin progress bar
  // shows that a fresh render is on its way. The full skeleton is kept for the
  // one case with nothing to show yet: the frame's first load.
  const framePainted =
    loadedFrameKey !== null && loadedFrameKey.startsWith(`${device}|`)
  const showSkeleton = previewLoading && !framePainted
  const showReloadBar = previewLoading && framePainted

  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Latest-ref so the message listener isn't re-registered on every editor
  // keystroke just because the parent re-created this callback.
  const onPageChangeRef = useRef(onPageChange)
  const onOpenDocumentRef = useRef(onOpenDocument)
  const buildSrcRef = useRef(buildSrc)
  const appearanceRef = useRef(appearance)
  useEffect(() => {
    onPageChangeRef.current = onPageChange
    onOpenDocumentRef.current = onOpenDocument
    buildSrcRef.current = buildSrc
    appearanceRef.current = appearance
  })
  // Same-origin, so we can reach into the rendered portal and toggle its theme
  // class directly — instant, no network, no reload.
  const applyPreviewTheme = useCallback((): void => {
    const root = iframeRef.current?.contentDocument?.querySelector<HTMLElement>(
      "[data-portal-root]",
    )
    if (!root) return
    // The preview root is server-rendered with the literal `light`/`dark` class
    // (cn(appearance, ...)) so it forces its own tokens independent of the app
    // shell's theme. We must swap BOTH classes here — toggling only `dark` would
    // leave a stale `light` class, which wins the cascade (.light is defined
    // after .dark in index.css) and pins the preview to light.
    root.classList.toggle("dark", appearance === "dark")
    root.classList.toggle("light", appearance === "light")
    iframeRef.current?.contentWindow?.postMessage(
      createPortalPreviewThemeMessage(appearance),
      window.location.origin,
    )
  }, [appearance])

  const handleFrameLoad = useCallback((): void => {
    applyPreviewTheme()
    setLoadedFrameKey(committedFrame.key)
    // Same-origin: catch doc-link clicks in the rendered portal. Only the
    // explicit "Edit document" control (data-portal-document-ref) opens the
    // editor; ordinary doc links (nav rail, pager, cross-links) just move the
    // preview to that doc, staying on the draft render rather than following
    // the public /p/... href. The listener dies with the frame's document on
    // every reload.
    const frameDocument = iframeRef.current?.contentDocument
    frameDocument?.addEventListener(
      "click",
      (event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return
        }
        const anchor = (event.target as Element | null)?.closest?.("a[href]")
        if (!anchor) return
        const editRef = anchor.getAttribute("data-portal-document-ref")
        if (editRef) {
          if (!onOpenDocumentRef.current) return
          event.preventDefault()
          event.stopPropagation()
          onOpenDocumentRef.current(editRef)
          return
        }
        const docRef = portalDocRefFromHref(
          anchor.getAttribute("href") ?? "",
          window.location.origin,
        )
        if (!docRef) return
        event.preventDefault()
        event.stopPropagation()
        frameDocument.defaultView?.location.assign(
          `${buildSrcRef.current(appearanceRef.current)}&doc=${encodeURIComponent(docRef)}`,
        )
      },
      true,
    )
  }, [applyPreviewTheme, committedFrame.key])

  useEffect(() => {
    applyPreviewTheme()
  }, [applyPreviewTheme])

  useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) return
      if (event.source !== iframeRef.current?.contentWindow) return
      if (isPortalPreviewThemeReadyMessage(event.data)) {
        applyPreviewTheme()
        return
      }
      if (isPortalPreviewPageMessage(event.data)) {
        const reported = event.data.page
        // Adopt the frame's page first so the editor's URL catching up doesn't
        // read as a new request and reload the frame.
        setPageNav((current) =>
          current.page === reported ? current : { ...current, page: reported },
        )
        if (reported !== pageSlug) onPageChangeRef.current?.(reported)
        return
      }
      if (!isPortalPreviewThemeMessage(event.data)) return
      if (event.data.mode !== appearance) onAppearanceChange(event.data.mode)
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [appearance, applyPreviewTheme, onAppearanceChange, pageSlug])

  useEffect(() => {
    const element = fitAreaRef.current
    if (!element) return

    const update = (): void => {
      setFitArea({
        width: element.clientWidth,
        height: element.clientHeight,
      })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div className={cn("flex h-full flex-col", className)}>
      {/* Both devices keep a fixed viewport and scale visually to fit the panel.
          Resizing the panel must never change responsive breakpoints or the
          amount of content visible within the device viewport.
          Controls float over the backdrop — no chrome bar. */}
      {/* pt-14 reserves room for the floating top-right controls (actions +
          orientation, absolute top-0) so the centered preview card never slides
          under them. Other sides keep the original p-4 inset. */}
      <div className="relative flex-1 overflow-auto bg-muted/30 px-4 pb-4 pt-14 scrollbar-none">
        <PreviewMeshBackground />

        {/* Floating controls: actions + orientation, top-right.
            No header bar, no dimensions/url chrome. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-end gap-2 p-3">
          <div className="pointer-events-auto flex items-center gap-2">
            {actions}
            <div className="flex items-center rounded-md bg-muted p-0.5">
              <Button
                type="button"
                variant={device === "desktop" ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label="Desktop preview"
                aria-pressed={device === "desktop"}
                onClick={() => onDeviceChange("desktop")}
              >
                <Monitor />
              </Button>
              <Button
                type="button"
                variant={device === "mobile" ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label="Mobile preview"
                aria-pressed={device === "mobile"}
                onClick={() => onDeviceChange("mobile")}
              >
                <Smartphone />
              </Button>
            </div>
          </div>
        </div>

        <div
          ref={fitAreaRef}
          className="relative flex h-full min-h-[360px] w-full items-center justify-center"
        >
          <div
            data-testid={isPhone ? "portal-preview-phone" : undefined}
            className={cn(
              "relative",
              isPhone &&
                "rounded-[3rem] bg-neutral-900 shadow-[0_0_0_1px_rgba(255,255,255,0.08)_inset,0_0_0_1px_rgba(0,0,0,0.4),0_30px_60px_-20px_rgba(15,23,42,0.45)] dark:bg-neutral-950",
            )}
            style={isPhone ? { padding: PHONE_BEZEL } : undefined}
          >
            {isPhone && (
              <>
                {/* Decorative side buttons: action + volume (left), power (right). */}
                <span aria-hidden="true" className="absolute -left-[3px] top-[16%] h-6 w-[3px] rounded-l-sm bg-neutral-800" />
                <span aria-hidden="true" className="absolute -left-[3px] top-[24%] h-11 w-[3px] rounded-l-sm bg-neutral-800" />
                <span aria-hidden="true" className="absolute -left-[3px] top-[31%] h-11 w-[3px] rounded-l-sm bg-neutral-800" />
                <span aria-hidden="true" className="absolute -right-[3px] top-[26%] h-16 w-[3px] rounded-r-sm bg-neutral-800" />
              </>
            )}
          <div
            className={cn(
              "relative overflow-hidden bg-background",
              isPhone
                ? "rounded-[2.4rem]"
                : "rounded-xl border border-border shadow-sm",
            )}
            aria-busy={previewLoading}
            // One frame for previewing and editing: an open document keeps the
            // exact card the rendered portal occupies, so opening one never
            // resizes or re-lays-out the view. The editor lays out at the full
            // device viewport and is shrunk with CSS `zoom` (not a transform),
            // so it scales exactly like the iframe while hit-testing and
            // getBoundingClientRect stay correct for its floating menus.
            style={{ width: scaledWidth, height: scaledHeight }}
          >
            {showSkeleton && (
              <PortalPreviewSkeleton
                appearance={appearance}
                device={device}
                surface={surface}
              />
            )}
            {showReloadBar && (
              <LoadingBar
                label="Updating portal preview"
                className="delayed-reveal pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 rounded-none bg-transparent"
              />
            )}
            {/* A save or page change gives the frame a new src, so the server
                route re-renders; a device change re-mounts it. The theme
                swap is applied imperatively (see applyPreviewTheme) so toggling
                light/dark never reloads. Same-origin, no embedding restrictions. */}
            {editing ? (
              <div
                data-testid="portal-preview-editor"
                data-preview-editor=""
                className="flex min-h-0 flex-col"
                style={{
                  width: frame.width,
                  height: frame.height,
                  zoom: scale,
                }}
              >
                {contentHeader}
                <div className="flex min-h-0 flex-1">
                  {contentSidebar}
                  <div className="min-h-0 min-w-0 flex-1 overflow-auto">
                    {content}
                  </div>
                </div>
              </div>
            ) : (
              <iframe
                ref={iframeRef}
                // Keyed by device only: a new src navigates this same frame
                // instead of remounting it, which is what lets the previous
                // render stay visible during a reload.
                key={device}
                title="Portal preview"
                src={committedFrame.src}
                onLoad={handleFrameLoad}
                className="origin-top-left border-0 bg-background"
                style={{
                  width: frame.width,
                  height: frame.height,
                  transform: `scale(${scale})`,
                }}
              />
            )}
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
