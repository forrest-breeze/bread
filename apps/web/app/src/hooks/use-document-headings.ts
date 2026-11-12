"use client"

import { useEffect, useState, type RefObject } from "react"

export interface DocumentHeading {
  id: string
  text: string
  level: number
}

/**
 * Where a heading comes to rest when jumped to: just below the portal's sticky
 * header. The header's height varies (it grows a second row when the portal
 * has page navigation), so this follows `--portal-header-height` rather than
 * assuming one; the fallback covers frames that don't define it.
 */
const SCROLL_MARGIN_TOP = "calc(var(--portal-header-height, 4.5rem) + 1.5rem)"
/** Minimum distance of the activation line below the viewport top: clears a sticky header (window) or the container edge. */
const WINDOW_MIN_OFFSET = 96
const CONTAINER_MIN_OFFSET = 32
/** The activation line sits this far down the visible scroll area. */
const ACTIVATION_RATIO = 0.25
/** Sub-pixel slack so a heading scrolled exactly onto the line counts as crossed. */
const ACTIVATION_TOLERANCE = 2

function getScrollRoot(element: HTMLElement): HTMLElement | Window {
  let parent = element.parentElement
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY
    if (
      /(auto|scroll|overlay)/.test(overflowY) &&
      parent.scrollHeight > parent.clientHeight
    ) {
      return parent
    }
    parent = parent.parentElement
  }
  return window
}

export interface ScrollViewport {
  /** Viewport-relative top edge of the visible scroll area. */
  top: number
  /** Visible height of the scroll area. */
  height: number
  /** Distance scrolled from the top. */
  scrollTop: number
  /** Maximum scrollable distance (0 when the content fits). */
  maxScroll: number
  /** Minimum gap between `top` and the activation line. */
  minOffset: number
}

function readViewport(scrollRoot: HTMLElement | Window): ScrollViewport {
  if (scrollRoot === window) {
    const root = document.documentElement
    return {
      top: 0,
      height: window.innerHeight,
      scrollTop: window.scrollY,
      maxScroll: Math.max(0, root.scrollHeight - window.innerHeight),
      minOffset: WINDOW_MIN_OFFSET,
    }
  }
  const root = scrollRoot as HTMLElement
  return {
    top: root.getBoundingClientRect().top,
    height: root.clientHeight,
    scrollTop: root.scrollTop,
    maxScroll: Math.max(0, root.scrollHeight - root.clientHeight),
    minOffset: CONTAINER_MIN_OFFSET,
  }
}

/**
 * Viewport-relative y of the "you are here" line. A heading becomes active once
 * its top crosses above this line.
 *
 * The line normally rests a fixed fraction down the visible area, so it scales
 * with whatever frame the document lives in. Headings in the last screenful of
 * a page can never scroll up that far, so over the final stretch of scrolling
 * the line glides down to the bottom edge — each trailing heading is crossed
 * in order instead of the TOC jumping straight to the last one.
 */
export function getActivationLine(viewport: ScrollViewport): number {
  const { top, height, scrollTop, maxScroll, minOffset } = viewport
  const restOffset = Math.min(Math.max(minOffset, height * ACTIVATION_RATIO), height)
  const restLine = top + restOffset
  const bottomLine = top + height

  // Distance over which the line travels from rest to the bottom. Capped by
  // the total scroll so short pages still start with the line at rest.
  const travel = Math.min(bottomLine - restLine, maxScroll)
  if (travel <= 0) return restLine

  const remaining = Math.max(0, maxScroll - scrollTop)
  const progress = remaining >= travel ? 0 : 1 - remaining / travel
  return restLine + (bottomLine - restLine) * progress
}

/** Index of the last heading whose top has crossed the activation line (0 when none has). */
export function pickActiveHeadingIndex(headingTops: number[], activationLine: number): number {
  let current = 0
  for (let i = 0; i < headingTops.length; i++) {
    if (headingTops[i]! <= activationLine + ACTIVATION_TOLERANCE) current = i
    else break
  }
  return current
}

function headingsEqual(a: DocumentHeading[], b: DocumentHeading[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.id !== y.id || x.text !== y.text || x.level !== y.level) return false
  }
  return true
}

function readHeadingNodes(container: HTMLElement): Array<{
  node: HTMLElement
  heading: DocumentHeading
}> {
  const usedIds = new Set<string>()
  return Array.from(container.querySelectorAll<HTMLElement>("h1, h2, h3"))
    .map((node, index) => {
      const baseId = node.getAttribute("data-node-id") || `kb-h-${index}`
      let id = baseId
      let suffix = 2
      while (usedIds.has(id)) id = `${baseId}-${suffix++}`
      usedIds.add(id)
      return {
        node,
        heading: { id, text: node.textContent?.trim() ?? "", level: Number(node.tagName.slice(1)) || 1 },
      }
    })
    .filter(({ heading }) => heading.text.length > 0)
}

export function findDocumentHeading(container: HTMLElement, id: string): HTMLElement | undefined {
  return readHeadingNodes(container).find(({ heading }) => heading.id === id)?.node
}

/**
 * Derives a table-of-contents from a rendered document body and tracks which
 * heading is currently in view.
 *
 * Reads headings straight from the live DOM (rather than re-parsing the HTML
 * string) so the TOC and the scroll targets stay in perfect sync. Headings
 * authored in the Tiptap editor already carry a stable `data-node-id`; for any
 * heading without one (legacy / Markdown-rendered content) a positional id is
 * assigned so click-to-scroll still works.
 */
export function useDocumentHeadings(
  containerRef: RefObject<HTMLElement | null>,
  content: string,
): { headings: DocumentHeading[]; activeId: string | null } {
  const [headings, setHeadings] = useState<DocumentHeading[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  // Build the heading list from the rendered DOM whenever the body changes.
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      setHeadings((prev) => (prev.length === 0 ? prev : []))
      return
    }

    const syncHeadings = (): void => {
      const next = readHeadingNodes(container).map(({ node, heading }) => {
        // ProseMirror owns editable DOM. Writing attributes here makes its
        // observer redraw the heading, which triggers our observer again.
        if (!node.closest('[contenteditable="true"]')) {
          if (node.id !== heading.id) node.id = heading.id
          if (node.style.scrollMarginTop !== SCROLL_MARGIN_TOP) {
            node.style.scrollMarginTop = SCROLL_MARGIN_TOP
          }
        }
        return heading
      })

      // Only update when the heading set actually changed. Replacing the array
      // unconditionally caused an infinite loop: setHeadings → parent re-renders
      // the body → MutationObserver childList fires → syncHeadings → setHeadings.
      // The scroll-spy effect re-queries live elements by id, so it doesn't need
      // a fresh array reference to find the current DOM nodes.
      setHeadings((prev) => (headingsEqual(prev, next) ? prev : next))
    }

    syncHeadings()
    const observer = new MutationObserver(syncHeadings)
    observer.observe(container, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [containerRef, content])

  // Scroll-spy: keep a visible current-section marker even between headings.
  useEffect(() => {
    const container = containerRef.current
    if (!container || headings.length === 0) {
      setActiveId(null)
      return
    }

    // Ids come from the computed headings, not `node.id`: headings inside the
    // editor's contenteditable never get an id attribute written.
    const liveElements = (): Array<{ node: HTMLElement; id: string }> => {
      const currentContainer = containerRef.current
      if (!currentContainer) return []
      return readHeadingNodes(currentContainer).map(({ node, heading }) => ({ node, id: heading.id }))
    }

    if (liveElements().length === 0) {
      setActiveId(null)
      return
    }

    let frame: number | null = null

    const updateActiveHeading = (): void => {
      frame = null
      const currentContainer = containerRef.current
      const elements = liveElements()
      if (!currentContainer || elements.length === 0) {
        setActiveId(null)
        return
      }

      // Resolved per update: an editor can mount (or grow tall enough to
      // scroll) after this effect runs, so the scroll root found up front may
      // be stale — e.g. the portal builder's preview frame starts as `window`.
      const scrollRoot = getScrollRoot(currentContainer)
      const viewport = readViewport(scrollRoot)
      // A heading jumped to from the TOC rests at its scroll margin, so the
      // line can never sit above that or the clicked entry wouldn't activate.
      const scrollMargin =
        Number.parseFloat(window.getComputedStyle(elements[0]!.node).scrollMarginTop) || 0
      viewport.minOffset = Math.max(viewport.minOffset, scrollMargin)
      const activationLine = getActivationLine(viewport)
      const index = pickActiveHeadingIndex(
        elements.map(({ node }) => node.getBoundingClientRect().top),
        activationLine,
      )
      const current = elements[index]!

      setActiveId((previous) => (previous === current.id ? previous : current.id))
    }

    const scheduleUpdate = (): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(updateActiveHeading)
    }

    // Scroll doesn't bubble, but a capturing document listener sees scrolls
    // from window and every nested scroll container alike.
    scheduleUpdate()
    document.addEventListener("scroll", scheduleUpdate, { capture: true, passive: true })
    window.addEventListener("resize", scheduleUpdate)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      document.removeEventListener("scroll", scheduleUpdate, { capture: true })
      window.removeEventListener("resize", scheduleUpdate)
    }
  }, [containerRef, headings])

  return { headings, activeId }
}
