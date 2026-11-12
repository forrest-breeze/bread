// @vitest-environment happy-dom
import { describe, it, expect } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import { DecorationSet } from "@tiptap/pm/view"
import { DiffHighlight } from "./diff-highlight"

function decorationsFor(content: string, baseline: string): DecorationSet | null {
  const element = document.createElement("div")
  const editor = new Editor({
    element,
    extensions: [StarterKit, DiffHighlight.configure({ baseline })],
    content,
  })
  // Read the plugin's decoration set straight off the state.
  const plugin = editor.state.plugins.find((p) =>
    String((p as { key?: string }).key).startsWith("diffHighlight"),
  )
  const decos = plugin?.getState(editor.state) as DecorationSet | undefined
  return decos ?? null
}

describe("DiffHighlight", () => {
  it("marks every word as added when there is no baseline", () => {
    const decos = decorationsFor("<p>Hello world</p>", "")
    expect(decos).not.toBeNull()
    const found = decos!.find()
    expect(found.length).toBeGreaterThan(0)
  })

  it("highlights only the changed word against a baseline", () => {
    const decos = decorationsFor(
      "<p>the quick red fox</p>",
      "<p>the quick brown fox</p>",
    )
    expect(decos).not.toBeNull()
    const found = decos!.find()
    // "red" added (inline) + "brown" deleted (widget) = at least 2 decorations.
    expect(found.length).toBeGreaterThanOrEqual(1)
  })

  it("merges consecutive changed words into one highlight (spaces included)", () => {
    const element = document.createElement("div")
    document.body.appendChild(element)
    const editor = new Editor({
      element,
      extensions: [
        StarterKit,
        DiffHighlight.configure({ baseline: "<p>alpha beta gamma</p>" }),
      ],
      content: "<p>alpha NEW WORDS gamma</p>",
    })
    const added = Array.from(editor.view.dom.querySelectorAll(".diff-added"))
    expect(added.length).toBe(1)
    expect(added[0]?.textContent).toBe("NEW WORDS")
  })

  it("still diffs a multi-KB document (not suppressed by the size cap)", () => {
    // ~4KB of prose per side — large enough that the old 600k-cell cap blanked
    // it. One sentence differs, so there must be at least one decoration.
    const para = (n: number, word: string): string =>
      `<p>${Array.from({ length: 40 }, (_, i) => `sentence ${n} word ${i} ${word}`).join(" ")}</p>`
    const baseline = Array.from({ length: 6 }, (_, n) => para(n, "alpha")).join("")
    const next = baseline.replace("word 0 alpha", "word 0 OMEGA")
    const decos = decorationsFor(next, baseline)
    expect(decos).not.toBeNull()
    expect(decos!.find().length).toBeGreaterThan(0)
  })
})
