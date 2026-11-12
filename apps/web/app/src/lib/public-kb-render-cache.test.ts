import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  renderPublicHtml: vi.fn((content: string) => `<p>${content}</p>`),
  renderApiReferenceHtml: vi.fn((content: string) => ({
    html: `<p>${content}</p>`,
    examplesHtml: "",
  })),
  withCodeSampleGroups: vi.fn((html: string) => `<div>${html}</div>`),
}))

vi.mock("@/lib/public-kb-render", () => ({
  renderPublicHtml: mocks.renderPublicHtml,
}))
vi.mock("@/lib/portal/api-reference-html", () => ({
  renderApiReferenceHtml: mocks.renderApiReferenceHtml,
  withCodeSampleGroups: mocks.withCodeSampleGroups,
}))

import {
  renderApiReferenceHtmlCached,
  renderPublicHtmlCached,
  renderPublicHtmlWithCodeGroupsCached,
} from "./public-kb-render-cache"

describe("public render cache", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders a body once and reuses the result", async () => {
    const first = await renderPublicHtmlCached("cache: same body")
    const second = await renderPublicHtmlCached("cache: same body")

    expect(first).toBe("<p>cache: same body</p>")
    expect(second).toBe(first)
    expect(mocks.renderPublicHtml).toHaveBeenCalledTimes(1)
  })

  it("renders again when the body changes", async () => {
    await renderPublicHtmlCached("cache: version one")
    const edited = await renderPublicHtmlCached("cache: version two")

    expect(edited).toBe("<p>cache: version two</p>")
    expect(mocks.renderPublicHtml).toHaveBeenCalledTimes(2)
  })

  it("shares one render between concurrent requests for the same body", async () => {
    const [a, b] = await Promise.all([
      renderPublicHtmlCached("cache: concurrent"),
      renderPublicHtmlCached("cache: concurrent"),
    ])

    expect(a).toBe(b)
    expect(mocks.renderPublicHtml).toHaveBeenCalledTimes(1)
  })

  it("keeps the plain, code-grouped and API reference renders separate", async () => {
    const body = "cache: one body, three shapes"
    const plain = await renderPublicHtmlCached(body)
    const grouped = await renderPublicHtmlWithCodeGroupsCached(body)
    const reference = await renderApiReferenceHtmlCached(body)

    expect(plain).toBe(`<p>${body}</p>`)
    expect(grouped).toBe(`<div><p>${body}</p></div>`)
    expect(reference).toEqual({ html: `<p>${body}</p>`, examplesHtml: "" })
  })

  it("caches in memory without the shared cache for previews", async () => {
    await renderPublicHtmlCached("cache: preview draft", { memoryOnly: true })
    await renderPublicHtmlCached("cache: preview draft", { memoryOnly: true })

    expect(mocks.renderPublicHtml).toHaveBeenCalledTimes(1)
  })
})
