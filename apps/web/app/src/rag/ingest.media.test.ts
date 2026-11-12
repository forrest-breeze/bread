/**
 * Media-reference safety for the HTML→text ingest fallback.
 *
 * Bodies without `content_json` are ingested via `textToProseMirrorDoc` /
 * `planIngestion`. When such a body is sanitized HTML containing an S3 media
 * reference, that literal tag must never reach embedded chunk text.
 *
 * These tests pin that the text-fallback strips `<img>` tags (keeping the alt
 * as `[image: alt]`) and that the ProseMirror image-node path stays empty.
 */
import { describe, expect, it } from "vitest"

import { nodeToText, planIngestion, textToProseMirrorDoc } from "./ingest"

describe("ingest media-reference safety (HTML→text fallback)", () => {
  it("strips <img src=/api/media/...> from text-fallback embedded chunks", () => {
    const body = [
      "# Deploy runbook",
      "",
      "Restart the worker, then check the dashboard:",
      "",
      '<img src="/api/media/abc" alt="diagram">',
      "",
      "Confirm green.",
    ].join("\n")

    const plans = planIngestion(textToProseMirrorDoc(body))
    const allText = plans
      .flatMap((p) => p.chunks.map((c) => c.content))
      .join("\n")

    // The media URL and the raw tag must be gone.
    expect(allText).not.toContain("<img")
    expect(allText).not.toContain("/api/media/abc")
    // Alt text is retained as a marker so the descriptive signal survives.
    expect(allText).toContain("[image: diagram]")
    // Surrounding prose is preserved.
    expect(allText).toContain("Restart the worker")
    expect(allText).toContain("Confirm green.")
  })

  it("drops the alt entirely when it is empty", () => {
    const body = 'Before.\n\n<img src="/api/media/xyz">\n\nAfter.'
    const plans = planIngestion(textToProseMirrorDoc(body))
    const allText = plans
      .flatMap((p) => p.chunks.map((c) => c.content))
      .join("\n")

    expect(allText).not.toContain("/api/media/xyz")
    expect(allText).not.toContain("<img")
    expect(allText).toContain("Before.")
    expect(allText).toContain("After.")
  })

  it("strips playable video tags while retaining their title", () => {
    const body =
      'Before.\n\n<video src="/api/media/video-1" title="Setup walkthrough" controls></video>\n\nAfter.'
    const plans = planIngestion(textToProseMirrorDoc(body))
    const allText = plans
      .flatMap((p) => p.chunks.map((c) => c.content))
      .join("\n")

    expect(allText).not.toContain("<video")
    expect(allText).not.toContain("/api/media/video-1")
    expect(allText).toContain("[video: Setup walkthrough]")
  })

  it("is a no-op for plain/markdown content with no images", () => {
    const body = "# Title\n\nplain paragraph text"
    const plans = planIngestion(textToProseMirrorDoc(body))
    const allText = plans
      .flatMap((p) => p.chunks.map((c) => c.content))
      .join("\n")

    expect(allText).toContain("plain paragraph text")
  })

  it("excludes ProseMirror image nodes from extracted text", () => {
    // The editor (content_json) path: an image node has no text children, so
    // nodeToText must contribute nothing for it.
    const imageNode = {
      type: "image",
      attrs: { src: "/api/media/node-img", alt: "screenshot" },
    }
    expect(nodeToText(imageNode)).toBe("")

    const paragraphWithImage = {
      type: "paragraph",
      content: [{ type: "text", text: "see " }, imageNode],
    }
    const text = nodeToText(paragraphWithImage)
    expect(text).not.toContain("/api/media/node-img")
    expect(text).toContain("see")
  })

  it("excludes ProseMirror video nodes from extracted text", () => {
    expect(
      nodeToText({
        type: "video",
        attrs: { src: "/api/media/node-video", title: "Walkthrough" },
      }),
    ).toBe("")
  })

  it("includes Mermaid source so diagram labels remain searchable", () => {
    expect(
      nodeToText({
        type: "mermaidDiagram",
        attrs: {
          source: "flowchart LR\n  Browser --> API\n  API --> Database",
        },
      }),
    ).toBe("flowchart LR\n  Browser --> API\n  API --> Database")
  })
})
