import { describe, it, expect } from "vitest"
import { buildDiffStat, buildTextDiff } from "@/lib/text-diff"

describe("buildTextDiff", () => {
  it("returns an empty list when the texts are identical", () => {
    const diff = buildTextDiff("alpha\nbeta", "alpha\nbeta")
    expect(diff).toEqual([])
  })

  it("marks a single-line addition as 'added'", () => {
    const diff = buildTextDiff("alpha", "alpha\nbeta")
    const types = diff.map((line) => line.type)
    expect(types).toContain("added")
    const added = diff.find((line) => line.type === "added")
    expect(added?.value).toBe("beta")
  })

  it("marks a removed line as 'removed'", () => {
    const diff = buildTextDiff("alpha\nbeta", "alpha")
    const removed = diff.find((line) => line.type === "removed")
    expect(removed?.value).toBe("beta")
  })

  it("includes context lines around a change", () => {
    const previous = "one\ntwo\nthree\nfour\nfive"
    const next = "one\ntwo\nTHREE\nfour\nfive"
    const diff = buildTextDiff(previous, next, { contextLines: 1 })
    const types = diff.map((line) => line.type)
    expect(types).toContain("added")
    expect(types).toContain("removed")
    expect(types).toContain("context")
  })

  it("normalizes CRLF to LF so diffs aren't spammed by newline style", () => {
    const diff = buildTextDiff("alpha\r\nbeta", "alpha\nbeta")
    expect(diff).toEqual([])
  })

  it("collapses unchanged regions into a 'skipped' marker between far-apart edits", () => {
    const previous = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n")
    const next = previous.replace("line-0", "LINE-0").replace("line-19", "LINE-19")
    const diff = buildTextDiff(previous, next, { contextLines: 1 })
    const hasSkipped = diff.some((line) => line.type === "skipped")
    expect(hasSkipped).toBe(true)
  })

  it("falls back to a whole-block replacement when the LCS matrix would be too large", () => {
    // previous.length * next.length > maxMatrixSize forces the cheap path:
    // every old line is removed, every new line is added, no context pairs.
    const previous = Array.from({ length: 25 }, (_, i) => `old-${i}`).join("\n")
    const next = Array.from({ length: 25 }, (_, i) => `new-${i}`).join("\n")
    const diff = buildTextDiff(previous, next, { maxMatrixSize: 10 })
    const hasContext = diff.some((line) => line.type === "context")
    expect(hasContext).toBe(false)
    expect(diff.some((line) => line.type === "removed")).toBe(true)
    expect(diff.some((line) => line.type === "added")).toBe(true)
  })

  it("truncates output above maxVisibleLines", () => {
    const previous = Array.from({ length: 60 }, (_, i) => `old-${i}`).join("\n")
    const next = Array.from({ length: 60 }, (_, i) => `new-${i}`).join("\n")
    const diff = buildTextDiff(previous, next, { maxVisibleLines: 5 })
    expect(diff.length).toBeLessThanOrEqual(5)
    expect(diff.at(-1)?.type).toBe("skipped")
  })
})

describe("buildDiffStat", () => {
  it("counts nothing for identical text", () => {
    expect(buildDiffStat("same\nlines", "same\nlines")).toEqual({
      added: 0,
      removed: 0,
    })
  })

  it("counts added and removed lines separately", () => {
    const stat = buildDiffStat("one\ntwo\nthree", "one\ntwo point five\nthree\nfour")
    expect(stat.added).toBe(2)
    expect(stat.removed).toBe(1)
  })

  // Splitting "" yields one empty line, so a naive count reports a phantom
  // removal for content created from nothing. Git calls that a pure addition.
  it("counts a pure insertion with no phantom removal", () => {
    expect(buildDiffStat("", "a\nb\nc")).toEqual({ added: 3, removed: 0 })
  })

  it("counts a full deletion with no phantom addition", () => {
    expect(buildDiffStat("a\nb\nc", "")).toEqual({ added: 0, removed: 3 })
  })

  // The rendered diff collapses context and truncates past maxVisibleLines, so
  // counting its output would under-report exactly the large edits where the
  // number matters most. The stat counts the raw diff instead.
  it("reports the full count for an edit larger than the render cap", () => {
    const previous = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")
    const next = Array.from({ length: 400 }, (_, i) => `changed ${i}`).join("\n")

    const stat = buildDiffStat(previous, next)
    const rendered = buildTextDiff(previous, next)

    expect(stat.added).toBe(400)
    expect(stat.removed).toBe(400)
    expect(rendered.length).toBeLessThan(stat.added + stat.removed)
  })
})
