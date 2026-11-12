import { describe, expect, it } from "vitest"
import { resolveScopeRootId, scopeForRoot } from "./scope-tree"

const folders = [
  { id: "root", parent_folder_id: null },
  { id: "guides", parent_folder_id: "root" },
  { id: "api", parent_folder_id: "root" },
  { id: "loose", parent_folder_id: null },
]

describe("resolveScopeRootId", () => {
  it("reads the explicit root a picker wrote", () => {
    expect(resolveScopeRootId(scopeForRoot({ folders }, "root"), folders)).toBe(
      "root",
    )
  })

  it("treats a whole-workspace scope as rootless", () => {
    expect(resolveScopeRootId(null, folders)).toBeNull()
  })

  it("infers the shared parent of a legacy multi-folder scope", () => {
    expect(resolveScopeRootId(["guides", "api"], folders)).toBe("root")
  })

  it("treats a single included folder as the root", () => {
    expect(resolveScopeRootId(["guides"], folders)).toBe("guides")
  })

  it("stays rootless when included folders share no parent", () => {
    expect(resolveScopeRootId(["guides", "loose"], folders)).toBeNull()
  })

  it("ignores entries for folders that are no longer eligible", () => {
    expect(resolveScopeRootId(["gone", "guides"], folders)).toBe("guides")
  })
})
