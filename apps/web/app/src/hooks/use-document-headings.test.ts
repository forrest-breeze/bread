import { describe, expect, it } from "vitest"
import { getActivationLine, pickActiveHeadingIndex, type ScrollViewport } from "./use-document-headings"

const viewport = (overrides: Partial<ScrollViewport> = {}): ScrollViewport => ({
  top: 0,
  height: 800,
  scrollTop: 0,
  maxScroll: 4000,
  minOffset: 96,
  ...overrides,
})

describe("getActivationLine", () => {
  it("rests a fraction down the visible area, scaling with its height", () => {
    expect(getActivationLine(viewport())).toBe(200)
    expect(getActivationLine(viewport({ height: 1200 }))).toBe(300)
  })

  it("never sits above the minimum offset in short frames", () => {
    expect(getActivationLine(viewport({ height: 300 }))).toBe(96)
  })

  it("is measured from the scroll container's own top edge", () => {
    expect(getActivationLine(viewport({ top: 120, minOffset: 32 }))).toBe(320)
  })

  it("glides to the bottom edge over the final screenful of scroll", () => {
    // Travel is 600px (800 - 200). Halfway through it, the line is halfway down.
    expect(getActivationLine(viewport({ scrollTop: 4000 - 600 }))).toBe(200)
    expect(getActivationLine(viewport({ scrollTop: 4000 - 300 }))).toBe(500)
    expect(getActivationLine(viewport({ scrollTop: 4000 }))).toBe(800)
  })

  it("keeps the line at rest at the top of a short scrollable page", () => {
    const short = viewport({ maxScroll: 200 })
    expect(getActivationLine(short)).toBe(200)
    expect(getActivationLine({ ...short, scrollTop: 200 })).toBe(800)
  })

  it("stays at rest when nothing scrolls", () => {
    expect(getActivationLine(viewport({ maxScroll: 0 }))).toBe(200)
  })
})

describe("pickActiveHeadingIndex", () => {
  it("picks the last heading that crossed the line", () => {
    expect(pickActiveHeadingIndex([-500, 100, 250, 900], 200)).toBe(1)
  })

  it("falls back to the first heading before any crosses", () => {
    expect(pickActiveHeadingIndex([400, 900], 200)).toBe(0)
  })

  it("counts a heading scrolled onto the line despite sub-pixel rounding", () => {
    expect(pickActiveHeadingIndex([-300, 96.6], 96)).toBe(1)
  })
})
