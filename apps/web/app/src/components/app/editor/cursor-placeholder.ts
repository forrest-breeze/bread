import Placeholder from "@tiptap/extension-placeholder"
import { isNodeEmpty } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

const cursorPlaceholderKey = new PluginKey("cursorPlaceholder")

/**
 * Placeholder that only decorates the empty textblock holding the cursor,
 * at any nesting depth (card/tab bodies included).
 *
 * The stock extension with `includeChildren: true` keeps an incrementally
 * mapped decoration cache that leaks: after pressing Enter a few times and
 * moving the cursor back up, every empty paragraph keeps its placeholder.
 * Deriving the decoration from the selection on each render is O(1) and
 * cannot go stale.
 */
export const CursorPlaceholder = Placeholder.extend({
  addProseMirrorPlugins() {
    const { editor, options } = this
    const dataAttribute = `data-${options.dataAttribute || "placeholder"}`

    return [
      new Plugin({
        key: cursorPlaceholderKey,
        props: {
          decorations: ({ doc, selection }) => {
            if (options.showOnlyWhenEditable && !editor.isEditable) return null
            const { $anchor } = selection
            const node = $anchor.parent
            if (!node.type.isTextblock || !isNodeEmpty(node)) return null
            if ($anchor.depth === 0) return null

            const pos = $anchor.before()
            const hasAnchor = true
            const classes = [
              typeof options.emptyNodeClass === "function"
                ? options.emptyNodeClass({ editor, node, pos, hasAnchor })
                : options.emptyNodeClass,
            ]
            if (editor.isEmpty) classes.push(options.emptyEditorClass)

            const text =
              typeof options.placeholder === "function"
                ? options.placeholder({ editor, node, pos, hasAnchor })
                : options.placeholder

            return DecorationSet.create(doc, [
              Decoration.node(pos, pos + node.nodeSize, {
                class: classes.join(" "),
                [dataAttribute]: text,
              }),
            ])
          },
        },
      }),
    ]
  },
})
