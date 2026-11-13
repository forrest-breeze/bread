// @vitest-environment happy-dom

import { render, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TiptapEditor } from "./tiptap-editor"

// A GFM table as it arrives from a Markdown paste or a captured body.
const MARKDOWN_TABLE = [
  "| Program | Window | Deal |",
  "|---|---|---|",
  "| **LeapYear** | Deadline Oct 8 | See site |",
  "| YC (W27) | est. late Oct | $500K |",
].join("\n")

function cellTexts(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector)).map((cell) =>
    (cell.textContent ?? "").trim(),
  )
}

describe("TiptapEditor tables", () => {
  it("keeps a Markdown table as a table instead of flattening its cells", async () => {
    const onCreate = vi.fn()
    render(<TiptapEditor content={MARKDOWN_TABLE} onCreate={onCreate} />)

    await waitFor(() => {
      expect(document.querySelector(".breezify-editor table")).not.toBeNull()
    })

    expect(cellTexts(".breezify-editor th")).toEqual(["Program", "Window", "Deal"])
    expect(cellTexts(".breezify-editor td")).toEqual([
      "LeapYear",
      "Deadline Oct 8",
      "See site",
      "YC (W27)",
      "est. late Oct",
      "$500K",
    ])
    expect(document.querySelector(".breezify-editor td strong")?.textContent).toBe(
      "LeapYear",
    )
    // The pipes and the delimiter row are Markdown syntax, not content.
    expect(document.querySelector(".breezify-editor")?.textContent).not.toContain("|")

    // What the parent receives (and persists) is the table, not a paragraph.
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    const html = onCreate.mock.calls[0][0] as string
    expect(html).toContain("<table")
    expect(html).toContain("<th")
    expect(html).toContain("<strong>LeapYear</strong>")
    expect(html).not.toContain("<p>Program Window Deal")
  })

  it("inserts a table from the slash menu", async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    render(<TiptapEditor content="" onUpdate={onUpdate} />)

    await waitFor(() => {
      expect(document.querySelector(".breezify-editor")).not.toBeNull()
    })
    const editor = document.querySelector<HTMLElement>(".breezify-editor")
    expect(editor).not.toBeNull()
    if (!editor) return

    await user.click(editor)
    await user.type(editor, "/table")
    await user.keyboard("{Enter}")

    // Enter opens the size grid (3 × 3 preselected); a second Enter inserts.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="table-grid-picker"]')).not.toBeNull()
    })
    await user.keyboard("{Enter}")

    await waitFor(() => {
      expect(document.querySelectorAll(".breezify-editor tr")).toHaveLength(3)
      expect(document.querySelectorAll(".breezify-editor th")).toHaveLength(3)
      expect(document.querySelectorAll(".breezify-editor td")).toHaveLength(6)
    })
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(expect.stringContaining("<table"))
    })
  })

  it("inserts a custom-size table from the slash menu grid", async () => {
    const user = userEvent.setup()
    render(<TiptapEditor content="" />)

    await waitFor(() => {
      expect(document.querySelector(".breezify-editor")).not.toBeNull()
    })
    const editor = document.querySelector<HTMLElement>(".breezify-editor")
    if (!editor) throw new Error("editor missing")

    await user.click(editor)
    await user.type(editor, "/table")
    await user.keyboard("{Enter}")
    await waitFor(() => {
      expect(document.querySelector('[data-testid="table-grid-picker"]')).not.toBeNull()
    })

    // 3×3 → 5 cols × 4 rows
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowDown}{Enter}")

    await waitFor(() => {
      expect(document.querySelectorAll(".breezify-editor tr")).toHaveLength(4)
      expect(document.querySelectorAll(".breezify-editor th")).toHaveLength(5)
      expect(document.querySelectorAll(".breezify-editor td")).toHaveLength(15)
    })
  })

  it("edits rows, columns and the table from the cell menu", async () => {
    const user = userEvent.setup()
    render(<TiptapEditor content="" />)
    await waitFor(() => expect(document.querySelector(".breezify-editor")).not.toBeNull())
    const editor = document.querySelector<HTMLElement>(".breezify-editor")
    if (!editor) throw new Error("editor missing")

    await user.click(editor)
    await user.type(editor, "/table")
    await user.keyboard("{Enter}{Enter}")
    await waitFor(() => expect(document.querySelectorAll(".breezify-editor tr")).toHaveLength(3))

    const openMenu = async () => {
      const button = await waitFor(() => {
        const b = document.querySelector<HTMLElement>('[aria-label="Table options"]')
        if (!b) throw new Error("menu button missing")
        return b
      })
      await user.click(button)
    }
    const choose = async (label: string) => {
      await openMenu()
      const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (el) => el.textContent === label,
      )
      if (!item) throw new Error(`no menu item ${label}`)
      await user.click(item)
    }

    await choose("Insert row below")
    await waitFor(() => expect(document.querySelectorAll(".breezify-editor tr")).toHaveLength(4))
    await choose("Delete column")
    await waitFor(() => expect(document.querySelectorAll(".breezify-editor tr:first-child > *")).toHaveLength(2))
    await choose("Delete row")
    await waitFor(() => expect(document.querySelectorAll(".breezify-editor tr")).toHaveLength(3))
    await choose("Delete table")
    await waitFor(() => expect(document.querySelector(".breezify-editor table")).toBeNull())
    expect(document.querySelector('[aria-label="Table options"]')).toBeNull()
  })
})
