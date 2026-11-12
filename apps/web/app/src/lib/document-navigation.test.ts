import { describe, expect, it } from "vitest"
import { isNavigableDocument } from "./document-navigation"

describe("isNavigableDocument", () => {
  it("hides unfiled GitHub source material", () => {
    expect(
      isNavigableDocument({ source: "GitHub", folder_id: null }),
    ).toBe(false)
  })

  it("shows a GitHub document after it is promoted into a folder", () => {
    expect(
      isNavigableDocument({ source: "GitHub", folder_id: "folder-1" }),
    ).toBe(true)
  })

  it("keeps ordinary unfiled documents visible", () => {
    expect(
      isNavigableDocument({ source: "Manual", folder_id: null }),
    ).toBe(true)
  })
})

