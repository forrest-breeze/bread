import { Node } from "@tiptap/core"
import { cardIcon, isSafeCardHref } from "@/lib/document-tabs"

// Keep imported tab groups intact while their contents remain editable.
// The reader adds the interactive tab bar; the editor shows every section.
export const DocumentTabs = Node.create({
  name: "documentTabs",
  group: "block",
  content: "documentTab+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-document-tabs]" }],
  renderHTML: () => ["div", { "data-document-tabs": "" }, 0],
})

export const DocumentTab = Node.create({
  name: "documentTab",
  content: "block+",
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      title: {
        default: "Section",
        parseHTML: (element) => element.getAttribute("data-document-tab"),
        renderHTML: (attributes) => ({ "data-document-tab": attributes.title }),
      },
    }
  },
  parseHTML: () => [{ tag: "section[data-document-tab]" }],
  renderHTML: ({ HTMLAttributes }) => ["section", HTMLAttributes, 0],
})

// Card groups keep their title and link as attributes; the body stays editable.
// The rendered title link is regenerated from attributes, never parsed as content.
export const DocumentCards = Node.create({
  name: "documentCards",
  group: "block",
  content: "documentCard+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-document-cards]" }],
  renderHTML: () => ["div", { "data-document-cards": "" }, 0],
})

export const DocumentCard = Node.create({
  name: "documentCard",
  content: "block+",
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      title: {
        default: "Card",
        parseHTML: (element) => element.getAttribute("data-document-card"),
        renderHTML: (attributes) => ({ "data-document-card": attributes.title }),
      },
      href: {
        default: null,
        parseHTML: (element) => {
          const href = element.getAttribute("data-card-href")
          return href && isSafeCardHref(href) ? href.trim() : null
        },
        renderHTML: (attributes) => (attributes.href ? { "data-card-href": attributes.href } : {}),
      },
      icon: {
        default: null,
        parseHTML: (element) => cardIcon(element.getAttribute("data-card-icon")),
        renderHTML: (attributes) => {
          const icon = cardIcon(attributes.icon)
          return icon ? { "data-card-icon": icon } : {}
        },
      },
    }
  },
  parseHTML: () => [{ tag: "section[data-document-card]", contentElement: "[data-card-body]" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const title: string = node.attrs.title
    const href: string | null = node.attrs.href && isSafeCardHref(node.attrs.href) ? node.attrs.href : null
    const icon = cardIcon(node.attrs.icon)
    return [
      "section",
      HTMLAttributes,
      ...(icon ? [["span", { "data-card-glyph": "", "aria-hidden": "true", contenteditable: "false" }, icon]] : []),
      ["p", { "data-card-title": "", contenteditable: "false" }, href ? ["a", { href }, title] : title],
      ["div", { "data-card-body": "" }, 0],
    ]
  },
})
