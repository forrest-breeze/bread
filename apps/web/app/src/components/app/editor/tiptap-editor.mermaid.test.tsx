// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TiptapEditor } from "./tiptap-editor"
import { renderMermaidInElement } from "./mermaid-extension"

const { mockInitialize, mockRender } = vi.hoisted(() => ({
  mockInitialize: vi.fn(),
  mockRender: vi.fn().mockResolvedValue({
    svg: '<svg role="graphics-document"><text>Diagram</text></svg>',
  }),
}))

vi.mock("mermaid", () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}))

describe("TiptapEditor Mermaid controls", () => {
  it("renders imported Markdown Mermaid fences in the editor", async () => {
    const { container } = render(<TiptapEditor content={'```mermaid\nsequenceDiagram\nA->>B: Ping\n```'} />)
    await waitFor(() => expect(container.querySelector(".mermaid-svg svg")).not.toBeNull())
    expect(container.querySelector(".breezify-editor > pre")).toBeNull()
  })

  it.each(["mermaid", "plaintext"])("renders imported %s code in the reading view", async (language) => {
    const container = document.createElement("div")
    container.innerHTML = `<pre><code class="language-${language}">sequenceDiagram\nA-&gt;&gt;B: Ping</code></pre><pre><code>ordinary code</code></pre>`
    await renderMermaidInElement(container)
    expect(container.querySelector('.mermaid-static-render svg')).not.toBeNull()
    expect(container.querySelectorAll("pre")).toHaveLength(1)
    expect(container.querySelector("pre")?.textContent).toBe("ordinary code")
  })

  it("preserves imported source if rendering fails", async () => {
    mockRender.mockRejectedValueOnce(new Error("Invalid diagram"))
    const container = document.createElement("div")
    container.innerHTML = '<pre><code class="language-mermaid">invalid</code></pre>'
    await renderMermaidInElement(container)
    expect(container.querySelector("pre")?.textContent).toBe("invalid")
  })

  it("inserts and persists a Mermaid diagram from the slash menu", async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    render(
      <TiptapEditor
        content=""
        onUpdate={onUpdate}
      />,
    )

    await waitFor(() => {
      expect(document.querySelector(".breezify-editor")).not.toBeNull()
    })
    const editor = document.querySelector<HTMLElement>(".breezify-editor")
    expect(editor).not.toBeNull()
    if (!editor) return

    await user.click(editor)
    await user.type(editor, "/mermaid")
    await user.keyboard("{Enter}")

    const sourceInput = await screen.findByLabelText("Mermaid diagram source")
    const source = "flowchart LR\n  Browser --> API"
    fireEvent.change(sourceInput, { target: { value: source } })

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        expect.stringContaining('data-type="mermaid-diagram"'),
      )
      expect(onUpdate).toHaveBeenCalledWith(
        expect.stringContaining("Browser --&gt; API"),
      )
    })
  })

  it("keeps Mermaid available while filtering the slash menu", async () => {
    const user = userEvent.setup()
    render(<TiptapEditor content="" />)

    await waitFor(() => {
      expect(document.querySelector(".breezify-editor")).not.toBeNull()
    })
    const editor = document.querySelector<HTMLElement>(".breezify-editor")
    expect(editor).not.toBeNull()
    if (!editor) return

    await user.click(editor)
    await user.type(editor, "/mermaid")

    expect(await screen.findByText("Mermaid Diagram")).toBeInTheDocument()
    expect(screen.queryByText("Image", { exact: true })).toBeNull()
    expect(screen.queryByText("Video", { exact: true })).toBeNull()

    await user.keyboard("{Enter}")
    expect(
      await screen.findByLabelText("Mermaid diagram source"),
    ).toBeInTheDocument()
    expect(editor.textContent).not.toContain("/mermaid")
  })

  it("renders saved diagrams in read-only HTML with strict security", async () => {
    const container = document.createElement("div")
    container.innerHTML =
      '<div data-type="mermaid-diagram" data-source="flowchart TD&#10;A--&gt;B"><pre data-mermaid-fallback><code>flowchart TD\nA--&gt;B</code></pre></div>'

    await renderMermaidInElement(container)

    expect(mockInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        startOnLoad: false,
      }),
    )
    expect(mockRender).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-static-/),
      "flowchart TD\nA-->B",
    )
    expect(container.querySelector("svg")).not.toBeNull()
    expect(
      container.querySelector('[data-type="mermaid-diagram"]'),
    ).toHaveAttribute("role", "img")
  })
})
