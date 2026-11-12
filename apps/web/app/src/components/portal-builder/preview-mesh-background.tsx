"use client"

import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Interactive mesh backdrop for the live-preview fit area.
//
// Renders a full-bleed canvas behind the centered device frame: a grid of
// nodes connected into a mesh that organically drifts and bends toward the
// pointer. Purely decorative — `pointer-events-none` so it never steals
// clicks/scrolls from the preview iframe; pointer position is sampled from the
// parent fit area via a passed-in ref-less window listener scoped to the canvas
// bounding box.
//
// Theme-aware: the node/line color is read from the canvas element's computed
// `color` (driven by the `text-foreground` utility), so it tracks the app
// shell's light/dark tokens with no JS theme wiring.
// ---------------------------------------------------------------------------

interface PreviewMeshBackgroundProps {
  className?: string
}

const GRID_SPACING = 20 // px between rest-position nodes
const INFLUENCE_RADIUS = 130 // px — cursor reach
const MAX_PULL = 7 // px — cap on cursor displacement
const LINE_DISTANCE = GRID_SPACING * 1.7 // only connect near neighbors

// Neutral gray, rendered at low alpha so it sits well on both light and dark
// preview backdrops. The mesh is always visible at a base opacity; proximity to
// the cursor lifts it.
const MESH_RGB = { r: 142, g: 142, b: 142 }
const BASE_LINE_ALPHA = 0.16
const BASE_NODE_ALPHA = 0.28

interface Node {
  baseX: number
  baseY: number
  x: number
  y: number
}

export function PreviewMeshBackground({
  className,
}: PreviewMeshBackgroundProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const context = ctx // non-null binding for nested closures

    let nodes: Node[] = []
    let cols = 0
    let rows = 0
    let width = 0
    let height = 0
    let dpr = 1

    // Pointer state, eased toward the raw target so the mesh settles smoothly
    // when the cursor stops or leaves.
    const pointer = { x: -9999, y: -9999, active: false }
    const eased = { x: -9999, y: -9999, strength: 0 }

    const build = (): void => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)

      cols = Math.ceil(width / GRID_SPACING) + 2
      rows = Math.ceil(height / GRID_SPACING) + 2
      nodes = []
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const baseX = c * GRID_SPACING - GRID_SPACING / 2
          const baseY = r * GRID_SPACING - GRID_SPACING / 2
          nodes.push({ baseX, baseY, x: baseX, y: baseY })
        }
      }
    }

    const color = MESH_RGB

    let frame = 0
    const draw = (): void => {
      // Ease the active pointer toward its target; decay strength when inactive.
      const targetStrength = pointer.active ? 1 : 0
      // Release faster than it engages so the warp doesn't linger when the
      // pointer leaves (or crosses onto the preview iframe).
      eased.strength += (targetStrength - eased.strength) * (pointer.active ? 0.12 : 0.22)
      if (pointer.active) {
        eased.x += (pointer.x - eased.x) * 0.18
        eased.y += (pointer.y - eased.y) * 0.18
      }

      context.clearRect(0, 0, width, height)

      // Update node positions: rest on a perfectly straight grid, deform only
      // toward the cursor.
      for (const node of nodes) {
        let targetX = node.baseX
        let targetY = node.baseY

        if (eased.strength > 0.01) {
          const dx = eased.x - node.baseX
          const dy = eased.y - node.baseY
          const dist = Math.hypot(dx, dy)
          if (dist < INFLUENCE_RADIUS && dist > 0.001) {
            const falloff = (1 - dist / INFLUENCE_RADIUS) ** 2
            const pull = falloff * MAX_PULL * eased.strength
            targetX += (dx / dist) * pull
            targetY += (dy / dist) * pull
          }
        }

        // Spring the rendered position toward target for fluidity.
        node.x += (targetX - node.x) * 0.16
        node.y += (targetY - node.y) * 0.16
      }

      // Draw connecting lines (right + down neighbors only).
      const { r, g, b } = color
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const i = row * cols + col
          const a = nodes[i]
          if (col + 1 < cols) connect(a, nodes[i + 1])
          if (row + 1 < rows) connect(a, nodes[i + cols])
        }
      }

      function connect(a: Node, c2: Node): void {
        const dist = Math.hypot(a.x - c2.x, a.y - c2.y)
        if (dist > LINE_DISTANCE) return
        // Lines closer to the cursor glow a touch brighter.
        const mx = (a.x + c2.x) / 2
        const my = (a.y + c2.y) / 2
        let boost = 0
        if (eased.strength > 0.01) {
          const d = Math.hypot(eased.x - mx, eased.y - my)
          if (d < INFLUENCE_RADIUS) {
            boost = (1 - d / INFLUENCE_RADIUS) * 0.07 * eased.strength
          }
        }
        const alpha = BASE_LINE_ALPHA + boost
        context.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`
        context.lineWidth = 1
        context.beginPath()
        context.moveTo(a.x, a.y)
        context.lineTo(c2.x, c2.y)
        context.stroke()
      }

      // Draw nodes.
      for (const node of nodes) {
        let nodeAlpha = BASE_NODE_ALPHA
        let radius = 1
        if (eased.strength > 0.01) {
          const d = Math.hypot(eased.x - node.x, eased.y - node.y)
          if (d < INFLUENCE_RADIUS) {
            const f = (1 - d / INFLUENCE_RADIUS) * eased.strength
            nodeAlpha += f * 0.16
            radius += f * 0.55
          }
        }
        context.fillStyle = `rgba(${r}, ${g}, ${b}, ${nodeAlpha})`
        context.beginPath()
        context.arc(node.x, node.y, radius, 0, Math.PI * 2)
        context.fill()
      }

      frame = window.requestAnimationFrame(draw)
    }

    const handlePointerMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
      if (inside) {
        if (!pointer.active) {
          // Jump the eased pointer to entry point to avoid a sweep-in artifact.
          eased.x = x
          eased.y = y
        }
        pointer.x = x
        pointer.y = y
        pointer.active = true
      } else {
        pointer.active = false
      }
    }

    const handlePointerLeave = (): void => {
      pointer.active = false
    }

    // The preview iframe (and any same-doc embeds) swallow pointer events, so
    // window `pointermove` stops firing the moment the cursor crosses onto them
    // — freezing the last hover. `pointerover` still bubbles to window as the
    // cursor enters such elements, so deactivate when we land on an iframe.
    const handlePointerOver = (e: PointerEvent): void => {
      if ((e.target as HTMLElement | null)?.tagName === "IFRAME") {
        pointer.active = false
      }
    }

    // Cursor left the document entirely (relatedTarget null) — release.
    const handleWindowOut = (e: PointerEvent): void => {
      if (!e.relatedTarget) pointer.active = false
    }

    build()
    frame = window.requestAnimationFrame(draw)

    const resizeObserver = new ResizeObserver(() => {
      build()
    })
    resizeObserver.observe(canvas)

    // Listen on window so the mesh reacts even though the canvas itself is
    // pointer-events-none (clicks pass through to the iframe frame above).
    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerleave", handlePointerLeave)
    window.addEventListener("pointerover", handlePointerOver)
    window.addEventListener("pointerout", handleWindowOut)

    return () => {
      window.cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerleave", handlePointerLeave)
      window.removeEventListener("pointerover", handlePointerOver)
      window.removeEventListener("pointerout", handleWindowOut)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full",
        className,
      )}
    />
  )
}
