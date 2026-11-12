import { describe, expect, it } from "vitest"
import {
  normalizePublishedDate,
  readPublishedDate,
  resolveFeedDate,
} from "./published-date"

describe("normalizePublishedDate", () => {
  it("canonicalizes a Postgres timestamp to ISO", () => {
    // What Supabase hands back is not the shape the GitHub frontmatter
    // validator accepts, so everything normalizes at the boundary.
    expect(normalizePublishedDate("2026-08-17 17:00:00+00")).toBe(
      "2026-08-17T17:00:00.000Z",
    )
  })

  it("canonicalizes a shortened ISO string", () => {
    expect(normalizePublishedDate("2026-08-17T17:00:00Z")).toBe(
      "2026-08-17T17:00:00.000Z",
    )
  })

  it("rejects anything unusable", () => {
    expect(normalizePublishedDate("not a date")).toBeNull()
    expect(normalizePublishedDate("")).toBeNull()
    expect(normalizePublishedDate("   ")).toBeNull()
    expect(normalizePublishedDate(null)).toBeNull()
    expect(normalizePublishedDate(17)).toBeNull()
  })
})

describe("readPublishedDate", () => {
  it("reads the date out of the metadata bag", () => {
    expect(
      readPublishedDate({ published_date: "2026-08-17T17:00:00Z" }),
    ).toBe("2026-08-17T17:00:00.000Z")
  })

  it("returns null for metadata without one", () => {
    // The field is sparse — most documents never carry it.
    expect(readPublishedDate({ blog_cover: { url: "/x.png" } })).toBeNull()
    expect(readPublishedDate(null)).toBeNull()
    expect(readPublishedDate("nonsense")).toBeNull()
  })

  it("ignores a stored value that is not a usable date", () => {
    expect(readPublishedDate({ published_date: "whenever" })).toBeNull()
  })
})

describe("resolveFeedDate", () => {
  // The whole point: an edit changes updated_at but must not re-date the entry.
  it("prefers the publication date over updated_at", () => {
    expect(
      resolveFeedDate({
        publishedAt: "2026-06-28T17:00:00Z",
        updatedAt: "2026-08-24T12:00:00Z",
      }),
    ).toBe("2026-06-28T17:00:00.000Z")
  })

  it("falls back to updated_at when nothing is published", () => {
    // Keeps every document dated before this field existed working unchanged.
    expect(
      resolveFeedDate({ publishedAt: null, updatedAt: "2026-08-24T12:00:00Z" }),
    ).toBe("2026-08-24T12:00:00.000Z")
  })

  it("falls back when the stored publication date is unusable", () => {
    expect(
      resolveFeedDate({ publishedAt: "junk", updatedAt: "2026-08-24T12:00:00Z" }),
    ).toBe("2026-08-24T12:00:00.000Z")
  })

  it("returns null when neither is usable", () => {
    expect(resolveFeedDate({})).toBeNull()
  })
})
