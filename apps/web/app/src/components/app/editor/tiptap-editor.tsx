"use client"

import { useEditor, EditorContent, type Editor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { HeadingWithId } from "@/tiptap/extensions/heading-with-id"
import { PageBreak } from "@/tiptap/extensions/page-break"
import { DiffHighlight } from "@/tiptap/extensions/diff-highlight"
import { CursorPlaceholder } from "./cursor-placeholder"
import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"
import Link from "@tiptap/extension-link"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { TableKit } from "@tiptap/extension-table"
import { renderDocumentHtml } from "@/lib/render-document-html"
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model"
import { Markdown } from "tiptap-markdown"
import { common, createLowlight } from "lowlight"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react"
import { AlertCircle, Loader2 } from "lucide-react"
import {
  SlashCommandExtension,
  createSlashCommandSuggestion,
} from "./slash-command"
import { BubbleToolbar } from "./bubble-toolbar"
import { BlockHandle } from "./block-handle"
import { TableCellMenu } from "./table-cell-menu"
import { MathBlock, MathInline } from "./math-extension"
import {
  EditableDocumentCard,
  EditableDocumentCards,
  EditableDocumentTab,
  EditableDocumentTabs,
} from "./document-blocks-views"
import { MermaidDiagram } from "./mermaid-extension"
import {
  MediaImage,
  MediaVideo,
  mediaBlockInsertionPosition,
} from "./media-extension"
import { cn } from "@/lib/utils"
import { uploadDocumentMedia } from "@/lib/api/document-media"
import { embeddableMediaKind } from "@/lib/storage/media-upload-policy"
import "@/styles/document-blocks.css"

// Markdown or stored HTML containing tab/card directives (MDX or `{% %}` form).
const DIRECTIVE_SOURCE = /{%\s*(?:tabs|cards)\s*%}|<(?:Tabs|CardGroup|Cards)[\s>]/
const lowlight = createLowlight(common)

export interface TiptapEditorRef {
  focus: () => void
  getEditor: () => Editor | null
}

interface TiptapEditorProps {
  content?: string
  onUpdate?: (html: string) => void
  onJSONUpdate?: (json: Record<string, unknown>) => void
  /**
   * Fires after the editor normalizes initial content (e.g. markdown → HTML
   * or heading nodeId assignment). The parent should sync its mirror state
   * without marking the doc dirty, so the outline reflects what Tiptap
   * actually rendered.
   */
  onNormalize?: (html: string) => void
  /**
   * Fires once the editor instance exists and its initial content has been
   * normalized, with that normalized HTML. Lets a parent capture a stable
   * baseline at the right moment (needed because `immediatelyRender` is false
   * for SSR, so the editor isn't available during the first render).
   */
  onCreate?: (html: string) => void
  editable?: boolean
  autoFocus?: boolean
  /** Enables S3-backed image/video uploads for a persisted document. */
  documentId?: string
  /**
   * When set, blocks whose text differs from this baseline document are
   * highlighted inline (see DiffHighlight). Used by proposal review to show the
   * changes a librarian proposal makes against the live document.
   */
  diffBaseline?: string
}

export const TiptapEditor = forwardRef<TiptapEditorRef, TiptapEditorProps>(
  (
    {
      content = "",
      onUpdate,
      onJSONUpdate,
      onNormalize,
      onCreate,
      editable = true,
      autoFocus = false,
      documentId,
      diffBaseline,
    },
    ref,
  ) => {
    // Track whether we're doing an external content sync to avoid echo
    const suppressUpdateRef = useRef(false)
    const [mediaUpload, setMediaUpload] = useState<
      | { state: "idle" }
      | { state: "uploading"; fileName: string }
      | { state: "error"; message: string }
    >({ state: "idle" })

    const editor = useEditor({
      // Must be false under Next.js SSR — `true` throws a hydration error.
      immediatelyRender: false,
      extensions: [
        EditableDocumentTabs,
        EditableDocumentTab,
        EditableDocumentCards,
        EditableDocumentCard,
        StarterKit.configure({
          heading: false,
          codeBlock: false,
          link: false,
        }),
        HeadingWithId.configure({ levels: [1, 2, 3] }).extend({
          addKeyboardShortcuts() {
            const exitEmptyHeading = (): boolean => {
              if (!this.editor.isActive("heading")) return false
              const { $head, empty } = this.editor.state.selection
              if (!empty) return false
              if ($head.parent.content.size !== 0) return false
              return this.editor.commands.setParagraph()
            }

            return {
              ...this.parent?.(),
              Enter: exitEmptyHeading,
              Backspace: exitEmptyHeading,
            }
          },
        }),
        CodeBlockLowlight.configure({
          lowlight,
          defaultLanguage: "plaintext",
        }),
        Markdown.configure({
          html: true,
          transformPastedText: true,
          transformCopiedText: true,
        }),
        Link.configure({
          openOnClick: false,
          HTMLAttributes: {
            rel: "noopener noreferrer nofollow",
            class: null,
          },
        }),
        CursorPlaceholder.configure({
          placeholder: ({ editor: e, node, pos }) => {
            if (node.type.name === "paragraph") {
              // `pos` can come from a doc newer than `e.state.doc` while
              // setContent is mid-transaction; treat that as "unknown parent".
              const doc = e.state.doc
              if (pos < 0 || pos > doc.content.size) return ""
              const parent = doc.resolve(pos).parent.type.name
              if (parent === "documentCard") return "Add a description"
              if (parent === "documentTab") return "Tab content…"
              // Nested placeholders are on (for card/tab bodies); keep other
              // nested paragraphs (lists, quotes, table cells) quiet.
              if (parent !== "doc") return ""
            }
            if (node.type.name === "heading") {
              const level = Math.min(node.attrs?.level || 1, 3)
              return `Heading ${level}`
            }
            if (
              node.type.name === "bulletList" ||
              node.type.name === "orderedList" ||
              node.type.name === "listItem" ||
              node.type.name === "taskList" ||
              node.type.name === "taskItem" ||
              node.type.name === "blockquote" ||
              node.type.name === "codeBlock"
            ) {
              return ""
            }
            // First paragraph: show a hint about slash commands
            if (pos === 0) return "Start writing, or press / for commands..."
            return "Type / for commands..."
          },
          showOnlyWhenEditable: true,
          includeChildren: true,
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        // Without table nodes in the schema, ProseMirror's DOMParser drops the
        // <table>/<tr>/<td> wrappers that tiptap-markdown (markdown-it, GFM
        // tables on) produces and flattens every cell into one paragraph; the
        // normalize pass then persists that flattened HTML. Column resizing
        // stays off: tables arrive from Markdown and are edited with Tab /
        // Enter, and the read-only renderers do not need per-column widths.
        TableKit.configure({
          table: { resizable: false },
        }),
        MediaImage,
        MediaVideo,
        MathBlock,
        MathInline,
        MermaidDiagram,
        PageBreak,
        SlashCommandExtension.configure({
          suggestion: createSlashCommandSuggestion(),
        }),
        ...(diffBaseline !== undefined
          ? [DiffHighlight.configure({ baseline: diffBaseline })]
          : []),
      ],
      content: DIRECTIVE_SOURCE.test(content) ? renderDocumentHtml(content) : content,
      editable,
      editorProps: {
        attributes: {
          class: "bread-editor outline-none",
        },
        // tiptap-markdown doesn't know tab/card directives and would flatten
        // them into text; render them ourselves when pasted as plain text.
        handlePaste: (view, event) => {
          const text = event.clipboardData?.getData("text/plain") ?? ""
          if (!DIRECTIVE_SOURCE.test(text)) return false
          const html = renderDocumentHtml(text)
          if (!/data-document-(?:tabs|cards)=/.test(html)) return false
          const container = document.createElement("div")
          container.innerHTML = html
          const slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(container)
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
          return true
        },
      },
      onCreate: ({ editor: e }) => {
        onCreate?.(e.getHTML())
      },
      onUpdate: ({ editor: e }) => {
        if (suppressUpdateRef.current) return
        onUpdate?.(e.getHTML())
        onJSONUpdate?.(e.getJSON() as Record<string, unknown>)
      },
    })

    const uploadMediaFiles = useCallback(
      async (files: File[], insertAt?: number): Promise<void> => {
        if (!editor || !editable || !documentId || files.length === 0) return

        let nextPosition = insertAt
        for (const file of files) {
          const kind = embeddableMediaKind(file.type)
          if (!kind) {
            setMediaUpload({
              state: "error",
              message:
                "Use a PNG, JPEG, WebP, GIF, AVIF, MP4, WebM, or MOV file.",
            })
            continue
          }

          try {
            setMediaUpload({ state: "uploading", fileName: file.name })
            const media = await uploadDocumentMedia(documentId, file)
            const node =
              media.kind === "image"
                ? {
                    type: "image",
                    attrs: {
                      src: media.src,
                      alt: file.name.replace(/\.[^.]+$/, ""),
                      title: file.name,
                      width: media.width,
                      height: media.height,
                    },
                  }
                : {
                    type: "video",
                    attrs: {
                      src: media.src,
                      title: file.name,
                      width: media.width,
                      height: media.height,
                    },
                  }

            let inserted: boolean
            if (typeof nextPosition === "number") {
              const position = mediaBlockInsertionPosition(
                editor.state.doc,
                nextPosition,
              )
              inserted = editor
                .chain()
                .focus()
                .insertContentAt(position, node)
                .run()
              nextPosition = position + 1
            } else {
              inserted = editor.chain().focus().insertContent(node).run()
            }

            // A stale pointer position should never strand a successfully
            // uploaded object. Fall back to the document end, and surface a
            // visible error if ProseMirror still refuses the node.
            if (!inserted) {
              inserted = editor
                .chain()
                .focus("end")
                .insertContent(node)
                .run()
            }
            if (!inserted) {
              throw new Error(
                "The media uploaded but could not be inserted into this document. Try again at the end of the document.",
              )
            }
            setMediaUpload({ state: "idle" })
          } catch (error) {
            setMediaUpload({
              state: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "The media upload failed.",
            })
          }
        }
      },
      [documentId, editable, editor],
    )

    const blockAreaRef = useRef<HTMLDivElement>(null)

    useImperativeHandle(ref, () => ({
      focus: () => {
        editor?.commands.focus()
      },
      getEditor: () => editor,
    }))

    // Sync external content changes (e.g. when switching documents)
    useEffect(() => {
      if (editor && content !== editor.getHTML()) {
        suppressUpdateRef.current = true
        // Use setTimeout to move the setContent call out of the current render/effect cycle
        // and avoid the "flushSync was called from inside a lifecycle method" warning.
        const t = setTimeout(() => {
          editor.commands.setContent(DIRECTIVE_SOURCE.test(content) ? renderDocumentHtml(content) : content)
          suppressUpdateRef.current = false
          // Tiptap may normalize the content (parse markdown, assign heading
          // nodeIds, etc.). Surface the normalized HTML so the parent's
          // mirror state — and anything derived from it like the outline —
          // reflects what the editor actually rendered.
          const normalized = editor.getHTML()
          if (normalized !== content) {
            onNormalize?.(normalized)
          }
        }, 0)
        return () => clearTimeout(t)
      }
    }, [content, editor, onNormalize])

    useEffect(() => {
      if (editor) editor.setEditable(editable)
    }, [editable, editor])

    // Paste and drag/drop use the same direct-to-S3 path as the toolbar. Event
    // capture runs before ProseMirror's own handlers so binary files are not
    // accidentally interpreted as inline data URLs.
    useEffect(() => {
      if (!editor || !editable || !documentId) return
      const dom = editor.view.dom

      const mediaFiles = (list: FileList | null): File[] =>
        Array.from(list ?? []).filter((file) =>
          Boolean(embeddableMediaKind(file.type)),
        )

      const handlePaste = (event: ClipboardEvent): void => {
        const files = mediaFiles(event.clipboardData?.files ?? null)
        if (files.length === 0) return
        event.preventDefault()
        void uploadMediaFiles(files)
      }
      const handleDragOver = (event: DragEvent): void => {
        if (!event.dataTransfer?.types.includes("Files")) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }
      const handleDrop = (event: DragEvent): void => {
        const files = mediaFiles(event.dataTransfer?.files ?? null)
        if (files.length === 0) return
        event.preventDefault()
        const coordinates = editor.view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        })
        void uploadMediaFiles(files, coordinates?.pos)
      }

      dom.addEventListener("paste", handlePaste, true)
      dom.addEventListener("dragover", handleDragOver, true)
      dom.addEventListener("drop", handleDrop, true)
      return () => {
        dom.removeEventListener("paste", handlePaste, true)
        dom.removeEventListener("dragover", handleDragOver, true)
        dom.removeEventListener("drop", handleDrop, true)
      }
    }, [documentId, editable, editor, uploadMediaFiles])

    // Auto-focus at end of content without scrolling the viewport
    // (scrollIntoView:false prevents jumping to the end of long docs on open)
    useEffect(() => {
      if (!editor || !autoFocus) return
      const t = setTimeout(() => {
        editor.commands.focus("end", { scrollIntoView: false })
      }, 0)
      return () => clearTimeout(t)
    }, [editor, autoFocus])

    if (!editor) return null

    return (
      <div className="w-full">
        {editable && documentId && mediaUpload.state !== "idle" && (
          <div className="mb-3 flex min-h-8 flex-wrap items-center gap-1.5">
            {mediaUpload.state === "uploading" && (
              <span
                role="status"
                className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span className="max-w-56 truncate">
                  Uploading {mediaUpload.fileName} to S3…
                </span>
              </span>
            )}
            {mediaUpload.state === "error" && (
              <span
                role="alert"
                className="inline-flex items-center gap-1.5 text-xs text-destructive"
              >
                <AlertCircle className="size-3.5 shrink-0" />
                {mediaUpload.message}
              </span>
            )}
          </div>
        )}
        <BubbleToolbar editor={editor} />
        {/* The ::before strip extends the hover area into the left gutter so
            the block handle stays put while the pointer travels to it. */}
        <div
          ref={blockAreaRef}
          className={cn(
            "relative",
            editable && "before:absolute before:inset-y-0 before:-left-16 before:w-16 before:content-['']",
          )}
        >
          {editable && <BlockHandle editor={editor} wrapperRef={blockAreaRef} />}
          {editable && <TableCellMenu editor={editor} wrapperRef={blockAreaRef} />}
          <EditorContent editor={editor} />
        </div>
      </div>
    )
  }
)

TiptapEditor.displayName = "TiptapEditor"
