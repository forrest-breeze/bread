// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TiptapEditor } from "./tiptap-editor"

const { mockUploadDocumentMedia } = vi.hoisted(() => ({
  mockUploadDocumentMedia: vi.fn(),
}))

vi.mock("@/lib/api/document-media", () => ({
  uploadDocumentMedia: mockUploadDocumentMedia,
}))

describe("TiptapEditor document media drag and drop", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("does not show an insertion toolbar for persisted documents", async () => {
    render(
      <TiptapEditor
        documentId="550e8400-e29b-41d4-a716-446655440000"
        content="<p>Body</p>"
      />,
    )
    await waitFor(() => {
      expect(document.querySelector(".bread-editor")).not.toBeNull()
    })
    expect(screen.queryByRole("button", { name: "Image" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Video" })).toBeNull()
    expect(screen.queryByLabelText("Upload image or video")).toBeNull()
  })

  it("uploads a dropped image and inserts its stable authenticated media URL", async () => {
    mockUploadDocumentMedia.mockResolvedValue({
      id: "media-1",
      src: "/api/media/media-1",
      kind: "image",
      mime: "image/png",
      width: 1200,
      height: 800,
    })
    const onUpdate = vi.fn()
    render(
      <TiptapEditor
        documentId="550e8400-e29b-41d4-a716-446655440000"
        content="<p>Body</p>"
        onUpdate={onUpdate}
      />,
    )

    await waitFor(() => {
      expect(document.querySelector(".bread-editor")).not.toBeNull()
    })
    const editor = document.querySelector<HTMLElement>(".bread-editor")
    expect(editor).not.toBeNull()
    if (!editor) return
    const file = new File(["image"], "architecture.png", {
      type: "image/png",
    })
    fireEvent.drop(editor, { dataTransfer: { files: [file] } })

    await waitFor(() => {
      expect(mockUploadDocumentMedia).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440000",
        file,
      )
      expect(
        document.querySelector('img[src="/api/media/media-1"]'),
      ).not.toBeNull()
      const image = document.querySelector<HTMLImageElement>(
        'img[src="/api/media/media-1"]',
      )
      expect(image?.getAttribute("width")).toBe("1200")
      expect(image?.getAttribute("height")).toBe("800")
    })
    expect(onUpdate).toHaveBeenCalledWith(
      expect.stringContaining('src="/api/media/media-1"'),
    )
  })

  it("inserts a playable video node after a drop", async () => {
    mockUploadDocumentMedia.mockResolvedValue({
      id: "media-video",
      src: "/api/media/media-video",
      kind: "video",
      mime: "video/mp4",
      width: 1920,
      height: 1080,
    })
    render(
      <TiptapEditor
        documentId="550e8400-e29b-41d4-a716-446655440000"
        content="<p>Body</p>"
      />,
    )

    await waitFor(() => {
      expect(document.querySelector(".bread-editor")).not.toBeNull()
    })
    const editor = document.querySelector<HTMLElement>(".bread-editor")
    expect(editor).not.toBeNull()
    if (!editor) return
    fireEvent.drop(editor, {
      dataTransfer: {
        files: [new File(["video"], "demo.mp4", { type: "video/mp4" })],
      },
    })

    await waitFor(() => {
      const video = document.querySelector<HTMLVideoElement>(
        'video[src="/api/media/media-video"]',
      )
      expect(video).not.toBeNull()
      expect(video?.hasAttribute("controls")).toBe(true)
      expect(video?.getAttribute("preload")).toBe("metadata")
      expect(video?.getAttribute("width")).toBe("1920")
      expect(video?.getAttribute("height")).toBe("1080")
    })
  })
})
