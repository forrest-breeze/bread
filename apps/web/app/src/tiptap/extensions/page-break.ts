import { Node, mergeAttributes } from "@tiptap/core"
import { Plugin } from "@tiptap/pm/state"

// Reuse the heading node-id format so the sidebar/hash navigation can key
// page breaks exactly like it keys headings. Lowercase alphanumeric keeps
// the value safe inside ltree labels if we ever persist it.
const NODE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
const NODE_ID_LENGTH = 8

function generatePageBreakNodeId(): string {
  const bytes = new Uint8Array(NODE_ID_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < NODE_ID_LENGTH; i++) {
    out += NODE_ID_ALPHABET[bytes[i] % NODE_ID_ALPHABET.length]
  }
  return out
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: {
      insertPageBreak: (attrs?: { name?: string }) => ReturnType
    }
  }
}

export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      nodeId: {
        default: null,
        parseHTML: (element: HTMLElement): string | null =>
          element.getAttribute("data-node-id") || null,
        renderHTML: (attrs: Record<string, unknown>): Record<string, string> =>
          attrs.nodeId ? { "data-node-id": attrs.nodeId as string } : {},
      },
      name: {
        default: "",
        parseHTML: (element: HTMLElement): string =>
          element.getAttribute("data-name") || "",
        renderHTML: (attrs: Record<string, unknown>): Record<string, string> =>
          attrs.name ? { "data-name": attrs.name as string } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="page-break"]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const name = (node.attrs as { name?: string }).name || ""
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "page-break",
        class: "breezify-page-break",
      }),
      [
        "span",
        { class: "breezify-page-break__label", contenteditable: "false" },
        name || "New page",
      ],
    ]
  },

  addCommands() {
    return {
      insertPageBreak:
        (attrs = {}) =>
        ({ chain }) =>
          chain()
            .insertContent({
              type: this.name,
              attrs: {
                nodeId: generatePageBreakNodeId(),
                name: attrs.name ?? "",
              },
            })
            .run(),
    }
  },

  // Every edit sweeps missing/duplicate ids so page-break nodes copy-pasted
  // from elsewhere still end up with unique, stable identifiers.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _oldState, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null
          const tr = newState.tr
          const seen = new Set<string>()
          let modified = false
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== "pageBreak") return
            const existing = (node.attrs as { nodeId?: string | null }).nodeId
            let id = existing ?? ""
            if (!id || seen.has(id)) {
              id = generatePageBreakNodeId()
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
