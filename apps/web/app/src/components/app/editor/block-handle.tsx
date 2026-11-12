"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { Editor } from "@tiptap/react"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import { GripVertical, Plus } from "lucide-react"

/** ProseMirror's drop handler reads `view.dragging` to move (not copy). */
function setViewDragging(view: EditorView, dragging: EditorView["dragging"]): void {
  view.dragging = dragging
}

interface HoveredBlock {
  /** Document position directly before the top-level block. */
  pos: number
  node: PMNode
  dom: HTMLElement
  /** Offset from the wrapper's top, in the wrapper's own (unzoomed) px. */
  top: number
}

/**
 * Notion-style gutter controls for the top-level block under the pointer:
 * "+" opens the slash menu on a new line after it, and the grip drags the
 * block elsewhere (ProseMirror's native drag/drop moves it, the drop cursor
 * shows where).
 *
 * Positions are measured with getBoundingClientRect and divided by the
 * wrapper's effective zoom, so it stays aligned inside the portal builder's
 * CSS-zoomed preview frame.
 */
export function BlockHandle({
  editor,
  wrapperRef,
}: {
  editor: Editor
  wrapperRef: React.RefObject<HTMLDivElement | null>
}): React.ReactElement | null {
  const [hovered, setHovered] = useState<HoveredBlock | null>(null)
  const draggingRef = useRef(false)

  const blockAtY = useCallback(
    (clientY: number): HoveredBlock | null => {
      const wrapper = wrapperRef.current
      if (!wrapper || editor.isDestroyed) return null
      const view = editor.view
      let match: { pos: number; node: PMNode; dom: HTMLElement } | null = null
      editor.state.doc.forEach((node, offset) => {
        const dom = view.nodeDOM(offset)
        if (!(dom instanceof HTMLElement)) return
        // The last block whose top is above the pointer: gaps between blocks
        // (margins) resolve to the block above them.
        if (dom.getBoundingClientRect().top <= clientY) {
          match = { pos: offset, node, dom }
        }
      })
      if (!match) return null
      const { pos, node, dom } = match as { pos: number; node: PMNode; dom: HTMLElement }
      const wrapperRect = wrapper.getBoundingClientRect()
      const zoom = wrapper.offsetWidth > 0 ? wrapperRect.width / wrapper.offsetWidth : 1
      const rect = dom.getBoundingClientRect()
      if (clientY > rect.bottom + 24 * zoom) return null
      // Align the controls with the block's first line, not its box top.
      const lineHeight = Number.parseFloat(window.getComputedStyle(dom).lineHeight)
      const firstLine = Number.isFinite(lineHeight) ? Math.min(lineHeight, rect.height / zoom) : 24
      const top = (rect.top - wrapperRect.top) / zoom + Math.max(0, (firstLine - 24) / 2)
      return { pos, node, dom, top }
    },
    [editor, wrapperRef],
  )

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const onMove = (event: MouseEvent): void => {
      if (draggingRef.current || !editor.isEditable) return
      // Hovering the controls themselves keeps the current block.
      if ((event.target as Element).closest?.("[data-block-handle]")) return
      setHovered(blockAtY(event.clientY))
    }
    const onLeave = (): void => {
      if (!draggingRef.current) setHovered(null)
    }
    // Typing reflows blocks; drop the stale handle until the pointer moves.
    const onUpdate = (): void => {
      if (!draggingRef.current) setHovered(null)
    }
    wrapper.addEventListener("mousemove", onMove)
    wrapper.addEventListener("mouseleave", onLeave)
    editor.on("update", onUpdate)
    return () => {
      wrapper.removeEventListener("mousemove", onMove)
      wrapper.removeEventListener("mouseleave", onLeave)
      editor.off("update", onUpdate)
    }
  }, [blockAtY, editor, wrapperRef])

  if (!hovered || !editor.isEditable) return null

  const insertBelow = (): void => {
    const { pos, node } = hovered
    // An empty paragraph takes the "/" itself, like Notion.
    if (node.type.name === "paragraph" && node.content.size === 0) {
      editor.chain().focus().insertContentAt(pos + 1, "/").run()
    } else {
      const after = pos + node.nodeSize
      editor
        .chain()
        .focus()
        .insertContentAt(after, { type: "paragraph", content: [{ type: "text", text: "/" }] })
        .setTextSelection(after + 2)
        .run()
    }
    setHovered(null)
  }

  const selectBlock = (): void => {
    const { view } = editor
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, hovered.pos)))
    view.focus()
  }

  const onDragStart = (event: React.DragEvent): void => {
    const { view } = editor
    const selection = NodeSelection.create(view.state.doc, hovered.pos)
    view.dispatch(view.state.tr.setSelection(selection))
    const slice = selection.content()
    const { dom, text } = view.serializeForClipboard(slice)
    event.dataTransfer.clearData()
    event.dataTransfer.setData("text/html", dom.innerHTML)
    event.dataTransfer.setData("text/plain", text)
    event.dataTransfer.effectAllowed = "copyMove"
    event.dataTransfer.setDragImage(hovered.dom, 0, 0)
    setViewDragging(view, { slice, move: true })
    draggingRef.current = true
  }

  const onDragEnd = (): void => {
    draggingRef.current = false
    setViewDragging(editor.view, null)
    setHovered(null)
  }

  return (
    <div
      data-block-handle=""
      contentEditable={false}
      className="absolute -left-14 z-10 flex h-6 items-center gap-0.5 text-muted-foreground/70"
      style={{ top: hovered.top }}
    >
      <button
        type="button"
        aria-label="Add block below"
        title="Add block below"
        onMouseDown={(event) => event.preventDefault()}
        onClick={insertBelow}
        className="flex size-6 items-center justify-center rounded hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-4" />
      </button>
      <div
        role="button"
        tabIndex={-1}
        aria-label="Drag to move block"
        title="Drag to move"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={selectBlock}
        className="flex h-6 w-5 cursor-grab items-center justify-center rounded hover:bg-muted hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" />
      </div>
    </div>
  )
}
