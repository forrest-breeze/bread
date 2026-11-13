// @vitest-environment happy-dom

import { createRef } from "react"
import { render, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { TiptapEditor, type TiptapEditorRef } from "./tiptap-editor"

const placeholders = () =>
  Array.from(document.querySelectorAll(".breezify-editor [data-placeholder]")).filter(
    (el) => el.getAttribute("data-placeholder"),
  )

describe("TiptapEditor placeholder", () => {
  it("only shows the placeholder on the empty block holding the cursor", async () => {
    const ref = createRef<TiptapEditorRef>()
    render(<TiptapEditor ref={ref} content="<p>hello</p>" />)
    await waitFor(() => expect(ref.current?.getEditor()).toBeTruthy())
    const editor = ref.current!.getEditor()!

    editor.commands.focus("end")
    editor.commands.enter()
    editor.commands.enter()
    editor.commands.enter()
    expect(placeholders()).toHaveLength(1)

    // Move back up into the first empty paragraph.
    editor.commands.setTextSelection(8)
    expect(placeholders()).toHaveLength(1)

    // Cursor on a non-empty paragraph: no placeholder.
    editor.commands.setTextSelection(3)
    expect(placeholders()).toHaveLength(0)
  })
})
