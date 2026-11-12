import { describe, it, expect } from "vitest"
import {
  MEDIA_API_PATH,
  PUBLIC_MEDIA_API_PATH,
  mediaApiUrl,
  publicMediaApiUrl,
  mediaImgHtml,
  mediaVideoHtml,
  rewriteMediaForPublic,
  stripImgTagsToText,
  stripMediaTagsToText,
  extractMediaIds,
} from "@/lib/storage/media-refs"

describe("url builders", () => {
  it("builds authenticated and public media urls", () => {
    expect(mediaApiUrl("abc-123")).toBe("/api/media/abc-123")
    expect(publicMediaApiUrl("abc-123")).toBe("/api/public/media/abc-123")
    expect(MEDIA_API_PATH).toBe("/api/media/")
    expect(PUBLIC_MEDIA_API_PATH).toBe("/api/public/media/")
  })
})

describe("mediaImgHtml", () => {
  it("builds a sanitizer-safe <img> with a relative src", () => {
    expect(mediaImgHtml("id1", "a diagram")).toBe(
      '<img src="/api/media/id1" alt="a diagram">',
    )
  })

  it("escapes alt to avoid attribute breakout", () => {
    expect(mediaImgHtml("id1", 'x" onerror="alert(1)')).toBe(
      '<img src="/api/media/id1" alt="x&quot; onerror=&quot;alert(1)">',
    )
  })
})

describe("mediaVideoHtml", () => {
  it("builds a playable, sanitizer-safe video tag", () => {
    expect(mediaVideoHtml("id2", "Product tour")).toBe(
      '<video src="/api/media/id2" title="Product tour" controls playsinline preload="metadata"></video>',
    )
  })

  it("escapes title attributes", () => {
    expect(mediaVideoHtml("id2", 'x" onerror="alert(1)')).toContain(
      'title="x&quot; onerror=&quot;alert(1)"',
    )
  })
})

describe("rewriteMediaForPublic — public render surface", () => {
  it("swaps the authenticated path for the public one", () => {
    const html = '<img src="/api/media/xyz" alt="d">'
    expect(rewriteMediaForPublic(html)).toBe(
      '<img src="/api/public/media/xyz" alt="d">',
    )
  })

  it("leaves already-public refs untouched (no double rewrite)", () => {
    const html = '<img src="/api/public/media/xyz" alt="d">'
    expect(rewriteMediaForPublic(html)).toBe(html)
  })

  it("rewrites multiple imgs and preserves surrounding html", () => {
    const html =
      '<p>a</p><img src="/api/media/a"><p>b</p><img src="/api/media/b">'
    expect(rewriteMediaForPublic(html)).toBe(
      '<p>a</p><img src="/api/public/media/a"><p>b</p><img src="/api/public/media/b">',
    )
  })

  it("rewrites video sources through the same public media gate", () => {
    const html =
      '<video src="/api/media/video-1" controls preload="metadata"></video>'
    expect(rewriteMediaForPublic(html)).toContain(
      'src="/api/public/media/video-1"',
    )
  })

  it("ignores unrelated urls", () => {
    const html = '<a href="/api/documents/1">x</a><img src="https://x/y.png">'
    expect(rewriteMediaForPublic(html)).toBe(html)
  })
})

describe("stripMediaTagsToText — all binary editor media", () => {
  it("keeps image alt text and video titles but removes both tags and URLs", () => {
    const html =
      '<img src="/api/media/image-1" alt="Architecture"><video src="/api/media/video-1" title="Walkthrough" controls></video>'
    const output = stripMediaTagsToText(html)
    expect(output).toBe("[image: Architecture][video: Walkthrough]")
    expect(output).not.toContain("/api/media/")
  })

  it("drops an unlabeled video and its fallback contents", () => {
    expect(
      stripMediaTagsToText(
        '<p>Before</p><video src="/api/media/v1">fallback</video><p>After</p>',
      ),
    ).toBe("<p>Before</p><p>After</p>")
  })
})

describe("stripImgTagsToText — embedding/text-fallback surface", () => {
  it("replaces an <img> with a labeled alt marker", () => {
    const html = "<p>Before</p><img src=\"/api/media/x1\" alt=\"cache diagram\"><p>After</p>"
    expect(stripImgTagsToText(html)).toBe(
      "<p>Before</p>[image: cache diagram]<p>After</p>",
    )
  })

  it("drops the tag entirely when alt is empty/absent", () => {
    expect(stripImgTagsToText('a <img src="/api/media/x1"> b')).toBe("a  b")
  })

  it("handles self-closing and multiple imgs", () => {
    const html = '<img src="/api/media/a" alt="one"/> and <img src="/api/media/b" alt="two">'
    expect(stripImgTagsToText(html)).toBe("[image: one] and [image: two]")
  })

  it("leaves non-img markup intact", () => {
    const html = "<p>no images here</p>"
    expect(stripImgTagsToText(html)).toBe(html)
  })
})

describe("extractMediaIds", () => {
  it("collects ids from both authenticated and public refs, deduped", () => {
    const html =
      '<img src="/api/media/one"><video src="/api/public/media/two"></video><img src="/api/media/one">'
    expect(extractMediaIds(html)).toEqual(["one", "two"])
  })

  it("returns empty for a body with no media", () => {
    expect(extractMediaIds("<p>plain</p>")).toEqual([])
  })
})
