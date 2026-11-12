// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest"
import { Editor } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import {
  MediaImage,
  MediaVideo,
  mediaBlockInsertionPosition,
} from "./media-extension"

const editors: Editor[] = []

function createEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, MediaImage, MediaVideo],
    content,
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

describe("document media Tiptap nodes", () => {
  it("round-trips an authenticated S3 image reference", () => {
    const html = createEditor(
      '<img src="/api/media/image-1" alt="Diagram" title="diagram.png">',
    ).getHTML()

    expect(html).toContain('src="/api/media/image-1"')
    expect(html).toContain('alt="Diagram"')
    expect(html).toContain('loading="lazy"')
  })

  it("round-trips a playable S3 video reference", () => {
    const html = createEditor(
      '<video src="/api/media/video-1" title="demo.mp4" width="1920" height="1080" controls></video>',
    ).getHTML()

    expect(html).toContain("<video")
    expect(html).toContain('src="/api/media/video-1"')
    expect(html).toContain('width="1920"')
    expect(html).toContain('height="1080"')
    expect(html).toContain("controls")
    expect(html).toContain("playsinline")
    expect(html).toContain('preload="metadata"')
  })

  it("moves a pointer inside text to a valid media block boundary", () => {
    const editor = createEditor("<p>Drop inside this paragraph</p>")
    const position = mediaBlockInsertionPosition(editor.state.doc, 5)

    expect(position).toBe(editor.state.doc.content.size)
    expect(
      editor
        .chain()
        .insertContentAt(position, {
          type: "video",
          attrs: { src: "/api/media/video-1", title: "demo.mp4" },
        })
        .run(),
    ).toBe(true)
    expect(editor.getHTML()).toContain('src="/api/media/video-1"')
  })

  it("keeps an existing top-level boundary unchanged", () => {
    const editor = createEditor("<p>First</p><p>Second</p>")
    const firstNodeSize = editor.state.doc.firstChild?.nodeSize ?? 0

    expect(
      mediaBlockInsertionPosition(editor.state.doc, firstNodeSize),
    ).toBe(firstNodeSize)
  })
})
