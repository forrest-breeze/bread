import { describe, expect, it } from "vitest"
import { mergeTextThreeWay } from "./text-three-way-merge"

describe("mergeTextThreeWay", () => {
  it("keeps the changed side when only one side moved", () => {
    expect(mergeTextThreeWay("a\nb\n", "a\nlocal\n", "a\nb\n")).toEqual({
      ok: true,
      content: "a\nlocal\n",
      autoMerged: false,
    })
  })

  it("automatically merges independent line edits", () => {
    expect(
      mergeTextThreeWay(
        "one\ntwo\nthree\n",
        "ONE\ntwo\nthree\n",
        "one\ntwo\nTHREE\n",
      ),
    ).toEqual({
      ok: true,
      content: "ONE\ntwo\nTHREE\n",
      autoMerged: true,
    })
  })

  it("deduplicates the same edit made on both sides", () => {
    expect(
      mergeTextThreeWay("one\ntwo\n", "one\nTWO\n", "one\nTWO\n"),
    ).toEqual({
      ok: true,
      content: "one\nTWO\n",
      autoMerged: false,
    })
  })

  it("returns structured conflicts for overlapping edits", () => {
    const result = mergeTextThreeWay(
      "one\ntwo\nthree\n",
      "one\nlocal\nthree\n",
      "one\nremote\nthree\n",
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.conflicts).toEqual([
        expect.objectContaining({
          baseStartLine: 2,
          local: "local\n",
          remote: "remote\n",
        }),
      ])
    }
  })
})
