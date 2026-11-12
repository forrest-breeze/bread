// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => {
  const payload = {
    files: [
      {
        path: "docs/help/setup.md",
        status: "modified" as const,
        previous: "one\ntwo",
        next: "one\ntwo\nthree",
        previousBlobSha: "blob-setup",
      },
      {
        path: "docs/help/new-page.md",
        status: "added" as const,
        previous: "",
        next: "fresh\ncontent",
      },
      {
        path: "docs/help/gone.md",
        status: "removed" as const,
        previous: "",
        next: "",
        bodyOmitted: true,
      },
    ],
    changed_file_count: 3,
    truncated: false,
    compared_commit_sha: "abc123",
  }
  return {
    payload,
    value: {} as Record<string, unknown>,
    refreshDiff: vi.fn(),
    setActivePath: vi.fn(),
    setAllSelected: vi.fn(),
    toggleSelectedPath: vi.fn(),
  }
})

vi.mock("@/components/app/workspace-changes-context", () => ({
  useWorkspaceChanges: () => harness.value,
}))

import { WorkspacePublishDiffView } from "./workspace-publish-diff-view"
import { WorkspaceChangesFileList } from "./workspace-changes-file-list"

function baseValue(): Record<string, unknown> {
  return {
    activeFile: harness.payload.files[0],
    allSelected: true,
    changedFileCount: 3,
    data: harness.payload,
    error: undefined,
    files: harness.payload.files,
    loading: false,
    selectedCount: 3,
    selectedPaths: new Set(harness.payload.files.map((file) => file.path)),
    unavailableReason: null,
    refreshDiff: harness.refreshDiff,
    setActivePath: harness.setActivePath,
    setAllSelected: harness.setAllSelected,
    toggleSelectedPath: harness.toggleSelectedPath,
  }
}

beforeEach(() => {
  harness.refreshDiff.mockReset().mockResolvedValue(harness.payload)
  harness.setActivePath.mockReset()
  harness.setAllSelected.mockReset()
  harness.toggleSelectedPath.mockReset()
  harness.value = baseValue()
})

describe("WorkspaceChangesFileList", () => {
  it("lists every changed path with its filename and directory", () => {
    render(<WorkspaceChangesFileList />)

    expect(screen.getByText("setup.md")).toBeTruthy()
    expect(screen.getByText("new-page.md")).toBeTruthy()
    expect(screen.getByText("gone.md")).toBeTruthy()
    expect(screen.getAllByText("docs/help/").length).toBe(3)
  })

  it("activates a file for the main diff view when clicked", () => {
    render(<WorkspaceChangesFileList />)

    fireEvent.click(screen.getByText("new-page.md"))

    expect(harness.setActivePath).toHaveBeenCalledWith("docs/help/new-page.md")
  })

  it("stages files through the shared selection", () => {
    render(<WorkspaceChangesFileList />)

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Stage docs/help/setup.md",
      }),
    )
    expect(harness.toggleSelectedPath).toHaveBeenCalledWith(
      "docs/help/setup.md",
    )

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Stage all changed files" }),
    )
    expect(harness.setAllSelected).toHaveBeenCalledWith(false)
  })
})

describe("WorkspacePublishDiffView", () => {
  it("shows only the active file's diff, with no file list or back link", () => {
    render(<WorkspacePublishDiffView />)

    expect(screen.getByText("three")).toBeTruthy()
    expect(screen.queryByText("new-page.md")).toBeNull()
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("renders whichever file the sidebar made active", () => {
    harness.value = { ...baseValue(), activeFile: harness.payload.files[1] }
    render(<WorkspacePublishDiffView />)

    expect(screen.getByText("fresh")).toBeTruthy()
    expect(screen.getByText("added")).toBeTruthy()
  })

  it("explains a file whose body was withheld", () => {
    harness.value = { ...baseValue(), activeFile: harness.payload.files[2] }
    render(<WorkspacePublishDiffView />)

    expect(screen.getByText(/too large to show a diff/i)).toBeTruthy()
    expect(screen.getByText(/will still be deleted/i)).toBeTruthy()
  })

  it("shows a loading bar without a spinner", () => {
    harness.value = {
      ...baseValue(),
      data: undefined,
      activeFile: undefined,
      files: [],
      loading: true,
      selectedCount: 0,
      selectedPaths: new Set(),
    }

    render(<WorkspacePublishDiffView />)

    expect(
      screen.getByRole("progressbar", {
        name: "Workspace GitHub comparison progress",
      }),
    ).toBeInTheDocument()
    expect(document.querySelector(".animate-spin")).toBeNull()
  })

  it("explains why a diff is unavailable", () => {
    harness.value = {
      ...baseValue(),
      data: undefined,
      files: [],
      selectedCount: 0,
      selectedPaths: new Set(),
      unavailableReason:
        "GitHub has changes Bread has not pulled in yet.",
    }

    render(<WorkspacePublishDiffView />)

    expect(
      screen.getByText("GitHub has changes Bread has not pulled in yet."),
    ).toBeTruthy()
  })

  it("retries a failed comparison", () => {
    harness.value = {
      ...baseValue(),
      data: undefined,
      error: new Error("Workspace publishing is not ready."),
      files: [],
      selectedCount: 0,
      selectedPaths: new Set(),
    }

    render(<WorkspacePublishDiffView />)
    fireEvent.click(screen.getByRole("button", { name: "Retry comparison" }))

    expect(harness.refreshDiff).toHaveBeenCalledOnce()
  })

  it("says so when the cap hid some files", () => {
    harness.value = {
      ...baseValue(),
      data: {
        ...harness.payload,
        truncated: true,
        changed_file_count: 90,
      },
    }

    render(<WorkspacePublishDiffView />)

    expect(screen.getByText(/Showing the first 3/)).toBeTruthy()
  })
})
