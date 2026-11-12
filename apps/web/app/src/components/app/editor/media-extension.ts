import { mergeAttributes, Node } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

/**
 * Media nodes are top-level blocks. A pointer drop often resolves inside a
 * paragraph, list item, or other text block, where inserting a block atom can
 * be rejected without changing the document. Move such positions to the
 * boundary immediately after their top-level block.
 */
export function mediaBlockInsertionPosition(
  doc: ProseMirrorNode,
  requestedPosition: number,
): number {
  const clamped = Math.min(Math.max(0, requestedPosition), doc.content.size)
  const resolved = doc.resolve(clamped)
  return resolved.depth > 0 ? resolved.after(1) : clamped
}

export const MediaImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      title: { default: null },
      width: { default: null },
      height: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: "img[src]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        loading: "lazy",
      }),
    ]
  },
})

export const MediaVideo = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
      width: { default: null },
      height: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: "video[src]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "video",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        controls: "",
        playsinline: "",
        preload: "metadata",
      }),
    ]
  },
})
