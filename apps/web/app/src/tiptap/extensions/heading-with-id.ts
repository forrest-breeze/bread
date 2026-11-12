import Heading from "@tiptap/extension-heading"
import { Plugin } from "@tiptap/pm/state"

// Alphabet is lowercase alphanumeric so node IDs are safe as ltree labels.
const NODE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const NODE_ID_LENGTH = 8

export function generateHeadingNodeId(): string {
  const bytes = new Uint8Array(NODE_ID_LENGTH)
  // crypto.getRandomValues is available in browsers and Node >= 18.
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < NODE_ID_LENGTH; i++) {
    out += NODE_ID_ALPHABET[bytes[i] % NODE_ID_ALPHABET.length]
  }
  return out
}

export const HeadingWithId = Heading.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {}
    return {
      ...parent,
      nodeId: {
        default: null,
        parseHTML: (element: HTMLElement): string | null =>
          element.getAttribute("data-node-id") || null,
        renderHTML: (attrs: Record<string, unknown>): Record<string, string> =>
          attrs.nodeId ? { "data-node-id": attrs.nodeId as string } : {},
      },
    }
  },

  // Existing headings opened without IDs get them on editor creation, so the
  // next autosave persists stable IDs.
  onCreate() {
    const { state, view } = this.editor
    const tr = state.tr
    const seen = new Set<string>()
    let modified = false
    state.doc.descendants((node, pos) => {
      if (node.type.name !== "heading") return
      const existing = (node.attrs as { nodeId?: string | null }).nodeId
      let id: string = existing ?? ""
      if (!id || seen.has(id)) {
        id = generateHeadingNodeId()
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, nodeId: id })
        modified = true
      }
      seen.add(id)
    })
    if (modified) {
      tr.setMeta("addToHistory", false)
      view.dispatch(tr)
    }
  },

  // Every edit gets a fresh pass so pasted or split headings always carry a
  // unique ID. Dedupes collisions introduced by copy/paste.
  addProseMirrorPlugins() {
    const parentPlugins = this.parent?.() ?? []
    return [
      ...parentPlugins,
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null
          const tr = newState.tr
          const seen = new Set<string>()
          let modified = false
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== "heading") return
            const existing = (node.attrs as { nodeId?: string | null }).nodeId
            let id: string = existing ?? ""
            if (!id || seen.has(id)) {
              id = generateHeadingNodeId()
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, nodeId: id })
              modified = true
            }
            seen.add(id)
          })
          return modified ? tr : null
        },
      }),
    ]
  },
})
