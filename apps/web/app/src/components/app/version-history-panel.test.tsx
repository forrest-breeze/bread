// @vitest-environment jsdom
/**
 * VersionHistoryPanel — which two texts the "Changes" view compares.
 *
 * A version row snapshots the content as it was BEFORE an edit (see the POST in
 * api/documents/[id]). So the changes an edit MADE are that row against the
 * state that replaced it — the next newer row, or the live document for the
 * most recent one. Comparing every row against the current document instead
 * shows the cumulative drift since that point, which for older entries is not
 * the edit at all.
 */

import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { doc, versions } = vi.hoisted(() => ({
  doc: { current: { content: "" } as { content: string } },
  versions: { current: [] as unknown[] },
}))

vi.mock("@/hooks/swr", () => ({
  useDocument: () => ({ data: doc.current }),
  useWorkspace: () => ({ data: { user_role: "owner" } }),
  useDocumentVersions: () => ({
    data: { versions: versions.current },
    isLoading: false,
    mutate: vi.fn(),
  }),
  useGitHubDocumentHistory: () => ({ data: null, isLoading: false, error: null }),
  useGitHubDocumentState: () => ({ data: null, mutate: vi.fn() }),
}))

vi.mock("@/components/app/rich-content-preview", () => ({
  RichContentPreview: () => <div />,
}))

import { VersionHistoryPanel } from "./version-history-panel"

function version(id: string, content: string, createdAt: string) {
  return {
    id,
    content,
    title: "Doc",
    source: "manual",
    created_at: createdAt,
    edited_by: null,
    editor_name: null,
  }
}

/** Expand a version row and switch it to the Changes view. */
function openChanges(label: string): HTMLElement {
  fireEvent.click(screen.getByText(label))
  fireEvent.click(screen.getByRole("button", { name: "Changes" }))
  return screen.getByText(/Changes/).closest("div") as HTMLElement
}

describe("VersionHistoryPanel changes view", () => {
  beforeEach(() => {
    doc.current = { content: "line one\nline two\nline three" }
    versions.current = [
      // Newest first: the state before the most recent edit.
      version("v-new", "line one\nline two", "2026-08-20T10:00:00.000Z"),
      // Older: the state before the edit that added "line two".
      version("v-old", "line one", "2026-08-19T10:00:00.000Z"),
    ]
  })

  it("diffs the newest snapshot against the live document", () => {
    render(<VersionHistoryPanel documentId="d1" onRestore={vi.fn()} />)

    const rows = screen.getAllByRole("button", { name: /Manual edit/i })
    fireEvent.click(rows[0]!)
    fireEvent.click(screen.getByRole("button", { name: "Changes" }))

    // The newest edit added "line three" and nothing else.
    expect(screen.getByText("Changes since this snapshot")).toBeTruthy()
    expect(screen.getByText("+1")).toBeTruthy()
    expect(screen.queryByText("line two", { selector: ".bg-emerald-500\\/10" })).toBeNull()
  })

  // The regression this guards: before the fix an older row was diffed against
  // the CURRENT document, so it reported every later edit as part of this one.
  it("diffs an older snapshot against the snapshot that replaced it", () => {
    render(<VersionHistoryPanel documentId="d1" onRestore={vi.fn()} />)

    const rows = screen.getAllByRole("button", { name: /Manual edit/i })
    fireEvent.click(rows[1]!)
    fireEvent.click(screen.getByRole("button", { name: "Changes" }))

    expect(screen.getByText("Changes made by this edit")).toBeTruthy()
    // That edit added exactly one line ("line two"). Diffing against the
    // current document would have reported two.
    expect(screen.getByText("+1")).toBeTruthy()
  })

  it("says nothing changed when an edit was a no-op", () => {
    doc.current = { content: "line one\nline two" }
    versions.current = [version("v-new", "line one\nline two", "2026-08-20T10:00:00.000Z")]
    render(<VersionHistoryPanel documentId="d1" onRestore={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: /Manual edit/i }))
    fireEvent.click(screen.getByRole("button", { name: "Changes" }))

    expect(screen.getByText("Nothing changed in this edit.")).toBeTruthy()
  })
})
