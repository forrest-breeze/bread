import { describe, expect, it } from "vitest"
import type { PublicDocSummary } from "@/lib/public-kb"
import { changelogNeighbors, sortChangelogDocs } from "./changelog-entry"

function release(
  id: string,
  title: string,
  updatedAt?: string,
): PublicDocSummary {
  return {
    id,
    slug: id,
    title,
    source: null,
    updated_at: updatedAt,
  }
}

describe("changelog entry navigation", () => {
  it("sorts releases newest-first and leaves undated entries last", () => {
    const ordered = sortChangelogDocs([
      release("old", "Old", "2026-06-01T00:00:00Z"),
      release("undated", "Undated"),
      release("new", "New", "2026-08-01T00:00:00Z"),
    ])

    expect(ordered.map((document) => document.id)).toEqual([
      "new",
      "old",
      "undated",
    ])
  })

  it("builds page-local newer and older links in feed order", () => {
    const documents = [
      release("old", "Old", "2026-06-01T00:00:00Z"),
      release("current", "Current", "2026-07-01T00:00:00Z"),
      release("new", "New", "2026-08-01T00:00:00Z"),
    ]

    expect(
      changelogNeighbors(
        documents,
        "current",
        (document) => `/page/changelog/${document.slug}`,
      ),
    ).toEqual({
      newer: { title: "New", href: "/page/changelog/new" },
      older: { title: "Old", href: "/page/changelog/old" },
    })
  })
})
