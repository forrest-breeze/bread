// @vitest-environment happy-dom
/**
 * localStorage-backed preference helpers. These need a window, so we switch
 * the env to happy-dom on a per-file basis — vitest.config.ts defaults to node.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_BUILDER_DOCUMENT_SORT_MODE,
  DEFAULT_DOCUMENT_NAV_SORT_MODE,
  getStoredBuilderDocumentSortMode,
  getStoredDocumentNavSortMode,
  getStoredOpenFolderIds,
  setStoredBuilderDocumentSortMode,
  setStoredDocumentNavSortMode,
  setStoredOpenFolderIds,
} from "@/lib/document-nav-preferences"

afterEach(() => {
  window.localStorage.clear()
})

// ---------------------------------------------------------------------------
// Sort mode
// ---------------------------------------------------------------------------

describe("document nav sort mode", () => {
  it("defaults to alphabetical when storage is empty", () => {
    expect(getStoredDocumentNavSortMode()).toBe(DEFAULT_DOCUMENT_NAV_SORT_MODE)
  })

  it("round-trips 'recent' through storage", () => {
    setStoredDocumentNavSortMode("recent")
    expect(getStoredDocumentNavSortMode()).toBe("recent")
  })

  it("round-trips 'alphabetical' through storage", () => {
    setStoredDocumentNavSortMode("alphabetical")
    expect(getStoredDocumentNavSortMode()).toBe("alphabetical")
  })

  it("round-trips 'created' and 'custom' through storage", () => {
    setStoredDocumentNavSortMode("created")
    expect(getStoredDocumentNavSortMode()).toBe("created")
    setStoredDocumentNavSortMode("custom")
    expect(getStoredDocumentNavSortMode()).toBe("custom")
  })

  it("falls back to the default for any unknown stored value", () => {
    window.localStorage.setItem("bread-doc-nav-sort-mode", "garbage")
    expect(getStoredDocumentNavSortMode()).toBe(DEFAULT_DOCUMENT_NAV_SORT_MODE)
  })
})

// ---------------------------------------------------------------------------
// Builder sort mode — its own key, deliberately not synced with the nav mode
// ---------------------------------------------------------------------------

describe("builder document sort mode", () => {
  it("defaults to custom when storage is empty", () => {
    expect(getStoredBuilderDocumentSortMode()).toBe(
      DEFAULT_BUILDER_DOCUMENT_SORT_MODE,
    )
    expect(DEFAULT_BUILDER_DOCUMENT_SORT_MODE).toBe("custom")
  })

  it("stores independently of the knowledge nav preference", () => {
    setStoredDocumentNavSortMode("recent")
    setStoredBuilderDocumentSortMode("alphabetical")
    expect(getStoredDocumentNavSortMode()).toBe("recent")
    expect(getStoredBuilderDocumentSortMode()).toBe("alphabetical")
  })

  it("falls back to custom for any unknown stored value", () => {
    window.localStorage.setItem("bread-kb-builder-doc-sort-mode", "garbage")
    expect(getStoredBuilderDocumentSortMode()).toBe("custom")
  })
})

// ---------------------------------------------------------------------------
// Open folder ids
// ---------------------------------------------------------------------------

describe("open folder id persistence", () => {
  it("returns an empty set when storage is empty", () => {
    expect(getStoredOpenFolderIds().size).toBe(0)
  })

  it("round-trips a set of ids through storage", () => {
    const ids = new Set(["folder-a", "folder-b"])
    setStoredOpenFolderIds(ids)
    const round = getStoredOpenFolderIds()
    expect(round.has("folder-a")).toBe(true)
    expect(round.has("folder-b")).toBe(true)
    expect(round.size).toBe(2)
  })

  it("returns an empty set when stored JSON is malformed", () => {
    window.localStorage.setItem("bread-doc-nav-open-folders", "{not json")
    expect(getStoredOpenFolderIds().size).toBe(0)
  })

  it("filters non-string entries out of a stored array", () => {
    window.localStorage.setItem(
      "bread-doc-nav-open-folders",
      JSON.stringify(["valid", 42, null, "other"]),
    )
    const ids = getStoredOpenFolderIds()
    expect(ids.has("valid")).toBe(true)
    expect(ids.has("other")).toBe(true)
    expect(ids.size).toBe(2)
  })

  it("returns an empty set when stored value is not an array", () => {
    window.localStorage.setItem(
      "bread-doc-nav-open-folders",
      JSON.stringify({ not: "array" }),
    )
    expect(getStoredOpenFolderIds().size).toBe(0)
  })
})
