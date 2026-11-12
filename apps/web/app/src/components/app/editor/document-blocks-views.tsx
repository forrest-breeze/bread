"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react"
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Link2,
  Plus,
  SmilePlus,
  Trash2,
} from "lucide-react"
import { cardIcon, isSafeCardHref } from "@/lib/document-tabs"
import { cn } from "@/lib/utils"
import { DocumentCard, DocumentCards, DocumentTab, DocumentTabs } from "./document-tabs-extension"

// Editor-only views for card and tab groups. Titles, links and icons are node
// attributes, so they're edited through these controls; stored HTML is still
// produced by each node's renderHTML, so readers are unaffected.

const CARD_ICONS = ["🚀", "⚡", "🔔", "👤", "📦", "🧾", "💳", "🔒", "⚠️", "🛠️", "📊", "🌍", "💬", "✅", "🧩", "📘"]

const fieldClass = "w-full min-w-0 border-0 bg-transparent p-0 outline-none placeholder:text-muted-foreground/60 focus:ring-0"

type GetPos = NodeViewProps["getPos"]

function moveSibling(editor: Editor, getPos: GetPos, node: ProseMirrorNode, delta: -1 | 1) {
  const pos = getPos()
  if (typeof pos !== "number") return
  const $pos = editor.state.doc.resolve(pos)
  const target = $pos.index() + delta
  if (target < 0 || target >= $pos.parent.childCount) return
  const sibling = $pos.parent.child(target)
  const tr = editor.state.tr
  if (delta > 0) {
    tr.insert(pos + node.nodeSize + sibling.nodeSize, node).delete(pos, pos + node.nodeSize)
  } else {
    tr.delete(pos, pos + node.nodeSize).insert(pos - sibling.nodeSize, node)
  }
  editor.view.dispatch(tr)
}

/** Remove one item; removing the last item removes the whole group. */
function deleteItem(editor: Editor, getPos: GetPos, node: ProseMirrorNode) {
  const pos = getPos()
  if (typeof pos !== "number") return
  const $pos = editor.state.doc.resolve(pos)
  const tr = editor.state.tr
  if ($pos.parent.childCount <= 1) {
    const groupPos = $pos.before()
    tr.delete(groupPos, groupPos + $pos.parent.nodeSize)
  } else {
    tr.delete(pos, pos + node.nodeSize)
  }
  editor.view.dispatch(tr)
  editor.commands.focus()
}

function appendItem(editor: Editor, getPos: GetPos, group: ProseMirrorNode, type: "documentCard" | "documentTab", title: string) {
  const pos = getPos()
  if (typeof pos !== "number") return
  const { schema } = editor
  const item = schema.nodes[type].create({ title }, schema.nodes.paragraph.create())
  const insertAt = pos + group.nodeSize - 1
  const tr = editor.state.tr.insert(insertAt, item)
  editor.view.dispatch(tr)
  // Put the cursor in the new item's body paragraph.
  editor.commands.focus(insertAt + 2)
}

function siblingInfo(editor: Editor, getPos: GetPos) {
  const pos = getPos()
  if (typeof pos !== "number") return { index: 0, count: 1 }
  const $pos = editor.state.doc.resolve(pos)
  return { index: $pos.index(), count: $pos.parent.childCount }
}

function ToolbarButton({ label, onClick, children, danger, disabled }: { label: string; onClick?: () => void; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
        danger && "hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      {children}
    </button>
  )
}

function ItemToolbar({ children }: { children: ReactNode }) {
  return (
    <div
      contentEditable={false}
      className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100"
    >
      {children}
    </div>
  )
}

function DragHandle() {
  return (
    <span
      data-drag-handle=""
      draggable
      title="Drag to reorder"
      className="flex size-6 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
    >
      <GripVertical className="size-3.5" />
    </span>
  )
}

function IconPicker({ icon, onChange }: { icon: string | null; onChange: (icon: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", close)
    return () => document.removeEventListener("mousedown", close)
  }, [open])
  const pick = (value: string | null) => {
    onChange(value)
    setOpen(false)
    setCustom("")
  }
  return (
    <div ref={ref} className="relative mb-2 w-fit">
      <button
        type="button"
        aria-label={icon ? "Change icon" : "Add icon"}
        title={icon ? "Change icon" : "Add icon"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex size-9 items-center justify-center rounded-md text-2xl leading-none transition-colors hover:bg-accent",
          !icon && "text-muted-foreground opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100",
        )}
      >
        {icon ?? <SmilePlus className="size-4" />}
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-border bg-popover p-2 shadow-lg">
          <div className="grid grid-cols-8 gap-0.5">
            {CARD_ICONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => pick(emoji)}
                className={cn("flex size-6 items-center justify-center rounded text-base hover:bg-accent", icon === emoji && "bg-accent")}
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              aria-label="Custom emoji"
              placeholder="Paste an emoji"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && cardIcon(custom)) {
                  event.preventDefault()
                  pick(cardIcon(custom))
                }
              }}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs outline-none focus:border-ring"
            />
            {icon ? (
              <button type="button" onClick={() => pick(null)} className="h-7 rounded px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
                Remove
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── Cards ───────────────────────────────────────────────────────────

function DocumentCardsView({ editor, getPos, node }: NodeViewProps) {
  return (
    <NodeViewWrapper className="my-6">
      <NodeViewContent data-document-cards="" className="!my-0" />
      {editor.isEditable ? (
        <button
          type="button"
          contentEditable={false}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => appendItem(editor, getPos, node, "documentCard", "New card")}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <Plus className="size-3.5" /> Add card
        </button>
      ) : null}
    </NodeViewWrapper>
  )
}

function DocumentCardView({ editor, getPos, node, updateAttributes }: NodeViewProps) {
  const title: string = node.attrs.title ?? ""
  const href: string = node.attrs.href ?? ""
  const icon = cardIcon(node.attrs.icon)
  const [linkOpen, setLinkOpen] = useState(false)
  const showLink = linkOpen || href !== ""
  const invalidHref = href.trim() !== "" && !isSafeCardHref(href)
  const editable = editor.isEditable
  return (
    <NodeViewWrapper data-document-card={title} className="group/item">
      {editable ? (
        <ItemToolbar>
          <ToolbarButton label={href ? "Edit link" : "Add link"} onClick={() => setLinkOpen((value) => !value)}>
            <Link2 className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Delete card" danger onClick={() => deleteItem(editor, getPos, node)}>
            <Trash2 className="size-3.5" />
          </ToolbarButton>
          <DragHandle />
        </ItemToolbar>
      ) : null}
      <div contentEditable={false}>
        {editable ? (
          <IconPicker icon={icon} onChange={(next) => updateAttributes({ icon: next })} />
        ) : icon ? (
          <span data-card-glyph="">{icon}</span>
        ) : null}
        <input
          aria-label="Card title"
          readOnly={!editable}
          className={cn(fieldClass, "pr-28 font-semibold")}
          placeholder="Card title"
          value={title}
          onChange={(event) => updateAttributes({ title: event.target.value })}
        />
        {showLink ? (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Link2 className="size-3 shrink-0" />
            <input
              aria-label="Card link"
              readOnly={!editable}
              autoFocus={linkOpen && !href}
              className={cn(fieldClass, "text-xs")}
              placeholder="/p/…/doc/page or https://…"
              value={href}
              onChange={(event) => updateAttributes({ href: event.target.value.trim() || null })}
              onBlur={() => setLinkOpen(false)}
            />
          </div>
        ) : null}
        {invalidHref ? (
          <p className="mt-1 text-xs text-destructive">Use a /path, #anchor, or http(s) link. This link won’t be published.</p>
        ) : null}
      </div>
      <NodeViewContent data-card-body="" className="mt-1" />
    </NodeViewWrapper>
  )
}

// ── Tabs ────────────────────────────────────────────────────────────

function DocumentTabsView({ editor, getPos, node }: NodeViewProps) {
  return (
    <NodeViewWrapper className="my-6 rounded-lg border border-border p-3">
      <NodeViewContent data-document-tabs="" className="!my-0 flex flex-col gap-3" />
      {editor.isEditable ? (
        <button
          type="button"
          contentEditable={false}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => appendItem(editor, getPos, node, "documentTab", "New tab")}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <Plus className="size-3.5" /> Add tab
        </button>
      ) : null}
    </NodeViewWrapper>
  )
}

function DocumentTabView({ editor, getPos, node, updateAttributes }: NodeViewProps) {
  const title: string = node.attrs.title ?? ""
  const { index, count } = siblingInfo(editor, getPos)
  const editable = editor.isEditable
  return (
    <NodeViewWrapper data-document-tab={title} className="group/item relative !pt-0">
      {editable ? (
        <ItemToolbar>
          <ToolbarButton label="Move up" disabled={index === 0} onClick={() => moveSibling(editor, getPos, node, -1)}>
            <ArrowUp className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Move down" disabled={index >= count - 1} onClick={() => moveSibling(editor, getPos, node, 1)}>
            <ArrowDown className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton label="Delete tab" danger onClick={() => deleteItem(editor, getPos, node)}>
            <Trash2 className="size-3.5" />
          </ToolbarButton>
          <DragHandle />
        </ItemToolbar>
      ) : null}
      <div contentEditable={false} className="mb-1 border-b border-border/60 pb-1">
        <input
          aria-label="Tab title"
          readOnly={!editable}
          className={cn(fieldClass, "pr-28 text-sm font-semibold")}
          placeholder="Tab title"
          value={title}
          onChange={(event) => updateAttributes({ title: event.target.value })}
        />
      </div>
      <NodeViewContent />
    </NodeViewWrapper>
  )
}

export const EditableDocumentCards = DocumentCards.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocumentCardsView)
  },
})

export const EditableDocumentCard = DocumentCard.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocumentCardView)
  },
})

export const EditableDocumentTabs = DocumentTabs.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocumentTabsView)
  },
})

export const EditableDocumentTab = DocumentTab.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DocumentTabView)
  },
})
