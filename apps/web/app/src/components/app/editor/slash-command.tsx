"use client"

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { Extension, type Editor, type Range } from "@tiptap/core"
import { ReactRenderer } from "@tiptap/react"
import Suggestion, {
  type SuggestionOptions,
  type SuggestionProps,
  type SuggestionKeyDownProps,
} from "@tiptap/suggestion"
import tippy, { type Instance as TippyInstance } from "tippy.js"
import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  TextQuote,
  Code,
  Minus,
  Sigma,
  Radical,
  Workflow,
  Table as TableIcon,
  LayoutGrid,
  PanelTop,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ── Types ───────────────────────────────────────────────────────────

type SlashCommandSection = "Basic blocks" | "Components" | "Advanced"

const SECTION_ORDER: SlashCommandSection[] = ["Basic blocks", "Components", "Advanced"]

interface SlashCommandItem {
  title: string
  section: SlashCommandSection
  /** Markdown shortcut hint shown on the right, if any. */
  shortcut?: string
  description: string
  keywords: string[]
  icon: ReactNode
  command: () => void
  /**
   * When set, choosing the item opens a size grid instead of running
   * `command`; the picked size is passed here.
   */
  gridPicker?: (size: { rows: number; cols: number }) => void
}

interface SlashCommandMenuProps {
  items: SlashCommandItem[]
  command: (item: SlashCommandItem) => void
}

// ── Table size grid ─────────────────────────────────────────────────

const GRID_COLS = 10
const GRID_ROWS = 8
const DEFAULT_GRID_SIZE = { rows: 3, cols: 3 }

interface TableGridPickerProps {
  size: { rows: number; cols: number }
  onHover: (size: { rows: number; cols: number }) => void
  onPick: (size: { rows: number; cols: number }) => void
}

function TableGridPicker({ size, onHover, onPick }: TableGridPickerProps) {
  return (
    <div className="p-2" data-testid="table-grid-picker">
      <div
        className="grid gap-0.5"
        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
          const row = Math.floor(i / GRID_COLS) + 1
          const col = (i % GRID_COLS) + 1
          const active = row <= size.rows && col <= size.cols
          return (
            <button
              key={i}
              type="button"
              aria-label={`${col} × ${row} table`}
              data-active={active}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHover({ rows: row, cols: col })}
              onClick={() => onPick({ rows: row, cols: col })}
              className={cn(
                "aspect-square rounded-[3px] border transition-colors",
                active
                  ? "border-primary/60 bg-primary/20"
                  : "border-border bg-muted/40"
              )}
            />
          )
        })}
      </div>
      <div className="pt-2 text-center text-xs text-muted-foreground">
        {size.cols} × {size.rows}
      </div>
    </div>
  )
}

// ── Menu Component ──────────────────────────────────────────────────

const SlashCommandMenu = forwardRef<
  { onKeyDown: (props: { event: KeyboardEvent }) => boolean },
  SlashCommandMenuProps
>(({ items, command }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [prevItems, setPrevItems] = useState(items)
  const [picker, setPicker] = useState<{
    item: SlashCommandItem
    size: { rows: number; cols: number }
  } | null>(null)

  if (items !== prevItems) {
    setPrevItems(items)
    setSelectedIndex(0)
  }

  const choose = (item: SlashCommandItem) => {
    if (item.gridPicker) {
      setPicker({ item, size: DEFAULT_GRID_SIZE })
      return
    }
    command(item)
  }

  const pick = (size: { rows: number; cols: number }) => {
    if (!picker) return
    // Run through the suggestion's `command` so the "/query" range is
    // cleared the same way as for any other item.
    command({ ...picker.item, command: () => picker.item.gridPicker?.(size) })
  }

  const onKeyDown = ({ event }: { event: KeyboardEvent }): boolean => {
    if (picker) {
      const { rows, cols } = picker.size
      const move = (next: { rows: number; cols: number }) => {
        event.preventDefault()
        setPicker({ ...picker, size: next })
        return true
      }
      switch (event.key) {
        case "ArrowRight":
          return move({ rows, cols: Math.min(GRID_COLS, cols + 1) })
        case "ArrowLeft":
          return move({ rows, cols: Math.max(1, cols - 1) })
        case "ArrowDown":
          return move({ rows: Math.min(GRID_ROWS, rows + 1), cols })
        case "ArrowUp":
          return move({ rows: Math.max(1, rows - 1), cols })
        case "Enter":
          event.preventDefault()
          pick(picker.size)
          return true
        default:
          return false
      }
    }

    if (items.length === 0) return false
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex((selectedIndex + items.length - 1) % items.length)
      return true
    }

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedIndex((selectedIndex + 1) % items.length)
      return true
    }

    if (event.key === "Enter") {
      event.preventDefault()
      const item = items[selectedIndex]
      if (item) choose(item)
      return true
    }

    return false
  }

  useImperativeHandle(ref, () => ({ onKeyDown }))

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  if (picker) {
    return (
      <div className="z-50 w-64 rounded-lg border border-border bg-popover shadow-lg">
        <TableGridPicker
          size={picker.size}
          onHover={(size) => setPicker({ ...picker, size })}
          onPick={pick}
        />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="w-64 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-lg">
        No matching blocks
      </div>
    )
  }

  // Items arrive sorted by section; render a header whenever it changes.
  return (
    <div
      ref={listRef}
      className="z-50 w-64 max-h-[340px] overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      {items.map((item, index) => (
        <div key={item.title}>
          {index === 0 || items[index - 1].section !== item.section ? (
            <div
              className={cn(
                "px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground",
                index > 0 && "mt-1 border-t border-border"
              )}
            >
              {item.section}
            </div>
          ) : null}
          <button
            data-index={index}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => choose(item)}
            title={item.description}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
              index === selectedIndex
                ? "bg-accent text-accent-foreground"
                : "text-popover-foreground"
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {item.shortcut ? (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {item.shortcut}
              </span>
            ) : null}
          </button>
        </div>
      ))}
    </div>
  )
})

SlashCommandMenu.displayName = "SlashCommandMenu"

// ── Filter Helper ───────────────────────────────────────────────────

/**
 * Filter slash command items by a query string.
 * Matches case-insensitively against title, description, and keywords.
 * Groups matches by section, preserving source order within each section.
 */
function filterSlashCommandItems(
  items: SlashCommandItem[],
  query: string
): SlashCommandItem[] {
  const q = query.toLowerCase()
  const matches = !query
    ? items
    : items.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.keywords.some((kw) => kw.toLowerCase().includes(q))
      )
  // Group by section (stable within a section) so headers render once.
  return SECTION_ORDER.flatMap((section) =>
    matches.filter((item) => item.section === section)
  )
}

// ── Command Items Factory ───────────────────────────────────────────

// EditorChain is intentionally typed as `unknown` here because the chain
// methods (toggleBulletList, setHeading, toggleTaskList, etc.) are injected
// by Tiptap extensions at runtime and are not part of the base ChainedCommands
// type without declaration merging. We access them via a single escape-hatch cast.
type AnyEditorChain = {
  focus: () => AnyEditorChain
  deleteRange: (r: Range) => AnyEditorChain
  setParagraph: () => AnyEditorChain
  setHeading: (attrs: { level: number }) => AnyEditorChain
  toggleBulletList: () => AnyEditorChain
  toggleOrderedList: () => AnyEditorChain
  toggleTaskList: () => AnyEditorChain
  toggleBlockquote: () => AnyEditorChain
  toggleCodeBlock: () => AnyEditorChain
  setHorizontalRule: () => AnyEditorChain
  insertTable: (options: {
    rows: number
    cols: number
    withHeaderRow: boolean
  }) => AnyEditorChain
  insertContent: (content: Record<string, unknown>) => AnyEditorChain
  run: () => boolean
}

function getSlashCommandItems(
  editor: Editor,
  range: Range,
): SlashCommandItem[] {
  if (!editor || !range) return []

  // Cast through unknown to our structural interface — extension-provided
  // chain methods are not in the base ChainedCommands type.
  const chain = (): AnyEditorChain =>
    editor.chain() as unknown as AnyEditorChain
  const r = range

  return [
    {
      title: "Text",
      section: "Basic blocks",
      description: "Plain text paragraph",
      keywords: ["paragraph", "plain", "text", "body", "p"],
      icon: <Type className="size-4" />,
      command: () => chain().focus().deleteRange(r).setParagraph().run(),
    },
    {
      title: "Heading 1",
      section: "Basic blocks",
      shortcut: "#",
      description: "Large section heading",
      keywords: ["h1", "heading", "title", "large", "header", "section"],
      icon: <Heading1 className="size-4" />,
      command: () =>
        chain().focus().deleteRange(r).setHeading({ level: 1 }).run(),
    },
    {
      title: "Heading 2",
      section: "Basic blocks",
      shortcut: "##",
      description: "Medium section heading",
      keywords: ["h2", "heading", "subtitle", "medium", "header", "section"],
      icon: <Heading2 className="size-4" />,
      command: () =>
        chain().focus().deleteRange(r).setHeading({ level: 2 }).run(),
    },
    {
      title: "Heading 3",
      section: "Basic blocks",
      shortcut: "###",
      description: "Small section heading",
      keywords: ["h3", "heading", "small", "header", "section", "subheading"],
      icon: <Heading3 className="size-4" />,
      command: () =>
        chain().focus().deleteRange(r).setHeading({ level: 3 }).run(),
    },
    {
      title: "Bullet List",
      section: "Basic blocks",
      shortcut: "-",
      description: "Unordered list",
      keywords: ["ul", "list", "bullets", "unordered", "items", "dash"],
      icon: <List className="size-4" />,
      command: () =>
        chain().focus().deleteRange(r).toggleBulletList().run(),
    },
    {
      title: "Numbered List",
      section: "Basic blocks",
      shortcut: "1.",
      description: "Ordered list",
      keywords: ["ol", "list", "numbered", "ordered", "sequence", "steps"],
      icon: <ListOrdered className="size-4" />,
      command: () =>
        chain().focus().deleteRange(r).toggleOrderedList().run(),
    },
    {
      title: "To-do List",
      section: "Basic blocks",
      shortcut: "[ ]",
      description: "Task list with checkboxes",
      keywords: ["todo", "task", "checklist", "checkbox", "action", "items"],
      icon: <ListChecks className="size-4" />,
      command: () =>
        chain().focus().deleteRange(r).toggleTaskList().run(),
    },
    {
      title: "Quote",
      section: "Basic blocks",
      shortcut: ">",
      description: "Blockquote",
      keywords: ["blockquote", "quote", "callout", "cite", "pullquote"],
      icon: <TextQuote className="size-4" />,
      command: () =>
        chain().focus().deleteRange(r).toggleBlockquote().run(),
    },
    {
      title: "Code",
      section: "Basic blocks",
      shortcut: "```",
      description: "Code block",
      keywords: ["code", "codeblock", "pre", "snippet", "monospace", "fence"],
      icon: <Code className="size-4" />,
      command: () =>
        chain().focus().deleteRange(r).toggleCodeBlock().run(),
    },
    {
      title: "Divider",
      section: "Basic blocks",
      shortcut: "---",
      description: "Horizontal rule",
      keywords: ["hr", "divider", "rule", "separator", "line", "break"],
      icon: <Minus className="size-4" />,
      command: () =>
        chain().focus().deleteRange(r).setHorizontalRule().run(),
    },
    {
      title: "Cards",
      section: "Components",
      description: "Grid of linked cards with icons",
      keywords: ["cards", "card", "grid", "links", "tiles", "cardgroup"],
      icon: <LayoutGrid className="size-4" />,
      command: () =>
        chain()
          .focus()
          .deleteRange(r)
          .insertContent({
            type: "documentCards",
            content: ["Card one", "Card two"].map((title) => ({
              type: "documentCard",
              attrs: { title },
              content: [{ type: "paragraph" }],
            })),
          })
          .run(),
    },
    {
      title: "Tabs",
      section: "Components",
      description: "Switchable tabbed sections",
      keywords: ["tabs", "tab", "sections", "switch", "variants"],
      icon: <PanelTop className="size-4" />,
      command: () =>
        chain()
          .focus()
          .deleteRange(r)
          .insertContent({
            type: "documentTabs",
            content: ["Tab one", "Tab two"].map((title) => ({
              type: "documentTab",
              attrs: { title },
              content: [{ type: "paragraph" }],
            })),
          })
          .run(),
    },
    {
      title: "Table",
      section: "Components",
      description: "Table with a header row — pick its size",
      keywords: ["table", "grid", "rows", "columns", "cells", "spreadsheet"],
      icon: <TableIcon className="size-4" />,
      command: () =>
        chain()
          .focus()
          .deleteRange(r)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
      gridPicker: ({ rows, cols }) =>
        chain()
          .focus()
          .deleteRange(r)
          .insertTable({ rows, cols, withHeaderRow: true })
          .run(),
    },
    {
      title: "Mermaid Diagram",
      section: "Advanced",
      description: "Flowchart, sequence diagram, and more",
      keywords: [
        "mermaid",
        "diagram",
        "flowchart",
        "sequence",
        "graph",
        "architecture",
      ],
      icon: <Workflow className="size-4" />,
      command: () =>
        chain()
          .deleteRange(r)
          .insertContent({
            type: "mermaidDiagram",
            attrs: { source: "" },
          })
          .run(),
    },
    {
      title: "Math Block",
      section: "Advanced",
      description: "Display equation",
      keywords: ["math", "latex", "equation", "formula", "display", "block", "katex"],
      icon: <Sigma className="size-4" />,
      command: () =>
        chain()
          .focus()
          .deleteRange(r)
          .insertContent({ type: "mathBlock", attrs: { latex: "" } })
          .run(),
    },
    {
      title: "Inline Math",
      section: "Advanced",
      description: "Inline equation",
      keywords: ["math", "latex", "equation", "formula", "inline", "katex"],
      icon: <Radical className="size-4" />,
      command: () =>
        chain()
          .focus()
          .deleteRange(r)
          .insertContent({ type: "mathInline", attrs: { latex: "" } })
          .run(),
    },
  ]
}

// ── Extension Options ───────────────────────────────────────────────

interface SlashCommandOptions {
  /**
   * When true (default), the slash menu filters items as the user types.
   * Set to false to restore the legacy "show all items" behavior.
   */
  experimentalFuzzyFilter: boolean
  suggestion: Partial<SuggestionOptions<SlashCommandItem>>
}

// ── Tiptap Extension ────────────────────────────────────────────────

export const SlashCommandExtension = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions(): SlashCommandOptions {
    return {
      experimentalFuzzyFilter: true,
      suggestion: {
        char: "/",
        startOfLine: false,
        command: ({ editor, range, props }) => {
          ;(props as { command: (ctx: { editor: typeof editor; range: typeof range }) => void }).command({ editor, range })
        },
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ]
  },
})

// ── Suggestion render config (used by the editor) ───────────────────

export function createSlashCommandSuggestion(options?: {
  experimentalFuzzyFilter?: boolean
}): Partial<SuggestionOptions<SlashCommandItem>> {
  const experimentalFuzzyFilter = options?.experimentalFuzzyFilter ?? true
  return {
    items: (): SlashCommandItem[] => [],
    render: () => {
      let component: ReactRenderer
      let popup: TippyInstance[]

      return {
        onStart: (props: SuggestionProps<SlashCommandItem>) => {
          const allItems = getSlashCommandItems(
            props.editor,
            props.range,
          )
          const query = props.query ?? ""
          const filteredItems = experimentalFuzzyFilter
            ? filterSlashCommandItems(allItems, query)
            : allItems

          component = new ReactRenderer(SlashCommandMenu, {
            props: { ...props, items: filteredItems },
            editor: props.editor,
          })

          if (!props.clientRect) return

          // Mount on the editor's own <body> so `position: fixed` resolves
          // against the viewport (a transformed/contained ancestor would
          // otherwise offset the menu away from the caret), and carry the
          // editor's theme class over so the menu matches its surroundings.
          const editorDom = props.editor.view.dom
          const ownerDocument = editorDom.ownerDocument
          const theme = editorDom.closest(".dark, .light")
          const container = ownerDocument.createElement("div")
          if (theme) container.className = theme.classList.contains("dark") ? "dark" : "light"
          container.append(component.element)

          const getReferenceClientRect = props.clientRect
          popup = [tippy(ownerDocument.body, {
            getReferenceClientRect: () => getReferenceClientRect() ?? new DOMRect(),
            appendTo: () => ownerDocument.body,
            content: container,
            offset: [0, 6],
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "bottom-start",
            duration: 0,
            popperOptions: {
              strategy: "fixed",
              modifiers: [
                {
                  name: "preventOverflow",
                  options: { boundary: "viewport", padding: 8 },
                },
                {
                  name: "flip",
                  options: { fallbackPlacements: ["top-start", "bottom-start"] },
                },
              ],
            },
          })]
        },

        onUpdate(props: SuggestionProps<SlashCommandItem>) {
          const allItems = getSlashCommandItems(
            props.editor,
            props.range,
          )
          const query = props.query ?? ""
          const filteredItems = experimentalFuzzyFilter
            ? filterSlashCommandItems(allItems, query)
            : allItems

          component.updateProps({ ...props, items: filteredItems })

          if (!props.clientRect) return

          const getReferenceClientRect = props.clientRect
          popup[0].setProps({
            getReferenceClientRect: () => getReferenceClientRect() ?? new DOMRect(),
          })
        },

        onKeyDown(props: SuggestionKeyDownProps): boolean {
          if (props.event.key === "Escape") {
            popup[0].hide()
            return true
          }
          return (component.ref as { onKeyDown?: (props: { event: KeyboardEvent }) => boolean } | null)?.onKeyDown?.({ event: props.event }) ?? false
        },

        onExit() {
          popup[0].destroy()
          component.destroy()
        },
      }
    },
  }
}
