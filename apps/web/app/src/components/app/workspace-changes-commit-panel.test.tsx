// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  clearMutationError: vi.fn(),
  commitSelected: vi.fn(),
  refreshDiff: vi.fn(),
  revertSelected: vi.fn(),
}))

vi.mock("@/components/app/workspace-changes-context", () => ({
  useWorkspaceChanges: () => harness.value,
}))

vi.mock("@/components/app/workspace-github-publish", () => ({
  WorkspaceGitHubPublish: () => <div>GitHub setup controls</div>,
}))

import { WorkspaceChangesCommitPanel } from "./workspace-changes-commit-panel"

function baseValue(): Record<string, unknown> {
  return {
    conflictCount: 0,
    data: {
      files: [{ path: "docs/one.md" }, { path: "docs/two.md" }],
    },
    error: undefined,
    files: [{ path: "docs/one.md" }, { path: "docs/two.md" }],
    loading: false,
    mutation: null,
    mutationError: null,
    pullRequest: null,
    selectedCanRevert: true,
    selectedCount: 2,
    unavailableReason: null,
    clearMutationError: harness.clearMutationError,
    commitSelected: harness.commitSelected,
    refreshDiff: harness.refreshDiff,
    revertSelected: harness.revertSelected,
  }
}

beforeEach(() => {
  harness.clearMutationError.mockReset()
  harness.commitSelected.mockReset().mockResolvedValue(true)
  harness.refreshDiff.mockReset().mockResolvedValue(undefined)
  harness.revertSelected.mockReset().mockResolvedValue(true)
  harness.value = baseValue()
})

describe("WorkspaceChangesCommitPanel", () => {
  it("owns one commit action for the complete staged set", async () => {
    const user = userEvent.setup()
    render(<WorkspaceChangesCommitPanel />)

    expect(screen.getByText("2 of 2")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Commit" })).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: "Commit" }))

    expect(
      screen.getByRole("heading", { name: "Commit 2 staged changes?" }),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: "Commit staged changes" }),
    )

    expect(harness.commitSelected).toHaveBeenCalledOnce()
  })

  it("keeps revert beside commit in the sidebar", async () => {
    const user = userEvent.setup()
    render(<WorkspaceChangesCommitPanel />)

    await user.click(screen.getByRole("button", { name: "Revert" }))
    expect(
      screen.getByRole("heading", { name: "Revert 2 staged changes?" }),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: "Revert staged changes" }),
    )

    expect(harness.revertSelected).toHaveBeenCalledOnce()
  })

  it("leaves the diff pane as the only loading bar while warming", () => {
    harness.value = {
      ...baseValue(),
      data: undefined,
      files: [],
      loading: true,
      selectedCount: 0,
    }
    render(<WorkspaceChangesCommitPanel />)

    expect(screen.getByText("Preparing saved changes…")).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(document.querySelector(".animate-spin")).toBeNull()
  })

  it("falls back to GitHub setup controls when no comparison is available", () => {
    harness.value = {
      ...baseValue(),
      data: undefined,
      files: [],
      selectedCount: 0,
      unavailableReason: "GitHub publishing is not configured.",
    }
    render(<WorkspaceChangesCommitPanel />)

    expect(screen.getByText("GitHub setup controls")).toBeInTheDocument()
  })
})
