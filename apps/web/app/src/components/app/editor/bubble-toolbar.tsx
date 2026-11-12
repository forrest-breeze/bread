"use client"

import { BubbleMenu } from "@tiptap/react/menus"
import type { Editor } from "@tiptap/react"
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link,
  Unlink,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useCallback, useState } from "react"
import { AppTooltip } from "@/components/ui/tooltip"

interface BubbleToolbarProps {
  editor: Editor
}

function ToolbarButton({
  onClick,
  isActive,
  label,
  shortcut,
  children,
}: {
  onClick: () => void
  isActive: boolean
  label: string
  shortcut?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <AppTooltip label={label} shortcut={shortcut} sideOffset={10}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={isActive}
        className={cn(
          "flex size-7 items-center justify-center rounded text-sm transition-colors",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground"
        )}
      >
        {children}
      </button>
    </AppTooltip>
  )
}

export function BubbleToolbar({ editor }: BubbleToolbarProps): React.ReactElement {
  const [linkInput, setLinkInput] = useState("")
  const [showLinkInput, setShowLinkInput] = useState(false)

  const setLink = useCallback(() => {
    if (!linkInput) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run()
      setShowLinkInput(false)
      return
    }

    const url = linkInput.startsWith("http") ? linkInput : `https://${linkInput}`
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
    setLinkInput("")
    setShowLinkInput(false)
  }, [editor, linkInput])

  const openLinkInput = useCallback(() => {
    const existingHref = editor.getAttributes("link").href as string | undefined
    setLinkInput(existingHref || "")
    setShowLinkInput(true)
  }, [editor])

  return (
    <BubbleMenu
      editor={editor}
      options={{
        placement: "top",
        offset: { mainAxis: 8 },
      }}
      className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      {showLinkInput ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setLink()
          }}
          className="flex items-center gap-1"
        >
          <input
            type="text"
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            placeholder="Paste link..."
            className="h-7 w-40 rounded border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/50 focus:border-primary"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setShowLinkInput(false)
                editor.commands.focus()
              }
            }}
          />
          <button
            type="submit"
            className="flex h-7 items-center rounded bg-primary px-2 text-[11px] font-medium text-primary-foreground"
          >
            Set
          </button>
        </form>
      ) : (
        <>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            isActive={editor.isActive("bold")}
            label="Bold"
            shortcut="⌘B"
          >
            <Bold className="size-3.5" />
          </ToolbarButton>

          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            isActive={editor.isActive("italic")}
            label="Italic"
            shortcut="⌘I"
          >
            <Italic className="size-3.5" />
          </ToolbarButton>

          <ToolbarButton
            onClick={() => editor.chain().focus().toggleStrike().run()}
            isActive={editor.isActive("strike")}
            label="Strikethrough"
          >
            <Strikethrough className="size-3.5" />
          </ToolbarButton>

          <ToolbarButton
            onClick={() => editor.chain().focus().toggleCode().run()}
            isActive={editor.isActive("code")}
            label="Inline code"
          >
            <Code className="size-3.5" />
          </ToolbarButton>

          <div className="mx-0.5 h-4 w-px bg-border" />

          {editor.isActive("link") ? (
            <ToolbarButton
              onClick={() =>
                editor.chain().focus().extendMarkRange("link").unsetLink().run()
              }
              isActive={false}
              label="Remove link"
            >
              <Unlink className="size-3.5" />
            </ToolbarButton>
          ) : (
            <ToolbarButton onClick={openLinkInput} isActive={false} label="Add link">
              <Link className="size-3.5" />
            </ToolbarButton>
          )}
        </>
      )}
    </BubbleMenu>
  )
}
